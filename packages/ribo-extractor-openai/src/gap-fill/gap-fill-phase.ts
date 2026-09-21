/**
 * @file The gap-fill follow-up phase — one focused call over the leaves the base
 * extraction abstained on (or cited badly), as a `Phase` the phased engine runs
 * after a base phase.
 *
 * This is the phase half of the `gapFillExtractor` port (design
 * `phased-extraction-design.md` §4.7): the candidate collection is `plan`, the
 * one chat call is `run`, and the splice-back is `merge` — each delegating to the
 * pure helpers in `gap-fill.ts`, which own the reasoning about candidates,
 * directives and non-regressive merging. The preset that wires this phase after
 * an {@link extractorPhase} base is `gapFillExtractor` in that file.
 *
 * Three shapes worth naming:
 *
 * - **`plan` yields at most ONE item** carrying the whole candidate list — both
 *   candidate kinds travel in a single follow-up call, because they share
 *   everything that makes the call expensive (see `GapFillOptions.targets`). The
 *   no-candidates case returns `[]`, which the engine treats as a no-op for the
 *   phase — no call, no event, no usage change — which is the whole passthrough
 *   behaviour.
 * - **`normalize` runs in `merge`, not as the engine's option.** The engine
 *   normalizes unconditionally before the closing parse, but skips `merge`
 *   entirely on an empty plan — so applying it here runs it once on the
 *   follow-up path and never on the passthrough path, which is exactly the
 *   documented semantics of `GapFillOptions.normalize`.
 * - **`merge` writes `raw` as well as `fields`**: `raw` is the merged fields
 *   BEFORE `normalize` runs — the base's answers with the follow-up's accepted
 *   ones spliced in — so both calls' contributions stay visible in one place.
 *   The engine's result `raw` comes from the draft, which only a phase's merge
 *   writes; if this merge did not set it, a follow-up run would either lose
 *   `raw` entirely or report the base phase's raw model output instead.
 */

import { z } from "zod";

import { phaseBuilder } from "@azx/ribo-core";
import type {
  ChatClient,
  Enveloped,
  Extracted,
  ExtractionTarget,
  NoProvenance,
  Phase,
  PhaseDef,
} from "@azx/ribo-core";

import type { UsageTotals } from "../prompt/extraction-common.js";
import {
  addUsage,
  assertStopFinishReason,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "../prompt/extraction-common.js";
import type { AbstainedLeaf, GapFillTarget } from "./gap-fill.js";
import {
  acceptImprovements,
  buildGapFillMessages,
  findAbstainedLeaves,
  findUngroundedLeaves,
  formatLeafPath,
  leafSchemaAtPath,
  mergeGapFilledLeaves,
} from "./gap-fill.js";

/** Options for {@link gapFillPhase} — the gap-fill preset's follow-up half. */
export interface GapFillPhaseOptions<V extends Record<string, unknown>, P = NoProvenance> {
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
   * `SingleShotOptions.maxTokens` for the rationale for transport configuration
   * living on the extractor.
   */
  readonly maxTokens?: number;
  /**
   * Which kinds of gap to re-ask about. Defaults to `["abstained"]` — the original
   * behaviour. See `GapFillOptions.targets` for the measurement behind the default
   * and the cost of enabling `"ungrounded"`.
   */
  readonly targets?: readonly GapFillTarget[];
  /**
   * The deterministic, model-free pass run on the MERGED result after a
   * follow-up — the same role as `GapFillOptions.normalize`. Applied by this
   * phase's `merge`, never as the engine's option, so it runs once on the
   * follow-up path and never on the passthrough path. Defaults to identity.
   */
  readonly normalize?: (fields: Enveloped<V, P>) => Enveloped<V, P>;
  /**
   * Overrides the phase's id — `"gapfill"` by default. See `PhaseMeta.id` in
   * `@azx/ribo-core` for what an id reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
  /**
   * Ids of the phases this one must follow. The phase declares none of its
   * own — it is an optional refiner over whatever draft it is given, and its
   * `plan` returns `[]` when it finds no candidates, so even `[gapfill]` alone
   * is a valid list (ADR 0008) — meaning the list is exactly what you pass.
   */
  readonly requires?: readonly string[];
}

/**
 * The one work item the follow-up phase's `plan` emits: the whole candidate list
 * for the single follow-up call, plus the transcript text the merge will need.
 *
 * The transcript rides on the item because `merge` — which applies
 * {@link acceptImprovements}, scoring the follow-up's citations against the
 * transcript — has no phase context to read it from, and the draft must not
 * carry it (the transcript lives on the context precisely so no phase can mutate
 * it). It is the same string `ctx.transcript.text` handed the run.
 */
interface GapFillItem {
  readonly candidates: readonly AbstainedLeaf[];
  readonly transcript: string;
}

/**
 * The follow-up phase: collect the leaves the base left abstained-with-evidence
 * (and, when enabled, ungrounded), make ONE focused chat call about them, and
 * splice the improvements back into the draft.
 *
 * Pins `maxRetries: 0` — today's follow-up has no retry loop, and the engine's
 * default of 2 would silently add one. `describeItem` returns `{ key: "" }` —
 * one call over the whole document, which is the `""` convention's meaning
 * (`groupedExtractor`'s GroupMap). No observer: the engine owns the unit stream.
 */
export function gapFillPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: GapFillPhaseOptions<V, P>,
): Phase<V, P> {
  const {
    target,
    chat,
    model,
    maxTokens,
    normalize = (fields) => fields,
    targets = ["abstained"],
    id: phaseId = "gapfill",
  } = options;
  const wanted = new Set<GapFillTarget>(targets);
  const context = `gapFillExtractor: model response for "${target.name}"`;
  // `-`, not `:` — the schema-name charset constraint documented in per-group.
  const name = `${target.name}-gap-fill`;

  const def: PhaseDef<V, P, GapFillItem, Record<string, Extracted<unknown>>> = {
    id: phaseId,
    maxRetries: 0,
    // Deliberately no `requires` of its own, and no default: gap-fill is an
    // optional refiner whose plan returns `[]` when it finds no candidates, so
    // `[gapfill]` alone is a valid list — the engine treats an empty plan as a
    // no-op (ADR 0008). The caller's ids are the whole `requires` (see the
    // option).
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    describeItem: () => ({ key: "" }),
    plan: (draft, ctx) => {
      // THE CAST, and why it is sound: the pure helpers take `Enveloped<V, P>`;
      // `draft.fields` is `DeepPartial<Enveloped<V, P>>`, deliberately not
      // assignable to it. In the gap-fill composition the base phase populates
      // complete fields before this phase runs, so the walk sees whole leaves —
      // but nothing enforces that for a `gapFillPhase` used standalone (the
      // composition test does exactly that), and a draft missing part of a leaf
      // envelope would be skipped by `isExtractedLeaf` rather than mis-read.
      const fields = draft.fields as Enveloped<V, P>;
      const candidates = [
        ...(wanted.has("abstained") ? findAbstainedLeaves(fields) : []),
        ...(wanted.has("ungrounded") ? findUngroundedLeaves(fields, ctx.transcript.text) : []),
      ];
      // No candidates: the whole passthrough behaviour — the engine treats an
      // empty plan as a no-op (no call, no event, no usage change, no merge).
      if (candidates.length === 0) return [];
      return [{ candidates, transcript: ctx.transcript.text }];
    },
    run: async (item, _draft, ctx) => {
      // Scope the follow-up to exactly the candidate leaves, keyed by formatted
      // path: each entry carries that leaf's own envelope schema out of the
      // extraction schema, so the response is validated against the same value
      // constraints (enum members, string vs number) as the original call.
      const shape: Record<string, z.ZodType> = {};
      for (const candidate of item.candidates) {
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
          messages: buildGapFillMessages(target, item.transcript, item.candidates),
          response_format: {
            type: "json_schema",
            json_schema: { name, schema: jsonSchema, strict: true },
          },
          maxTokens,
        },
        context,
        // Forwarded, not rebuilt: the phase context's signal is the caller's
        // cancellation combined with the phase pool's sibling abort, and a
        // dropped forward would strand cancellation silently.
        { signal: ctx.signal },
      );

      assertStopFinishReason(completion, context);

      const raw = parseJsonContent(completion.content, context);
      // Every value was just parsed against a leaf envelope schema, so the
      // record's `unknown` values ARE envelopes; the index signature cannot see it.
      const parsed = parseWithSchema(responseSchema, raw, context) as Record<
        string,
        Extracted<unknown>
      >;

      const totals: UsageTotals = {};
      addUsage(totals, completion.usage);
      return { value: parsed, usage: { calls: 1, ...totals } };
    },
    merge: (draft, outcomes) => {
      let next = draft;
      for (const outcome of outcomes) {
        // An error outcome carries no contribution. The phase runs under abort
        // semantics — its failures reject out of `run` before `merge` — so this
        // arm is unreachable through the engine, and skipped rather than
        // invented around here.
        if (outcome.outcome !== "result") continue;
        const accepted = acceptImprovements(
          outcome.output.value,
          outcome.item.candidates,
          outcome.item.transcript,
        );
        // THE CAST, and why it is sound: same assumption as in `plan` — the base
        // phase populated complete fields before this phase runs, so the merge
        // walks whole leaves. A standalone `gapFillPhase` whose draft is missing
        // part of a leaf is skipped by `isExtractedLeaf`, never mis-read.
        const merged = mergeGapFilledLeaves(next.fields as Enveloped<V, P>, accepted);
        // `raw` is the merged fields BEFORE normalize runs — the assembled whole
        // the final normalize ran over, so both calls' contributions stay
        // visible in one place — and it is set whether or not the base carried a
        // raw of its own. `fields` gets the normalized copy.
        next = { ...next, raw: merged, fields: normalize(merged) };
      }
      return next;
    },
  };
  return phaseBuilder<V, P>()(def);
}
