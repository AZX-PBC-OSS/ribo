import type { Capture, Outbox, OutboxItem, RecorderPhase, RecorderState } from "@azx/ribo-core";
import { RecorderError } from "@azx/ribo-core";
import { useCallback, useState } from "react";

// `AnyRecorder` is this package's own alias for a recorder whose host context type
// the provider cannot know — it is defined in ./context.js, NOT in @azx/ribo-core.
import type { AnyRecorder } from "./context.js";
import { useOptionalRiboInstance, useRiboInstance } from "./use-ribo-instance.js";
import { useSubscribed } from "./use-subscribed.js";

export interface UseRecorderOptions {
  readonly recorder?: AnyRecorder;
  readonly outbox?: Outbox;
  /**
   * Hand the capture to the outbox on stop. Defaults to **`true`**.
   *
   * A recording that stops without reaching disk is lost, so the durable path is
   * the default rather than an opt-in. With `enqueue: false` no outbox is needed
   * and `stop()` resolves `item: undefined`.
   */
  readonly enqueue?: boolean;
}

export interface StopResult {
  readonly capture: Capture<Record<string, unknown>>;
  /** The queued row, or `undefined` when `enqueue` was `false`. */
  readonly item: OutboxItem | undefined;
}

export interface UseRecorderResult {
  readonly phase: RecorderPhase;
  readonly elapsedMs: number;
  /** Raw RMS in `[0, 1]` — the honest value. */
  readonly level: number;
  /** {@link level} under a perceptual curve, for drawing a meter. */
  readonly scaledLevel: number;
  /** An async `start`/`stop` is in flight. */
  readonly busy: boolean;
  readonly error: RecorderError | undefined;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<StopResult>;
  readonly pause: () => void;
  readonly resume: () => void;
  /** Start when idle, stop when recording or paused. */
  readonly toggle: () => Promise<void>;
}

/**
 * Capture, as React state.
 *
 * ```tsx
 * const { phase, scaledLevel, toggle } = useRecorder();
 * <button onClick={toggle}>{phase === "recording" ? "Stop" : "Record"}</button>
 * <Meter value={scaledLevel} />
 * ```
 *
 * Errors are captured into {@link UseRecorderResult.error} rather than thrown out
 * of an event handler, where React cannot route them anywhere useful. The one
 * exception is a misconfiguration — `enqueue` on with no outbox — which throws at
 * render, because it is a wiring bug the developer must fix rather than a runtime
 * condition the UI should display.
 *
 * {@link UseRecorderResult.stop} is asymmetric with {@link UseRecorderResult.start}
 * on purpose: `start()` swallows its failure into `error` state and always resolves,
 * because a host typically fires it from a click handler with no return value to
 * act on and just re-renders off `phase`/`error`. `stop()` does that **and**
 * re-throws, because its resolved value carries the `Capture` (and, on the durable
 * path, the `OutboxItem`) the caller actually needs next — to hand to a review
 * screen, say. Swallowing the failure there would let a caller read `item`/`capture`
 * off a promise that never produced them, silently proceeding as if the recording
 * had been saved. A caller must therefore `await stop()` inside a `try`, same as
 * any other operation whose result it depends on; `error` state is populated
 * alongside the throw for a UI that also wants to render the failure inline.
 */
export function useRecorder(options: UseRecorderOptions = {}): UseRecorderResult {
  const { enqueue = true } = options;
  const recorder = useRiboInstance("recorder", options.recorder);
  // Resolved unconditionally — a conditional hook call breaks the rules of hooks,
  // and `eslint-plugin-react-hooks` is configured for this package and will reject
  // it. The *check* is conditional instead, and it throws at first render rather
  // than at the end of the first recording, by which point the audio is in memory
  // with nowhere to go.
  const maybeOutbox = useOptionalRiboInstance("outbox", options.outbox);
  if (enqueue && maybeOutbox === undefined) {
    throw new Error(
      "ribo: useRecorder({ enqueue: true }) needs an outbox, so a stopped recording reaches disk. Pass one to <RiboProvider value={{ outbox }}>, or set enqueue: false to handle the capture yourself.",
    );
  }
  const outbox = enqueue ? maybeOutbox : undefined;

  // `subscribe` must stay referentially stable across renders — see
  // useSubscribed's doc comment. `Recorder.state` allocates a fresh object on
  // every read, so an unmemoized arrow here would re-subscribe every render and
  // never stop: the effect's `[subscribe]` dependency would change every commit,
  // and the source's immediate delivery-on-subscribe would hand back an object
  // that is never `Object.is`-equal to the last one.
  const subscribe = useCallback(
    (listener: (state: RecorderState) => void) => recorder.subscribe(listener),
    [recorder],
  );
  const state = useSubscribed(subscribe, () => recorder.state);
  const [error, setError] = useState<RecorderError | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    setError(undefined);
    setBusy(true);
    try {
      await recorder.start();
    } catch (cause) {
      setError(asRecorderError(cause));
    } finally {
      setBusy(false);
    }
  }, [recorder]);

  const stop = useCallback(async (): Promise<StopResult> => {
    setError(undefined);
    setBusy(true);
    try {
      const capture = await recorder.stop();
      const item = outbox === undefined ? undefined : await outbox.enqueue(capture);
      return { capture, item };
    } catch (cause) {
      const failure = asRecorderError(cause);
      setError(failure);
      throw failure;
    } finally {
      setBusy(false);
    }
  }, [outbox, recorder]);

  const pause = useCallback(() => {
    try {
      recorder.pause();
    } catch (cause) {
      setError(asRecorderError(cause));
    }
  }, [recorder]);

  const resume = useCallback(() => {
    try {
      recorder.resume();
    } catch (cause) {
      setError(asRecorderError(cause));
    }
  }, [recorder]);

  const toggle = useCallback(async () => {
    // Reads `recorder.phase` directly rather than the subscribed `state.phase`:
    // `state` can be one render behind a phase change, and a toggle that acts on
    // a stale phase double-starts or double-stops. The instance is the authority.
    if (recorder.phase === "idle") return await start();
    await stop();
  }, [recorder, start, stop]);

  return {
    phase: state.phase,
    elapsedMs: state.elapsedMs,
    level: state.level,
    scaledLevel: scaleLevel(state.level),
    busy,
    error,
    start,
    stop,
    pause,
    resume,
    toggle,
  };
}

/**
 * Maps raw RMS onto something a bar can show.
 *
 * `RecorderState.level` is honest RMS, and for ordinary speech it sits low enough
 * that a bar at `level * 100%` barely leaves the left edge — it reads as a broken
 * meter, not a quiet room. Doc 04 assigns this mapping to the meter component; a
 * headless package has no meter, so the hook owns it, and every consumer gets the
 * same curve instead of guessing at its own.
 *
 * `sqrt` rather than a dB mapping: it is monotonic, needs no floor, and is what
 * the playground arrived at against a real microphone.
 */
const scaleLevel = (level: number): number => Math.sqrt(level);

/** Keeps `error` typed as `RecorderError` without lying about an unknown cause. */
const asRecorderError = (cause: unknown): RecorderError =>
  cause instanceof RecorderError
    ? cause
    : new RecorderError("capture-failed", "The capture failed.", { cause });
