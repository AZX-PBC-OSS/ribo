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
 * With no candidates the base result passes through: no second call, no usage
 * change — the follow-up phase's `plan` finds nothing and the engine skips it.
 * (Its base phase still reports its one unit to `onUnit` — see
 * {@link GapFillOptions.onUnit}.) Otherwise the result is fresh, only the
 * candidate leaves move, and usage reports the base run plus one call.
 *
 * The finish-reason gate, terminal-transport classification and parse helpers
 * are the shared ones from `extraction-common.ts`, used by the follow-up phase
 * in `gap-fill-phase.ts`. The leaf walk and merge below share the codebase's
 * one generic RUNTIME walker over `Enveloped<V>` data — the walker in
 * `enveloped()` is schema-time and serves a different purpose.
 */

import { z } from "zod";

import { extractorPhase, phasedExtractor, spanGroundedness } from "@azx/ribo-core";
import type {
  Enveloped,
  Extracted,
  ExtractionObserver,
  Extractor,
  ExtractionTarget,
  NoProvenance,
  PhaseUnit,
} from "@azx/ribo-core";

import type { ChatClient, ChatMessage } from "./chat-client.js";
import { gapFillPhase } from "./gap-fill-phase.js";

/**
 * Options for {@link gapFillExtractor}.
 *
 * Inherits `onUnit` from {@link ExtractionObserver}, widened to {@link PhaseUnit}:
 * the extractor is a `phasedExtractor` preset, so the engine owns the unit stream
 * and every event is a phase event — one for the base phase's single item and, on
 * the follow-up path, one for the follow-up call (`phaseId` distinguishes them;
 * `attempt` is always 1, there is no retry loop on either phase). The passthrough
 * path — no candidates — emits the base phase's `start`/`done` pair and nothing
 * else. This is a widening from the pre-port `GapFillUnit` events: a handler
 * written against the old type will now receive events its type did not name.
 */
export interface GapFillOptions<
  V extends Record<string, unknown>,
  P = NoProvenance,
> extends ExtractionObserver<PhaseUnit> {
  /**
   * The wrapped extractor. Its result is the base the follow-up merges into.
   *
   * Handed over ALREADY BUILT — a composite in the sense of design
   * `extraction-observability-design.md` §0.3, not of its Ask 2: the base's own
   * units flow through whatever `onUnit` the caller gave the base when
   * constructing it, and `onUnit` on THIS options object observes the engine's
   * phase events, which cover the base phase's single item as well as the
   * follow-up call.
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
 *
 * Exported for the follow-up phase (`gap-fill-phase.ts`), which builds the same
 * scoped response schema; not part of the package barrel.
 */
export const leafSchemaAtPath = (schema: z.ZodType, path: LeafPath): z.ZodType => {
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
 *
 * Exported for the follow-up phase (`gap-fill-phase.ts`), which sends exactly
 * these messages; not part of the package barrel.
 */
export const buildGapFillMessages = <V extends Record<string, unknown>, P = NoProvenance>(
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
 *
 * Exported for the follow-up phase (`gap-fill-phase.ts`), whose merge applies it;
 * not part of the package barrel.
 */
export const acceptImprovements = (
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
 * Wrap a base {@link Extractor} with one bounded follow-up pass over
 * abstained-with-evidence leaves — see the file header for the failure this
 * addresses.
 *
 * The body is a `phasedExtractor` preset of two phases — this is the port that
 * proved {@link extractorPhase}, the lift that makes any `Extractor` a phase
 * (design `phased-extraction-design.md` §4.7):
 *
 *   1. **The base phase** ({@link extractorPhase}) runs `base.extract` —
 *      pinned to `maxRetries: 0`, because today's wrapper calls the base
 *      exactly once and the engine's default of 2 would retry a transiently
 *      failing base with real backoff, stacking on whatever retry policy the
 *      base already has and emitting per-attempt error events.
 *   2. **The follow-up phase** ({@link gapFillPhase}) collects the candidates
 *      from the base's fields ({@link findAbstainedLeaves}, and
 *      {@link findUngroundedLeaves} when `targets` enables it), makes the ONE
 *      follow-up call scoped to exactly those leaves' schemas, and merges the
 *      improvements back — applying `normalize` there, so it runs once on the
 *      follow-up path and never on the passthrough path (the engine skips a
 *      phase whose `plan` found no work, which is where today's "no second
 *      call, no usage change" passthrough lives).
 *
 * The pure helpers below — the candidate finders, the leaf-path formatter, the
 * merge, the message assembly with its two directives, and the improvement
 * filter — are what the phase is built from; they are kept here, unchanged,
 * because their doc comments are the reasoning this strategy exists to keep.
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
  return phasedExtractor({
    target,
    // Neither phase retries: the base is called exactly once, and the follow-up
    // phase pins its own zero (see gap-fill-phase.ts). This run-level zero is
    // what pins the BASE phase — `extractorPhase` declares no `maxRetries` of
    // its own, so without it the base would inherit the engine's default of 2.
    maxRetries: 0,
    phases: [
      extractorPhase("base", base),
      gapFillPhase({ target, chat, model, maxTokens, targets, normalize }),
    ],
    onUnit,
  });
}
