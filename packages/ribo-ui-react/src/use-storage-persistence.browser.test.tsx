import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StrictMode } from "react";

import { useStoragePersistence } from "./use-storage-persistence.js";

// vitest-browser-react@2.2.0's `render` is async — see
// context.browser.test.tsx. Every render below is awaited.
//
// The module-level store in use-storage-persistence.ts is shared by every
// caller *within one page* — that is its whole point (see the hook's doc
// comment). It means test order in this file matters: the tests that observe
// an un-asked origin run FIRST, before any test mocks `navigator.storage` or
// calls `request()` and mutates the real grant. Every test from "two
// consumers" onward mocks `navigator.storage.persist`/`persisted` and
// restores the spies before returning, so it cannot leak a decision into a
// later test either.

test("reports a persistence grant from the real Storage API", async () => {
  // Checking the DOM for any of the four vocabulary members is not enough on
  // its own: "unknown" is also the pre-refresh module default, so a hook that
  // never actually called the Storage API at all -- always stuck on that
  // default -- would satisfy this check on the very first paint, before any
  // real work happened. Spying on `persisted()` and waiting for it to have
  // actually been called is what proves the real API work happened, rather
  // than trusting a coincidentally-matching default.
  const persistedSpy = vi.spyOn(navigator.storage, "persisted");
  try {
    function Probe() {
      return <p>persistence {useStoragePersistence().persistence}</p>;
    }
    const screen = await render(<Probe />);
    await vi.waitFor(() => expect(persistedSpy).toHaveBeenCalled());
    await expect
      .element(screen.getByText(/persistence (granted|denied|unsupported|unknown)/))
      .toBeInTheDocument();
  } finally {
    persistedSpy.mockRestore();
  }
});

test("renders a real value under StrictMode too", async () => {
  // playground/src/main.tsx wraps the real app in <StrictMode>; vitest-browser-react
  // defaults reactStrictMode to false, so nothing else in this file exercises the
  // mode the real app actually renders in. This must use the same spy-based proof
  // as the test above rather than a render-count wait: StrictMode's own
  // render-phase/effect double-invocation inflates the render count on its own,
  // regardless of whether refresh() does anything real -- confirmed by hand, a
  // render-count version of this test kept passing with the mount-refresh
  // disabled entirely, while the equivalent non-StrictMode test correctly went
  // red under the same mutation. Placed before the tests below that depend on
  // the module-level snapshot still being "unknown": this one never asks for
  // persistence, so it cannot flip that shared state.
  const persistedSpy = vi.spyOn(navigator.storage, "persisted");
  try {
    function Probe() {
      return <p>persistence {useStoragePersistence().persistence}</p>;
    }
    const screen = await render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await vi.waitFor(() => expect(persistedSpy).toHaveBeenCalled());
    await expect
      .element(screen.getByText(/persistence (granted|denied|unsupported|unknown)/))
      .toBeInTheDocument();
  } finally {
    persistedSpy.mockRestore();
  }
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
  //
  // `persist()` and `persisted()` are both pinned here rather than left to the
  // real headless-Chromium heuristic. That pinning is what makes this test
  // actually discriminate a per-hook (non-shared) reimplementation: with
  // `persisted()` permanently answering "not persisted" for every caller,
  // Observer -- which never calls `request()` -- has no way to independently
  // learn "granted" from its OWN mount-time `readStorage()` call. The only
  // remaining path to "granted" is Granter's `publish()` reaching Observer
  // through the shared module store. Without this pinning, a per-hook
  // reimplementation could accidentally pass: Observer's own mount-time
  // `readStorage()` asks the same real browser origin Granter just granted,
  // and could observe that real change directly, with no sharing involved at
  // all -- proving nothing about the mechanism this test exists to pin.
  const persistSpy = vi.spyOn(navigator.storage, "persist").mockResolvedValue(true);
  const persistedSpy = vi.spyOn(navigator.storage, "persisted").mockResolvedValue(false);
  try {
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

    // The observer never called request(), and its own persisted() reads are
    // pinned to "false" forever -- so "granted" can only have reached it
    // through the shared store.
    await vi.waitFor(() => expect(seen.at(-1)).toBe("granted"));
  } finally {
    persistSpy.mockRestore();
    persistedSpy.mockRestore();
  }
});

test("a plain refresh after a denial does not revert it back to unknown", async () => {
  // The bug this pins: `request()` resolving "denied" is a real, non-theoretical
  // refusal, and `persisted()` legitimately keeps answering `false` afterward --
  // nothing was granted, so there is nothing for it to report otherwise. A later
  // *plain* refresh (this component's own re-mount, or -- the real-world
  // trigger -- a second consumer like `useWorkSafety` mounting after the
  // request already settled) must not read that same honest `false` and
  // downgrade the known refusal back to "unknown", which would tell a reviewer
  // the request is "still being checked" forever, after the browser already
  // answered. Unlike the transient-rejection test below, `persisted()` here
  // never throws -- it consistently, correctly returns `false` on every call --
  // so this is not a race or a failure path, only the ordinary case of asking
  // twice after a refusal.
  const persistSpy = vi.spyOn(navigator.storage, "persist").mockResolvedValue(false);
  const persistedSpy = vi.spyOn(navigator.storage, "persisted").mockResolvedValue(false);
  try {
    const renders = vi.fn();
    let seen: string | undefined;
    let request: (() => Promise<string>) | undefined;
    let refresh: (() => void) | undefined;
    function Probe() {
      renders();
      const result = useStoragePersistence();
      seen = result.persistence;
      request = result.request;
      refresh = result.refresh;
      return null;
    }
    await render(<Probe />);
    // Wait for the mount's own natural refresh to settle first -- same
    // sequencing note as the transient-rejection test below: skipping this
    // lets the mount's real (here, mocked-false) `readStorage()` resolve
    // *after* `request()` below, which would also produce "unknown", but for
    // an unsequenced-test-setup reason rather than the one this test exists
    // to catch.
    await vi.waitFor(() => expect(renders.mock.calls.length).toBeGreaterThan(1));

    await request?.();
    await vi.waitFor(() => expect(seen).toBe("denied"));

    const rendersBeforeRefresh = renders.mock.calls.length;
    refresh?.();
    // `persisted()` resolves normally (no throw) in this refresh cycle, so
    // `publish()` fires and a render happens -- that render is the
    // value-independent signal the refresh cycle actually ran, the same
    // idiom the two tests below use for the same reason.
    await vi.waitFor(() => expect(renders.mock.calls.length).toBeGreaterThan(rendersBeforeRefresh));
    expect(seen).toBe("denied");
  } finally {
    persistSpy.mockRestore();
    persistedSpy.mockRestore();
  }
});

test("a plain refresh after a grant downgrades it to unknown once persisted() stops confirming it", async () => {
  // The mirror of the denial test above, and the sharper of the two failure
  // modes: `publish`'s merge preserving a known "denied" against a plain
  // `false` read equally preserves a known "granted" against one -- so a
  // refresh AFTER the browser has revoked or lost the grant (the user cleared
  // site data; a private-browsing session that never really persisted)
  // must not go on reporting "granted". Continuing to claim it would tell
  // `useWorkSafety`'s verdict -- and so the reviewer -- that a device's
  // recordings are protected from eviction after the browser has said
  // otherwise, which is worse than the "still checking" regression the
  // denial-preserving test guards against. `persisted()` here answers `false`
  // plainly and consistently, same as that test -- this is not a race or a
  // throw, only the ordinary case of asking again after the grant no longer
  // holds.
  const persistSpy = vi.spyOn(navigator.storage, "persist").mockResolvedValue(true);
  try {
    const renders = vi.fn();
    let seen: string | undefined;
    let request: (() => Promise<string>) | undefined;
    let refresh: (() => void) | undefined;
    function Probe() {
      renders();
      const result = useStoragePersistence();
      seen = result.persistence;
      request = result.request;
      refresh = result.refresh;
      return null;
    }
    await render(<Probe />);
    await vi.waitFor(() => expect(renders.mock.calls.length).toBeGreaterThan(1));

    await request?.();
    await vi.waitFor(() => expect(seen).toBe("granted"));

    const rendersBeforeRefresh = renders.mock.calls.length;
    const persistedSpy = vi.spyOn(navigator.storage, "persisted").mockResolvedValue(false);
    try {
      refresh?.();
      await vi.waitFor(() =>
        expect(renders.mock.calls.length).toBeGreaterThan(rendersBeforeRefresh),
      );
      // Exactly "unknown", not "denied": this read never saw a persist() call
      // refuse anything, so asserting a refusal would invent information the
      // read does not have.
      expect(seen).toBe("unknown");
    } finally {
      persistedSpy.mockRestore();
    }
  } finally {
    persistSpy.mockRestore();
  }
});

test("an older request() call cannot overwrite a newer one's result, however the two settle", async () => {
  // The concurrency gap named in review: nothing ordered two overlapping
  // `request()` calls, and this is not hypothetical -- `StoragePanel` calls
  // `request()` from a mount effect, and React's StrictMode runs every mount
  // effect twice. Simulated here with two persist() calls resolved OUT OF
  // invocation order: the SECOND (newer) call settles first, with a real
  // grant; the FIRST (older, now-stale) call settles after it, with a
  // refusal. Without an invocation-ordered token, the older call's
  // later-arriving publish wins on settle order and silently downgrades the
  // fresh grant back to "denied" -- for no reason but timing.
  // `persisted()` is pinned to `true` for the whole test -- not to exercise
  // it, but to remove it as a variable: the component's own mount-time
  // `refresh()` runs concurrently with the two `request()` calls below and
  // otherwise races them for real (this file's `persisted()` is genuinely
  // async), which would make an unrelated, unmocked read the thing that
  // decides whether this test passes rather than the ordering under test.
  // Pinned "true" agrees with the eventual "granted" outcome either way, so a
  // stray publish from it cannot manufacture a false pass OR a false fail.
  const persistedSpy = vi.spyOn(navigator.storage, "persisted").mockResolvedValue(true);
  let resolveOlder: ((granted: boolean) => void) | undefined;
  let resolveNewer: ((granted: boolean) => void) | undefined;
  const persistSpy = vi
    .spyOn(navigator.storage, "persist")
    .mockImplementationOnce(() => new Promise((resolve) => (resolveOlder = resolve)))
    .mockImplementationOnce(() => new Promise((resolve) => (resolveNewer = resolve)));
  try {
    let seen: string | undefined;
    let request: (() => Promise<string>) | undefined;
    function Probe() {
      const result = useStoragePersistence();
      seen = result.persistence;
      request = result.request;
      return null;
    }
    await render(<Probe />);

    const older = request?.();
    const newer = request?.();
    if (resolveOlder === undefined || resolveNewer === undefined) {
      throw new Error("both request() calls must have called persist() by now");
    }

    // Newer settles FIRST, with a real grant.
    resolveNewer(true);
    await newer;
    await vi.waitFor(() => expect(seen).toBe("granted"));

    // Older settles SECOND (later in wall-clock time), with a refusal.
    resolveOlder(false);
    const olderResult = await older;

    // The older call's own return value still honestly reports what ITS
    // persist() call answered -- only the shared published state must not
    // move because of it.
    expect(olderResult).toBe("denied");
    expect(seen).toBe("granted");
  } finally {
    persistSpy.mockRestore();
    persistedSpy.mockRestore();
  }
});

test("a thrown persist() does not downgrade a known-good grant to denied", async () => {
  // The bug this pins: `request()`'s catch used to fold ANY thrown `persist()`
  // into `granted = "denied"` and publish it unconditionally. That runs on
  // every app boot -- `StoragePanel` calls `request()` from a mount effect --
  // so a transient throw on a LATER call would downgrade an already-known
  // `"granted"` to a manufactured refusal. A throw is not a resolved `false`;
  // it never told anyone the grant was refused, only that asking failed. The
  // hook's own doc comment reserves `"denied"` for an actual `persist()` that
  // resolved `false`, and this is the one path in the file that broke it.
  const persistSpy = vi.spyOn(navigator.storage, "persist").mockResolvedValueOnce(true);
  try {
    const renders = vi.fn();
    let seen: string | undefined;
    let request: (() => Promise<string>) | undefined;
    function Probe() {
      renders();
      const result = useStoragePersistence();
      seen = result.persistence;
      request = result.request;
      return null;
    }
    await render(<Probe />);
    await vi.waitFor(() => expect(renders.mock.calls.length).toBeGreaterThan(1));

    await request?.();
    await vi.waitFor(() => expect(seen).toBe("granted"));

    persistSpy.mockRejectedValueOnce(new Error("transient failure"));
    const result = await request?.();

    // Neither the published, shared state nor this call's own return value
    // says "denied" -- both report the best currently-known answer, which is
    // the grant that was already there, because the throw told nobody anything.
    expect(seen).toBe("granted");
    expect(result).toBe("granted");
  } finally {
    persistSpy.mockRestore();
  }
});

test("a transient persisted() rejection does not overwrite a known-good grant", async () => {
  // The data-loss case: a user already granted persistence (real or
  // simulated), and some LATER refresh's persisted() call happens to reject
  // (a real, non-theoretical possibility -- the Storage API can throw under
  // resource pressure). That failure must not tell workSafety the device just
  // became unprotected.
  const persistSpy = vi.spyOn(navigator.storage, "persist").mockResolvedValueOnce(true);
  try {
    const renders = vi.fn();
    let seen: string | undefined;
    let request: (() => Promise<string>) | undefined;
    let refresh: (() => void) | undefined;
    function Probe() {
      renders();
      const result = useStoragePersistence();
      seen = result.persistence;
      request = result.request;
      refresh = result.refresh;
      return null;
    }
    await render(<Probe />);
    // Wait for the mount's OWN natural (real, unmocked) refresh cycle to
    // fully settle before calling request(). Skipping this created a race
    // that was NOT the one this test means to exercise: the mount's real
    // persisted() read can resolve "unknown" *after* request() below
    // publishes "granted", clobbering it -- coincidentally reproducing the
    // exact unsequenced-publish symptom this test exists to rule out, but for
    // the wrong reason (test setup, not the injected rejection).
    await vi.waitFor(() => expect(renders.mock.calls.length).toBeGreaterThan(1));

    await request?.();
    await vi.waitFor(() => expect(seen).toBe("granted"));

    const rendersBeforeRefresh = renders.mock.calls.length;
    const persistedSpy = vi
      .spyOn(navigator.storage, "persisted")
      .mockRejectedValueOnce(new Error("transient failure"));
    try {
      refresh?.();
      // estimate() still succeeds in this same refresh cycle, so publish()
      // still fires (and a render still happens) even though the persisted()
      // half of the same readStorage() call failed -- that render is the
      // value-independent signal the refresh cycle actually ran.
      await vi.waitFor(() =>
        expect(renders.mock.calls.length).toBeGreaterThan(rendersBeforeRefresh),
      );
      expect(seen).toBe("granted");
    } finally {
      persistedSpy.mockRestore();
    }
  } finally {
    persistSpy.mockRestore();
  }
});

test("a transient estimate() rejection does not erase a known-good estimate", async () => {
  const renders = vi.fn();
  let seenEstimate: StorageEstimate | undefined;
  let refresh: (() => void) | undefined;
  function Probe() {
    renders();
    const result = useStoragePersistence();
    seenEstimate = result.estimate;
    refresh = result.refresh;
    return null;
  }
  await render(<Probe />);
  // Wait for the mount's OWN natural refresh to fully settle -- NOT merely for
  // `seenEstimate?.quota` to already look good. A prior test in this file can
  // leave the shared module snapshot already holding a real, valid estimate;
  // subscribeToStorage delivers that leftover value synchronously on mount, so
  // `quota > 0` alone can be trivially true on the very first render, before
  // this mount's own refresh has even been dispatched. Without this wait, that
  // still-in-flight, unmocked mount-refresh can resolve and publish *after*
  // the mocked rejection below, racing with and masking it -- reproduced by
  // hand: this exact test passed with the data-loss bug reintroduced when run
  // as part of the full file, and only failed when run in isolation, until
  // this wait was added.
  await vi.waitFor(() => expect(renders.mock.calls.length).toBeGreaterThan(1));
  await vi.waitFor(() => expect(seenEstimate?.quota).toBeGreaterThan(0));

  const rendersBeforeRefresh = renders.mock.calls.length;
  const estimateSpy = vi
    .spyOn(navigator.storage, "estimate")
    .mockRejectedValueOnce(new Error("transient failure"));
  try {
    refresh?.();
    // persisted() still succeeds in this same refresh cycle, so publish()
    // still fires even though the estimate() half failed.
    await vi.waitFor(() => expect(renders.mock.calls.length).toBeGreaterThan(rendersBeforeRefresh));
    expect(seenEstimate?.quota).toBeGreaterThan(0);
  } finally {
    estimateSpy.mockRestore();
  }
});
