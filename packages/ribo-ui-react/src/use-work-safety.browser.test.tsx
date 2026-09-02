import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createConnectivity, openOutbox, type Outbox } from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { RiboProvider } from "./RiboProvider.js";
import { useWorkSafety } from "./use-work-safety.js";

// vitest-browser-react@2.2.0's `render` is async — see context.browser.test.tsx.
// Every render below is awaited.

/** The shape `Outbox.watch` returns — see use-outbox-items.browser.test.tsx for why
 * this is spelled out rather than importing rxjs directly. */
type WatchObservable = ReturnType<Outbox["watch"]>;

const freshOutbox = () =>
  openOutbox({ name: `t-${crypto.randomUUID()}`, storage: getRxStorageMemory() });

/**
 * A connectivity model over injected seams — no real network, no real events.
 * Same shape as use-connectivity.browser.test.tsx's helper.
 */
function fakeConnectivity(online: boolean) {
  return createConnectivity({
    bindEvents: () => () => undefined,
    isOnline: () => online,
    probe: async () => new Response(null, { status: online ? 204 : 503 }),
  });
}

test("un-reviewed work is never reported as safe", async () => {
  // The hook-level assertion of the same regression work-safety.test.ts covers:
  // a session parked for review is unsynced work on the device, and a UI built on
  // this hook must not tell the auditor their work is safe. "awaiting-review" is
  // now a session status (not a recording status), so the test opens a session
  // and patches it there directly.
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: {}, ref: "job-7" });
  await outbox.patchSession(session.id, { status: "awaiting-review" });

  function Probe() {
    const { safety, work, loading, error } = useWorkSafety();
    if (loading) return <p>loading</p>;
    if (error !== undefined) return <p>unavailable</p>;
    return (
      <p>
        {safety?.level} pending {work?.pending} review {work?.awaitingReview}
      </p>
    );
  }

  const screen = await render(
    <RiboProvider value={{ outbox, connectivity: fakeConnectivity(true) }}>
      <Probe />
    </RiboProvider>,
  );

  await expect.element(screen.getByText(/pending 1 review 1/)).toBeInTheDocument();
  await expect.element(screen.getByText(/^safe/)).not.toBeInTheDocument();
  await outbox.close();
});

test("an outbox read failure yields no verdict, never a safe one", async () => {
  // The regression that matters most here: on a watch error `useOutboxItems` keeps
  // its initial empty array, an empty array summarizes to pending 0, and pending 0
  // classifies as `safe / nothing-captured`. A defaulted verdict would therefore
  // announce that the work is safe exactly when we failed to read it.
  //
  // Errors through `Outbox.watch` in real use arrive via the returned
  // Observable's `error` channel (RxDB's `$.pipe(...)` stream), never as a
  // synchronous throw from `watch()` itself -- `use-outbox-items.browser.test.tsx`'s
  // own "surfaces a watch error" test mocks it the same way. Mirroring that here
  // is what makes this test exercise `useOutboxItems`'s real error path instead of
  // an uncaught exception inside its effect, which React would treat as a render
  // crash rather than a value this hook could ever see.
  const outbox = await freshOutbox();
  vi.spyOn(outbox, "watch").mockReturnValue({
    // The hook always subscribes with an object observer (see
    // use-outbox-items.ts), never the function-overload form, so this fake
    // only needs to handle that one shape — mirroring
    // use-outbox-items.browser.test.tsx's own "surfaces a watch error" fake.
    subscribe: (observer: { error?: (cause: unknown) => void }) => {
      observer.error?.(new Error("storage is gone"));
      return { unsubscribe: () => undefined, closed: true };
    },
  } as WatchObservable);

  // Captured directly rather than inferred through the rendered text: a Probe
  // that only branches its own markup on `error` would pass even if `safety`
  // itself were defaulted to a benign verdict underneath, which is exactly the
  // regression this test exists to catch. Asserting on the hook's actual
  // `safety` value is what makes that distinction visible.
  let seenSafety: ReturnType<typeof useWorkSafety>["safety"];
  let seenError: Error | undefined;
  function Probe() {
    const { safety, error } = useWorkSafety();
    seenSafety = safety;
    seenError = error;
    return <p>{error === undefined ? `verdict ${String(safety?.level)}` : "unavailable"}</p>;
  }

  const screen = await render(
    <RiboProvider value={{ outbox, connectivity: fakeConnectivity(true) }}>
      <Probe />
    </RiboProvider>,
  );

  await expect.element(screen.getByText("unavailable")).toBeInTheDocument();
  expect(seenError).toBeInstanceOf(Error);
  expect(seenSafety).toBeUndefined();
  await outbox.close();
});
