import { expect, test, vi } from "vitest";

import { FakeTranscriber } from "./fake-transcriber.js";
import {
  DEFAULT_CAPABILITY_TTL_MS,
  firstCapable,
  type TranscriberFallback,
} from "./first-capable.js";
import { isTransientFailure, TerminalQueueError } from "./queue/backoff.js";
import type { Recording } from "./recording.js";
import { TranscriberUnavailableError } from "./transcriber.js";

const recording = (id = "rec-1"): Recording => ({
  id,
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 1_200,
  mimeType: "audio/webm",
  ctx: {},
});

const audio = () => new Blob(["not really audio"], { type: "audio/webm" });

const onDevice = (overrides = {}) =>
  new FakeTranscriber({ engine: "ondevice-whisper", text: "on-device text", ...overrides });

const managed = (overrides = {}) =>
  new FakeTranscriber({ engine: "managed-azure", text: "managed text", ...overrides });

// A controllable clock, so "how long is a capability cached for" is asserted
// rather than slept through.
const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

test("rejects an empty roster — there is nothing to fall back to or from", () => {
  expect(() => firstCapable([])).toThrow(/at least one/i);
});

test("rejects duplicate engine ids — the capability cache is keyed by them", () => {
  expect(() => firstCapable([onDevice(), onDevice()])).toThrow(/ondevice-whisper/);
});

test("picks the first ready transcriber and never touches the rest", async () => {
  const first = onDevice();
  const second = managed();
  const composite = firstCapable([first, second]);

  const transcript = await composite.transcribe(recording(), audio());

  expect(transcript.text).toBe("on-device text");
  expect(transcript.engine).toBe("ondevice-whisper");
  expect(second.calls).toHaveLength(0);
});

test("skips a transcriber whose capability is unavailable", async () => {
  const first = onDevice({
    capability: { status: "unavailable", reason: "unsupported-platform", detail: "no WebGPU" },
  });
  const second = managed();

  const transcript = await firstCapable([first, second]).transcribe(recording(), audio());

  expect(transcript.engine).toBe("managed-azure");
  expect(first.calls).toHaveLength(0);
});

// The consent rule. A queue drain must never be able to start a 165 MB fetch on
// a field tablet's metered uplink.
test("never selects a needs-download transcriber — that fetch requires consent", async () => {
  const first = onDevice({ capability: { status: "needs-download", downloadBytes: 165_000_000 } });
  const second = managed();

  const transcript = await firstCapable([first, second]).transcribe(recording(), audio());

  expect(transcript.engine).toBe("managed-azure");
  expect(first.calls).toHaveLength(0);
});

test("falling back is reported — silent degradation is the failure mode we cannot have", async () => {
  const first = onDevice({
    capability: { status: "unavailable", reason: "model-unavailable", detail: "weights missing" },
  });
  const onFallback = vi.fn<(event: TranscriberFallback) => void>();

  await firstCapable([first, managed()], { onFallback }).transcribe(recording("rec-9"), audio());

  expect(onFallback).toHaveBeenCalledOnce();
  const event = onFallback.mock.calls[0]?.[0] as TranscriberFallback;
  expect(event.recordingId).toBe("rec-9");
  expect(event.selected).toBe("managed-azure");
  expect(event.skipped).toEqual([
    {
      engine: "ondevice-whisper",
      capability: { status: "unavailable", reason: "model-unavailable", detail: "weights missing" },
    },
  ]);
});

test("no fallback event when the preferred engine ran", async () => {
  const onFallback = vi.fn();

  await firstCapable([onDevice(), managed()], { onFallback }).transcribe(recording(), audio());

  expect(onFallback).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Capability failure vs attempt failure — the distinction the whole design is for
// ---------------------------------------------------------------------------

test("a capability failure discovered mid-attempt falls through to the next engine", async () => {
  const first = onDevice();
  first.failWithUnavailable("unsupported-platform", "ORT init threw");
  const second = managed();

  const transcript = await firstCapable([first, second]).transcribe(recording(), audio());

  expect(first.calls).toHaveLength(1);
  expect(transcript.engine).toBe("managed-azure");
});

test("an attempt failure propagates untouched — the queue owns retries, not this", async () => {
  const first = onDevice();
  const oom = new Error("out of memory decoding this clip");
  first.failNextWith(oom);
  const second = managed();
  const composite = firstCapable([first, second]);

  await expect(composite.transcribe(recording(), audio())).rejects.toBe(oom);
  // NOT demoted to cloud. One bad clip is not a broken device.
  expect(second.calls).toHaveLength(0);
  expect(isTransientFailure(oom)).toBe(true);

  // Which is exactly what makes the queue's retry work: the next attempt goes
  // right back to the preferred engine.
  const transcript = await composite.transcribe(recording(), audio());
  expect(transcript.engine).toBe("ondevice-whisper");
});

test("a mid-attempt capability failure demotes the engine for subsequent items", async () => {
  const first = onDevice();
  first.failWithUnavailable("unsupported-platform", "ORT init threw");
  const composite = firstCapable([first, managed()]);

  await composite.transcribe(recording("rec-1"), audio());
  await composite.transcribe(recording("rec-2"), audio());

  // Tried once, demoted, never asked again.
  expect(first.calls).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Caching: what, and for how long
// ---------------------------------------------------------------------------

test("a ready capability is cached, so WebGPU init is not re-probed per item", async () => {
  const first = onDevice();
  const composite = firstCapable([first, managed()], { now: clock().now });

  await composite.transcribe(recording("rec-1"), audio());
  await composite.transcribe(recording("rec-2"), audio());
  await composite.transcribe(recording("rec-3"), audio());

  expect(first.capabilityCalls).toBe(1);
  expect(first.calls).toHaveLength(3);
});

test("the cache expires after the TTL — availability is dynamic", async () => {
  const time = clock();
  const first = onDevice({
    capability: { status: "unavailable", reason: "offline", detail: "no network" },
  });
  const composite = firstCapable([first, managed()], { now: time.now });

  await composite.transcribe(recording("rec-1"), audio());
  expect(first.capabilityCalls).toBe(1);

  time.advance(DEFAULT_CAPABILITY_TTL_MS - 1);
  await composite.transcribe(recording("rec-2"), audio());
  expect(first.capabilityCalls).toBe(1);

  time.advance(1);
  first.setCapability({ status: "ready" });
  const transcript = await composite.transcribe(recording("rec-3"), audio());

  expect(first.capabilityCalls).toBe(2);
  expect(transcript.engine).toBe("ondevice-whisper");
});

test("a permanently unavailable engine is cached for the whole session, TTL or not", async () => {
  const time = clock();
  const first = onDevice({
    capability: { status: "unavailable", reason: "unsupported-platform", detail: "no WebGPU" },
  });
  const composite = firstCapable([first, managed()], { now: time.now });

  await composite.transcribe(recording("rec-1"), audio());
  time.advance(DEFAULT_CAPABILITY_TTL_MS * 100);
  await composite.transcribe(recording("rec-2"), audio());

  // WebGPU does not appear mid-session. Re-probing it is pure cost.
  expect(first.capabilityCalls).toBe(1);
});

test("invalidate re-probes — this is how a finished model download is announced", async () => {
  const first = onDevice({
    capability: { status: "needs-download", downloadBytes: 165_000_000 },
  });
  const composite = firstCapable([first, managed()], { now: clock().now });

  expect((await composite.transcribe(recording("rec-1"), audio())).engine).toBe("managed-azure");

  first.setCapability({ status: "ready" });
  composite.invalidate("ondevice-whisper");

  expect((await composite.transcribe(recording("rec-2"), audio())).engine).toBe("ondevice-whisper");
});

test("invalidate with no argument clears every engine — the `online` event case", async () => {
  const time = clock();
  const first = onDevice({
    capability: { status: "unavailable", reason: "offline", detail: "no network" },
  });
  const composite = firstCapable([first, managed()], { now: time.now });

  await composite.transcribe(recording("rec-1"), audio());
  first.setCapability({ status: "ready" });
  composite.invalidate();

  expect((await composite.transcribe(recording("rec-2"), audio())).engine).toBe("ondevice-whisper");
});

test("a probe that throws is treated as unavailable, not as a crash", async () => {
  const first = onDevice();
  vi.spyOn(first, "capability").mockRejectedValue(new Error("probe blew up"));

  const transcript = await firstCapable([first, managed()]).transcribe(recording(), audio());

  expect(transcript.engine).toBe("managed-azure");
});

// ---------------------------------------------------------------------------
// Reporting up: what the download screen and the "nothing works" path need
// ---------------------------------------------------------------------------

test("the composite's own capability is the best of its delegates'", async () => {
  await expect(firstCapable([onDevice(), managed()]).capability()).resolves.toEqual({
    status: "ready",
  });

  await expect(
    firstCapable([
      onDevice({ capability: { status: "needs-download", downloadBytes: 165_000_000 } }),
      managed({ capability: { status: "unavailable", reason: "offline", detail: "no network" } }),
    ]).capability(),
  ).resolves.toEqual({ status: "needs-download", downloadBytes: 165_000_000 });

  await expect(
    firstCapable([
      onDevice({
        capability: { status: "unavailable", reason: "unsupported-platform", detail: "no WebGPU" },
      }),
      managed({ capability: { status: "unavailable", reason: "offline", detail: "no network" } }),
    ]).capability(),
  ).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-platform",
    detail: "no WebGPU",
  });
});

test("capabilities() is the per-engine roster the download screen renders from", async () => {
  const composite = firstCapable([
    onDevice({
      capability: { status: "needs-download", downloadBytes: 165_000_000, detail: "base.en" },
    }),
    managed({ capability: { status: "unavailable", reason: "offline", detail: "no network" } }),
  ]);

  await expect(composite.capabilities()).resolves.toEqual([
    {
      engine: "ondevice-whisper",
      capability: { status: "needs-download", downloadBytes: 165_000_000, detail: "base.en" },
    },
    {
      engine: "managed-azure",
      capability: { status: "unavailable", reason: "offline", detail: "no network" },
    },
  ]);
});

test("nothing ready but something could be: transient, so the queue retries", async () => {
  const composite = firstCapable([
    onDevice({ capability: { status: "needs-download", downloadBytes: 165_000_000 } }),
    managed({ capability: { status: "unavailable", reason: "offline", detail: "no network" } }),
  ]);

  const error = await composite.transcribe(recording(), audio()).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(TranscriberUnavailableError);
  expect(error).not.toBeInstanceOf(TerminalQueueError);
  expect(isTransientFailure(error)).toBe(true);
  expect((error as Error).message).toContain("ondevice-whisper");
  expect((error as Error).message).toContain("managed-azure");
});

test("nothing can ever work here: terminal, so the queue stops burning attempts", async () => {
  const composite = firstCapable([
    onDevice({
      capability: { status: "unavailable", reason: "unsupported-platform", detail: "no WebGPU" },
    }),
    managed({ capability: { status: "unavailable", reason: "too-slow", detail: "RTF 4.2" } }),
  ]);

  const error = await composite.transcribe(recording(), audio()).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(TerminalQueueError);
  expect(isTransientFailure(error)).toBe(false);
  expect((error as Error).message).toContain("unsupported-platform");
});

test("the composite is itself a Transcriber, so it composes", async () => {
  const inner = firstCapable([onDevice()], { engine: "inner" });
  const outer = firstCapable([inner, managed()], { engine: "outer" });

  expect(outer.engine).toBe("outer");
  // Provenance is the engine that actually produced the text, never the wrapper.
  expect((await outer.transcribe(recording(), audio())).engine).toBe("ondevice-whisper");
});
