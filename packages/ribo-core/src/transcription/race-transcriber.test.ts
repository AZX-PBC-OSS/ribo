import { describe, expect, test } from "vitest";

import { FakeTranscriber } from "./fake-transcriber.js";
import type { AudioCapture } from "../capture/audio-capture.js";
import { preferEngineOrder } from "./transcription-arbitration.js";
import type {
  TranscriptionArbiter,
  TranscriptionArbiterInput,
} from "./transcription-arbitration.js";
import { raceTranscriber } from "./race-transcriber.js";
import { isTransientFailure, TerminalError } from "../storage/backoff.js";
import {
  TranscriberUnavailableError,
  type Transcriber,
  type TranscriberCapability,
  type TranscribeOptions,
} from "./transcriber.js";
import type { Transcript } from "../capture/transcript.js";

const recording = (id = "rec-1"): AudioCapture => ({
  id,
  capturedAt: "2026-07-23T10:00:00.000Z",
  kind: "audio",
  durationMs: 1_200,
  mimeType: "audio/webm",
  ctx: {},
});

const audio = () => new Blob(["not really audio"], { type: "audio/webm" });

const transcript = (engine: string, text: string): Transcript => ({
  recordingId: "rec-1",
  text,
  engine,
});

const onDevice = (overrides = {}) =>
  new FakeTranscriber({ engine: "ondevice-whisper", text: "on-device text", ...overrides });

const managed = (overrides = {}) =>
  new FakeTranscriber({ engine: "managed-azure", text: "managed text", ...overrides });

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

/**
 * A transcriber whose `transcribe` parks on a deferred promise, records the
 * options each call received, and — unless told not to — rejects when the
 * signal it received aborts, modelling a real transport that honours
 * cancellation. Tests drive settlement order directly instead of sleeping.
 */
class DeferredTranscriber implements Transcriber {
  readonly engine: string;
  readonly capability: () => Promise<TranscriberCapability>;

  /** The options of every `transcribe()` call, positionally matching calls. */
  readonly receivedOptions: (TranscribeOptions | undefined)[] = [];

  #pending: ReturnType<typeof makeDeferred<Transcript>> | undefined;

  constructor(engine: string, capability: TranscriberCapability = { status: "ready" }) {
    this.engine = engine;
    this.capability = () => Promise.resolve(capability);
  }

  transcribe(item: AudioCapture, _bytes: Blob, options?: TranscribeOptions): Promise<Transcript> {
    this.receivedOptions.push(options);
    const deferred = makeDeferred<Transcript>();
    this.#pending = deferred;
    const signal = options?.signal;
    if (signal) {
      signal.addEventListener("abort", () => deferred.reject(signal.reason), { once: true });
    }
    return deferred.promise;
  }

  resolve(text: string): void {
    this.#pending?.resolve(transcript(this.engine, text));
  }

  reject(error: unknown): void {
    this.#pending?.reject(error);
  }
}

/**
 * Yield to the event loop so the gating probes settle and every lane is
 * dispatched before the test drives a settlement — the same helper
 * race-extractor.test.ts uses, for the same reason.
 */
async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// The test runs in Vitest's node environment, but `ribo-core` is a browser library and
// does not include `@types/node`. Declaring `process` locally keeps the test scoped
// rather than widening the package's tsconfig for a single Node-specific assertion.
declare const process: {
  on: (event: "unhandledRejection", handler: (reason: unknown) => void) => void;
  off: (event: "unhandledRejection", handler: (reason: unknown) => void) => void;
};

describe("raceTranscriber", () => {
  test("under preferEngineOrder the slower, higher-ranked engine's transcript wins", async () => {
    const slow = new DeferredTranscriber("slow");
    const fast = new DeferredTranscriber("fast");
    const composite = raceTranscriber([slow, fast], {
      arbiter: preferEngineOrder(["slow", "fast"]),
    });

    const pending = composite.transcribe(recording(), audio());
    await yieldToEventLoop();
    fast.resolve("fast text");
    await yieldToEventLoop();
    slow.resolve("slow text");

    const transcript = await pending;
    // `fast` settled first, but `slow` outranks it — the arbiter waited.
    expect(transcript.engine).toBe("slow");
    expect(transcript.text).toBe("slow text");
  });

  test("under the default arbiter the first success wins", async () => {
    const slow = new DeferredTranscriber("slow");
    const fast = new DeferredTranscriber("fast");
    const composite = raceTranscriber([slow, fast]);

    const pending = composite.transcribe(recording(), audio());
    await yieldToEventLoop();
    fast.resolve("fast text");

    const transcript = await pending;
    expect(transcript.engine).toBe("fast");
    expect(transcript.text).toBe("fast text");
  });

  // Capability gating happens before the race, and matters beyond cost:
  // dispatching to a managed engine uploads the audio, and an engine that
  // cannot serve the item should not receive it.
  test("an unavailable engine is never asked to transcribe", async () => {
    const offline = onDevice({
      capability: { status: "unavailable", reason: "offline", detail: "no network" },
    });
    const cloud = managed();

    const transcript = await raceTranscriber([offline, cloud]).transcribe(recording(), audio());

    expect(offline.calls).toHaveLength(0);
    expect(transcript.engine).toBe("managed-azure");
  });

  test("a losing lane is aborted when the winner is accepted", async () => {
    const loser = new DeferredTranscriber("slow");
    const winner = new DeferredTranscriber("fast");
    const composite = raceTranscriber([loser, winner]);

    const pending = composite.transcribe(recording(), audio());
    await yieldToEventLoop();
    winner.resolve("fast text");
    const result = await pending;
    await yieldToEventLoop();

    expect(result.engine).toBe("fast");
    // The loser's own signal was aborted — the fake honours it, and the
    // rejection that follows is dropped rather than surfaced.
    expect(loser.receivedOptions[0]?.signal?.aborted).toBe(true);
    // Only every OTHER lane: the winner's lane is not aborted out from under it.
    expect(winner.receivedOptions[0]?.signal?.aborted).toBe(false);
  });

  test("a caller abort propagates as a cancellation, not as an arbiter give-up", async () => {
    const arbiterInputs: TranscriptionArbiterInput[] = [];
    const arbiter: TranscriptionArbiter = (input) => {
      arbiterInputs.push({ outcomes: [...input.outcomes], exhausted: input.exhausted });
      return { continue: true };
    };
    const first = new DeferredTranscriber("a");
    const second = new DeferredTranscriber("b");
    const composite = raceTranscriber([first, second], { arbiter });
    const caller = new AbortController();

    const failure = composite
      .transcribe(recording(), audio(), { signal: caller.signal })
      .catch((error: unknown) => error);
    await yieldToEventLoop();
    caller.abort();

    const error = await failure;
    // The caller's own abort reason, by identity — not an arbiter verdict.
    expect(error).toBe(caller.signal.reason);
    // The arbiter was never consulted: a cancelled run is nobody's give-up.
    expect(arbiterInputs).toEqual([]);
  });

  test("every lane rejecting gives up with the first error", async () => {
    const first = new DeferredTranscriber("a");
    const second = new DeferredTranscriber("b");
    const firstError = new TranscriberUnavailableError({
      engine: "a",
      reason: "offline",
      detail: "no network",
    });
    const secondError = new TranscriberUnavailableError({
      engine: "b",
      reason: "offline",
      detail: "no network",
    });
    const composite = raceTranscriber([first, second]);

    const pending = composite.transcribe(recording(), audio());
    await yieldToEventLoop();
    first.reject(firstError);
    second.reject(secondError);

    const error = await pending.catch((e: unknown) => e);

    expect(error).toBe(firstError);
    expect(isTransientFailure(error)).toBe(true);
  });

  test("capabilities() reports the roster", async () => {
    const composite = raceTranscriber([onDevice(), managed()]);

    expect(await composite.capabilities()).toEqual([
      { engine: "ondevice-whisper", capability: { status: "ready" } },
      { engine: "managed-azure", capability: { status: "ready" } },
    ]);
  });

  test("a losing lane's rejection never surfaces as the result, and never as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);
    try {
      // A lane that genuinely IGNORES its abort signal, so its rejection is an
      // ordinary attempt failure arriving after the race is already over — which is
      // the path this test's title names.
      //
      // `DeferredTranscriber` was used here first and does NOT exercise it: its
      // constructor attaches an abort listener, so the winner's `abortLanes` rejects
      // the loser itself and the later manual reject is a no-op on an
      // already-rejected promise. The test passed, but through the abort path that
      // other tests already cover — and deleting that listener would not have failed
      // it. A fixture that ignores the signal is the only way to reach the late
      // ordinary rejection.
      let rejectLoser!: (reason: unknown) => void;
      const loser: Transcriber = {
        engine: "slow",
        capability: async () => ({ status: "ready" }),
        transcribe: () =>
          new Promise<Transcript>((_resolve, reject) => {
            rejectLoser = reject;
          }),
      };
      const winner = new FakeTranscriber({ engine: "fast", text: "fast text" });
      const composite = raceTranscriber([loser, winner]);

      const result = await composite.transcribe(recording(), audio());
      expect(result.engine).toBe("fast");

      // The slow candidate rejects *after* the fast one has already won. The
      // combinator must have attached a rejection handler to the slow promise,
      // or this surfaces as an unhandled rejection and the test fails on the
      // assertion below.
      rejectLoser(new Error("slow lost"));

      // Give Node's unhandled-rejection check a turn to fire if the handler is
      // missing. A bare microtask flush is not enough; the event is emitted on
      // the next macrotick.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  test("when every engine is gated out, fails as firstCapable does — terminal when every verdict is permanent", async () => {
    const unsupportedPlatform = (engine: string) =>
      new FakeTranscriber({
        engine,
        capability: {
          status: "unavailable",
          reason: "unsupported-platform",
          detail: "no WebGPU",
        },
      });

    const error = await raceTranscriber([unsupportedPlatform("a"), unsupportedPlatform("b")])
      .transcribe(recording(), audio())
      .catch((e: unknown) => e);

    // This device will never do it — no retry budget is burned proving that.
    expect(error).toBeInstanceOf(TerminalError);
  });

  test("when every engine is gated out, fails retryably when any verdict is a situation", async () => {
    const needsDownload = onDevice({
      capability: { status: "needs-download", downloadBytes: 165_000_000 },
    });
    const offline = managed({
      capability: { status: "unavailable", reason: "offline", detail: "no network" },
    });

    const error = await raceTranscriber([needsDownload, offline])
      .transcribe(recording(), audio())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TranscriberUnavailableError);
    expect(isTransientFailure(error)).toBe(true);
  });

  test("refuses an empty roster at construction", () => {
    expect(() => raceTranscriber([])).toThrow(TypeError);
    expect(() => raceTranscriber([])).toThrow(/at least one/);
  });

  test("refuses duplicate engine ids at construction — the capability cache is keyed by them", () => {
    expect(() => raceTranscriber([onDevice(), onDevice()])).toThrow(TypeError);
    expect(() => raceTranscriber([onDevice(), onDevice()])).toThrow(/ondevice-whisper/);
  });

  test("the composite's engine defaults to 'race' and is overridable", () => {
    expect(raceTranscriber([onDevice()]).engine).toBe("race");
    expect(raceTranscriber([onDevice()], { engine: "custom" }).engine).toBe("custom");
  });
});
