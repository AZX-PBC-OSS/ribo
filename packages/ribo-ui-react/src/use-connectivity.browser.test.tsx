import { expect, test, vi } from "vitest";
import { render, renderHook } from "vitest-browser-react";
import { StrictMode } from "react";
import {
  createConnectivity,
  type Connectivity,
  type ConnectivityState,
  type ConnectivityStatus,
} from "@azx/ribo-core";

import { RiboProvider } from "./RiboProvider.js";
import { useConnectivity } from "./use-connectivity.js";

// vitest-browser-react@2.2.0's `render` is async — see
// context.browser.test.tsx. Every render below is awaited.

/**
 * A connectivity model over injected seams — no real network, no real events.
 *
 * `probe` resolves a **`Response`**, not a boolean: the contract is "resolve with an
 * ok Response to report healthy", and a non-ok response, a throw or an abort all
 * count as unreachable (`connectivity.ts`).
 */
function fakeConnectivity(online: boolean) {
  return createConnectivity({
    bindEvents: () => () => undefined,
    isOnline: () => online,
    probe: async () => new Response(null, { status: online ? 204 : 503 }),
  });
}

/**
 * A `Connectivity` double with a configurable, non-default `status` and a
 * `subscribed` flag tracking whether its (single) listener is currently live.
 *
 * Two independent needs share this shape:
 *
 *  - The real, un-started `createConnectivity()` model always begins at
 *    `"offline"`, so asserting a rendered `"offline"` against it cannot tell
 *    "the hook reads `instance.state`" apart from "the hook hard-codes
 *    offline" — a bug that would pass every such test. A configurable,
 *    non-default status closes that gap: only a hook that actually reads the
 *    given instance can render it correctly.
 *  - Proving an instance swap unsubscribes the old instance and subscribes
 *    the new one needs to observe each instance's own live-listener state
 *    independently, which the real `Connectivity` has no accessor for.
 */
function makeControllableConnectivity(status: ConnectivityStatus): Connectivity & {
  readonly subscribed: boolean;
} {
  let subscribed = false;
  return {
    get subscribed() {
      return subscribed;
    },
    get state(): ConnectivityState {
      return { status };
    },
    subscribe(listener: (state: ConnectivityState) => void) {
      subscribed = true;
      listener({ status });
      return () => {
        subscribed = false;
      };
    },
    start: () => undefined,
    stop: () => undefined,
  };
}

test("renders the current connectivity state without a provider when given an instance", async () => {
  // A double with a non-default status, not the real (always-"offline")
  // model: asserting "offline" here could never distinguish a hook that
  // genuinely reads `instance.state` from one that just hard-codes "offline"
  // -- both would render identically. Only a real read can produce "online".
  const connectivity = makeControllableConnectivity("online");
  function Probe() {
    return <p>status {useConnectivity(connectivity).status}</p>;
  }
  const screen = await render(<Probe />);
  await expect.element(screen.getByText("status online")).toBeInTheDocument();
});

test("resolves connectivity from the provider", async () => {
  // A different non-default status than the test above, so this test cannot
  // pass by coincidence against a hook that hard-codes some OTHER fixed
  // string either.
  const connectivity = makeControllableConnectivity("probing");
  function Probe() {
    return <p>status {useConnectivity().status}</p>;
  }
  const screen = await render(
    <RiboProvider value={{ connectivity }}>
      <Probe />
    </RiboProvider>,
  );
  await expect.element(screen.getByText("status probing")).toBeInTheDocument();
});

test("an override instance wins over the provider's, same as useRiboInstance", async () => {
  // Both fakes start at the same "offline" status, so asserting on the
  // rendered text would pass even if the wrong instance were resolved --
  // that shape of assertion is exactly what let a real defect in this task's
  // own storage-persistence hook slip past (see use-storage-persistence.ts's
  // fix commit). Spying on each instance's `subscribe` instead proves WHICH
  // object the hook actually subscribed to.
  const provided = fakeConnectivity(false);
  const override = fakeConnectivity(false);
  const overrideSubscribe = vi.spyOn(override, "subscribe");
  const providedSubscribe = vi.spyOn(provided, "subscribe");
  function Probe() {
    return <p>status {useConnectivity(override).status}</p>;
  }
  const screen = await render(
    <RiboProvider value={{ connectivity: provided }}>
      <Probe />
    </RiboProvider>,
  );
  await expect.element(screen.getByText("status offline")).toBeInTheDocument();
  expect(overrideSubscribe).toHaveBeenCalled();
  expect(providedSubscribe).not.toHaveBeenCalled();
});

test("without a provider and without an override, throws the named error", async () => {
  function Probe() {
    return <p>status {useConnectivity().status}</p>;
  }
  await expect(render(<Probe />)).rejects.toThrow(/connectivity/i);
});

test("swapping the instance prop unsubscribes the old one and subscribes the new one", async () => {
  // The pattern-level gap this closes: `subscribe`'s `useCallback` is keyed on
  // `[instance]` in the shipped code, but nothing before this test would
  // notice if it were keyed on `[]` instead -- every other test here hands the
  // hook a single, unchanging instance for its whole lifetime. A `[]` key
  // would mean the effect never re-runs when `instance` changes, so the old
  // instance is never unsubscribed and the new one is never subscribed to at
  // all. Verified by hand: re-keying to `[]` turns this test red (see the
  // task report for the isolated run).
  const a = makeControllableConnectivity("offline");
  const b = makeControllableConnectivity("online");
  const { result, rerender } = await renderHook(
    (connectivity?: Connectivity) => useConnectivity(connectivity),
    { initialProps: a },
  );
  expect(result.current.status).toBe("offline");
  expect(a.subscribed).toBe(true);
  expect(b.subscribed).toBe(false);

  await rerender(b);

  expect(a.subscribed).toBe(false);
  expect(b.subscribed).toBe(true);
  expect(result.current.status).toBe("online");
});

/**
 * A `Connectivity` double whose `subscribe` allocates a fresh state object on
 * every call and stops emitting past `cap` -- the same hard-cap trick
 * `use-subscribed.browser.test.tsx`'s "unmemoized subscribe" test uses, and for
 * the same reason: an unmemoized `subscribe` inside `useConnectivity` reproduces
 * a *genuine* infinite render loop against the real `Connectivity.state`
 * getter (verified by hand: removing the hook's `useCallback` hangs a real
 * Chromium tab console-spamming "Maximum update depth exceeded" faster than
 * either React's own safety net or vitest's `testTimeout` reliably intervenes --
 * the tight synchronous re-render loop starves the event loop the timeout timer
 * needs to fire on). A test that could hang the whole suite is not a usable
 * regression test, so this fake caps the loop itself and asserts on a bounded
 * render count instead of relying on the real model to ever stop.
 */
function makeRunawayConnectivity(cap: number): Connectivity {
  let calls = 0;
  return {
    get state(): ConnectivityState {
      return { status: "offline" };
    },
    subscribe(listener: (state: ConnectivityState) => void) {
      calls += 1;
      if (calls <= cap) listener({ status: "offline" }); // fresh object every call
      return () => undefined;
    },
    start: () => undefined,
    stop: () => undefined,
  };
}

test("does not loop against Connectivity's allocating state -- pins the memoized-subscribe contract", async () => {
  const RUNAWAY_CAP = 20;
  const connectivity = makeRunawayConnectivity(RUNAWAY_CAP);
  const renders = vi.fn();
  function Probe() {
    renders();
    return <p>status {useConnectivity(connectivity).status}</p>;
  }
  await render(<Probe />);
  // A correctly memoized `subscribe` subscribes once and never loops, so this
  // stays near 1. An unmemoized `subscribe` blows straight through the cap
  // before the fake goes quiet -- see the file comment above for why this
  // fake exists instead of asserting against the real Connectivity model.
  expect(renders.mock.calls.length).toBeLessThan(RUNAWAY_CAP);
});

/**
 * A `Connectivity` double that tracks how many listeners are currently live,
 * mirroring `use-subscribed.browser.test.tsx`'s `makeSource`. The real
 * `Connectivity` returned by `createConnectivity` has no public listener-count
 * accessor, so proving StrictMode's double mount/cleanup/remount settles to
 * exactly one live subscription -- not two, not zero -- needs a double built
 * for it.
 */
function makeCountingConnectivity(): Connectivity & { readonly liveCount: number } {
  let liveCount = 0;
  return {
    get liveCount() {
      return liveCount;
    },
    get state(): ConnectivityState {
      return { status: "offline" };
    },
    subscribe(listener: (state: ConnectivityState) => void) {
      liveCount += 1;
      listener({ status: "offline" });
      return () => {
        liveCount -= 1;
      };
    },
    start: () => undefined,
    stop: () => undefined,
  };
}

test("under StrictMode, the double mount/cleanup/remount settles to one live subscription, and zero after unmount", async () => {
  // playground/src/main.tsx wraps the real app in <StrictMode>; vitest-browser-react
  // defaults reactStrictMode to false, so nothing else in this file exercises the
  // mode the real app actually renders in. React 19 StrictMode mounts, cleans up,
  // and re-mounts effects to surface missing cleanup -- this asserts the
  // subscription settles to exactly one live listener, not two or zero, matching
  // use-subscribed.browser.test.tsx's own StrictMode test for the underlying hook.
  const connectivity = makeCountingConnectivity();
  function Probe() {
    return <p>status {useConnectivity(connectivity).status}</p>;
  }
  const screen = await render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );
  await expect.element(screen.getByText("status offline")).toBeInTheDocument();
  expect(connectivity.liveCount).toBe(1);
  await screen.unmount();
  expect(connectivity.liveCount).toBe(0);
});
