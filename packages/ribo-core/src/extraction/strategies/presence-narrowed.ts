/**
 * The presence-narrowed preset: a caller-supplied presence phase, then core's
 * fill phase over the same walked groups. The presence phase seeds
 * every group key; the fill narrows to what presence found — the composition
 * ADR 0027 licenses for the managed path.
 *
 * The presence phase is a PARAMETER, not an import: core's chat-backed
 * `presencePhase` and the System One one are interchangeable here, and this
 * package takes no dependency on either beyond core's `Phase` contract.
 *
 * Construction validates the list, so a renamed presence phase must be named
 * through the fill's REPLACING `requires` option or the preset throws naming
 * the id. The list is exactly the two phases; a host wanting engine knobs
 * (`concurrency`, `maxRetries`, `onUnit`, …) hand-assembles the same list
 * through core's `phasedExtractor`, the way every phase preset in this package
 * documents.
 */

import { phasedExtractor } from "../../phases/phased-extractor.js";
import { presenceFillPhase } from "../../phases/presence-fill-phase.js";
import type { Enveloped, NoProvenance } from "../../provenance/enveloped.js";
import type { Extractor } from "../extractor.js";
import type { Phase } from "../../phases/phase.js";
import type { PresenceFillPhaseOptions } from "../../phases/presence-fill-phase.js";

export function presenceNarrowedExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  presence: Phase<V, P>,
  options: PresenceFillPhaseOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  return phasedExtractor<V, P>({
    target: options.target,
    phases: [presence, presenceFillPhase<V, P>(options)],
  });
}
