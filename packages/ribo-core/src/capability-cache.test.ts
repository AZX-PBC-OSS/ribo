import { describe, expect, test } from "vitest";

import { CapabilityCache } from "./capability-cache.js";
import { FakeTranscriber } from "./fake-transcriber.js";
import type { Transcriber } from "./transcriber.js";

// A controllable clock, so "how long is a capability cached for" is asserted
// rather than slept through — the same double first-capable.test.ts uses.
const clock = (start = 1_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const onDevice = (overrides = {}) =>
  new FakeTranscriber({ engine: "ondevice-whisper", text: "on-device text", ...overrides });

const managed = (overrides = {}) =>
  new FakeTranscriber({ engine: "managed-azure", text: "managed text", ...overrides });

// FakeTranscriber's probe never rejects; the rejecting-probe case needs one
// that does. A bare object is enough — the cache only reads `engine` and
// `capability`. The probe count is the only way to see whether a rejecting
// answer was cached, so the helper counts like FakeTranscriber does.
const rejecting = (engine: string): Transcriber & { probeCalls: number } => {
  let probeCalls = 0;
  return {
    engine,
    capability: () => {
      probeCalls += 1;
      return Promise.reject(new Error("probe blew up"));
    },
    transcribe: () => Promise.reject(new Error("must not be called")),
    get probeCalls() {
      return probeCalls;
    },
  };
};

describe("CapabilityCache", () => {
  test("caches a verdict for its TTL", async () => {
    const engine = onDevice();
    const cache = new CapabilityCache({ now: clock().now });

    const first = await cache.capabilityOf(engine);
    const second = await cache.capabilityOf(engine);

    expect(first).toEqual({ status: "ready" });
    expect(second).toEqual({ status: "ready" });
    // The second read was served from the cache — one probe, two answers.
    expect(engine.capabilityCalls).toBe(1);
  });

  test("re-probes once the TTL has elapsed", async () => {
    const ttlMs = 30_000;
    const time = clock();
    const engine = onDevice();
    const cache = new CapabilityCache({ ttlMs, now: time.now });

    await cache.capabilityOf(engine);
    // Exactly at the entry's expiry: `now < expiresAt` is already false.
    time.advance(ttlMs);
    await cache.capabilityOf(engine);

    expect(engine.capabilityCalls).toBe(2);
  });

  // A permanent verdict is a fact about the device, not a situation — it is
  // cached with no expiry, so a long drain never re-probes for it.
  test("caches a permanent verdict forever", async () => {
    const time = clock();
    const engine = onDevice({
      capability: { status: "unavailable", reason: "unsupported-platform", detail: "no WebGPU" },
    });
    const cache = new CapabilityCache({ ttlMs: 30_000, now: time.now });

    await cache.capabilityOf(engine);
    time.advance(10_000_000);
    const capability = await cache.capabilityOf(engine);

    expect(capability).toEqual({
      status: "unavailable",
      reason: "unsupported-platform",
      detail: "no WebGPU",
    });
    expect(engine.capabilityCalls).toBe(1);
  });

  test("invalidate drops one engine and keeps the rest", async () => {
    const time = clock();
    const first = onDevice();
    const second = managed();
    const cache = new CapabilityCache({ now: time.now });

    await cache.capabilityOf(first);
    await cache.capabilityOf(second);
    cache.invalidate("ondevice-whisper");

    await cache.capabilityOf(first);
    await cache.capabilityOf(second);

    expect(first.capabilityCalls).toBe(2);
    expect(second.capabilityCalls).toBe(1);
  });

  test("invalidate with no argument drops every engine", async () => {
    const time = clock();
    const first = onDevice();
    const second = managed();
    const cache = new CapabilityCache({ now: time.now });

    await cache.capabilityOf(first);
    await cache.capabilityOf(second);
    cache.invalidate();

    await cache.capabilityOf(first);
    await cache.capabilityOf(second);

    expect(first.capabilityCalls).toBe(2);
    expect(second.capabilityCalls).toBe(2);
  });

  // A probe is not permitted to take the caller down. Its answer is
  // "unavailable" with reason "unknown" — which is NOT a permanent verdict, so
  // it is cached for the TTL only: a transiently broken probe must not pin the
  // engine out for the life of the page.
  test("a rejecting probe reads as unavailable/unknown and is not cached permanently", async () => {
    const ttlMs = 30_000;
    const time = clock();
    const engine = rejecting("broken-probe");
    const cache = new CapabilityCache({ ttlMs, now: time.now });

    const capability = await cache.capabilityOf(engine);
    expect(capability.status).toBe("unavailable");
    if (capability.status === "unavailable") {
      expect(capability.reason).toBe("unknown");
      expect(capability.detail).toMatch(/capability probe failed/);
      expect(capability.detail).toMatch(/probe blew up/);
    }

    // Not cached as permanent: past the TTL the engine is probed again.
    time.advance(ttlMs);
    await cache.capabilityOf(engine);
    expect(engine.probeCalls).toBe(2);
  });
});
