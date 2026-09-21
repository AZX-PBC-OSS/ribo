/**
 * @file The injectable timer seam shared by the connectivity model, the hedged
 * transcription combinator, and the timeout/hedged extraction combinators.
 */

/**
 * Schedules `fn` to run after `delayMs`, returning a **canceller**.
 *
 * A canceller rather than an opaque handle so the model never has to name a
 * timer id type that differs between node and the browser. Defaults to
 * `setTimeout`/`clearTimeout`; a test injects a hand-driven clock so it can
 * advance the stability window without a real wait and without faking timers
 * around IndexedDB.
 */
export type ScheduleTimer = (fn: () => void, delayMs: number) => () => void;
