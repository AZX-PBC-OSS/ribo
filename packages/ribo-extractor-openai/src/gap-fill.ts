/**
 * @file The gap-fill combinator — one bounded follow-up pass over
 * "abstained-with-evidence" leaves.
 *
 * A quality audit of real transcripts found a recurring failure in the
 * single-shot and per-group extractors: the model sometimes quotes exactly the
 * right passage in `sourceSpan` yet still leaves `value: null` — it locates
 * the evidence, then does not commit. The identical quote was mapped to a
 * value in one recording's extraction and left null in another's, so this is
 * inconsistency, not appropriate caution.
 *
 * `gapFillExtractor` wraps any base {@link Extractor}. After the base
 * extraction it collects the leaves with `value === null` but a non-null
 * `sourceSpan` and makes ONE focused chat call, handing the model the
 * transcript plus each candidate's own already-found quote, scoped to exactly
 * those leaves' schemas: for each, either commit to the value the quote
 * supports or explicitly reaffirm null. Reaffirming null is a valid,
 * unpenalized answer — some abstentions are correct — so this is a second
 * low-noise look at the model's own uncertain calls, not an
 * always-fill-the-blanks pass.
 *
 * With no candidates the base result passes through untouched: no second call,
 * no wrapper object, no usage change — and no progress event, since no work
 * happens to announce. Otherwise the result is fresh, only the candidate leaves
 * move, and usage reports the base run plus one call.
 *
 * The finish-reason gate, terminal-transport classification and parse helpers
 * are the shared ones from {@link ./extraction-common.ts}. The leaf
 * walk and merge below share the codebase's one generic RUNTIME walker over
 * `Enveloped<V>` data — the walker in `enveloped()` is schema-time and serves
 * a different purpose.
 */

import { z } from "zod";

import { nextUnitId, spanGroundedness } from "@azx/ribo-core";
import type {
  AnnotatedTranscript,
  Enveloped,
  Extracted,
  ExtractionObserver,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  ExtractionUsage,
  GapFillUnit,
  NoProvenance,
} from "@azx/ribo-core";

import type { ChatClient, ChatMessage, ChatUsage } from "./chat-client.js";
import type { UsageTotals } from "./extraction-common.js";
import {
  addUsage,
  assertStopFinishReason,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "./extraction-common.js";
import type { ExtractOptions } from "@azx/ribo-core";

/**
 * Options for {@link gapFillExtractor}.
 *
 * Inherits `onUnit` from {@link ExtractionObserver}, narrowed to {@link GapFillUnit}
 * (design `extraction-observability-design.md` §0.1 — the follow-up call is a unit
 * of work and is none of the other five). Only the follow-up path emits: `start`,
 * then `done` or `error`, with `attempt` always 1 — there is no retry loop. The
 * passthrough path emits nothing, matching its "no second call" contract.
 */
export interface GapFillOptions<
  V extends Record<string, unknown>,
  P = NoProvenance,
> extends ExtractionObserver<GapFillUnit> {
  /**
   * The wrapped extractor. Its result is the base the follow-up merges into.
   *
   * Handed over ALREADY BUILT — a composite in the sense of design
   * `extraction-observability-design.md` §0.3, not of its Ask 2: there is no
   * observer threading to do here, because the base's own units flow through
   * whatever `onUnit` the caller gave the base when constructing it. `onUnit` on
   * THIS options object observes the follow-up call only.
   */
  readonly base: Extractor<Enveloped<V, P>>;
  /**
   * The field knowledge: the follow-up reads its scoped schema from
   * `extractionSchema` and builds on `instructions`. Few-shot `examples` are NOT
   * projected into the follow-up — candidates can span groups arbitrarily, so no
   * coherent projection exists, and an unprojected example would imitate a shape
   * the scoped `response_format` forbids (the mismatch the per-group extractor's
   * leaf narrowing exists to avoid).
   */
  readonly target: ExtractionTarget<V, P>;
  /** The injected chat transport for the follow-up call. A fake in tests. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /**
   * Cap on generated tokens for the follow-up call. See
   * {@link SingleShotOptions.maxTokens} for the rationale for transport
   * configuration living on the extractor.
   */
  readonly maxTokens?: number;
  /**
   * The deterministic, model-free pass run on the MERGED result after a
   * follow-up — the same role as {@link SingleShotOptions.normalize}. The base
   * extractor's own normalize already ran inside `base`; this runs once over the
   * merged whole so the follow-up's fresh leaves go through the same pass. Never
   * runs on the passthrough path. Defaults to identity.
   */
  readonly normalize?: (fields: Enveloped<V, P>) => Enveloped<V, P>;
  /**
   * Which kinds of gap to re-ask about. Defaults to `["abstained"]` — the original behaviour.
   *
   * Adding `"ungrounded"` also re-asks leaves that committed to a value while citing text absent
   * from the transcript. Both kinds travel in one follow-up call, because they share everything
   * that makes the call expensive: the instructions, the transcript, and the round trip.
   *
   * Measured on a 126-leaf Manual J: re-asking converted about half the ungrounded spans to
   * verbatim quotes. It is off by default because it is a second cost centre on a paid endpoint,
   * and because a schema whose leaves ask the model for its own judgement rather than for a fact
   * — a `confidence: "high" | "low"` field inside a provenance envelope — will report every such
   * leaf as ungrounded forever and re-ask it on every extraction. Those fields do not belong in
   * an envelope; this option will not rescue them.
   */
  readonly targets?: readonly GapFillTarget[];
}

/**
 * One "abstained-with-evidence" leaf: the base extraction found a verbatim quote
 * but committed to no value.
 */
export interface AbstainedLeaf {
  /**
   * Path from the result root: strings for object keys, numbers for array
   * indices. Structured segments, not a pre-joined string, so the merge never
   * has to parse its own addressing back apart.
   */
  readonly path: readonly (string | number)[];
  /** The quote the base extraction already found — handed back to the model in the follow-up. */
  readonly sourceSpan: string;
  /**
   * Why this leaf is being re-asked, which decides what the model is told and what the merge
   * will accept back.
   *
   *   - `"abstained"` — a null value beside a real quote. The model found its evidence and did
   *     not commit; the follow-up asks it to.
   *   - `"ungrounded"` — a committed value beside a quote that is not in the transcript. The
   *     value may well be right; the citation is unverifiable, which is the one thing this
   *     library will not ship silently.
   */
  readonly kind: GapFillTarget;
}

/** Which kind of gap a follow-up call is for. See {@link AbstainedLeaf.kind}. */
export type GapFillTarget = "abstained" | "ungrounded";

/**
 * Distinguish a leaf envelope from a nested enveloped group. The envelope's own
 * key names ARE fixed (provenance.ts's `{ value, confidence, sourceSpan }`), so
 * testing them hard-codes nothing adapter-specific; the load-bearing check is
 * `confidence` being a number — a group's members are themselves envelopes or
 * groups, never bare numbers.
 */
const isExtractedLeaf = (node: unknown): node is Extracted<unknown> => {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const record = node as Record<string, unknown>;
  return "value" in record && "sourceSpan" in record && typeof record.confidence === "number";
};

/** A path through `Enveloped<V>` data: object keys and array indices. */
type LeafPath = readonly (string | number)[];

/**
 * The one generic runtime walk over enveloped data, as a structure-preserving
 * map over leaves: `fn` sees every leaf with its path, and a subtree keeps its
 * identity when nothing under it changed. The finder uses it as a pure visitor
 * (returning every leaf unchanged rebuilds nothing); the merge relies on the
 * identity preservation so untouched leaves stay reference-equal to the base.
 */
const mapLeaves = (
  node: unknown,
  path: LeafPath,
  fn: (leaf: Extracted<unknown>, path: LeafPath) => Extracted<unknown>,
): unknown => {
  if (isExtractedLeaf(node)) return fn(node, path);
  if (Array.isArray(node)) {
    let changed = false;
    const mapped = node.map((element, index) => {
      const next = mapLeaves(element, [...path, index], fn);
      if (next !== element) changed = true;
      return next;
    });
    return changed ? mapped : node;
  }
  // Enveloped data has no primitives outside leaves, but the walker is generic;
  // pass anything else through rather than Object.entries-ing a string.
  if (node === null || typeof node !== "object") return node;
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    const next = mapLeaves(child, [...path, key], fn);
    if (next !== child) changed = true;
    mapped[key] = next;
  }
  return changed ? mapped : node;
};

/**
 * Collect every leaf with `value === null` and a non-null `sourceSpan` — the
 * leaves where the model found its evidence and still did not commit. A null
 * with a null span is a plain, honest abstention and is NOT collected: there is
 * nothing to hand back for a second look.
 */
export function findAbstainedLeaves<V extends Record<string, unknown>, P = NoProvenance>(
  fields: Enveloped<V, P>,
): readonly AbstainedLeaf[] {
  const found: AbstainedLeaf[] = [];
  mapLeaves(fields, [], (leaf, path) => {
    if (leaf.value === null && leaf.sourceSpan !== null) {
      found.push({ path, sourceSpan: leaf.sourceSpan, kind: "abstained" });
    }
    return leaf;
  });
  return found;
}

/**
 * Render a leaf path for the follow-up request: `envelope.roof`,
 * `hvac[1].systemType`. The bracket style deliberately mirrors ribo-core's
 * `FieldPath` grammar, but the bracketed segment here is an array INDEX, not a
 * roster instance key, and nothing here ever parses the string back — the
 * candidate's structured path is what drives the merge. A local formatter, not
 * `buildFieldPath`, which validates for the review grammar.
 */
/**
 * Collect every leaf that committed to a value while citing text that is NOT in the transcript —
 * `spanGroundedness` of `"ungrounded"`.
 *
 * The middle tier is deliberately excluded. A `"near-miss"` span differs only in case, whitespace
 * or entity encoding; it is the tier that exists to say "this citation is fine, just re-spaced",
 * and re-asking for those would spend a call on a non-problem.
 *
 * A null value is never collected here, however bad its span — {@link findAbstainedLeaves} owns
 * those, and a leaf belongs to exactly one follow-up.
 *
 * Measured motivation: on a 126-leaf Manual J, a one-call extraction returned 15-18 ungrounded
 * spans per run and re-asking converted about half of them to verbatim quotes. The values were
 * usually right; the citations had been reformatted or synthesised.
 */
export function findUngroundedLeaves<V extends Record<string, unknown>, P = NoProvenance>(
  fields: Enveloped<V, P>,
  transcript: string,
): readonly AbstainedLeaf[] {
  const found: AbstainedLeaf[] = [];
  mapLeaves(fields, [], (leaf, path) => {
    if (
      leaf.value !== null &&
      leaf.sourceSpan !== null &&
      spanGroundedness(leaf.sourceSpan, transcript) === "ungrounded"
    ) {
      found.push({ path, sourceSpan: leaf.sourceSpan, kind: "ungrounded" });
    }
    return leaf;
  });
  return found;
}

export function formatLeafPath(path: readonly (string | number)[]): string {
  let out = "";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : out === "" ? segment : `.${segment}`;
  }
  return out;
}

/**
 * Splice a parsed follow-up response back into the base fields: every leaf whose
 * formatted path is a key of `followUp` is replaced by that entry, everything
 * else keeps its identity. Returns a fresh structure whenever anything changed;
 * the base result is never mutated.
 */
export function mergeGapFilledLeaves<V extends Record<string, unknown>, P = NoProvenance>(
  fields: Enveloped<V, P>,
  followUp: Readonly<Record<string, Extracted<unknown>>>,
): Enveloped<V, P> {
  // The cast is safe by the walk's contract: replacing leaf envelopes with
  // same-shaped leaf envelopes preserves the Enveloped<V, P> structure, and the
  // follow-up entries were parsed against the leaves' own schemas.
  return mapLeaves(fields, [], (leaf, path) => followUp[formatLeafPath(path)] ?? leaf) as Enveloped<
    V,
    P
  >;
}

/**
 * Resolve one candidate's path through the extraction schema to that leaf's own
 * envelope schema. Resolvable by construction — the candidate paths came from
 * data that parsed against this schema — but a wrong assumption here would
 * otherwise surface as an opaque zod error far from its cause, so the guard
 * throws naming the path.
 */
const leafSchemaAtPath = (schema: z.ZodType, path: LeafPath): z.ZodType => {
  let current = schema;
  for (const segment of path) {
    const next =
      typeof segment === "number"
        ? current instanceof z.ZodArray
          ? // `ZodArray.element` is typed against zod's core API; every schema
            // here is built through the classic API — the same narrowing
            // split-schema's groupCandidate makes.
            (current.element as z.ZodType)
          : undefined
        : current instanceof z.ZodObject
          ? // `ZodRawShape` values are core `$ZodType`; cast the shape, as
            // per-group does — every schema here is built through the classic API.
            ((current as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>)[segment]
          : undefined;
    if (next === undefined) {
      throw new Error(
        `gapFillExtractor: no schema at "${formatLeafPath(path)}" — a candidate path must resolve through the extraction schema`,
      );
    }
    current = next;
  }
  return current;
};

/**
 * The gap-fill half of the follow-up's system prompt. `null`-reaffirmation is
 * stated as valid and unpenalized in the prompt itself, not just tolerated by
 * the code: some abstentions are correct, and a directive that only asked for
 * values would manufacture commitments the transcript does not support.
 */
const GAP_FILL_DIRECTIVE = `A first extraction pass over the transcript found a supporting quote for each field listed by the user, but committed to no value. For each listed field, look at its quote again in the context of the full transcript and either:
- commit to the value the quote actually supports (keeping sourceSpan a verbatim quote from the transcript), or
- reaffirm null when the quote does not in fact determine a value for the field.

Reaffirming null is a fully valid answer. Never commit to a value the transcript does not support.`;

/**
 * The directive for ungrounded candidates.
 *
 * It has to make abstaining feel like an answer rather than a failure, because measurement says
 * the model will not otherwise reach for it: across three runs of a re-ask pass, roughly half the
 * ungrounded spans became verbatim quotes and **not one** leaf was conceded as null. A model told
 * only "your quote is wrong" hunts for a better quote for a value it has already committed to.
 * The merge does not rely on this wording — it refuses any answer that does not improve — but a
 * correct null is a better outcome than a refused answer, so the prompt asks for it plainly.
 */
const UNGROUNDED_DIRECTIVE = `A first extraction pass committed to a value for each field listed by the user, citing the quote shown. Each of those quotes was checked against the transcript and is NOT present in it — the citation was reformatted, assembled from separate places, or invented. The value itself may still be correct.

For each listed field, either:
- keep the value and replace sourceSpan with text copied character-for-character out of the transcript, or
- set BOTH value and sourceSpan to null if no such text exists.

Setting null is a fully valid answer and is the right one whenever the transcript does not state the value in copyable form. Do not reformat, re-space, or stitch together a quote: if you cannot paste it out of the transcript, it is not a quote.`;

/**
 * Assemble the follow-up's messages: the target's instructions plus the gap-fill
 * directive as the system prompt, the candidate list (each field's path and its
 * own already-found quote) as a user turn, and the transcript LAST — the
 * injection boundary (everything after the instructions is the auditor's
 * transcript, never instructions) depends on that ordering.
 */
const buildGapFillMessages = <V extends Record<string, unknown>, P = NoProvenance>(
  target: ExtractionTarget<V, P>,
  transcript: string,
  candidates: readonly AbstainedLeaf[],
): ChatMessage[] => {
  const describe = (candidate: AbstainedLeaf): string =>
    `Field "${formatLeafPath(candidate.path)}" — quote found: "${candidate.sourceSpan}"`;
  const abstained = candidates.filter((c) => c.kind === "abstained");
  const ungrounded = candidates.filter((c) => c.kind === "ungrounded");

  // Both kinds share one call, so the system prompt carries only the directives actually
  // needed: a caller who never enabled `"ungrounded"` sees byte-for-byte the prompt they
  // saw before this option existed.
  const directives = [
    ...(abstained.length > 0 ? [GAP_FILL_DIRECTIVE] : []),
    ...(ungrounded.length > 0 ? [UNGROUNDED_DIRECTIVE] : []),
  ].join("\n\n");

  const sections: string[] = [];
  if (abstained.length > 0) {
    sections.push(
      `A first extraction pass left each field below without a value, despite finding the quote shown. Re-examine each one.\n\n${abstained.map(describe).join("\n")}`,
    );
  }
  if (ungrounded.length > 0) {
    sections.push(
      `Each field below has a value whose quote is NOT present in the transcript. Re-examine each one.\n\n${ungrounded.map(describe).join("\n")}`,
    );
  }

  return [
    { role: "system", content: `${target.instructions}\n\n${directives}` },
    ...sections.map((content): ChatMessage => ({ role: "user", content })),
    { role: "user", content: transcript },
  ];
};

/**
 * Drop follow-up answers that do not improve on what the base already had.
 *
 * Only `"ungrounded"` candidates are filtered, and the rule is simple: the base leaf already has
 * a value, so the follow-up has to earn its replacement by either producing a citation that
 * actually grounds or conceding null. A second unverifiable quote is not progress, and accepting
 * it would let a re-ask quietly swap one fabricated citation for another.
 *
 * This makes the pass **non-regressive**: enabling it can move a leaf from ungrounded to grounded
 * or to an honest null, and can never make a leaf worse than the base run left it. That property
 * is what allows it to run automatically. `"abstained"` candidates are untouched — their base
 * value is null, so anything the follow-up commits to is the answer being sought.
 */
const acceptImprovements = (
  followUp: Readonly<Record<string, Extracted<unknown>>>,
  candidates: readonly AbstainedLeaf[],
  transcript: string,
): Record<string, Extracted<unknown>> => {
  const accepted: Record<string, Extracted<unknown>> = {};
  for (const candidate of candidates) {
    const key = formatLeafPath(candidate.path);
    const answer = followUp[key];
    if (answer === undefined) continue;
    if (candidate.kind === "abstained") {
      accepted[key] = answer;
      continue;
    }
    const conceded = answer.value === null;
    const grounds =
      answer.sourceSpan !== null &&
      spanGroundedness(answer.sourceSpan, transcript) !== "ungrounded";
    if (conceded || grounds) accepted[key] = answer;
  }
  return accepted;
};

/**
 * The base run's usage plus one more call, with token totals summed via
 * {@link addUsage}. A total appears only when the base run or the follow-up
 * actually reported it: absent and `0` must never collapse (see `UsageTotals`).
 * `engine`/`strategy` and any other base fields survive the spread.
 */
const combinedUsage = (
  baseUsage: ExtractionUsage,
  followUpUsage: ChatUsage | undefined,
): ExtractionUsage => {
  const totals: UsageTotals = {};
  addUsage(totals, followUpUsage);
  const sum = (base: number | undefined, added: number | undefined): number | undefined =>
    added === undefined ? base : (base ?? 0) + added;
  return {
    ...baseUsage,
    calls: baseUsage.calls + 1,
    promptTokens: sum(baseUsage.promptTokens, totals.promptTokens),
    completionTokens: sum(baseUsage.completionTokens, totals.completionTokens),
    cachedPromptTokens: sum(baseUsage.cachedPromptTokens, totals.cachedPromptTokens),
    cacheCreationPromptTokens: sum(
      baseUsage.cacheCreationPromptTokens,
      totals.cacheCreationPromptTokens,
    ),
  };
};

/**
 * Wrap a base {@link Extractor} with one bounded follow-up pass over
 * abstained-with-evidence leaves — see the file header for the failure this
 * addresses.
 *
 * On each `extract`:
 *   1. Run `base.extract(transcript)`.
 *   2. Collect the abstained-with-evidence leaves ({@link findAbstainedLeaves}).
 *      With none, return the base result unchanged — same object, same usage.
 *   3. Otherwise make exactly ONE follow-up call — reported through `onUnit` as
 *      one `gapfill` unit carrying the candidate count: the transcript plus each
 *      candidate's own quote, pinned to a strict schema carrying exactly the
 *      candidate leaves keyed by path, each entry being that leaf's own
 *      envelope schema out of `target.extractionSchema` — so the response is
 *      validated against the same value constraints as the original call. The
 *      response crosses the same gates as any extraction here:
 *      {@link assertStopFinishReason}, then `parseWithSchema`.
 *   4. Merge ({@link mergeGapFilledLeaves}): only candidate leaves change, into
 *      a fresh result object; `normalize` runs once over the merged whole, and
 *      usage sums the base run plus this call.
 */
export function gapFillExtractor<V extends Record<string, unknown>, P = NoProvenance>({
  base,
  target,
  chat,
  model,
  maxTokens,
  normalize = (fields) => fields,
  onUnit,
  targets = ["abstained"],
}: GapFillOptions<V, P>): Extractor<Enveloped<V, P>> {
  const wanted = new Set<GapFillTarget>(targets);
  const context = `gapFillExtractor: model response for "${target.name}"`;
  // `-`, not `:` — the schema-name charset constraint documented in per-group.
  const name = `${target.name}-gap-fill`;

  return {
    async extract(
      transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> {
      const baseResult = await base.extract(transcript, options);
      const candidates = [
        ...(wanted.has("abstained") ? findAbstainedLeaves(baseResult.fields) : []),
        ...(wanted.has("ungrounded")
          ? findUngroundedLeaves(baseResult.fields, transcript.text)
          : []),
      ];

      // The passthrough emits NOTHING: no call is made, so there is no unit to
      // report. A phantom event here would announce work that never happened.
      if (candidates.length === 0) return baseResult;

      const id = nextUnitId();
      onUnit?.({ id, unit: "gapfill", phase: "start", attempt: 1, candidates: candidates.length });
      try {
        // Scope the follow-up to exactly the candidate leaves, keyed by formatted
        // path: each entry carries that leaf's own envelope schema out of the
        // extraction schema, so the response is validated against the same value
        // constraints (enum members, string vs number) as the original call.
        const shape: Record<string, z.ZodType> = {};
        for (const candidate of candidates) {
          shape[formatLeafPath(candidate.path)] = leafSchemaAtPath(
            target.extractionSchema,
            candidate.path,
          );
        }
        const responseSchema = z.strictObject(shape);
        const jsonSchema = z.toJSONSchema(responseSchema, { target: "draft-2020-12" }) as Record<
          string,
          unknown
        >;

        const completion = await completeOrClassify(
          chat,
          {
            model,
            messages: buildGapFillMessages(target, transcript.text, candidates),
            response_format: {
              type: "json_schema",
              json_schema: { name, schema: jsonSchema, strict: true },
            },
            maxTokens,
          },
          context,
          options,
        );

        assertStopFinishReason(completion, context);

        const raw = parseJsonContent(completion.content, context);
        // Every value was just parsed against a leaf envelope schema, so the
        // record's `unknown` values ARE envelopes; the index signature cannot see it.
        const parsed = parseWithSchema(responseSchema, raw, context) as Record<
          string,
          Extracted<unknown>
        >;

        const merged = mergeGapFilledLeaves(
          baseResult.fields,
          acceptImprovements(parsed, candidates, transcript.text),
        );

        const result: ExtractionResult<Enveloped<V, P>> = {
          fields: normalize(merged),
          // Mirrors per-group: `raw` is the assembled whole the final normalize ran
          // over, so both calls' contributions stay visible in one place.
          raw: merged,
          usage: combinedUsage(baseResult.usage, completion.usage),
          ...(baseResult.statedEmptyGroups !== undefined
            ? { statedEmptyGroups: baseResult.statedEmptyGroups }
            : {}),
        };
        // `done` fires only once the whole path has succeeded, so the unit settles
        // exactly once: `done` if and only if extract() resolves, `error` if and
        // only if it rejects — never both, never neither.
        onUnit?.({
          id,
          unit: "gapfill",
          phase: "done",
          attempt: 1,
          candidates: candidates.length,
          // The follow-up completion's own usage — the combined base-plus-follow-up
          // total belongs to the result's `usage`, not to this unit's event.
          ...(completion.usage !== undefined
            ? {
                usage: {
                  inputTokens: completion.usage.promptTokens,
                  outputTokens: completion.usage.completionTokens,
                },
              }
            : {}),
        });
        return result;
      } catch (error) {
        onUnit?.({
          id,
          unit: "gapfill",
          phase: "error",
          attempt: 1,
          candidates: candidates.length,
          error,
        });
        throw error;
      }
    },
  };
}
