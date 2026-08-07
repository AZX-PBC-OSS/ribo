/**
 * The deterministic normalization pass — model-free code the extractor runs AFTER
 * the LLM. `normalization.md`'s dividing line: the LLM does *semantic* mapping
 * (pick the enum member, split the fuel axis, read a matrix state); code does the
 * *mechanical* transforms that are closed-form, unit-testable, and dangerous to let
 * a model improvise (range-clamp, band bucketing from a raw number).
 *
 * What lives here:
 *   - `clampConfidence` — the schema's `confidence` is a bare `z.number()` (`.min`/
 *     `.max` emit JSON-Schema keywords strict structured-output mode rejects), so
 *     the 0..1 range is enforced HERE, not in the schema. See schema.ts.
 *   - `inchesToAtticDepthBand` / `yearsToDhwAgeBand` — band bucketing GIVEN a raw
 *     number. Once a depth-in-inches or an age-in-years exists as a number, mapping
 *     it to the band whose range contains it is pure arithmetic with one audited
 *     boundary rule — never a per-transcript model guess.
 *   - `normalizeFields` — the pass itself: clamps `confidence` on every provenance
 *     envelope, at every depth. It does NOT touch `value`. It runs on the
 *     EXTRACTION shape (`SnuggExtraction`), between the model's response and review
 *     — `confidence` is an envelope field and exists nowhere else, so a
 *     values-shaped signature here could not be written at all.
 *
 * What deliberately does NOT live here:
 *   - R-value -> depth band. `normalization.md` §"Hazard 2 in detail" is explicit:
 *     the R->depth map is climate/material-dependent and lossy, so it is the ONE
 *     transform refused to both the model AND this pass. It is now also
 *     UNNECESSARY: `attic.atticInsulation` is a real R-value write target of its
 *     own, so a spoken R-value is stored as itself rather than parked in a holding
 *     pen awaiting a conversion nobody wanted to do.
 *   - `null` -> Snugg `"Not Tested"` health-matrix default. That is a WRITE-time
 *     concern (the API has no null state) and lands with egress in Phase 4 Task 6;
 *     keeping silence as `null` through extraction is what keeps a hallucinated
 *     pass measurable (`normalization.md` §"Hazard 3 in detail").
 *   - enum -> Snugg wire token. There is no such transform any more: `schema.ts`
 *     stores the spec's literal strings, so an extracted enum member IS the wire
 *     value. That deleted layer is the whole point of the schema being built from
 *     the machine-readable spec rather than a printed field sheet.
 */

import type { AtticInsulationDepth, DhwAgeBand, SnuggExtraction } from "./schema.js";

type AtticBand = (typeof AtticInsulationDepth.options)[number];
type AgeBand = (typeof DhwAgeBand.options)[number];

/**
 * Clamp a self-reported confidence into the intended 0..1 range. The schema cannot
 * express the bound (strict structured-output rejects `minimum`/`maximum`), so a
 * model that emits `1.4` or `-0.1` is corrected here. A non-finite input collapses
 * to `0` — an unusable confidence reads as "no confidence", never as a high one.
 */
export const clampConfidence = (confidence: number): number => {
  if (!Number.isFinite(confidence)) return 0;
  return Math.min(1, Math.max(0, confidence));
};

/**
 * Bucket a stated attic-insulation DEPTH in inches into its Snugg band.
 *
 * Bands: `0`, `1-3`, `4-6`, `7-9`, `10-12`, `13-15`, `16+` (the enum's eighth
 * member, `"Don't Know"`, is not a bucket and is never returned). The audited
 * boundary rule is upper-inclusive: a value falls in the band whose top it does not
 * exceed (`3` -> `1-3`, `6` -> `4-6`), so a fractional depth resolves
 * deterministically (`3.5` -> `4-6`). Only a true zero/none is `0`; any positive
 * depth is at least `1-3`. This is band bucketing GIVEN a number — it is never an
 * R-value conversion.
 *
 * @throws RangeError on a non-finite or negative depth (a negative depth is nonsense
 * and must surface, not be silently bucketed).
 */
export const inchesToAtticDepthBand = (inches: number): AtticBand => {
  if (!Number.isFinite(inches) || inches < 0) {
    throw new RangeError(`inchesToAtticDepthBand: depth must be finite and >= 0, got ${inches}`);
  }
  if (inches <= 0) return "0";
  if (inches <= 3) return "1-3";
  if (inches <= 6) return "4-6";
  if (inches <= 9) return "7-9";
  if (inches <= 12) return "10-12";
  if (inches <= 15) return "13-15";
  return "16+";
};

/**
 * Bucket a stated DHW age in years into its Snugg age band.
 *
 * Bands: `0-5`, `6-10`, `11-15`, `16-20`, `21-25`, `26-30`, `31-35`, `36+`. Same
 * upper-inclusive boundary rule, which resolves the boundary case `normalization.md`
 * calls out — `15` years -> `11-15`, not `16-20`. "About eight years" -> `6-10`.
 *
 * @throws RangeError on a non-finite or negative age.
 */
export const yearsToDhwAgeBand = (years: number): AgeBand => {
  if (!Number.isFinite(years) || years < 0) {
    throw new RangeError(`yearsToDhwAgeBand: age must be finite and >= 0, got ${years}`);
  }
  if (years <= 5) return "0-5";
  if (years <= 10) return "6-10";
  if (years <= 15) return "11-15";
  if (years <= 20) return "16-20";
  if (years <= 25) return "21-25";
  if (years <= 30) return "26-30";
  if (years <= 35) return "31-35";
  return "36+";
};

/**
 * Is this node a provenance envelope (a leaf) rather than a resource group?
 *
 * Structural, not positional: an envelope is the object carrying a `confidence`
 * number. Tested that way rather than by depth or by a group-name list so that
 * adding a group to `schema.ts` — or nesting one deeper — needs no change here.
 * The recursion below is the reason this pass survived the schema going from flat
 * fields plus one matrix to seven resource groups without touching its body.
 */
const isEnvelope = (node: unknown): node is { confidence: number } =>
  typeof node === "object" &&
  node !== null &&
  typeof (node as { confidence?: unknown }).confidence === "number";

/** Clamp every envelope's `confidence` at any depth, leaving `value`/`sourceSpan`. */
const clampDeep = (node: unknown): unknown => {
  if (isEnvelope(node)) return { ...node, confidence: clampConfidence(node.confidence) };
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, clampDeep(child)]));
  }
  return node;
};

/**
 * The deterministic pass the extractor runs after the model. Returns a new
 * `SnuggExtraction` with every envelope's `confidence` clamped to 0..1 — all 51
 * leaves, across all seven resource groups. `value` and `sourceSpan` are the
 * model's faithful "what was said" and are left untouched; this pass never invents,
 * converts, or re-files a value. Pure and model-free.
 *
 * Enveloped in, enveloped out: this is `SingleShotOptions.normalize`, which runs
 * inside the extractor's trust boundary, long before review turns envelopes into
 * writable values. Every key is present — the extraction shape is required at
 * every level — so there is nothing to skip over.
 */
export const normalizeFields = (fields: SnuggExtraction): SnuggExtraction =>
  clampDeep(fields) as SnuggExtraction;
