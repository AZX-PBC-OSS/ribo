import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { openOutbox, type Outbox, type SessionQuery } from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { useSessions } from "./use-sessions.js";

// vitest-browser-react@2.2.0's `render` is async — see context.browser.test.tsx.
// Every render below is awaited.

/**
 * @file `useSessions` — the query a caller passes must be the query that runs.
 *
 * This file exists because it did not. `SessionQuery` gained `ref` when the
 * session started owning what it is for, `Outbox.watchSessions` honours it, and
 * the hook silently dropped it: its memo key enumerated `status` and `limit` by
 * hand and then rebuilt the query by parsing that key back, so a field nobody
 * remembered to list was discarded on the way through. Every consumer got every
 * session on the device and filtered client-side.
 *
 * So the assertions here are deliberately about the *hook's* plumbing rather
 * than about RxDB's filtering, which `session-outbox.test.ts` already covers.
 */

const freshOutbox = () =>
  openOutbox({ name: `t-${crypto.randomUUID()}`, storage: getRxStorageMemory() });

test("a ref in the query reaches the outbox, and only matching sessions come back", async () => {
  const outbox = await freshOutbox();
  await outbox.openSession({ ctx: { jobId: "a" }, ref: "job-a" });
  await outbox.openSession({ ctx: { jobId: "b" }, ref: "job-b" });
  await outbox.openSession({ ctx: { jobId: "a2" }, ref: "job-a" });

  const seen: string[][] = [];
  function Probe() {
    const { items, loading } = useSessions({ ref: "job-a" }, outbox);
    if (!loading) seen.push(items.map((s) => s.ref));
    return null;
  }
  await render(<Probe />);

  await vi.waitFor(() => expect(seen.at(-1)).toEqual(["job-a", "job-a"]));
  await outbox.close();
});

test("ref composes with status rather than replacing it", async () => {
  const outbox = await freshOutbox();
  const wanted = await outbox.openSession({ ctx: {}, ref: "job-a" });
  await outbox.openSession({ ctx: {}, ref: "job-b" });
  const otherStatus = await outbox.openSession({ ctx: {}, ref: "job-a" });
  await outbox.closeSession(otherStatus.id); // → extracting

  const seen: string[][] = [];
  function Probe() {
    const { items, loading } = useSessions({ ref: "job-a", status: "open" }, outbox);
    if (!loading) seen.push(items.map((s) => s.id));
    return null;
  }
  await render(<Probe />);

  await vi.waitFor(() => expect(seen.at(-1)).toEqual([wanted.id]));
  await outbox.close();
});

test("every field of the query survives the memo key", async () => {
  // The guard against the defect recurring. The hook memoises on a serialised
  // query so the subscription does not tear down when a caller passes a fresh
  // object literal every render — and the bug was that the serialisation was a
  // hand-written allow-list. Asserting on the round trip rather than on a
  // particular field means a future addition to `SessionQuery` is covered by
  // this test on the day it is declared, not on the day someone remembers.
  const outbox = await freshOutbox();
  const query: SessionQuery = { ref: "job-a", status: "open", limit: 5 };

  const seen: SessionQuery[] = [];
  const spy = {
    ...outbox,
    watchSessions: (q: SessionQuery = {}) => {
      seen.push(q);
      return outbox.watchSessions(q);
    },
  } as unknown as Outbox;

  function Probe() {
    useSessions(query, spy);
    return null;
  }
  await render(<Probe />);

  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
  expect(seen[0]).toEqual(query);
  await outbox.close();
});

test("the same query written in a different key order does not resubscribe", async () => {
  // `queryKey` sorts, and this is what that sort is for. A caller assembling a
  // query conditionally can emit the same fields in a different order between
  // renders; without the sort those serialise differently, the memo misses, and
  // the subscription is torn down and rebuilt for a query that did not change.
  const outbox = await freshOutbox();
  let subscribes = 0;
  const spy = {
    ...outbox,
    watchSessions: (q: SessionQuery = {}) => {
      subscribes += 1;
      return outbox.watchSessions(q);
    },
  } as unknown as Outbox;

  function Probe({ swapped }: { swapped: boolean }) {
    useSessions(swapped ? { status: "open", ref: "job-a" } : { ref: "job-a", status: "open" }, spy);
    return null;
  }
  const screen = await render(<Probe swapped={false} />);
  await vi.waitFor(() => expect(subscribes).toBe(1));
  await screen.rerender(<Probe swapped={true} />);
  expect(subscribes).toBe(1);
  await outbox.close();
});

test("a query passed as a fresh object each render does not resubscribe", async () => {
  // The reason the memo key exists at all. If this regresses, the fix above has
  // traded a dropped field for a subscription torn down on every render.
  const outbox = await freshOutbox();
  let subscribes = 0;
  const spy = {
    ...outbox,
    watchSessions: (q: SessionQuery = {}) => {
      subscribes += 1;
      return outbox.watchSessions(q);
    },
  } as unknown as Outbox;

  function Probe({ tick }: { tick: number }) {
    // A NEW object literal every render, which is the shape a real caller writes.
    useSessions({ ref: "job-a", status: "open" }, spy);
    return <span>{tick}</span>;
  }
  const screen = await render(<Probe tick={0} />);
  await vi.waitFor(() => expect(subscribes).toBe(1));
  await screen.rerender(<Probe tick={1} />);
  await screen.rerender(<Probe tick={2} />);
  expect(subscribes).toBe(1);
  await outbox.close();
});
