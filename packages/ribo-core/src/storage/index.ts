/**
 * @file The storage subsystem's public surface.
 *
 * Re-exports only, like the package barrel above it. `src/index.ts` forwards this
 * module wholesale (`export * from "./storage/index.js"`); it is deliberately not
 * edited from here so that the package's one list of public names stays a single,
 * reviewable file.
 *
 * The RxDB schemas, migration strategies and database wiring this used to export
 * now live in `@azx/ribo-storage-rxdb`: they describe how one backend lays data
 * out, and a consumer of these contracts should not have to install RxDB to read
 * them. What stays here is the domain — the zod document schemas, the state
 * machines, and the operations over them.
 *
 * The design this implements — the capture store, per-item state machine,
 * foreground relay, idempotency, jittered backoff, serial ordering — is
 * `docs/implementation/09-offline-first.md`. Read that before changing anything
 * about retry or ordering semantics.
 */

export {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  fullJitterDelay,
  isTransientFailure,
  TerminalError,
} from "./backoff.js";
export type { BackoffOptions } from "./backoff.js";

export { openStorage, Storage } from "./storage.js";
export type { OpenStorageOptions } from "./storage.js";
export { CaptureStore } from "./captures.js";
export type { CaptureQuery, EnqueueInput } from "./captures.js";
export { SessionStore } from "./sessions.js";
export type { OpenSessionInput, SessionQuery } from "./sessions.js";
export type { Store } from "./entries.js";

export { createRelay } from "./relay.js";
export type {
  ConnectivitySource,
  ExtractedFieldMap,
  ExtractStepResult,
  Relay,
  RelayOptions,
  RelaySubject,
  SessionExtractInput,
  SessionExtractStep,
  SessionWriteInput,
  SessionWriteStep,
} from "./relay.js";

export {
  ACTIVE_CAPTURE_STATUSES,
  AUDIO_ATTACHMENT_ID,
  DERIVED_CAPTURE_KEYS,
  FINISHED_CAPTURE_STATUSES,
  CAPTURES_COLLECTION_NAME,
  CAPTURE_STATUSES,
  RECORDING_CAPTURE_STATUSES,
  captureDocumentSchema,
  captureSchema,
} from "./capture-schema.js";
export type { CaptureDocument, Capture, CapturePatch, CaptureStatus } from "./capture-schema.js";

export {
  ACTIVE_SESSION_STATUSES,
  FINISHED_SESSION_STATUSES,
  SESSION_COLLECTION_NAME,
  SESSION_STATUSES,
  sessionDocumentSchema,
  sessionItemSchema,
} from "./session-schema.js";
export type {
  SessionDocument,
  SessionItem,
  SessionPatch,
  SessionStatus,
} from "./session-schema.js";

export {
  PLUGIN_STORAGE_COLLECTION_NAME,
  pluginStorageDocumentSchema,
  pluginStorageEntryId,
} from "./plugin-storage-schema.js";
export type { PluginStorageDocument } from "./plugin-storage-schema.js";

export {
  createCaptureStorageScope,
  createPluginStorage,
  createPluginStorageScope,
} from "./plugin-storage.js";
export type { CaptureStorageScope, PluginStorage, PluginStorageScope } from "./plugin-storage.js";

export { joinSessionTranscript, listSessionTranscriptParts } from "./session-extract.js";

export {
  chunkName,
  chunkPrefix,
  isChunkOf,
  MAX_CHUNK_INDEX,
  MAX_SLICE_INDEX,
  sliceOversized,
} from "./chunk-names.js";
export {
  CAPTURE_LOCK,
  holdLock,
  isLockFree,
  relayItemLock,
  relaySessionLock,
} from "./capture-lock.js";
export type { HeldLock } from "./capture-lock.js";

export { decodeAudioDuration, openCaptureSession } from "./capture-session.js";
export type { CaptureHealth, CaptureSession, CaptureSessionOptions } from "./capture-session.js";

export { recoverInterrupted } from "./recovery.js";
export type { RecoveryOptions } from "./recovery.js";

export type {
  BlobDescriptor,
  BlobInput,
  CollectionName,
  EntryScopeKind,
  Finders,
  Modifier,
  StorageBackend,
  StoredDocument,
} from "./port.js";

// The in-memory backend: the fast one for node tests and development, and the
// standing proof that this package needs no RxDB. It is a real implementation of
// the port and passes the same conformance kit the production backend does.
export { createMemoryBackend, removeMemoryDatabase } from "./memory-backend.js";
