/**
 * @file The model-driven derivation. The model emits a list of
 * {@link ShapeOperation} that {@link deriveExtractionShape} applies — the
 * correct-by-construction applier this wave's design promised, so the model
 * never reaches the schemas themselves with anything but data.
 *
 * **The shape of it, and where it lives.** One-shot proposal, then repair:
 * the applier already refuses every malformed operation set at construction
 * with the offending path named, and that text is exactly what a repair turn
 * needs as feedback. A multi-turn move loop with live-applied operations is
 * the alternative — more permanent API, more surface to test, more chances to
 * bind instructions to live schema state. Wave 1's evidence (every refusal is
 * precise and named) argues for one-shot plus repair, and the wave locked the
 * decision: start there, argue otherwise if and when a build says so. ADR
 * 0016 records the choice with its cost.
 *
 * **Two distinct retry layers, one budget.** The chat-call step wraps
 * `completeOrClassify` in `retryAsync` so a 429 / 5xx / dropped connection
 * is retried silently with backoff, with its own budget (`maxNetworkRetries`,
 * default 2). The repair loop is separate (ADR 0016's "one repair attempt")
 * and counts only model verdicts — refusal, unsupported, `length`, content
 * filter — folded to `failure: "transport"`. A transport blip does not
 * consume a repair attempt: the chat-call wrapper retries it first, and on
 * exhaustion the proposal returns `[]` directly. The amendment is a
 * scoping, not a change to the repair budget or its exhaustion default;
 * see ADR 0016 for the original decision.
 *
 * **Caps never reach the model.** Packing is `schemaExtractor`'s job, after
 * the proposal lands. Disclosing the provider cap in the prompt got a spike
 * a fragmented partition for it, and the cap is the route's, not the model's,
 * to know about. Empty-array operations is a valid answer; emitting twenty
 * is also valid. The cap is downstream.
 *
 * **Runtime, not build time.** The proposal is async; it runs BEFORE
 * `deriveExtractionShape`, so the schema-extraction seam downstream stays
 * synchronous and unchanged. The operations array is a serialisable value;
 * its lifecycle is the host's, not `PluginStorage`'s — caching is theirs.
 *
 * **The closed overlap with `deriveExtractionShape`.** Whatever the proposer
 * returns, a `deriveExtractionShape(schema, { operations: proposedOps })`
 * call applies — same applier, same post-condition assertions, the same
 * `assertShapeMapping` invariants. A proposed shape that survives construction
 * is, by the same reasoning `shape-properties.test.ts` already pins, one the
 * library fully supports. A proposed shape that fails construction is repaired
 * (or, at exhaustion, the application runs with zero operations — friendly
 * to a newcomer and defensible to a reviewer).
 *
 * **No tool-calling in the {@link ChatClient} seam.** The same `complete`,
 * the same `completeOrClassify`, the same `assertStopFinishReason`, the same
 * `parseJsonContent`, the same `parseWithSchema`. A loop over structured
 * output works on any route (`openAiChat`, `helixChat`, an in-browser or
 * on-device implementation) and on-device too. `askPhase` builds a single
 * schema per instance behind a `CapableChatClient`; this has dynamic turns
 * and its own response schema, so compose from the lower-level helpers
 * rather than reach for it.
 */

import { z } from "zod";

import {
  assertStopFinishReason,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
  retryAsync,
  SchemaParseError,
  TerminalError,
} from "@azx/ribo-core";
import type {
  ChatClient,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  ExtractOptions,
} from "@azx/ribo-core";

import type { DerivedExtractionShape } from "./derived-shape.js";
import { deriveExtractionShape } from "./shape-operations.js";
import type { DeriveExtractionShapeOptions } from "./shape-operations.js";
import type { ShapeOperation } from "./shape-operation.js";
import { renderLeafInventory, walkLeafInventory } from "./leaf-inventory.js";

/**
 * Options for {@link proposeShapeOperations}.
 *
 * `chat`, `model`, `name` and `instructions` own the call the way
 * `singleShotExtractor`'s options do. `extract` runs once per schema; the
 * caller passes a `ChatClient` and a model, and the same instance would
 * naturally serve the eventual extractor. `name` is the schema constant
 * carried into repair turns as a context label, NOT the wire-schema name
 * (the proposer pins its own wire name so renaming the target does not
 * invalidate the response schema).
 */
export interface ProposeOptions {
  /** The injected chat transport. A fake in tests; `openAiChat` / `helixChat` in production. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /**
   * A short label for the caller's working context (e.g. `"my-extractor"`).
   * Surfaced in error messages so a caller looking at a thrown error can see
   * which proposing call rejected it. NOT the wire-name.
   */
  readonly context: string;
  /**
   * Domain guidance for the model — the same shape `singleShotExtractor`'s
   * `instructions` takes, declared so the proposer's prompt carries the
   * caller's reasoning about which fields matter most for THEIR capture.
   * Empty string is fine; everything the model needs is then in the leaf
   * inventory's descriptions and the proposal directive.
   */
  readonly instructions: string;
  /**
   * Cap on generated tokens for each propose call. Realistic operation lists
   * are short (a few dozen paths), so the default is OFF and a caller wanting
   * a cap can pass one. Undefined is the seam's "no cap"; the chat transport
   * decides what that means for the route.
   */
  readonly maxTokens?: number;
  /**
   * Number of repair attempts after the first proposal fails. Defaults to
   * `1`, the smallest count that lets the proven retry pattern run: first
   * turn, repair turn, accept. A repair is one full chat round-trip, which
   * is one real, paid model call; the budget is what gates "we stop trying
   * and accept whatever we got."
   *
   * At exhaustion the proposal returns `[]` — a valid operation set, just
   * an unshaped one. See ADR 0016 for the argued default; a caller who
   * would rather see an exception can wrap and check the operations array.
   */
  readonly maxRepairAttempts?: number;
  /**
   * Retries after a transport blip (a 429, a 5xx, a dropped connection) on
   * the chat call, so the total attempts is `maxNetworkRetries + 1`. A
   * transient blip on this layer does **not** consume the repair budget —
   * the chat-call step has its own retry, distinct from the repair loop,
   * and a model verdict (refusal / unsupported / length) still goes to the
   * repair loop unaltered. Defaults to `2`, matching `retryAsync`'s default
   * and `retryExtractor`'s default — three attempts total is what the
   * proven retry pattern assumes.
   *
   * The repair loop's chat call goes through the same wrapper, so a 429 on
   * a repair attempt is retried silently with the same budget.
   */
  readonly maxNetworkRetries?: number;
  /**
   * Injectable sleep used between network retries, so tests do not wait
   * real seconds. Takes the **already-computed** backoff result in
   * milliseconds, exactly as `RetryExtractorOptions.delay` does — a caller
   * that wants no backoff passes a function that ignores its argument and
   * resolves immediately. Defaults to a `setTimeout`-backed sleep.
   */
  readonly networkRetryDelay?: (ms: number) => Promise<void>;
  /**
   * Forwarded verbatim into each chat call. The deletion here would strand
   * a caller's deadline silently — see `extract.ts`'s delegation discipline
   * for the same rule every other call in this repo follows.
   */
  readonly options?: ExtractOptions;
}

/**
 * The response schema the model fills. `operations` is an unbounded array;
 * the route's `maxTokens` is what bounds the real output count, not the
 * schema — see the file header for why exposing a cap here would be wrong.
 *
 * `retype.to` is the closed set's lone member, verbatim: a string→number
 * retype. Widening the set in {@link ShapeOperation} widens it here.
 *
 * **`moves` is an array of `{from, to}` pairs, not a record.** A `z.record`
 * would emit a JSON Schema with `propertyNames` and `additionalProperties`
 * (the value-type schema) — keywords the Helix platform's structured-output
 * route rejects as outside its strict subset (`HTTP 400: responseFormat.schema
 * failed validation`). The transformation to a {@link ShapeOperation} happens
 * in {@link movesToRecord} below, where the array is collapsed back into a
 * record for the applier. The change is wire-only: callers' {@link ShapeOperation}
 * objects still carry `moves: Readonly<Record<string, string>>`.
 */
const proposedOperationsSchema = z.object({
  operations: z.array(
    z.union([
      z.object({ op: z.literal("drop"), path: z.string() }),
      z.object({ op: z.literal("retype"), path: z.string(), to: z.literal("number") }),
      z.object({
        op: z.literal("regroup"),
        group: z.string(),
        moves: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
      }),
      z.object({
        op: z.literal("nest"),
        group: z.string(),
        moves: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
      }),
    ]),
  ),
});

/**
 * Convert the wire-format array of `{from, to}` pairs into the record the
 * applier accepts. The duplicate-`from` case would already have been refused
 * by the applier as ambiguous; we collapse cleanly, last-write-wins the
 * duplicate just as `Object.fromEntries` does. The array form is a wire
 * accommodation for a platform-route constraint; the record form is what
 * the operation set's vocabulary actually means.
 */
const movesToRecord = (
  pairs: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    out[pair.from] = pair.to;
  }
  return out;
};

type ProposedOperations = z.infer<typeof proposedOperationsSchema>;

/**
 * The system prompt for the propose call. Two sections the model reads once
 * per attempt and re-reads verbatim on every repair:
 *
 *   - **Domain instructions** — `options.instructions`, exactly as the caller
 *     wrote them. A proposal with empty instructions still works; the
 *     directive below carries the task.
 *   - **The proposal directive** — pinned text describing the operation set
 *     and its composition rule. The composition rule is documented
 *     exhaustively in `package/ribo-extractor-openai/src/shape/shape-operation.ts`
 *     for a human reader; here it is summarised for the model in the same
 *     shape the applier validates.
 *
 * The directive names the cap-rule once, plainly: "there is no cap on count".
 * A substring check on a number would false-positive against an enum leaf's
 * numeric members (per the wave's pre-test hint); the assertion in
 * `operations-proposer.test.ts` matches this phrase instead.
 */
const PROPOSE_DIRECTIVE = `You are proposing shape operations for the user's schema. The schema below is theirs: nothing here changes their data, but the operations you select will produce the extraction schema a downstream model is asked to fill. The healthier proposal, the cleaner the downstream extraction.

The supported operations, and their closed composition rule:

- drop { path }: remove the leaf or whole subtree at this dotted object path. Use for fields a speaker virtually never states — audit/capture scoping, NOT to hide hard cases. The path is a dotted object path; instance-key brackets are not allowed.
- retype { path, to: "number" }: model the leaf as a number instead of its declared kind. ONLY for leaves whose declared kind in the schema is "string" — the closed retype set is exactly string→number. Use for fields the vendor typed as form-input strings but mean a number (the model's \`Number(quote)\` is the only legal forward).
- regroup { group, moves: { from: to } }: re-nest leaves within ONE top-level group (deepen, flatten, rename). The moves' sources and destinations are below the group, never at it. NEVER across a top-level boundary, NEVER passing through or landing on an array — one extraction value would have to fill every element.
- nest { group, moves: { from: to } }: CREATE a new top-level group and move top-level fields into it — this is how you give a flat schema structure. Every source is a top-level field (never an existing group, never a collection, never a nested path); the group is a new name you invent, never the name of an existing or dropped top-level key; destinations are paths below the new group.

The operations are a SET, not a sequence. Composition rules the applier enforces and will refuse with the offending path named:
- a duplicate drop / retype on the same path / regroup or nest on the same group is refused, not silently overwritten, and a top-level field may be moved by at most one nest;
- retype and a move (regroup or nest) compose on the same leaf (retype the kind, move the position — orthogonal);
- one regroup's or nest's move destinations are pairwise distinct, no two destinations prefix one another, and no regroup destination lies under a dropped path;
- a retype names a patch LEAF whose declared kind is "string";
- a move's source and destination are inside the group's element for a collection group, never passing through or landing on the array;
- a drop that empties the parent object is refused — drop the parent instead.

There is no cap on the number of operations. Decide freely which to propose; the schema packing, if your proposal is large, is a downstream concern.

If no operations are warranted, respond with an empty \`operations\` array.`;

const proposeContext = (context: string): string => `proposeShapeOperations: ${context}`;

/**
 * Render the conversation-built-so-far as a `ChatRequest`. The request schema
 * pins the response to the operation shape — same `strict: true` discipline
 * the rest of the library follows. The wire name is fixed (`shape-proposal`)
 * for the proposer's lifetime: nothing the caller changes invalidates it, and
 * the fixed name keeps a single response schema per Proposer call.
 */
const buildProposeRequest = (
  model: string,
  messages: readonly ChatMessage[],
  maxTokens: number | undefined,
): ChatRequest => ({
  model,
  messages,
  maxTokens,
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "shape-proposal",
      // The cast widens `toJSONSchema`'s `unknown` return into the
      // `Record<string, unknown>` the `json_schema.schema` slot expects.
      // The runtime value is a JSON Schema object either way; suppression
      // matches the same move `single-shot.ts` and `schema-retry.ts` make.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- widening unknown to Record<string, unknown>; see comment above
      schema: z.toJSONSchema(proposedOperationsSchema, { target: "draft-2020-12" }) as Record<
        string,
        unknown
      >,
      strict: true,
    },
  },
});

/**
 * One propose call's outcome: either the operations the model emitted, or a
 * refusal the next repair turn uses as feedback. The prior output rides on
 * the failure so a repair assistant turn can show the model its own previous
 * answer — the same trick `schema-retry` uses on its retries.
 *
 * Reuses the chat transport's `completeOrClassify` / `assertStopFinishReason`
 * terminal classification (refusal / unsupported / `"length"` /
 * `"content_filter"`) to short-circuit a misbehaving model: re-prompting into
 * a refusal would just produce another refusal, and re-prompting into a
 * truncation would truncate at the same point. The wave's argued default is
 * "return `[]`, never throw", and these reclassifications are folded into the
 * same exhaustion path rather than letting them escape.
 */
type ProposeAttemptResult =
  | { readonly ok: true; readonly operations: readonly ShapeOperation[] }
  | {
      readonly ok: false;
      readonly failure: "transport" | "json" | "schema" | "shape";
      readonly refusal: string;
      readonly priorOutput: string;
    };

/**
 * Run one propose call against the chat transport. Four failure kinds, each
 * carrying a refusal string for the next repair turn (or, at exhaustion, the
 * one word "transport" failure path that consumes the budget without
 * reattempting because the transport verdict is final):
 *
 *   - **Transient transport rejection** (5xx, 429, dropped connection) —
 *     retried by `retryAsync` over the chat-call layer. On exhaustion the
 *     error is rethrown so `proposeShapeOperations` returns `[]` **without**
 *     burning a repair attempt — a transport blip does not consume the repair
 *     budget, by the same reasoning `retryExtractor` and `validateExtractor`
 *     apply (ADR 0016, with the amendment that scopes the repair chance to
 *     model verdicts).
 *   - **Transport verdict** (refusal, unsupported, `length`, content filter)
 *     — `completeOrClassify` translates refusal / unsupported into
 *     `TerminalError`; `assertStopFinishReason` (below) does the same for
 *     `length` / content filter. Both are model verdicts: re-prompting on the
 *     same input reproduces them. Folded into "failure: transport" so the
 *     repair loop gets one shot, then returns `[]`.
 *   - **JSON parse** (plain `Error` from `parseJsonContent`) — REPAIRABLE.
 *   - **Schema parse** (`SchemaParseError` from `parseWithSchema`) —
 *     REPAIRABLE.
 *   - **Shape apply** (`deriveExtractionShape` throws on a bad operation set)
 *     — REPAIRABLE: the applier's refusal text names the offending path
 *     precisely, the right feedback for a repair turn.
 */
const runAttempt = async (
  chat: ChatClient,
  request: ChatRequest,
  context: string,
  schema: z.ZodObject,
  options: ExtractOptions | undefined,
  networkRetry: { maxRetries: number; delay?: (ms: number) => Promise<void> },
): Promise<ProposeAttemptResult> => {
  let completion: ChatCompletion;
  try {
    completion = await retryAsync(
      // `ExtractOptions` is a structural superset of `ChatCallOptions` (it
      // adds `deadline`); the call site accepts it without a cast because
      // TS treats a wider object as assignable when its only extra member is
      // unconstrained by the target. The deadline rides through into the
      // chat object's options bag, where a transport that knows how to act
      // on it will find it.
      () => completeOrClassify(chat, request, context, options),
      {
        maxRetries: networkRetry.maxRetries,
        delay: networkRetry.delay,
        // The caller's signal consulted on every iteration's pre-attempt
        // check; cancellation aborts the retry loop untouched.
        signal: options?.signal,
      },
    );
  } catch (cause) {
    // Two distinct exits from the chat-call retry wrapper.
    //
    //   1. TerminalError — `completeOrClassify` translated a refusal /
    //      unsupported `ChatError` into one (re-sending the same request
    //      reproduces the same verdict). The model verdict is final for
    //      this input; the repair loop spends one attempt confirming the
    //      verdict persists.
    //   2. Anything else — a transient (5xx, 429, dropped connection,
    //      malformed-response) that exhausted `retryAsync`'s retries. The
    //      chat-call step has its own retry budget, distinct from the
    //      repair loop, so rethrow and let `proposeShapeOperations` return
    //      `[]` directly. A repair attempt on a transient blip, with no
    //      change to the input, would only burn another paid model call to
    //      the same verdict.
    if (cause instanceof TerminalError) {
      return {
        ok: false,
        failure: "transport",
        refusal: cause.message,
        priorOutput: "",
      };
    }
    throw cause;
  }

  // `assertStopFinishReason` reclassifies a non-`"stop"` finish reason
  // (`"length"`, `"content_filter"`) as terminal — re-sending the same
  // request truncates at the same point; a content filter fires on the
  // same content. The repair loop will give it one chance, then fall
  // through to the `[]` exhaustion default.
  try {
    assertStopFinishReason(completion, context);
  } catch (cause) {
    return {
      ok: false,
      failure: "transport",
      refusal: cause instanceof Error ? cause.message : String(cause),
      priorOutput: completion.content,
    };
  }

  // Capture the verbatim content so a repair turn can show the model its
  // own assistant message — same handling as schema-retry's `failure.output`.
  const rawContent = completion.content;

  let raw: unknown;
  try {
    raw = parseJsonContent(rawContent, context);
  } catch (cause) {
    return {
      ok: false,
      failure: "json",
      refusal: cause instanceof Error ? cause.message : String(cause),
      priorOutput: rawContent,
    };
  }

  let parsed: ProposedOperations;
  try {
    parsed = parseWithSchema(proposedOperationsSchema, raw, context);
  } catch (cause) {
    const refusal =
      cause instanceof SchemaParseError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return {
      ok: false,
      failure: "schema",
      refusal,
      // Show the model the JSON object it emitted, even though it failed the
      // response schema. Wrapped to keep the assistant turn's content textual.
      priorOutput: JSON.stringify(raw),
    };
  }

  // The shape apply runs against the user's schema with the proposed ops.
  // Refusal text from this path names the offending path precisely — that's
  // what makes it the right feedback for a repair turn. The wire-format moves
  // (array of pairs, see `proposedOperationsSchema`'s header) are converted
  // back to records before the applier sees them.
  try {
    const operations: ShapeOperation[] = parsed.operations.map((op) => {
      if (op.op === "regroup")
        return { op: "regroup", group: op.group, moves: movesToRecord(op.moves) };
      if (op.op === "nest")
        return { op: "nest", group: op.group, moves: movesToRecord(op.moves) };
      return op;
    });
    deriveExtractionShape(schema, { operations });
    return { ok: true, operations };
  } catch (cause) {
    return {
      ok: false,
      failure: "shape",
      refusal: cause instanceof Error ? cause.message : String(cause),
      priorOutput: JSON.stringify(raw),
    };
  }
};

const repairFeedback = (
  failure: "transport" | "json" | "schema" | "shape",
  refusal: string,
): string => {
  if (failure === "transport") {
    // The transport verdict is final for this input; the repair asks the
    // model to confirm or produce a valid alternative before the budget
    // gives up. A second refusal of the same kind drives the exhaustion
    // fallback.
    return (
      `Your previous response was rejected by the transport: ${refusal}. ` +
      "Re-attempt the proposal in the same JSON shape; the model's answer is " +
      "the one a downstream extraction call can consume."
    );
  }
  if (failure === "json") {
    return (
      `Your previous response was not valid JSON: ${refusal}. Return a single JSON ` +
      "object matching the response schema; no prose outside the object."
    );
  }
  if (failure === "schema") {
    return (
      `Your previous response did not match the response schema: ${refusal}. Return ` +
      "a JSON object with one `operations` array of valid operation objects whose discriminators " +
      'are "drop", "retype", "regroup", or "nest". No prose outside the object.'
    );
  }
  // `failure === "shape"` — the response parsed, but the operations would
  // produce an invalid extraction shape. The refusal text is the applier's.
  return (
    `Your previous proposal would not produce a valid extraction shape: ${refusal}. ` +
    "Revise the operations so they satisfy the composition rule described in the system " +
    "prompt. Return a JSON object whose `operations` array contains the revised set."
  );
};

/**
 * Propose a {@link ShapeOperation} list for a caller's plain zod schema
 * using the model. Model-led naming of the operations, then handed to
 * {@link deriveExtractionShape} for application — the closed round-trip
 * that keeps the model away from schema surgery.
 *
 * **Lifecycle.** This is async and runs BEFORE construction of downstream
 * extraction. The returned array is serialisable: cache it, persist it, diff
 * it, feed it to `deriveExtractionShape`. {@link proposeExtractionShape} is
 * the same call composed with `deriveExtractionShape` for hosts that want
 * the shape directly.
 *
 * **Repair, and what happens at exhaustion.** The applier's construction-time
 * refusals are the repair prompt's content; one repair attempt by default.
 * At exhaustion, the function returns `[]` — a valid operation set, just
 * unshaped. ADR 0016 records the argued default.
 *
 * **Cancellation and deadline.** `options.signal` and `options.deadline`
 * are forwarded into each chat call through `completeOrClassify`. A caller
 * that does not pass `options` simply gets no signal/deadline plumbing.
 */
export async function proposeShapeOperations(
  schema: z.ZodObject,
  options: ProposeOptions,
): Promise<readonly ShapeOperation[]> {
  const context = proposeContext(options.context);
  const inventoryText = renderLeafInventory(walkLeafInventory(schema));
  const systemPrompt =
    options.instructions.length === 0
      ? PROPOSE_DIRECTIVE
      : `${options.instructions}\n\n${PROPOSE_DIRECTIVE}`;
  const baseMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: inventoryText },
  ];

  const networkRetry = {
    maxRetries: options.maxNetworkRetries ?? 2,
    delay: options.networkRetryDelay,
  };
  let messages: ChatMessage[] = baseMessages;
  let result: ProposeAttemptResult;
  try {
    result = await runAttempt(
      options.chat,
      buildProposeRequest(options.model, messages, options.maxTokens),
      context,
      schema,
      options.options,
      networkRetry,
    );
  } catch (cause) {
    // Transient retries on the chat-call step exhausted. Distinct from the
    // repair loop's exhaustion: the model was never reached (or never given
    // a chance to confirm a verdict). Returning `[]` matches the argued
    // default for the newcomer — the derivation still runs, just unshaped.
    // ADR 0016's amendment scopes the "one repair chance" to model verdicts;
    // a transport blip does not consume that chance, but its exhaustion
    // still yields `[]`. The `cause` is dropped — the chat-call retry layer's
    // caller policy is "exhausted transient → `[]`", not "exhausted
    // transient → thrown", so a fresh `[]` return is the right outcome;
    // rethrowing would push the transient up to the host's error handler
    // and lose the derivation entirely.
    void cause;
    return [];
  }
  if (result.ok) return result.operations;

  const maxRepairAttempts = options.maxRepairAttempts ?? 1;
  for (let attempt = 0; attempt < maxRepairAttempts; attempt++) {
    // Show the model its previous assistant turn and the validation outcome,
    // when there is a previous output worth showing. A transport verdict
    // (refusal / truncation) often has no useful content — skip the
    // assistant turn rather than append an empty message.
    const repairTurns: ChatMessage[] =
      result.priorOutput.length === 0 ? [] : [{ role: "assistant", content: result.priorOutput }];
    repairTurns.push({
      role: "user",
      content: repairFeedback(result.failure, result.refusal),
    });
    // The transcript never carries this — the only conversation turns are
    // the system prompt, the leaf inventory (once), and the repair pair.
    messages = [...baseMessages, ...repairTurns];
    try {
      result = await runAttempt(
        options.chat,
        buildProposeRequest(options.model, messages, options.maxTokens),
        context,
        schema,
        options.options,
        networkRetry,
      );
    } catch (cause) {
      // Same handling as the initial attempt: a transport blip that
      // exhausted its retries returns `[]` without consuming further repair
      // attempts. The repair budget is allocated per turn; transient
      // exhaustion on a repair attempt is just as recoverable on the next
      // call's window as transient exhaustion on the initial attempt.
      void cause;
      return [];
    }
    if (result.ok) return result.operations;
  }

  // Honest exhaustion default: an empty operation set. The applier accepts
  // it; the derivation runs as pure normalisation. ADR 0016's decision.
  return [];
}

/**
 * Propose AND apply: a one-call convenience returning the
 * {@link DerivedExtractionShape} the host can hand straight to
 * `schemaExtractor`'s `extractionSchema` passthrough or to `buildReviewRequest`.
 *
 * Composition is explicit: this function calls {@link proposeShapeOperations},
 * then {@link deriveExtractionShape} with the proposed operations. The two
 * steps are independent and a host composing a different phase order (e.g.
 * their own applier) prefers the operations-only call.
 *
 * The schema's `provenance`, `requiredOnCreate` and `identifyingFields`
 * pass through unwrapped: the proposer has nothing to do with them and the
 * applier carries them as it does for a hand-written operation list. They
 * are optional here exactly because they are optional on `deriveExtractionShape`.
 */
export async function proposeExtractionShape(
  schema: z.ZodObject,
  options: ProposeOptions,
  deriveOptions: Omit<DeriveExtractionShapeOptions, "operations"> = {},
): Promise<DerivedExtractionShape> {
  const operations = await proposeShapeOperations(schema, options);
  return deriveExtractionShape(schema, { ...deriveOptions, operations });
}
