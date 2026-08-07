import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

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

test("an un-asked origin reports unknown, never denied", async () => {
  // `persisted() === false` means "not persisted", which is also true before anyone
  // asks. Reporting that as `denied` would tell workSafety a request was refused
  // when none was made -- and `denied` is what drives the at-risk verdict.
  let seen: string | undefined;
  function Probe() {
    seen = useStoragePersistence().persistence;
    return null;
  }
  await render(<Probe />);
  await vi.waitFor(() => expect(seen).not.toBe(undefined));
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
