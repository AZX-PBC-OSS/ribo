import { expect, test, vi } from "vitest";
import { render, renderHook } from "vitest-browser-react";
import { StrictMode } from "react";
import { openOutbox, Recorder, RecorderError } from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import type { AnyRecorder } from "./context.js";
import type { UseRecorderResult } from "./use-recorder.js";
import { useRecorder } from "./use-recorder.js";

/**
 * A `Recorder` subclass that reports a fixed, caller-chosen `level`, so
 * `scaleLevel`'s curve can be pinned at real, non-zero points without a
 * microphone.
 *
 * `Recorder`'s `#level` is a true private (`#`) field, mutated only by its own
 * tick logic against a live analyser reading real audio — there is no public
 * seam to set it directly, and `scaleLevel` itself is module-private (not
 * exported from `use-recorder.ts`). Overriding the public, non-private `state`
 * getter works around both: `Recorder`'s own methods (`subscribe`, `#emit`)
 * call `this.state` polymorphically, so a subclass override is honored
 * regardless of where within the class the call originates, and the level
 * that reaches `useRecorder` is exactly the one this double chooses.
 */
class FixedLevelRecorder extends Recorder {
  readonly #fixedLevel: number;

  constructor(fixedLevel: number) {
    super();
    this.#fixedLevel = fixedLevel;
  }

  override get state() {
    return { ...super.state, level: this.#fixedLevel };
  }
}

// vitest-browser-react@2.2.0's `render` is async (it awaits React's commit before
// returning) — see context.browser.test.tsx and use-connectivity.browser.test.tsx.
// The brief's own sample tests call `render(<Probe />)` unawaited and, for the
// throwing case, `expect(() => render(<Probe />)).toThrow(...)`; both are wrong
// against this version of vitest-browser-react. A component that throws during
// render surfaces as a *rejected* `render()` promise, not a synchronous throw
// (`render` itself is an async function, so even a same-tick throw is converted
// to a rejection). Every render below is awaited, and the throwing test uses
// `await expect(render(...)).rejects.toThrow(...)`, matching every other
// `.browser.test.tsx` in this package.

/**
 * Wraps a real `Recorder`'s `subscribe` to count *live* (not yet unsubscribed)
 * listeners.
 *
 * `Recorder` is a concrete class with private `#fields`, unlike `Connectivity`
 * (an interface) — so, unlike `use-connectivity.browser.test.tsx`'s hand-built
 * doubles, a `useRecorder` test cannot fabricate a duck-typed stand-in and must
 * instrument a real instance instead. `vi.spyOn` + `mockImplementation` still
 * calls through to the original `subscribe`, so the recorder behaves exactly as
 * it always did; only the live-count bookkeeping is added on top.
 */
function trackLiveSubscriptions(recorder: AnyRecorder): { readonly liveCount: number } {
  let liveCount = 0;
  const original = recorder.subscribe.bind(recorder);
  vi.spyOn(recorder, "subscribe").mockImplementation((listener) => {
    liveCount += 1;
    const unsubscribe = original(listener);
    return () => {
      liveCount -= 1;
      unsubscribe();
    };
  });
  return {
    get liveCount() {
      return liveCount;
    },
  };
}

test("scaledLevel spreads the raw level, which is why the hook owns the curve", async () => {
  // Raw RMS for speech sits low enough that a bar at `level * 100%` barely leaves
  // the left edge. Every consumer would otherwise rediscover this and pick its own
  // curve — doc 04 assigns the mapping to the meter, and a headless package has no
  // meter, so the hook owns it.
  let seen: { level: number; scaledLevel: number } | undefined;
  const recorder = new Recorder();
  function Probe() {
    const { level, scaledLevel } = useRecorder({ recorder, enqueue: false });
    seen = { level, scaledLevel };
    return null;
  }
  await render(<Probe />);
  expect(seen).toEqual({ level: 0, scaledLevel: 0 });
});

test("scaledLevel follows Math.sqrt of the raw level, pinned at real, non-zero points", async () => {
  // The zero-point test above only pins scaleLevel(0) === 0, which every
  // monotonic curve through the origin satisfies -- `level * 2` passes it just
  // as well as `Math.sqrt`. These two points are chosen so `Math.sqrt(level)`
  // and `level * 2` disagree at both (0.09 -> 0.3 vs 0.18; 0.49 -> 0.7 vs 0.98),
  // so a curve-shape regression is caught even if it happens to preserve the
  // origin.
  const points: ReadonlyArray<readonly [level: number, scaledLevel: number]> = [
    [0.09, 0.3],
    [0.49, 0.7],
  ];
  for (const [level, expectedScaledLevel] of points) {
    const recorder = new FixedLevelRecorder(level);
    let seen: { level: number; scaledLevel: number } | undefined;
    function Probe() {
      const api = useRecorder({ recorder, enqueue: false });
      seen = { level: api.level, scaledLevel: api.scaledLevel };
      return null;
    }
    const screen = await render(<Probe />);
    expect(seen).toEqual({ level, scaledLevel: expectedScaledLevel });
    await screen.unmount();
  }
});

test("records, and enqueues the capture on stop by default", async () => {
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  const recorder = new Recorder();
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, outbox, sessionId: "test-session" });
    return <p>phase {api.phase}</p>;
  }
  const screen = await render(<Probe />);

  await api!.start();
  await expect.element(screen.getByText("phase recording")).toBeInTheDocument();
  const { item } = await api!.stop();

  // The durability promise: bytes reach disk without the host wiring it up.
  expect(item).toBeDefined();
  expect(await outbox.get(item!.id)).toBeDefined();
  await outbox.close();
});

test("enqueue: false returns the capture and writes nothing", async () => {
  const recorder = new Recorder();
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return null;
  }
  await render(<Probe />);

  await api!.start();
  const { capture, item } = await api!.stop();
  expect(item).toBeUndefined();
  expect(capture.audio.size).toBeGreaterThan(0);
});

test("surfaces pause and resume, and the phase they produce", async () => {
  const recorder = new Recorder();
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return <p>phase {api.phase}</p>;
  }
  const screen = await render(<Probe />);

  await api!.start();
  api!.pause();
  await expect.element(screen.getByText("phase paused")).toBeInTheDocument();
  api!.resume();
  await expect.element(screen.getByText("phase recording")).toBeInTheDocument();
  await api!.stop();
});

test("a stop() failure sets error state AND rejects the returned promise", async () => {
  // Asymmetric with start(): start() swallows a failure into `error` state and
  // resolves either way, but stop() both records the failure in `error` state
  // and re-throws it -- see use-recorder.ts's doc comment for why. Calling
  // stop() while idle drives a real `RecorderError("not-recording", ...)` out
  // of `Recorder.stop()` itself, no fake needed.
  const recorder = new Recorder();
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return null;
  }
  await render(<Probe />);

  await expect(api!.stop()).rejects.toThrow(RecorderError);
  await vi.waitFor(() => {
    expect(api!.error).toBeInstanceOf(RecorderError);
    expect(api!.error?.code).toBe("not-recording");
  });
});

test("a denied microphone surfaces as a RecorderError with a branchable code", async () => {
  // A string message would force every host to pattern-match prose. `.code` is
  // what distinguishes "ask the user to allow the mic" from "there is no mic".
  const recorder = new Recorder({
    getUserMedia: () => Promise.reject(new DOMException("no", "NotAllowedError")),
  });
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return null;
  }
  await render(<Probe />);

  await api!.start();
  await vi.waitFor(() => {
    expect(api!.error).toBeInstanceOf(RecorderError);
    expect(api!.error?.code).toBe("permission-denied");
  });
});

test("enqueue defaults on, so a missing outbox fails loudly rather than dropping audio", async () => {
  const recorder = new Recorder();
  function Probe() {
    useRecorder({ recorder });
    return null;
  }
  await expect(render(<Probe />)).rejects.toThrow(/outbox/i);
});

test("toggle starts when idle and stops when recording", async () => {
  const recorder = new Recorder();
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return <p>phase {api.phase}</p>;
  }
  const screen = await render(<Probe />);

  await api!.toggle();
  await expect.element(screen.getByText("phase recording")).toBeInTheDocument();

  await api!.toggle();
  await expect.element(screen.getByText("phase idle")).toBeInTheDocument();
});

test("busy is true while start() is in flight, and false once it settles", async () => {
  let resolveMedia!: (stream: MediaStream) => void;
  const pending = new Promise<MediaStream>((resolve) => {
    resolveMedia = resolve;
  });
  const recorder = new Recorder({ getUserMedia: () => pending });
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return <p>busy {String(api.busy)}</p>;
  }
  const screen = await render(<Probe />);

  const startPromise = api!.start();
  await expect.element(screen.getByText("busy true")).toBeInTheDocument();

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  resolveMedia(stream);
  await startPromise;

  await expect.element(screen.getByText("busy false")).toBeInTheDocument();
  await api!.stop();
});

test("swapping the recorder prop unsubscribes the old one and subscribes the new one", async () => {
  // The pattern-level gap this closes: `subscribe`'s `useCallback` is keyed on
  // `[recorder]` in the shipped code, but nothing before this test would notice
  // if it were keyed on `[]` instead -- every other test here hands the hook a
  // single, unchanging recorder for its whole lifetime. A `[]` key would mean the
  // effect never re-runs when `recorder` changes, so the old recorder is never
  // unsubscribed and the new one is never subscribed to at all. Verified by hand:
  // re-keying to `[]` turns this test red (see the task report for the isolated
  // run).
  const a = new Recorder();
  const b = new Recorder();
  const aTracker = trackLiveSubscriptions(a);
  const bTracker = trackLiveSubscriptions(b);

  const { result, rerender } = await renderHook<AnyRecorder, UseRecorderResult>(
    (recorder) => useRecorder({ recorder, enqueue: false }),
    { initialProps: a },
  );
  expect(result.current.phase).toBe("idle");
  expect(aTracker.liveCount).toBe(1);
  expect(bTracker.liveCount).toBe(0);

  await rerender(b);

  expect(aTracker.liveCount).toBe(0);
  expect(bTracker.liveCount).toBe(1);
});

test("under StrictMode, the double mount/cleanup/remount settles to one live subscription, and zero after unmount", async () => {
  // playground/src/main.tsx wraps the real app in <StrictMode>; vitest-browser-react
  // defaults reactStrictMode to false, so nothing else in this file exercises the
  // mode the real app actually renders in. React 19 StrictMode mounts, cleans up,
  // and re-mounts effects to surface missing cleanup -- this asserts the
  // subscription settles to exactly one live listener, not two or zero, matching
  // use-connectivity.browser.test.tsx's and use-subscribed.browser.test.tsx's own
  // StrictMode tests.
  const recorder = new Recorder();
  const tracker = trackLiveSubscriptions(recorder);
  function Probe() {
    const { phase } = useRecorder({ recorder, enqueue: false });
    return <p>phase {phase}</p>;
  }
  const screen = await render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );
  await expect.element(screen.getByText("phase idle")).toBeInTheDocument();
  expect(tracker.liveCount).toBe(1);
  await screen.unmount();
  expect(tracker.liveCount).toBe(0);
});
