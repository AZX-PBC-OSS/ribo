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

// The four phases `threePhaseExtractor` composes moved to `@azx/ribo-core` in
// SP4a wave 5 — they are transport-agnostic, and core owns the phase vocabulary
// — so their factories, options types, note keys and the `extractGroups` schema
// walk are exported THERE now. This barrel keeps only what it owns: the on-device
// transport, the preset that tunes the phases to it, and the device capability
// vocabulary.

export { SessionCapabilityError } from "./session.js";
