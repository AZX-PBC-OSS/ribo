/**
 * @file The public surface of `@azx/ribo-ui-react`.
 *
 * Re-exports only, like `@azx/ribo-core`'s barrel. This package is a **headless
 * hook layer**: no components beyond `RiboProvider`, no markup, no stylesheet.
 * Rendering is the host's; these hooks only wire core's engine to React state.
 */

export { RiboProvider } from "./RiboProvider.js";
export type { AnyRecorder, RiboInstances } from "./context.js";
export { useConnectivity } from "./use-connectivity.js";
export { useStoragePersistence } from "./use-storage-persistence.js";
export type { UseStoragePersistenceResult } from "./use-storage-persistence.js";
export { useReview } from "./use-review.js";
export type { UseReviewOptions, UseReviewResult } from "./use-review.js";
