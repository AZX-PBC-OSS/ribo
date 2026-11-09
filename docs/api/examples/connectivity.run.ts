/**
 * The runnable example behind docs/api/connectivity.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: every ambient input — the event
 * source, `navigator.onLine`, the probe, the timers — is injected.
 */

import assert from "node:assert/strict";
import {
  createConnectivity,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_STABILITY_WINDOW_MS,
  summarizeWork,
  workSafety,
  type ConnectivityState,
  type ConnectivityStatus,
  type ScheduleTimer,
  type WorkOnDevice,
} from "@azx/ribo-core";

/** A timer seam with a manual clock: nothing here waits real milliseconds. */
function manualScheduler() {
  let nowMs = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const delays: number[] = [];
  const schedule: ScheduleTimer = (fn, ms) => {
    delays.push(ms);
    timers.push({ at: nowMs + ms, fn });
    return () => {
      timers = timers.filter((timer) => timer.fn !== fn);
    };
  };
  const advance = (ms: number): void => {
    nowMs += ms;
    const due = timers.filter((timer) => timer.at <= nowMs).sort((a, b) => a.at - b.at);
    timers = timers.filter((timer) => timer.at > nowMs);
    for (const timer of due) timer.fn();
  };
  return { schedule, advance, delays };
}

function harness(options: { probe: (signal: AbortSignal) => Promise<Response> }) {
  const timer = manualScheduler();
  let onChange: () => void = () => undefined;
  let linkUp = true;
  const connectivity = createConnectivity({
    bindEvents: (cb) => {
      onChange = cb;
      return () => undefined;
    },
    isOnline: () => linkUp,
    probe: options.probe,
    schedule: timer.schedule,
  });
  const statuses: ConnectivityStatus[] = [];
  connectivity.subscribe((state: ConnectivityState) => statuses.push(state.status));
  const tick = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    connectivity,
    timer,
    statuses,
    fire: () => onChange(),
    setLink: (up: boolean) => void (linkUp = up),
    tick,
  };
}

export async function onlineIsAssertedOnlyAfterTheStabilityWindow(): Promise<void> {
  // #region usage
  const { connectivity, timer, statuses, fire, tick, setLink } = harness({
    probe: async () => new Response(null, { status: 204 }),
  });
  connectivity.start();
  // A probe succeeded, but one healthy answer is not `online` yet.
  const during = connectivity.state.status;
  await tick();
  timer.advance(DEFAULT_STABILITY_WINDOW_MS);
  const after = connectivity.state.status;
  // #endregion usage

  assert.equal(during, "probing");
  assert.equal(after, "online");

  // Going offline is instant — never delayed by a window. The raw `online`
  // event only marks the link; the model re-reads `navigator.onLine` itself.
  setLink(false);
  fire();
  assert.equal(connectivity.state.status, "offline");
  connectivity.stop();
  assert.deepEqual(statuses, ["offline", "probing", "online", "offline"]);
}

export async function aHangingProbeIsAbortedAndResolvedToOffline(): Promise<void> {
  const { connectivity, timer, tick } = harness({
    probe: (signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  connectivity.start();
  await tick();

  // The probe outlived its deadline: the model resolves the cycle itself.
  timer.advance(DEFAULT_PROBE_TIMEOUT_MS);
  assert.equal(connectivity.state.status, "offline");
  connectivity.stop();
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The values themselves, so the page quoting this region prints them:
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 5_000);
  assert.equal(DEFAULT_STABILITY_WINDOW_MS, 3_000);

  // With no probeTimeoutMs option, the deadline the model arms is the exported
  // constant — read from packages/ribo-core/src/connectivity/connectivity.ts.
  // A source change that moved it fails here.
  const hung = harness({
    probe: () => new Promise<Response>(() => undefined),
  });
  hung.connectivity.start();
  assert.deepEqual(hung.timer.delays, [DEFAULT_PROBE_TIMEOUT_MS]);

  // And with no stabilityWindowMs option, the window armed behind a healthy
  // probe is the other constant.
  const healthy = harness({
    probe: async () => new Response(null, { status: 204 }),
  });
  healthy.connectivity.start();
  await healthy.tick();
  assert.deepEqual(healthy.timer.delays, [DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_STABILITY_WINDOW_MS]);
}
// #endregion defaults

export async function workSafetyIsAGradientWithAHardEdge(): Promise<void> {
  const pending: WorkOnDevice = summarizeWork(
    [{ status: "queued" }],
    [{ status: "awaiting-review" }, { status: "open" }],
  );
  assert.deepEqual(pending, {
    pending: 3,
    dead: 0,
    synced: 0,
    awaitingReview: 1,
    openSessions: 1,
  });

  // Persisted, waiting to sync: protected, never safe — the work is still on
  // the device.
  const waiting = workSafety(pending, "granted", "offline");
  assert.deepEqual(waiting, {
    level: "protected",
    reason: "awaiting-sync",
    pending: 3,
    connectivity: "offline",
  });

  // No persistence grant: at risk of routine eviction, whatever the link says.
  const unpersisted = workSafety(pending, "denied", "online");
  assert.equal(unpersisted.level, "at-risk");

  // A dead item outranks everything: no amount of waiting fixes it.
  const dead = workSafety({ ...pending, dead: 1 }, "granted", "online");
  assert.deepEqual(dead, { level: "action-required", reason: "failed-permanently", dead: 1 });

  // The hard edge: only work that has left the device is `safe`.
  const safe = workSafety(summarizeWork([], [{ status: "done" }]), "granted", "online");
  assert.deepEqual(safe, { level: "safe", reason: "all-synced" });
}
