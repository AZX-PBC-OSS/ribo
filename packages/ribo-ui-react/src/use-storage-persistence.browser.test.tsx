import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StrictMode } from "react";

import { useStoragePersistence } from "./use-storage-persistence.js";

// vitest-browser-react@2.2.0's `render` is async — see
// context.browser.test.tsx. Every render below is awaited.
//
// The module-level store in use-storage-persistence.ts is shared by every
// caller *within one page* — that is its whole point (see the hook's doc
// comment). It means test order in this file matters: the one test that
// actually calls `request()` and mutates the real grant runs LAST, so it
// cannot leak a "granted"/"denied" decision into the tests above it that mean
// to observe an un-asked origin.

test("reports a persistence grant from the real Storage API", async () => {
  function Probe() {
    return <p>persistence {useStoragePersistence().persistence}</p>;
  }
  const screen = await render(<Probe />);
  // Real Chromium: `persisted()` resolves, so the value must settle to one of the
  // four honest states and must not stay "unknown" forever... except this origin
  // has not been asked yet, so "unknown" *is* the honest answer here. This test
  // only proves the hook renders a real value from the four-state vocabulary,
  // not which one.
  await expect
    .element(screen.getByText(/persistence (granted|denied|unsupported|unknown)/))
    .toBeInTheDocument();
});

test("renders a real value under StrictMode too", async () => {
  // playground/src/main.tsx wraps the real app in <StrictMode>; vitest-browser-react
  // defaults reactStrictMode to false, so nothing else in this file exercises the
  // mode the real app actually renders in. Same honestly-weak scope as the test
  // above -- this does not call `request()` or assert which vocabulary member
  // renders, only that StrictMode's double mount/cleanup/remount settles to a
  // real value rather than a stuck or duplicated one. Placed before the tests
  // below that depend on the module-level snapshot still being "unknown": this
  // one never asks for persistence, so it cannot flip that shared state.
  function Probe() {
    return <p>persistence {useStoragePersistence().persistence}</p>;
  }
  const screen = await render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );
  await expect
    .element(screen.getByText(/persistence (granted|denied|unsupported|unknown)/))
    .toBeInTheDocument();
});

test("an un-asked origin reports unknown, never denied", async () => {
  // `persisted() === false` means "not persisted", which is also true before anyone
  // asks. Reporting that as `denied` would tell workSafety a request was refused
  // when none was made -- and `denied` is what drives the at-risk verdict.
  //
  // This must wait for the mount's own `readStorage()`/`persisted()` call to
  // actually settle before asserting -- NOT merely for `seen` to be defined.
  // `seen` is already "unknown" (the module's synchronous initial value)
  // before that async call ever resolves, so a `not.toBe(undefined)` guard is
  // a no-op: in isolation it is satisfied on the very first render and the
  // assertion below fires against the pre-refresh value, never observing
  // whatever `readStorage()` actually produced. (It went red anyway when this
  // whole file ran in order, only because the *previous* test's mount had
  // already resolved its own `readStorage()` and mutated the shared
  // module-level snapshot by the time this one mounted -- an accident of file
  // order, not synchronization this test performs, and exactly the kind of
  // false-negative-in-isolation this comment exists to rule out.)
  //
  // `publish()` always allocates a fresh snapshot object
  // (`{ ...snapshot, ...next }`), and `useSubscribed` re-renders on ANY new
  // object identity even when every field is unchanged -- so counting renders
  // past the initial mount is a value-independent signal that the refresh
  // cycle actually completed, whether or not the answer changed.
  const renders = vi.fn();
  let seen: string | undefined;
  function Probe() {
    renders();
    seen = useStoragePersistence().persistence;
    return null;
  }
  await render(<Probe />);
  await vi.waitFor(() => expect(renders.mock.calls.length).toBeGreaterThan(1));
  expect(seen).not.toBe("denied");
});

test("exposes a storage estimate", async () => {
  let seen: StorageEstimate | undefined;
  function Probe() {
    seen = useStoragePersistence().estimate;
    return null;
  }
  await render(<Probe />);
  await vi.waitFor(() => expect(seen?.quota).toBeGreaterThan(0));
});

test("two consumers see one shared grant, not independent copies", async () => {
  // The bug this shape prevents: with per-hook state, granting persistence in one
  // component leaves every other consumer -- including useWorkSafety -- reporting
  // the old value, so the app can say "at risk" about a device it just protected.
  const seen: string[] = [];
  function Granter() {
    const { request } = useStoragePersistence();
    return (
      <button type="button" onClick={() => void request()}>
        grant
      </button>
    );
  }
  function Observer() {
    const { persistence } = useStoragePersistence();
    seen.push(persistence);
    return <p>observer {persistence}</p>;
  }

  const screen = await render(
    <>
      <Granter />
      <Observer />
    </>,
  );
  await screen.getByRole("button", { name: "grant" }).click();

  // The observer never called request(), so it can only know via the shared
  // store. Whether the headless browser actually grants or refuses the request
  // is outside our control (site-engagement heuristics) -- what this proves is
  // that *some* decision, not "unknown", reached the Observer without it ever
  // asking.
  await vi.waitFor(() => expect(seen.at(-1)).not.toBe("unknown"));
});
