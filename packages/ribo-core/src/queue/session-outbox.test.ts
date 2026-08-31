import type { RxStorage } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { afterEach, expect, test } from "vitest";

import type { PersistedReviewOutcome } from "../review.js";
import { removeOutboxDatabase } from "./database.js";
import { openOutbox, type Outbox } from "./outbox.js";

// Session lifecycle operations, driven through the public Outbox API over
// memory storage — same seam as outbox-memory.test.ts, same reason: memory
// needs no IndexedDB, so these run as fast node `unit` tests.

const opened: { outbox: Outbox; name: string; storage: RxStorage<unknown, unknown> }[] = [];

afterEach(async () => {
  for (const { outbox, name, storage } of opened.splice(0)) {
    if (!outbox.closed) await outbox.close();
    await removeOutboxDatabase(name, storage);
  }
});

function uniqueName(): string {
  return `ribo-session-${crypto.randomUUID()}`;
}

async function open(): Promise<Outbox> {
  const storage = getRxStorageMemory();
  const name = uniqueName();
  const outbox = await openOutbox({ name, storage });
  opened.push({ outbox, name, storage });
  return outbox;
}

test("openSession creates an open session with an idempotency key", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  expect(session.status).toBe("open");
  expect(session.id).toBeTruthy();
  expect(session.idempotencyKey).toBeTruthy();
  expect(session.extracted).toBeUndefined();
  expect(session.reviewOutcome).toBeUndefined();
  expect(session.closedAt).toBeUndefined();
});

test("openSession with an injected id and idempotency key uses them", async () => {
  const outbox = await open();
  const session = await outbox.openSession({ id: "s-custom", idempotencyKey: "key-custom" });
  expect(session.id).toBe("s-custom");
  expect(session.idempotencyKey).toBe("key-custom");
});

test("closeSession transitions open → extracting and sets closedAt", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  const closed = await outbox.closeSession(session.id);
  expect(closed.status).toBe("extracting");
  expect(closed.closedAt).toBeDefined();
});

test("closeSession refuses a session that is not open", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await outbox.closeSession(session.id);
  await expect(outbox.closeSession(session.id)).rejects.toThrow(/not "open"/);
});

test("getSession reads a session by id", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  const read = await outbox.getSession(session.id);
  expect(read).toEqual(session);
});

test("getSession returns undefined for a missing id", async () => {
  const outbox = await open();
  const read = await outbox.getSession("does-not-exist");
  expect(read).toBeUndefined();
});

test("listSessions returns sessions sorted by openedAt ascending", async () => {
  let t = 0;
  const storage = getRxStorageMemory();
  const name = uniqueName();
  const outbox = await openOutbox({
    name,
    storage,
    now: () => t,
  });
  opened.push({ outbox, name, storage });

  t = 1_000;
  const first = await outbox.openSession();
  t = 2_000;
  const second = await outbox.openSession();
  const sessions = await outbox.listSessions();
  const firstIdx = sessions.findIndex((s) => s.id === first.id);
  const secondIdx = sessions.findIndex((s) => s.id === second.id);
  expect(firstIdx).toBeLessThan(secondIdx);
});

test("listSessions filters by status", async () => {
  const outbox = await open();
  const openSession = await outbox.openSession();
  await outbox.closeSession(openSession.id);
  const extracting = await outbox.listSessions({ status: "extracting" });
  expect(extracting).toHaveLength(1);
  expect(extracting[0]!.id).toBe(openSession.id);
  const openOnly = await outbox.listSessions({ status: "open" });
  expect(openOnly).toHaveLength(0);
});

test("patchSession updates fields and validates", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  const patched = await outbox.patchSession(session.id, { lastError: "something" });
  expect(patched.lastError).toBe("something");
  expect(patched.status).toBe("open");
});

test("patchSession refuses an invalid status", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await expect(
    outbox.patchSession(session.id, { status: "transcribing" as never }),
  ).rejects.toThrow();
});

test("submitSessionReview moves awaiting-review → writing", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await outbox.patchSession(session.id, {
    status: "awaiting-review",
    extracted: {},
    extractedFromRecordingIds: [],
  });
  const outcome: PersistedReviewOutcome = {
    status: "accepted",
    fields: { basedata: { yearBuilt: 1950 } },
  };
  const submitted = await outbox.submitSessionReview(session.id, outcome);
  expect(submitted.status).toBe("writing");
  expect(submitted.reviewOutcome).toEqual(outcome);
  expect(submitted.attempts).toBe(0);
});

test("submitSessionReview with a discard moves to awaiting-review... no, to done", async () => {
  // A discarded review outcome on a session means the human decided the whole
  // session's extraction is not going anywhere. Unlike the recording's discard
  // (which drops audio), there is no audio on the session to drop — the
  // recordings stay. The session transitions to `done` with the outcome recorded.
  const outbox = await open();
  const session = await outbox.openSession();
  await outbox.patchSession(session.id, {
    status: "awaiting-review",
    extracted: {},
    extractedFromRecordingIds: [],
  });
  const outcome: PersistedReviewOutcome = { status: "discarded", reason: "re-do the walk" };
  const submitted = await outbox.submitSessionReview(session.id, outcome);
  expect(submitted.status).toBe("done");
  expect(submitted.reviewOutcome).toEqual(outcome);
});

test("submitSessionReview refuses a session that is not awaiting-review", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await expect(
    outbox.submitSessionReview(session.id, { status: "accepted", fields: {} }),
  ).rejects.toThrow(/not "awaiting-review"/);
});

test("reopenSessionForReview moves dead → awaiting-review and clears the outcome", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await outbox.patchSession(session.id, {
    status: "dead",
    extracted: { basedata: { yearBuilt: 1950 } },
    extractedFromRecordingIds: ["r1"],
    reviewOutcome: { status: "accepted", fields: {} },
    lastError: "write failed",
    attempts: 3,
  });
  const reopened = await outbox.reopenSessionForReview(session.id);
  expect(reopened.status).toBe("awaiting-review");
  expect(reopened.reviewOutcome).toBeUndefined();
  expect(reopened.attempts).toBe(0);
  // lastError is deliberately left — it explains why the session needed reopening.
  expect(reopened.lastError).toBe("write failed");
  // extracted and extractedFromRecordingIds are preserved — the extraction is
  // still valid; only the review outcome is cleared.
  expect(reopened.extracted).toEqual({ basedata: { yearBuilt: 1950 } });
  expect(reopened.extractedFromRecordingIds).toEqual(["r1"]);
});

test("reopenSessionForReview refuses a session that is not dead", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await expect(outbox.reopenSessionForReview(session.id)).rejects.toThrow(/not "dead"/);
});

test("reopenSessionForReview refuses a dead session with no extracted data", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await outbox.patchSession(session.id, { status: "dead", lastError: "extraction failed" });
  await expect(outbox.reopenSessionForReview(session.id)).rejects.toThrow(/no extracted/);
});

test("reopenSessionForReview refuses a dead session with no transcript ids", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await outbox.patchSession(session.id, {
    status: "dead",
    extracted: { basedata: {} },
    lastError: "write failed",
  });
  await expect(outbox.reopenSessionForReview(session.id)).rejects.toThrow(/no recording ids/);
});

test("a session with a nested review outcome round-trips storage", async () => {
  const outbox = await open();
  const session = await outbox.openSession();
  await outbox.patchSession(session.id, {
    status: "awaiting-review",
    extracted: {},
    extractedFromRecordingIds: [],
  });
  const outcome: PersistedReviewOutcome = {
    status: "edited",
    fields: {
      atticRValue: 19,
      healthSafety: { ambientCo: "passed", gasLeak: null },
    },
    editedFields: ["healthSafety.ambientCo"],
    rejectedFields: ["healthSafety.asbestos"],
  };
  await outbox.submitSessionReview(session.id, outcome);
  const read = await outbox.getSession(session.id);
  expect(read?.reviewOutcome).toEqual(outcome);
});
