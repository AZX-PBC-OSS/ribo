import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useCallback } from "react";

import { useSubscribed } from "./use-subscribed.js";

// vitest-browser-react@2.2.0's `render` (and its `RenderResult.unmount`) are
// async — see context.browser.test.tsx. Every render below is awaited.

/** A minimal push source with the same contract as `Recorder.subscribe`. */
function makeSource(initial: number) {
  const listeners = new Set<(value: number) => void>();
  let current = initial;
  return {
    get current() {
      return current;
    },
    push(value: number) {
      current = value;
      for (const listener of listeners) listener(value);
    },
    subscribe(listener: (value: number) => void) {
      listeners.add(listener);
      listener(current); // immediately, like core's sources
      return () => listeners.delete(listener);
    },
    get size() {
      return listeners.size;
    },
  };
}

test("renders the pushed value and updates on push", async () => {
  const source = makeSource(1);
  function Probe() {
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    return <p>value {useSubscribed(subscribe, () => source.current)}</p>;
  }

  const screen = await render(<Probe />);
  await expect.element(screen.getByText("value 1")).toBeInTheDocument();

  source.push(2);
  await expect.element(screen.getByText("value 2")).toBeInTheDocument();
});

test("a value pushed between the render that seeds state and the effect that subscribes is not lost", async () => {
  // The gap this guards: `initial` runs during the render that seeds `useState`;
  // `subscribe` only runs afterwards, from the effect. If anything changed the
  // source in between, a hook that doesn't re-check on subscribe would show the
  // stale value forever. Core's real sources (Recorder, Connectivity) close this
  // gap by calling the listener immediately on subscribe; this test pushes a new
  // value from inside `initial` itself — the last possible moment before the
  // effect runs — to prove that push is not dropped.
  const source = makeSource(1);
  let pushedInGap = false;
  function Probe() {
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    const value = useSubscribed(subscribe, () => {
      const snapshot = source.current;
      if (!pushedInGap) {
        pushedInGap = true;
        source.push(2); // lands in the render → effect-subscribe gap
      }
      return snapshot;
    });
    return <p>value {value}</p>;
  }

  const screen = await render(<Probe />);
  await expect.element(screen.getByText("value 2")).toBeInTheDocument();
});

test("an unstable initial value does not loop — the whole reason this isn't useSyncExternalStore", async () => {
  // The bug this helper avoids: useSyncExternalStore calls getSnapshot on every
  // render to check for tearing, so a snapshot that is a fresh object every call
  // (like Recorder.state) never compares equal and React re-renders forever.
  // `initial` here is exactly that: a new object identity every call. It's safe
  // because useSubscribed only ever invokes it once, as useState's lazy
  // initializer — never as a per-render snapshot check.
  const source = makeSource(0);
  const renders = vi.fn();
  function Probe() {
    renders();
    const subscribe = useCallback(
      (listener: (value: { n: number }) => void) => source.subscribe((n) => listener({ n })),
      [],
    );
    const value = useSubscribed(subscribe, () => ({ n: source.current }));
    return <p>{value.n}</p>;
  }

  await render(<Probe />);
  expect(renders.mock.calls.length).toBeLessThan(10);
});

test("render count stays bounded across a run of pushes, not one render per emission plus a loop", async () => {
  const source = makeSource(0);
  const renders = vi.fn();
  function Probe() {
    renders();
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    return <p>{useSubscribed(subscribe, () => source.current)}</p>;
  }

  await render(<Probe />);
  for (let i = 1; i <= 5; i++) source.push(i);
  // 1 initial render + 5 pushes = 6. A generous ceiling that would still catch
  // an actual re-render loop (which would blow far past it) without being
  // brittle about React's own render scheduling.
  expect(renders.mock.calls.length).toBeLessThan(10);
});

test("unsubscribes on unmount", async () => {
  const source = makeSource(0);
  function Probe() {
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    useSubscribed(subscribe, () => source.current);
    return null;
  }
  const screen = await render(<Probe />);
  expect(source.size).toBeGreaterThan(0);
  await screen.unmount();
  expect(source.size).toBe(0);
});
