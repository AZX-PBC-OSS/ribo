import type { StorageBackend } from "./port.js";

/**
 * The injectables both stores share: the clock and the id sources.
 *
 * Passed rather than re-derived so that a `Storage` opened with a test clock has
 * one clock, not two that can disagree about what "now" is.
 */
export interface StoreDeps {
  readonly backend: StorageBackend;
  readonly now: () => number;
  readonly createId: () => string;
  readonly createIdempotencyKey: () => string;
}
