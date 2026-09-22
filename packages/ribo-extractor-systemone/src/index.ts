/**
 * @file System One-backed extraction strategies: a judging combinator that
 * corroborates a result before anyone acts on it, and a presence phase that
 * decides what the phases after it look at.
 *
 * Both talk to `@azx/ribo-systemone-managed`; neither knows which endpoint is
 * behind it (ADR 0016).
 */

// The schema read both strategies need: a leaf's enum members, so a question can
// state them. Without them a verifier reads the schema's own encoding of what was
// said as a fabrication (ADR 0017).
export { enumMembersAt } from "./enum-members.js";

// Corroboration: one choice per committed leaf, attached to a grounding census.
export { corroborationCensus } from "./corroboration-census.js";
export type {
  CorroboratedLeaf,
  CorroborationCensus,
  CorroborationCensusCounts,
  CorroborationCensusOptions,
  CorroborationVerdict,
} from "./corroboration-census.js";

// The combinator over that census — the second judging combinator after core's
// `validateExtractor`, rejecting terminally so an arbitration ladder falls through.
export {
  corroborateExtractor,
  CorroborationRejectedError,
  rejectUncorroboratedCommitments,
} from "./corroborate-extractor.js";
export type { CorroborateExtractorOptions, CorroborationPolicy } from "./corroborate-extractor.js";

// Presence at leaf granularity — every leaf of every group in one request, where
// core's own presence phase asks one call per group.
export { systemOnePresencePhase, DEFAULT_PRESENCE_THRESHOLD } from "./presence-phase.js";
export type { SystemOnePresencePhaseOptions } from "./presence-phase.js";
