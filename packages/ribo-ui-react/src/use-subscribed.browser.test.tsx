import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StrictMode, useCallback, useLayoutEffect } from "react";

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

test("a value pushed after the render that seeds state, before the effect subscribes, is not lost", async () => {
  // The gap this guards: `initial` runs during the render that seeds `useState`
  // (capturing 1); `subscribe` only runs afterwards, from useSubscribed's own
  // passive effect. React flushes every layout effect for a commit before any
  // passive effect, so pushing from a layout effect (a legitimate place for a
  // side effect, unlike inside a `useState` initializer) reproduces exactly that
  // gap: by the time useSubscribed's effect calls `subscribe`, the source has
  // already moved past the value `initial` captured. Core's real sources
  // (Recorder, Connectivity) close this gap by calling the listener immediately
  // on subscribe — a mutant that dropped that immediate call would leave this
  // test showing the stale value (1) forever instead of the pushed one (2).
  const source = makeSource(1);
  function Probe() {
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    useLayoutEffect(() => {
      source.push(2); // lands before useSubscribed's passive effect subscribes
    }, []);
    const value = useSubscribed(subscribe, () => source.current);
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
  // because useSubscribed only ever invokes it as useState's lazy initializer —
  // once per mount (twice under StrictMode, never covered here — see the
  // dedicated StrictMode test below) — never as a per-render snapshot check.
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

test("under StrictMode, the double mount/cleanup/remount settles to one subscriber, and zero after unmount", async () => {
  // The playground wraps its root in <StrictMode> (playground/src/main.tsx);
  // vitest-browser-react defaults reactStrictMode to false, so nothing else in
  // this file exercises the mode the real app actually renders in. React 19
  // StrictMode mounts, cleans up, and re-mounts effects (and double-invokes
  // useState lazy initializers) to surface missing cleanup — this asserts the
  // subscription settles to exactly one live listener, not two or zero.
  const source = makeSource(0);
  function Probe() {
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    useSubscribed(subscribe, () => source.current);
    return null;
  }
  const screen = await render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );
  expect(source.size).toBe(1);
  await screen.unmount();
  expect(source.size).toBe(0);
});

test("an unmemoized subscribe loops forever against a source with unstable delivery — pin the caller contract", async () => {
  // Every other test in this file wraps `subscribe` in `useCallback`, per the
  // hook's documented contract. This is what happens if a caller doesn't: an
  // inline arrow gives `subscribe` a new identity every render, so
  // useSubscribed's effect dependency `[subscribe]` changes every render too —
  // cleanup and resubscribe, on every commit. Paired with a source whose
  // immediate delivery-on-subscribe hands back a freshly-allocated object each
  // time (mirroring `Recorder.state`), that delivery is never `Object.is`-equal
  // to the last render's value, so `setValue` schedules another render, forever.
  //
  // To prove this without hanging the browser tab, this double is hard-capped:
  // it stops emitting once RUNAWAY_CAP calls have gone by, rather than relying
  // on React's own "Maximum update depth exceeded" safety net (a React internal
  // this test shouldn't depend on the existence or wording of). If the loop is
  // real, the render count blows straight through the cap before the double
  // goes quiet. If useSubscribed ever stopped needing a memoized `subscribe`,
  // render count would instead settle near 1 and this assertion would fail.
  const RUNAWAY_CAP = 20;
  let calls = 0;

  const renders = vi.fn();
  function Probe() {
    renders();
    // A fresh arrow every render — deliberately NOT wrapped in useCallback,
    // which is the misuse this test pins. A module-scope function here would
    // accidentally be just as stable as a memoized one and prove nothing.
    const subscribe = (listener: (value: { n: number }) => void) => {
      calls++;
      if (calls <= RUNAWAY_CAP) listener({ n: calls }); // fresh object every call
      return () => {};
    };
    const value = useSubscribed(subscribe, () => ({ n: 0 }));
    return <p>{value.n}</p>;
  }

  await render(<Probe />);
  expect(renders.mock.calls.length).toBeGreaterThan(RUNAWAY_CAP);
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
