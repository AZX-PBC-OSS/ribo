import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createConnectivity, type Connectivity, type ConnectivityState } from "@azx/ribo-core";

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

test("renders the current connectivity state without a provider when given an instance", async () => {
  // Never `start()`ed, so `isOnline: () => true` is never consulted — the model
  // begins at its own initial state (`offline`) regardless. This asserts the
  // hook faithfully relays that real initial value rather than proving anything
  // about a transition (none has happened) or about `isOnline`/`probe` (neither
  // has been called).
  const connectivity = fakeConnectivity(true);
  function Probe() {
    return <p>status {useConnectivity(connectivity).status}</p>;
  }
  const screen = await render(<Probe />);
  await expect.element(screen.getByText("status offline")).toBeInTheDocument();
});

test("resolves connectivity from the provider", async () => {
  const connectivity = fakeConnectivity(false);
  function Probe() {
    return <p>status {useConnectivity().status}</p>;
  }
  const screen = await render(
    <RiboProvider value={{ connectivity }}>
      <Probe />
    </RiboProvider>,
  );
  await expect.element(screen.getByText("status offline")).toBeInTheDocument();
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
