/**
 * @file The public surface of `@azx/ribo-ui-react`.
 *
 * Re-exports only, like `@azx/ribo-core`'s barrel. This package is a **headless
 * hook layer**: no components beyond `RiboProvider`, no markup, no stylesheet.
 * Rendering is the host's; these hooks only wire core's engine to React state.
 */

export { RiboProvider } from "./RiboProvider.js";
export type { AnyRecorder, RiboInstances } from "./context.js";
export { createCaptureCoordinator } from "./capture-coordinator.js";
export type { CaptureCoordinator } from "./capture-coordinator.js";
export { useConnectivity } from "./use-connectivity.js";
export { useOutboxItems } from "./use-outbox-items.js";
export type { UseOutboxItemsResult } from "./use-outbox-items.js";
export { useRecorder } from "./use-recorder.js";
export type { StopResult, UseRecorderOptions, UseRecorderResult } from "./use-recorder.js";
export { useReview } from "./use-review.js";
export type { UseReviewOptions, UseReviewResult } from "./use-review.js";
export { useSessions } from "./use-sessions.js";
export type { UseSessionsResult } from "./use-sessions.js";
export { useStoragePersistence } from "./use-storage-persistence.js";
export type { UseStoragePersistenceResult } from "./use-storage-persistence.js";
export { useWorkSafety } from "./use-work-safety.js";
export type { UseWorkSafetyResult } from "./use-work-safety.js";
