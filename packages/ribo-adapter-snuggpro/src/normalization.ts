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
 *     envelope (top-level and the nested health matrix). It does NOT touch `value`.
 *
 * What deliberately does NOT live here:
 *   - R-value -> depth band. `normalization.md` §"Hazard 2 in detail" is explicit:
 *     the R->depth map is climate/material-dependent and lossy, so it is the ONE
 *     transform refused to both the model AND this pass. A spoken R-value rests in
 *     `atticInsulationSpokenRValue` (the holding pen) until a reviewed table or the
 *     auditor resolves it. There is no R->band function here on purpose.
 *   - `null` -> Snugg "Not Tested" health-matrix default. That is a WRITE-time
 *     concern (Snugg has no null state) and lands with egress in Phase 4 Task 6;
 *     keeping silence as `null` through extraction is what keeps a hallucinated
 *     pass measurable (`normalization.md` §"Hazard 3 in detail").
 *   - enum -> Snugg wire token. Doc 12 marks the API tokens `[unknown]`; that
 *     rename is gated on a real API key (Task 6), not this pass.
 */

import type { AtticInsulationDepthBand, DhwAgeBand, SnuggFields } from "./schema.js";

type AtticBand = (typeof AtticInsulationDepthBand.options)[number];
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
 * Bands: `0`, `1-3`, `4-6`, `7-9`, `10-12`, `13-15`, `16+`. The audited boundary
 * rule is upper-inclusive: a value falls in the band whose top it does not exceed
 * (`3` -> `1-3`, `6` -> `4-6`), so a fractional depth resolves deterministically
 * (`3.5` -> `4-6`). Only a true zero/none is `0`; any positive depth is at least
 * `1-3`. This is band bucketing GIVEN a number — it is never an R-value conversion.
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

/** Clamp the `confidence` of one provenance envelope, leaving `value`/`sourceSpan`. */
const clampEnvelope = <E extends { confidence: number }>(envelope: E): E => ({
  ...envelope,
  confidence: clampConfidence(envelope.confidence),
});

/**
 * The deterministic pass the extractor runs after the model. Returns a new
 * `SnuggFields` with every envelope's `confidence` clamped to 0..1 — top-level
 * fields and each of the 11 health-matrix tests. `value` and `sourceSpan` are the
 * model's faithful "what was said" and are left untouched; this pass never invents,
 * converts, or re-files a value. Pure and model-free.
 */
export const normalizeFields = (fields: SnuggFields): SnuggFields => {
  const { healthSafety, ...top } = fields;

  const clampedTop = Object.fromEntries(
    Object.entries(top).map(([key, envelope]) => [key, clampEnvelope(envelope)]),
  ) as Omit<SnuggFields, "healthSafety">;

  const clampedHealth = Object.fromEntries(
    Object.entries(healthSafety).map(([key, envelope]) => [key, clampEnvelope(envelope)]),
  ) as SnuggFields["healthSafety"];

  return { ...clampedTop, healthSafety: clampedHealth };
};
