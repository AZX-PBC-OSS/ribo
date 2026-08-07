import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StrictMode } from "react";
import { openOutbox, type Outbox } from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { useOutboxItems } from "./use-outbox-items.js";

// vitest-browser-react@2.2.0's `render` is async — see context.browser.test.tsx.
// Every render below is awaited.

/** The shape `Outbox.watch` returns, spelled out so tests can fake it without
 * importing `rxjs` directly — `@azx/ribo-ui-react` has no dependency on it, only
 * `@azx/ribo-core` does. */
type WatchObservable = ReturnType<Outbox["watch"]>;
type WatchObserver = Parameters<WatchObservable["subscribe"]>[0];
type WatchSubscription = ReturnType<WatchObservable["subscribe"]>;

const freshOutbox = () =>
  openOutbox({ name: `t-${crypto.randomUUID()}`, storage: getRxStorageMemory() });

const aRecording = () => ({
  recording: {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    durationMs: 10,
    mimeType: "audio/webm",
    ctx: {},
  },
  audio: new Blob(["x"], { type: "audio/webm" }),
});

test("loading is a real state, distinct from empty", async () => {
  // A UI must be able to say "reading the outbox…" rather than flashing "nothing
  // here" before the first emission — the playground's ReviewPanel already draws
  // this distinction and it matters.
  const outbox = await freshOutbox();
  const seen: { loading: boolean; count: number }[] = [];
  function Probe() {
    const { items, loading } = useOutboxItems({}, outbox);
    seen.push({ loading, count: items.length });
    return null;
  }
  await render(<Probe />);
  expect(seen[0]).toEqual({ loading: true, count: 0 });
  await vi.waitFor(() => expect(seen.at(-1)).toEqual({ loading: false, count: 0 }));
  await outbox.close();
});

test("updates live when an item is enqueued", async () => {
  const outbox = await freshOutbox();
  function Probe() {
    return <p>count {useOutboxItems({}, outbox).items.length}</p>;
  }
  const screen = await render(<Probe />);
  await expect.element(screen.getByText("count 0")).toBeInTheDocument();

  await outbox.enqueue(aRecording());
  await expect.element(screen.getByText("count 1")).toBeInTheDocument();
  await outbox.close();
});

test("honours a status filter", async () => {
  const outbox = await freshOutbox();
  const item = await outbox.enqueue(aRecording());
  await outbox.patch(item.id, { status: "awaiting-review" });
  await outbox.enqueue(aRecording());

  function Probe() {
    return <p>parked {useOutboxItems({ status: "awaiting-review" }, outbox).items.length}</p>;
  }
  const screen = await render(<Probe />);
  await expect.element(screen.getByText("parked 1")).toBeInTheDocument();
  await outbox.close();
});

test("an inline query object does not re-subscribe every render", async () => {
  // The trap: `{ status: "queued" }` is a new object identity per render, so a
  // naive effect dependency tears the subscription down and rebuilds it forever.
  const outbox = await freshOutbox();
  const watch = vi.spyOn(outbox, "watch");
  function Probe() {
    const { items } = useOutboxItems({ status: "queued" }, outbox);
    return <p>count {items.length}</p>;
  }
  const screen = await render(<Probe />);
  await expect.element(screen.getByText("count 0")).toBeInTheDocument();
  await outbox.enqueue(aRecording());
  await expect.element(screen.getByText("count 1")).toBeInTheDocument();

  expect(watch.mock.calls.length).toBeLessThanOrEqual(2);
  await outbox.close();
});

test("tears down the RxDB subscription on unmount", async () => {
  // The one guarantee a leaked subscription would violate silently: RxDB keeps
  // notifying a component that no longer exists, and a second mount over the
  // same query piles up a second live subscriber underneath. Spying on `watch`'s
  // returned Observable's own `subscribe` captures the real Subscription the
  // hook's effect creates, so `.closed` proves teardown rather than merely
  // asserting a mock was called.
  const outbox = await freshOutbox();
  const originalWatch = outbox.watch.bind(outbox);
  const subscriptions: WatchSubscription[] = [];
  vi.spyOn(outbox, "watch").mockImplementation((query) => {
    const observable = originalWatch(query);
    return {
      subscribe: (observer: WatchObserver) => {
        const subscription = observable.subscribe(observer);
        subscriptions.push(subscription);
        return subscription;
      },
    } as WatchObservable;
  });

  function Probe() {
    useOutboxItems({}, outbox);
    return null;
  }
  const screen = await render(<Probe />);
  await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
  expect(subscriptions[0]!.closed).toBe(false);

  await screen.unmount();
  expect(subscriptions[0]!.closed).toBe(true);

  await outbox.close();
});

test("under StrictMode, the double mount/cleanup/remount settles to one live subscription, zero after unmount", async () => {
  // vitest-browser-react defaults reactStrictMode to false, but
  // playground/src/main.tsx wraps the real app in <StrictMode>. React 19's
  // deliberate double mount/cleanup/remount of effects would surface a doubled
  // (or leaked) RxDB subscription here even though nothing above this test
  // exercises that mode.
  const outbox = await freshOutbox();
  const originalWatch = outbox.watch.bind(outbox);
  const subscriptions: WatchSubscription[] = [];
  vi.spyOn(outbox, "watch").mockImplementation((query) => {
    const observable = originalWatch(query);
    return {
      subscribe: (observer: WatchObserver) => {
        const subscription = observable.subscribe(observer);
        subscriptions.push(subscription);
        return subscription;
      },
    } as WatchObservable;
  });

  function Probe() {
    useOutboxItems({}, outbox);
    return null;
  }
  const screen = await render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );
  await vi.waitFor(() => expect(subscriptions.filter((s) => !s.closed)).toHaveLength(1));

  await screen.unmount();
  expect(subscriptions.every((s) => s.closed)).toBe(true);

  await outbox.close();
});

test("surfaces a watch error without leaving loading stuck", async () => {
  const outbox = await freshOutbox();
  vi.spyOn(outbox, "watch").mockReturnValue({
    // The hook always subscribes with an object observer (see the
    // implementation), never the function-overload form, so this fake only
    // needs to handle that one shape.
    subscribe: (observer: { error?: (cause: unknown) => void }) => {
      observer.error?.(new Error("boom"));
      return { unsubscribe: () => undefined, closed: true } as WatchSubscription;
    },
  } as WatchObservable);

  function Probe() {
    const { error, loading } = useOutboxItems({}, outbox);
    return <p>state {error ? `error:${error.message}` : loading ? "loading" : "ready"}</p>;
  }
  const screen = await render(<Probe />);
  await expect.element(screen.getByText("state error:boom")).toBeInTheDocument();
  await outbox.close();
});

test("without a provider and without an override, throws the named error", async () => {
  function Probe() {
    const { items } = useOutboxItems();
    return <p>count {items.length}</p>;
  }
  await expect(render(<Probe />)).rejects.toThrow(/outbox/i);
});
