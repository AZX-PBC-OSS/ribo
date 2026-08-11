/**
 * @file The queue subsystem's public surface.
 *
 * Re-exports only, like the package barrel above it. `src/index.ts` is expected
 * to forward this module wholesale (`export * from "./queue/index.js"`); it is
 * deliberately not edited from here so that the package's one list of public
 * names stays a single, reviewable file.
 *
 * The design this implements — outbox collection, per-item state machine,
 * foreground relay, idempotency, jittered backoff, serial ordering — is
 * `docs/implementation/09-offline-first.md`. Read that before changing anything
 * about retry or ordering semantics.
 */

export {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  fullJitterDelay,
  isTransientFailure,
  TerminalQueueError,
} from "./backoff.js";
export type { BackoffOptions } from "./backoff.js";

export {
  DEFAULT_OUTBOX_DATABASE_NAME,
  openOutboxDatabase,
  removeOutboxDatabase,
} from "./database.js";
export type { OutboxCollection, OutboxDatabase } from "./database.js";

export { openOutbox, Outbox } from "./outbox.js";
export type { EnqueueInput, OpenOutboxOptions, OutboxQuery } from "./outbox.js";

export { createRelay } from "./relay.js";
export type {
  ConnectivitySource,
  ExtractedFieldMap,
  ExtractStep,
  ExtractStepInput,
  Relay,
  RelayOptions,
  WriteStep,
  WriteStepInput,
} from "./relay.js";

export {
  ACTIVE_OUTBOX_STATUSES,
  AUDIO_ATTACHMENT_ID,
  DERIVED_OUTBOX_ITEM_KEYS,
  FINISHED_OUTBOX_STATUSES,
  OUTBOX_COLLECTION_NAME,
  OUTBOX_STATUSES,
  RECORDING_OUTBOX_STATUSES,
  outboxDocumentSchema,
  outboxItemSchema,
  outboxRxSchema,
} from "./schema.js";
export type { OutboxDocument, OutboxItem, OutboxPatch, OutboxStatus } from "./schema.js";

export {
  chunkName,
  chunkPrefix,
  isChunkOf,
  MAX_CHUNK_INDEX,
  MAX_SLICE_INDEX,
  sliceOversized,
} from "./chunk-names.js";
export { CAPTURE_LOCK, holdLock, isLockFree } from "./capture-lock.js";
export type { HeldLock } from "./capture-lock.js";
