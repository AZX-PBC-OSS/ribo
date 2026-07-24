import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createConnectivity,
  type Connectivity,
  type ConnectivityProbe,
  type ConnectivityStatus,
} from "./connectivity.js";

// The connectivity model is fully headless — event source, `navigator.onLine`,
// the probe and the timers are all injected — so it is exercised here in node
// with fake timers rather than in a real browser. Every timing assertion below
// is driven by `vi.advanceTimersByTimeAsync`, never a wall-clock wait.

/**
 * A TanStack-`setEventListener`-shaped fake: `bind` stores the change callback
 * and returns a cleanup; `flip` sets the link-layer answer and fires one raw
 * transition, exactly as `window`'s `online`/`offline`/`visibilitychange`
 * events would.
 */
class FakeSource {
  #onChange: (() => void) | undefined;
  online = false;

  isOnline = (): boolean => this.online;

  bind = (onChange: () => void): (() => void) => {
    this.#onChange = onChange;
    return () => {
      this.#onChange = undefined;
    };
  };

  /** Set the link-layer state, then signal a raw change. */
  flip(online: boolean): void {
    this.online = online;
    this.#onChange?.();
  }

  get bound(): boolean {
    return this.#onChange !== undefined;
  }
}

/** A healthy probe that records how many times it was called. */
function countingProbe(status = 204): { fn: ConnectivityProbe; calls: number } {
  const state = {
    calls: 0,
    fn: (async () => {
      state.calls += 1;
      return new Response(null, { status });
    }) as ConnectivityProbe,
  };
  return state;
}

const healthy: ConnectivityProbe = async () => new Response(null, { status: 204 });
const nonOk: ConnectivityProbe = async () => new Response(null, { status: 500 });
const throwing: ConnectivityProbe = async () => {
  throw new TypeError("Failed to fetch");
};

// A microtask flush that also works under fake timers (microtasks are real).
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const live: Connectivity[] = [];

function build(
  source: FakeSource,
  probe: ConnectivityProbe,
  overrides: { probeTimeoutMs?: number; stabilityWindowMs?: number } = {},
): Connectivity {
  const conn = createConnectivity({
    bindEvents: source.bind,
    isOnline: source.isOnline,
    probe,
    // Deliberately non-default values: an earlier lesson in this repo is that a
    // misspelled option passes every assertion when the expected numbers happen
    // to equal the defaults. Non-defaults prove the options are wired through.
    probeTimeoutMs: overrides.probeTimeoutMs ?? 3000,
    stabilityWindowMs: overrides.stabilityWindowMs ?? 1000,
  });
  live.push(conn);
  return conn;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const conn of live.splice(0)) conn.stop();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The subscription shape — mirrors Recorder.subscribe()
// ---------------------------------------------------------------------------

test("subscribe emits the current state immediately and returns an unsubscribe", async () => {
  const source = new FakeSource();
  const conn = build(source, healthy);

  const seen: ConnectivityStatus[] = [];
  const unsubscribe = conn.subscribe((state) => seen.push(state.status));

  // Immediate first emission, before anything happens — nothing has been proven,
  // so the honest starting answer is "offline".
  expect(seen).toEqual(["offline"]);
  expect(conn.state.status).toBe("offline");

  unsubscribe();
  conn.start();
  source.online = true;
  source.flip(true);
  await flush();
  await vi.advanceTimersByTimeAsync(1000);

  // The detached listener heard none of the transitions that followed.
  expect(seen).toEqual(["offline"]);
});

// ---------------------------------------------------------------------------
// Decision 2: offline-negative is trusted instantly; online-positive is not
// ---------------------------------------------------------------------------

test("navigator.onLine === false is trusted immediately as offline, with no probe", () => {
  const source = new FakeSource();
  source.online = false;
  const probe = countingProbe();
  const conn = build(source, probe.fn);

  conn.start();

  expect(conn.state.status).toBe("offline");
  expect(probe.calls).toBe(0);
});

test("navigator.onLine === true is never trusted without a probe: it goes to probing, then online only after the stability window", async () => {
  const source = new FakeSource();
  source.online = true;
  const probe = countingProbe();
  const conn = build(source, probe.fn, { stabilityWindowMs: 1000 });

  const seen: ConnectivityStatus[] = [];
  conn.subscribe((state) => seen.push(state.status));

  conn.start();
  // Synchronously: probing, and a probe is in flight. NOT online.
  expect(conn.state.status).toBe("probing");
  expect(probe.calls).toBe(1);

  await flush(); // the probe resolves healthy
  // A single healthy probe is not enough — online is withheld for the window.
  expect(conn.state.status).toBe("probing");

  await vi.advanceTimersByTimeAsync(999);
  expect(conn.state.status).toBe("probing");

  await vi.advanceTimersByTimeAsync(1);
  expect(conn.state.status).toBe("online");

  expect(seen).toEqual(["offline", "probing", "online"]);
});

// ---------------------------------------------------------------------------
// Decision 3: the probe fails closed — abort / non-ok / throw all land offline
// ---------------------------------------------------------------------------

test("a non-ok probe response resolves to offline", async () => {
  const source = new FakeSource();
  source.online = true;
  const conn = build(source, nonOk);

  conn.start();
  await flush();

  expect(conn.state.status).toBe("offline");
});

test("a probe that throws (DNS failure, TypeError) resolves to offline", async () => {
  const source = new FakeSource();
  source.online = true;
  const conn = build(source, throwing);

  conn.start();
  await flush();

  expect(conn.state.status).toBe("offline");
});

test("a hanging probe fails fast to offline within the timeout, and the probe is aborted", async () => {
  const source = new FakeSource();
  source.online = true;

  let aborted = false;
  const hanging: ConnectivityProbe = (signal) =>
    new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  const conn = build(source, hanging, { probeTimeoutMs: 3000 });

  conn.start();
  expect(conn.state.status).toBe("probing");

  // The endpoint is online-but-useless: it never answers. Just before the hard
  // deadline we are still checking...
  await vi.advanceTimersByTimeAsync(2999);
  expect(conn.state.status).toBe("probing");
  expect(aborted).toBe(false);

  // ...and at the deadline the probe is aborted and we resolve to offline. No
  // wall-clock wait occurred — this whole test is fake-timer driven.
  await vi.advanceTimersByTimeAsync(1);
  expect(conn.state.status).toBe("offline");
  expect(aborted).toBe(true);
});

// ---------------------------------------------------------------------------
// Decision 4: going offline is instant (no debounce)
// ---------------------------------------------------------------------------

test("going offline is instant — an offline event drops a confirmed-online model immediately", async () => {
  const source = new FakeSource();
  source.online = true;
  const conn = build(source, healthy, { stabilityWindowMs: 1000 });

  conn.start();
  await flush();
  await vi.advanceTimersByTimeAsync(1000);
  expect(conn.state.status).toBe("online");

  // A loss is recognised with no debounce and no timer advance.
  source.flip(false);
  expect(conn.state.status).toBe("offline");
});

// ---------------------------------------------------------------------------
// Decision 4: hysteresis — the anti-thrash proof at the model level
// ---------------------------------------------------------------------------

test("flapping offline -> online -> offline -> online yields exactly one stably-online edge", async () => {
  const source = new FakeSource();
  source.online = false;
  const conn = build(source, healthy, { stabilityWindowMs: 1000 });

  const seen: ConnectivityStatus[] = [];
  conn.subscribe((state) => seen.push(state.status));

  conn.start(); // isOnline() === false → stays offline

  source.flip(true); // → probing, probe kicks off
  await flush(); //     probe healthy → stability window armed (still probing)

  source.flip(false); // → offline instantly, window cancelled

  source.flip(true); // → probing again, fresh probe
  await flush(); //     probe healthy → fresh window armed

  // Nothing else flaps; the window is allowed to elapse.
  await vi.advanceTimersByTimeAsync(1000); // → online, at last

  // The whole flap produced ONE online assertion, not one per online event.
  expect(seen.filter((status) => status === "online")).toHaveLength(1);
  expect(seen).toEqual(["offline", "probing", "offline", "probing", "online"]);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  test("start binds the event source; stop unbinds it and cancels a pending probe", async () => {
    const source = new FakeSource();
    source.online = true;
    const probe = countingProbe();
    const conn = build(source, probe.fn, { stabilityWindowMs: 1000 });

    expect(source.bound).toBe(false);
    conn.start();
    expect(source.bound).toBe(true);
    expect(conn.state.status).toBe("probing");

    conn.stop();
    expect(source.bound).toBe(false);

    // The window timer was cancelled by stop(), so advancing time asserts nothing.
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conn.state.status).not.toBe("online");
  });
});
