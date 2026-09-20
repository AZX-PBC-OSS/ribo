export { WHITESPACE_LOOP_THRESHOLD, isLoopingOutput } from "./loop-detector.js";

export { primeLanguageModel, probeLanguageModel } from "./capability.js";
export type {
  DownloadProgressEvent,
  LanguageModel,
  LanguageModelAvailability,
  LanguageModelCreateOptions,
  LanguageModelMonitor,
  PrimeProgressListener,
} from "./capability.js";

export { ONDEVICE_CHAT_ENGINE, OnDeviceChat } from "./ondevice-chat.js";
export type { OnDeviceChatOptions } from "./ondevice-chat.js";

export { threePhaseExtractor } from "./three-phase-extractor.js";
export type { ThreePhaseExtractorOptions } from "./three-phase-extractor.js";

// The four phases `threePhaseExtractor` composes, exported with the note keys
// their hand-offs cross the draft under, so a host can compose them differently —
// reorder them, drop the wrapped pass, slot a phase of its own between them —
// instead of taking the preset whole. The preset stays the supported path for
// callers who do not want to compose. This widens the public surface deliberately
// and permanently: the factories, their options types and their note keys are
// supported API from here on. The note keys are not optional extras — a host
// composing a subset needs the same branded key the neighbouring phases agree on,
// and a phase exported without its key is one that cannot be composed with
// anything.
export { presencePhase, presenceNoteKey } from "./phases/presence-phase.js";
export type { PresencePhaseOptions } from "./phases/presence-phase.js";

// The schema walk the phases consume, and its vocabulary. Exporting the phases
// without this exported something a host cannot actually run: `presencePhase`
// takes `groups: readonly Group[]`, and `extractGroups` is the only thing that
// produces them — `threePhaseExtractor` calls it before constructing the phase.
// A host could construct and validate a phase list but never execute one.
//
// This mirrors what `@azx/ribo-extractor-openai` already does for its own
// phases, where `splitExtractionSchema` and `PreparedGroup` are public so a
// caller can produce `inventoryPhase`'s `prepared`.
export { extractGroups } from "./phases/presence-phase.js";
export type { Group, Leaf, JsonSchema } from "./phases/presence-phase.js";

export { spanPhase, spansNoteKey } from "./phases/span-phase.js";
export type { SpanPhaseOptions } from "./phases/span-phase.js";

export {
  classifyPhase,
  classifyWrappedPhase,
  unsupportedNoteKey,
} from "./phases/classify-phase.js";
// `classifyWrappedPhase` has no options type of its own — it shares
// `ClassifyPhaseOptions`, and inventing an alias would be a second name for one
// commitment.
export type { ClassifyPhaseOptions } from "./phases/classify-phase.js";

export { SessionCapabilityError } from "./session.js";
