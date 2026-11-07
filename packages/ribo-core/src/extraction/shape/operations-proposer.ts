/**
 * @file The model-driven derivation. The model emits a list of
 * {@link ShapeOperation} that {@link deriveExtractionShape} applies — the
 * correct-by-construction applier this wave's design promised, so the model
 * never reaches the schemas themselves with anything but data.
 *
 * **The shape of it, and where it lives.** One proposal, then resume turns
 * over a committed set: each attempt that parses is folded through the commit
 * rule (`proposal-commit.ts`), every operation that applies is committed and
 * never re-sent, and a turn with refusals or an outright failure is answered
 * with a fresh resume request — the system prompt, the field list as the
 * committed operations left it (tagged `[dropped]` / `[retyped → …]` /
 * `[moved → …]` / `[part: …]`), and the refusal block. The model replies with a delta of
 * NEW operations only, so a repair reply containing just the fixes — the
 * reply that broke the re-proposing loop, which accepted it as the whole set
 * and discarded 446 applied operations — is now the correct answer by
 * construction. ADR 0032 records the choice; ADR 0016 records the
 * one-shot-plus-repair it amends.
 *
 * **Two distinct retry layers, one budget.** The chat-call step wraps
 * `completeOrClassify` in `retryAsync` so a 429 / 5xx / dropped connection
 * is retried silently with backoff, with its own budget (`maxNetworkRetries`,
 * default 2). The repair loop is separate (ADR 0016's "one repair attempt")
 * and counts only model verdicts — refusal, unsupported, `length`, content
 * filter — folded to `failure: "transport"`. A transport blip does not
 * consume a repair attempt: the chat-call wrapper retries it first, and on
 * exhaustion the proposal returns the committed set directly — `[]` only
 * when nothing has committed yet. The amendment is a
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
 * `assertShapeMapping` invariants. What the proposer returns IS a committed
 * set the commit rule validated as a whole, so the returned list derives with
 * zero refusals on every path — clean acceptance, exhaustion, transport
 * exhaustion. ADR 0024's surviving-subset amendment of ADR 0016 is subsumed
 * by the committed set: exhaustion returns it rather than the final
 * proposal's survivors.
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
} from "../../phases/chat-parse.js";
import { parseWithSchema } from "../parse-with-schema.js";
import { retryAsync } from "../../async/retry-async.js";
import { SchemaParseError } from "../schema-parse-error.js";
import { TerminalError } from "../../storage/backoff.js";
import type {
  ChatClient,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
} from "../../phases/chat-client.js";
import type { ExtractOptions } from "../extractor.js";

import type { DerivedExtractionShape } from "./derived-shape.js";
import { deriveExtractionShape } from "./shape-operations.js";
import type { DeriveExtractionShapeOptions } from "./shape-operations.js";
import type { ShapeOperation } from "./shape-operation.js";
import type { ShapeRefusalCause } from "./shape-refusal.js";
import { appliedTags, renderLeafInventory, walkLeafInventory } from "./leaf-inventory.js";
import type { InventoryDeclarations } from "./leaf-inventory.js";
import { commitAttempt } from "./proposal-commit.js";
import type { CommitRefusal } from "./proposal-commit.js";

/**
 * Options for {@link proposeShapeOperations}.
 *
 * `chat`, `model`, `context` and `instructions` own the call the way
 * `singleShotExtractor`'s options do. The proposer runs once per schema; the
 * caller passes a `ChatClient` and a model, and the same instance would
 * naturally serve the eventual extractor. `context` labels this call in error
 * messages, NOT the wire-schema name (the proposer pins its own wire name so
 * renaming the target does not invalidate the response schema).
 * @category Extraction
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
   * Number of resume attempts after the first proposal leaves something
   * uncommitted. A resume is one full chat round-trip, which is one real,
   * paid model call; the budget is what gates "we stop trying and accept
   * whatever we got."
   *
   * At exhaustion the proposal returns the committed set — every operation
   * that applied, in commit order — `[]` when nothing committed, a valid
   * operation set either way. See ADR 0016 for the argued default, ADR 0024
   * for the surviving-subset amendment the committed set subsumes, and ADR
   * 0032 for the resume itself; a caller who would rather see an
   * exception can wrap and check the operations array.
   *
   * **Default 3, raised from 1 on measured evidence.** ADR 0016 argued one
   * repair against an eleven-leaf fixture. A live run against a 294-property
   * vendor schema drew 91 operations, of which exactly ONE was invalid (a
   * `retype` naming a leaf the same proposal dropped) — and because the
   * applier was all-or-nothing, that one op cost all 91, including fourteen
   * good nests. The repair turn did not find it, so the run exhausted to `[]`
   * and produced nothing. The resume loop is the deeper fix: the 90 that
   * applied commit on the spot, and the resume turn asks only for what is
   * still missing.
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
 *
 * A partition's `parts` is pairs for the same reason — `{ label, fields }` —
 * converted by {@link partsToRecord}; a repeated label cannot survive that
 * record, so {@link runAttempt} refuses it there instead of collapsing it.
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
      z.object({
        op: z.literal("partition"),
        group: z.string(),
        parts: z.array(z.object({ label: z.string(), fields: z.array(z.string()).min(1) })).min(1),
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

/**
 * Convert the wire-format array of `{label, fields}` pairs into the record the
 * applier accepts — partition's counterpart of {@link movesToRecord}. A
 * repeated label cannot survive the record, and collapsing one would silently
 * move the first part's fields into the remainder, so the conversion caller
 * never hands a duplicate-label partition to the applier at all — see
 * {@link runAttempt}, which reports it as a not-committed operation instead.
 */
const partsToRecord = (
  pairs: ReadonlyArray<{ readonly label: string; readonly fields: readonly string[] }>,
): Readonly<Record<string, readonly string[]>> => {
  const out: Record<string, readonly string[]> = {};
  for (const pair of pairs) {
    out[pair.label] = pair.fields;
  }
  return out;
};

/** The first label a wire partition's parts name twice, if any. */
const firstDuplicateLabel = (
  pairs: ReadonlyArray<{ readonly label: string; readonly fields: readonly string[] }>,
): string | undefined => {
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (seen.has(pair.label)) return pair.label;
    seen.add(pair.label);
  }
  return undefined;
};

/**
 * A refusal the wire-to-operation conversion raises itself — a partition
 * whose wire parts repeat a label. The record form cannot carry the
 * duplicate, so handing the operation to the applier would show it a
 * different partition than the model sent; the refusal keeps it out of the
 * applier's hands and reaches the model through the same feedback block as
 * the commit rule's refusals.
 */
interface WireRefusal {
  /** The operation's position in the model's original operations array. */
  readonly at: number;
  /** The not-committed operation, in record form for display; never applied. */
  readonly operation: ShapeOperation;
  readonly reason: string;
}

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
 *     exhaustively in `packages/ribo-core/src/extraction/shape/shape-operation.ts`
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
- nest { group, moves: { from: to } }: CREATE a new top-level group and move top-level fields into it — this is how you give a flat schema structure. Every source is a top-level field (never an existing group, never a collection, never a nested path); destinations are paths below the new group. The group name may be one of the top-level fields you are moving — naming a group after the field that anchors it (group "pool" holding "pool", "poolSize", "poolPumpType") is fine and encouraged. It may NOT be the name of a top-level key you leave in place, or of one you dropped.
- partition { group, parts: [{ label, fields }] }: split ONE top-level group's direct fields into named parts — each part is extracted in its own call, and no call mixes two parts. Use it where a group's fields fall into distinct topics (heating vs cooling, thermostat vs foundation); keep labels short and descriptive; a field appears in at most one part; fields no part names form a remainder part, which is extracted too.

The operations are a SET, not a sequence. Composition rules the applier enforces and will refuse with the offending path named:
- a duplicate drop / retype on the same path / regroup or nest on the same group is refused, not silently overwritten, and a top-level field may be moved by at most one nest;
- retype and a move (regroup or nest) compose on the same leaf (retype the kind, move the position — orthogonal);
- one regroup's or nest's move destinations are pairwise distinct, no two destinations prefix one another, and no regroup destination lies under a dropped path;
- a retype names a patch LEAF whose declared kind is "string";
- a move's source and destination are inside the group's element for a collection group, never passing through or landing on the array;
- at most one partition per group;
- a partitioned group cannot also be regrouped;
- a drop that empties the parent object is refused — drop the parent instead;
- a drop that removes what a declaration names is refused: never drop a field tagged [required on create] or [identifying], a group tagged [provenance: ...], or a group containing a tagged field.

On a later turn the field list may reappear with some fields tagged [dropped], [retyped → number], [moved → …] or [part: …]: those operations are already applied and locked. Reply then with new operations only — the fixes for what was refused plus anything else you intend — and never repeat a tagged one; an empty \`operations\` array means you are done.

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
      // matches the same move `single-shot.ts` (in `@azx/ribo-core`) and
      // `schema-retry.ts` make.
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
 * One propose call's outcome: either the operations the model emitted, or an
 * outright failure the next resume turn uses as feedback. The attempt ends
 * at the parse: folding the operations into the committed set is the loop's
 * job, through `commitAttempt`, so this function never sees the schema.
 *
 * Reuses the chat transport's `completeOrClassify` / `assertStopFinishReason`
 * terminal classification (refusal / unsupported / `"length"` /
 * `"content_filter"`) to short-circuit a misbehaving model: re-prompting into
 * a refusal would just produce another refusal, and re-prompting into a
 * truncation would truncate at the same point. The argued default is "never
 * throw on a model's output", and these reclassifications are folded into the
 * same exhaustion path rather than letting them escape.
 */
type RunAttemptResult =
  | {
      readonly ok: true;
      readonly operations: readonly ShapeOperation[];
      /** Partitions the conversion itself refused — never in `operations`. */
      readonly wireRefusals: readonly WireRefusal[];
    }
  | {
      readonly ok: false;
      readonly failure: "transport" | "json" | "schema";
      readonly refusal: string;
    };

/**
 * Run one propose call against the chat transport. Three failure kinds, each
 * carrying a refusal string for the next resume turn (or, at exhaustion, the
 * one word "transport" failure path that consumes the budget without
 * reattempting because the transport verdict is final):
 *
 *   - **Transient transport rejection** (5xx, 429, dropped connection) —
 *     retried by `retryAsync` over the chat-call layer. On exhaustion the
 *     error is rethrown so `proposeShapeOperations` returns the committed set
 *     **without** burning a resume attempt — a transport blip does not
 *     consume the repair budget, by the same reasoning `retryExtractor` and
 *     `validateExtractor` apply (ADR 0016, with the amendment that scopes the
 *     repair chance to model verdicts).
 *   - **Transport verdict** (refusal, unsupported, `length`, content filter)
 *     — `completeOrClassify` translates refusal / unsupported into
 *     `TerminalError`; `assertStopFinishReason` (below) does the same for
 *     `length` / content filter. Both are model verdicts: re-prompting on the
 *     same input reproduces them. Folded into "failure: transport" so the
 *     resume loop gets one shot, then returns the committed set.
 *   - **JSON parse** (plain `Error` from `parseJsonContent`) — REPAIRABLE.
 *   - **Schema parse** (`SchemaParseError` from `parseWithSchema`) —
 *     REPAIRABLE.
 *
 * The shape apply left this function with the resume change: a parsed
 * attempt is folded into the committed set by `commitAttempt`, whose refusals
 * are the resume turn's feedback.
 */
const runAttempt = async (
  chat: ChatClient,
  request: ChatRequest,
  context: string,
  options: ExtractOptions | undefined,
  networkRetry: { maxRetries: number; delay?: (ms: number) => Promise<void> },
): Promise<RunAttemptResult> => {
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
    //      this input; the resume loop spends one attempt confirming the
    //      verdict persists.
    //   2. Anything else — a transient (5xx, 429, dropped connection,
    //      malformed-response) that exhausted `retryAsync`'s retries. The
    //      chat-call step has its own retry budget, distinct from the
    //      repair loop, so rethrow and let `proposeShapeOperations` return
    //      the committed set directly. A resume attempt on a transient blip,
    //      with no change to the input, would only burn another paid model
    //      call to the same verdict.
    if (cause instanceof TerminalError) {
      return {
        ok: false,
        failure: "transport",
        refusal: cause.message,
      };
    }
    throw cause;
  }

  // `assertStopFinishReason` reclassifies a non-`"stop"` finish reason
  // (`"length"`, `"content_filter"`) as terminal — re-sending the same
  // request truncates at the same point; a content filter fires on the
  // same content. The resume loop will give it one chance, then fall
  // through to the committed-set exhaustion default.
  try {
    assertStopFinishReason(completion, context);
  } catch (cause) {
    return {
      ok: false,
      failure: "transport",
      refusal: cause instanceof Error ? cause.message : String(cause),
    };
  }

  let raw: unknown;
  try {
    raw = parseJsonContent(completion.content, context);
  } catch (cause) {
    return {
      ok: false,
      failure: "json",
      refusal: cause instanceof Error ? cause.message : String(cause),
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
    };
  }

  // The wire-format records (arrays of pairs, see `proposedOperationsSchema`'s
  // header) are converted back before the commit rule sees them. A partition
  // whose parts repeat a label has no record form that means what the model
  // sent, so it is refused here — reported alongside the commit rule's
  // refusals, never handed to the applier.
  const operations: ShapeOperation[] = [];
  const wireRefusals: WireRefusal[] = [];
  parsed.operations.forEach((op, index) => {
    if (op.op === "regroup") {
      operations.push({ op: "regroup", group: op.group, moves: movesToRecord(op.moves) });
      return;
    }
    if (op.op === "nest") {
      operations.push({ op: "nest", group: op.group, moves: movesToRecord(op.moves) });
      return;
    }
    if (op.op === "partition") {
      const duplicate = firstDuplicateLabel(op.parts);
      if (duplicate === undefined) {
        operations.push({ op: "partition", group: op.group, parts: partsToRecord(op.parts) });
      } else {
        // The record below is display-only — the duplicate cannot survive it,
        // so this operation must never reach the applier.
        wireRefusals.push({
          at: index,
          operation: { op: "partition", group: op.group, parts: partsToRecord(op.parts) },
          reason:
            `labels must be unique within a group — part "${duplicate}" is named more ` +
            "than once.",
        });
      }
      return;
    }
    operations.push(op);
  });
  return { ok: true, operations, wireRefusals };
};

/**
 * The culprit clause a repair turn needs, appended to the refusal's own text.
 *
 * The reason alone can point the model at the wrong operation. A drop refused
 * because a `provenance` entry names its path is reported with the applier's
 * message — "provenance names group X, which is not a top-level property of the
 * shaped schema … the group may have been dropped" — which is the text the
 * THROWING surface has always produced and which existing tests pin byte for
 * byte. But under partial application that drop is *refused*, not applied, so
 * "may have been dropped" describes a world the applier did not choose. A model
 * reading prose alone would retract the declaration when the applier is telling
 * it the pair is in conflict.
 *
 * `cause` carries the truth structurally, so it is rendered rather than the
 * message reworded: the pinned text is preserved for the throwing surface and
 * the repair turn stops having to infer the culprit from prose. This is the
 * same defect the consequential class exists to fix, one layer out.
 */
const formatCause = (cause: ShapeRefusalCause): string => {
  if (cause.kind === "operation") {
    // The index is the culprit's position in the delta the model just sent —
    // `commitAttempt` translated it out of the combined array — so the model
    // can find the culprit in its own reply. A culprit is never committed, so
    // it is not "applied": both sides are back with the model.
    return ` (caused by your ${formatOperation(cause.operation)} at index ${String(cause.index)} in this reply, which was not applied either — fix or drop one of the two)`;
  }
  const where = cause.leaf === undefined ? `"${cause.group}"` : `"${cause.group}.${cause.leaf}"`;
  return ` (caused by the ${cause.declaration} declaration on ${where}, which this operation would strand — revise or drop the operation; declarations are the caller's and stay as they are)`;
};

/** The one-line label a resume turn prefixes a refusal with — the operation it names. */
const formatOperation = (operation: ShapeOperation): string =>
  operation.op === "drop" || operation.op === "retype"
    ? `${operation.op} "${operation.path}"`
    : `${operation.op} "${operation.group}"`;

/**
 * One feedback line per not-committed operation. A conflict with a committed
 * operation is reported against the locked one — the model must never be
 * told to retract an applied operation; anything else carries the cause
 * clause as before.
 */
const formatCommitRefusal = (refusal: CommitRefusal): string => {
  const line = `- ${formatOperation(refusal.operation)}: ${refusal.reason}`;
  if (refusal.conflictsWithCommitted !== undefined) {
    return (
      `${line} (conflicts with the already-applied ` +
      `${formatOperation(refusal.conflictsWithCommitted)}, which is locked; revise or drop this one)`
    );
  }
  return refusal.cause === undefined ? line : `${line}${formatCause(refusal.cause)}`;
};

/**
 * The refusal block of a resume request: every operation the commit rule
 * could not commit, one line each, closing with the delta instruction — the
 * model answers with NEW operations only, and an empty list means done.
 */
const refusalFeedback = (refused: readonly CommitRefusal[]): string =>
  "Part of your previous reply would not produce a valid extraction shape — what applied is " +
  "committed and locked, and shows as tags in the field list above. The operations that did " +
  "not apply:\n" +
  refused.map(formatCommitRefusal).join("\n") +
  "\nPropose only NEW operations — the fixes for these plus anything else you intend; operations " +
  "shown as tagged in the field list are already applied and locked, so do not repeat them. " +
  "An empty list means you are done.";

/**
 * Merge the conversion's own refusals with the commit rule's, in incoming
 * order. The commit rule reports against the handed list — the model's
 * operations minus the wire-refused ones — so each handed operation's
 * original position is its index plus the wire refusals before it.
 */
const withWireRefusals = (
  commitRefusals: readonly CommitRefusal[],
  wireRefusals: readonly WireRefusal[],
  handed: readonly ShapeOperation[],
): readonly CommitRefusal[] => {
  if (wireRefusals.length === 0) return commitRefusals;
  const refusedAt = new Set(wireRefusals.map((refusal) => refusal.at));
  const originalAt: number[] = [];
  let original = 0;
  for (let kept = 0; kept < handed.length; kept++) {
    while (refusedAt.has(original)) original++;
    originalAt.push(original);
    original++;
  }
  // A culprit's index is rendered as its position in the model's reply, so it
  // shifts too.
  const inReply = (refusal: CommitRefusal): CommitRefusal =>
    refusal.cause?.kind === "operation"
      ? { ...refusal, cause: { ...refusal.cause, index: originalAt[refusal.cause.index]! } }
      : refusal;
  const positioned = [
    ...commitRefusals.map((refusal) => ({
      at: originalAt[handed.indexOf(refusal.operation)]!,
      refusal: inReply(refusal),
    })),
    ...wireRefusals.map((refusal) => ({
      at: refusal.at,
      refusal: { operation: refusal.operation, reason: refusal.reason },
    })),
  ];
  return positioned.sort((a, b) => a.at - b.at).map((entry) => entry.refusal);
};

const repairFeedback = (
  failure: "transport" | "json" | "schema" | "shape",
  refusal: string,
): string => {
  if (failure === "transport") {
    // The transport verdict is final for this input; the resume asks the
    // model to confirm or produce a valid alternative before the budget
    // gives up. A second refusal of the same kind drives the exhaustion
    // fallback.
    return (
      `Your previous response was rejected by the transport: ${refusal}. ` +
      "Re-attempt in the same JSON shape; the model's answer is the one a downstream " +
      "extraction call can consume. The `operations` array holds NEW operations only — the " +
      "field list shows what is already applied and locked."
    );
  }
  if (failure === "json") {
    return (
      `Your previous response was not valid JSON: ${refusal}. Return a single JSON ` +
      "object matching the response schema; no prose outside the object. The `operations` " +
      "array holds NEW operations only — the field list shows what is already applied and locked."
    );
  }
  if (failure === "schema") {
    return (
      `Your previous response did not match the response schema: ${refusal}. Return ` +
      "a JSON object with one `operations` array of valid operation objects whose discriminators " +
      'are "drop", "retype", "regroup", "nest", or "partition". No prose outside the object; the array ' +
      "holds NEW operations only — the field list shows what is already applied and locked."
    );
  }
  // `failure === "shape"` — a throw out of the commit rule: the hard
  // boundary (a schema defect), folded into repairable feedback exactly as
  // the throwing surface's throw was folded before.
  return (
    `Your previous proposal would not produce a valid extraction shape: ${refusal}. ` +
    "Revise the operations so they satisfy the composition rule described in the system " +
    "prompt. Return a JSON object whose `operations` array contains NEW operations only — " +
    "the field list shows what is already applied and locked."
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
 * **Resume, and what happens at exhaustion.** Each parsed attempt is folded
 * into the committed set through `commitAttempt`; a turn that leaves anything
 * uncommitted is answered with a fresh resume request — the field list as
 * the committed operations left it, then one line per refusal — and the
 * model replies with a delta of NEW operations only. The default budget is
 * `maxRepairAttempts: 3`. At exhaustion, the function returns the committed
 * set — `[]` when nothing committed. ADR 0016 records the original `[]`
 * decision, ADR 0024 the surviving-subset amendment, and ADR 0032 the
 * committed set that subsumes both.
 *
 * **Declarations.** Pass the `provenance`, `requiredOnCreate` and
 * `identifyingFields` the result will be derived with. Each attempt is
 * validated against them, so a drop that would strand one is refused here
 * rather than thrown by the later derive, and the inventory tags what they
 * name so the model can avoid it.
 *
 * **Cancellation and deadline.** `options.signal` and `options.deadline`
 * are forwarded into each chat call through `completeOrClassify`. A caller
 * that does not pass `options` simply gets no signal/deadline plumbing.
 */
export async function proposeShapeOperations(
  schema: z.ZodObject,
  options: ProposeOptions,
  declarations: InventoryDeclarations = {},
): Promise<readonly ShapeOperation[]> {
  const context = proposeContext(options.context);
  const systemPrompt =
    options.instructions.length === 0
      ? PROPOSE_DIRECTIVE
      : `${options.instructions}\n\n${PROPOSE_DIRECTIVE}`;
  const networkRetry = {
    maxRetries: options.maxNetworkRetries ?? 2,
    delay: options.networkRetryDelay,
  };

  // The committed set: operations that applied, in the order they committed.
  // Committed operations are never re-sent and never re-validated away; a
  // resume turn shows them as field-list tags and asks only for what is
  // still missing.
  let committed: readonly ShapeOperation[] = [];
  const entries = walkLeafInventory(schema);

  // `feedback` undefined marks the FIRST request — the plain field list.
  // A resume request is fresh: the same system prompt, the field list
  // re-rendered with the committed set's applied tags, then the feedback.
  // No assistant turn: the model's previous answer is never echoed back.
  let feedback: string | undefined;
  let repairsLeft = options.maxRepairAttempts ?? 3;
  for (;;) {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        // Nothing committed means nothing to tag — and deriving an empty set
        // would rethrow a schema defect the fold already turned into feedback.
        content:
          feedback === undefined || committed.length === 0
            ? renderLeafInventory(entries, declarations)
            : renderLeafInventory(
                entries,
                declarations,
                appliedTags(
                  schema,
                  deriveExtractionShape(schema, { ...declarations, operations: committed }),
                ),
              ),
      },
    ];
    if (feedback !== undefined) messages.push({ role: "user", content: feedback });

    let result: RunAttemptResult;
    try {
      result = await runAttempt(
        options.chat,
        buildProposeRequest(options.model, messages, options.maxTokens),
        context,
        options.options,
        networkRetry,
      );
    } catch (cause) {
      // Transient retries on the chat-call step exhausted. Distinct from the
      // resume loop's exhaustion: the model was never reached this turn, so
      // nothing new can be committed — return the committed set (`[]` only
      // when nothing has committed yet). The `cause` is dropped: the
      // chat-call retry layer's caller policy is "exhausted transient →
      // return what we have", not "exhausted transient → thrown";
      // rethrowing would push the transient up to the host's error handler
      // and lose work already committed.
      void cause;
      return committed;
    }

    let nextFeedback: string;
    if (!result.ok) {
      // An outright failure commits nothing new; the next turn carries the
      // error, and nothing committed is lost.
      nextFeedback = repairFeedback(result.failure, result.refusal);
    } else {
      let fold: ReturnType<typeof commitAttempt>;
      try {
        fold = commitAttempt(schema, declarations, committed, result.operations);
      } catch (cause) {
        // A throw out of the commit rule is the hard boundary — the
        // committed set alone failing means a schema defect — folded into
        // repairable "shape" feedback exactly as the throwing surface's
        // throw was folded before. The proposer never throws on a model's
        // output; that is the standing contract.
        nextFeedback = repairFeedback(
          "shape",
          cause instanceof Error ? cause.message : String(cause),
        );
        if (repairsLeft === 0) return committed;
        repairsLeft--;
        feedback = nextFeedback;
        continue;
      }
      committed = fold.committed;
      const refused = withWireRefusals(fold.refused, result.wireRefusals, result.operations);
      if (refused.length === 0) return committed;
      nextFeedback = refusalFeedback(refused);
    }
    if (repairsLeft === 0) return committed;
    repairsLeft--;
    feedback = nextFeedback;
  }
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
 * The schema's `provenance`, `requiredOnCreate` and `identifyingFields` reach
 * both steps: the proposer validates each attempt against them, and the
 * applier carries them as it does for a hand-written operation list. They
 * are optional here exactly because they are optional on `deriveExtractionShape`.
 */
export async function proposeExtractionShape(
  schema: z.ZodObject,
  options: ProposeOptions,
  deriveOptions: Omit<DeriveExtractionShapeOptions, "operations"> = {},
): Promise<DerivedExtractionShape> {
  const operations = await proposeShapeOperations(schema, options, deriveOptions);
  return deriveExtractionShape(schema, { ...deriveOptions, operations });
}
