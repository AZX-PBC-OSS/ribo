import { expect, test } from "vitest";
import { z } from "zod";

import {
  ACTIVE_SESSION_STATUSES,
  FINISHED_SESSION_STATUSES,
  SESSION_COLLECTION_NAME,
  SESSION_STATUSES,
  sessionDocumentSchema,
  sessionItemSchema,
  sessionRxSchema,
} from "./session-schema.js";
import type { SessionPatch, SessionStatus } from "./session-schema.js";

// The session document is described twice, same as the recording: once in zod
// (the trust boundary) and once in RxDB's JSON schema (which carries the
// primary key, indexes). These tests pin the two against each other so they
// cannot drift — the same seam `schema.test.ts` guards for the recording.

const zodKeys = Object.keys(sessionDocumentSchema.shape).sort();

const optionalKeys = Object.entries(sessionDocumentSchema.shape)
  .filter(([, field]) => field instanceof z.ZodOptional)
  .map(([key]) => key)
  .sort();

test("the RxDB schema describes exactly the fields the zod schema does", () => {
  expect(Object.keys(sessionRxSchema.properties).sort()).toEqual(zodKeys);
});

test("the RxDB required list is exactly zod's non-optional fields", () => {
  const required = [...(sessionRxSchema.required ?? [])].sort();
  expect(required).toEqual(zodKeys.filter((key) => !optionalKeys.includes(key)));
});

test("the optional fields are the step outputs, the error, and the close timestamp", () => {
  expect(optionalKeys).toEqual([
    "closedAt",
    "extracted",
    "extractedBy",
    "extractedFromRecordingIds",
    "extractionUsage",
    "lastError",
    "reviewOutcome",
    "writeResult",
  ]);
});

test("the primary key is a required field, as RxDB demands", () => {
  expect(sessionRxSchema.primaryKey).toBe("id");
  expect(sessionRxSchema.required).toContain("id");
});

test("attachments are enabled — the sessions collection may need them later", () => {
  expect(sessionRxSchema.attachments).toBeDefined();
});

test("ref is indexed so a host can query 'the session for this job'", () => {
  expect(sessionRxSchema.indexes).toContain("ref");
});

test("the collection name is not the outbox's", () => {
  expect(SESSION_COLLECTION_NAME).toBe("sessions");
  expect(SESSION_COLLECTION_NAME).not.toBe("outbox");
});

test("the RxDB schema is at version 0", () => {
  // The sessions collection is new — starts at version 0, not bumped from the
  // outbox's version.
  expect(sessionRxSchema.version).toBe(0);
});

test("the session state machine has the expected statuses", () => {
  expect(SESSION_STATUSES).toEqual([
    "open",
    "extracting",
    "awaiting-review",
    "writing",
    "done",
    "failed",
    "dead",
  ]);
});

test("active session statuses are the ones the relay acts on", () => {
  // extracting and writing are in-flight; failed is resting (retryable after
  // backoff). open is NOT active — the relay does not act on an open session
  // until the host closes it. awaiting-review is NOT active — the review gate,
  // same omission as the recording side.
  expect(ACTIVE_SESSION_STATUSES).toEqual(["extracting", "writing", "failed"]);
});

test("finished session statuses are the ones the relay will not revisit", () => {
  expect(FINISHED_SESSION_STATUSES).toEqual(["done", "dead"]);
});

test("every status is active, finished, or explicitly parked for a human", () => {
  // awaiting-review is in neither set on purpose — that omission is the review
  // gate, same as the recording side. open is its own category: the host owns
  // it, the relay does not.
  const PARKED: readonly SessionStatus[] = ["awaiting-review"];
  const OPEN: readonly SessionStatus[] = ["open"];
  expect(
    [...ACTIVE_SESSION_STATUSES, ...FINISHED_SESSION_STATUSES, ...OPEN, ...PARKED].sort(),
  ).toEqual([...SESSION_STATUSES].sort());
});

test("awaiting-review is a status but is deliberately not active", () => {
  expect(SESSION_STATUSES).toContain("awaiting-review");
  expect(ACTIVE_SESSION_STATUSES as readonly string[]).not.toContain("awaiting-review");
  expect(FINISHED_SESSION_STATUSES as readonly string[]).not.toContain("awaiting-review");
});

test("open is a status but is deliberately not active", () => {
  expect(SESSION_STATUSES).toContain("open");
  expect(ACTIVE_SESSION_STATUSES as readonly string[]).not.toContain("open");
  expect(FINISHED_SESSION_STATUSES as readonly string[]).not.toContain("open");
});

test("every status fits the indexed maxLength the RxDB schema declares", () => {
  const bound = sessionRxSchema.properties.status.maxLength!;
  for (const status of SESSION_STATUSES) expect(status.length).toBeLessThanOrEqual(bound);
});

test("a session with status 'open' requires no extracted or reviewOutcome", () => {
  const doc = sessionDocumentSchema.parse(validSession());
  expect(doc.status).toBe("open");
  expect(doc.extracted).toBeUndefined();
  expect(doc.reviewOutcome).toBeUndefined();
});

test("a status not in the state machine is rejected at the boundary", () => {
  const valid = validSession();
  expect(sessionDocumentSchema.safeParse(valid).success).toBe(true);
  expect(sessionDocumentSchema.safeParse({ ...valid, status: "transcribing" }).success).toBe(false);
  expect(sessionDocumentSchema.safeParse({ ...valid, nextAttemptAt: "soon" }).success).toBe(false);
  expect(sessionDocumentSchema.safeParse({ ...valid, attempts: -1 }).success).toBe(false);
});

test("the projection is the document — no derived keys today", () => {
  // The session has no attachments, so no attachment-facts to compute. The
  // item schema is the document schema, and this test pins that: a future
  // derived field (e.g. recording count) needs to add it here AND keep it out
  // of the RxDB schema.
  expect(Object.keys(sessionItemSchema.shape).sort()).toEqual(zodKeys);
});

/**
 * The unpatchable fields, asserted at the TYPE level because nothing else can.
 *
 * Same reasoning as `schema.test.ts`: `SessionPatch` is derived by `Omit`, so a
 * field dropping out of that list is invisible to every runtime test. Each
 * `@ts-expect-error` IS the assertion.
 */
test("the fields decided once stay decided — none of them is patchable", () => {
  // @ts-expect-error `id` is the primary key.
  const id: SessionPatch = { id: "other" };
  // @ts-expect-error `openedAt` is when the session was opened, once.
  const openedAt: SessionPatch = { openedAt: "2026-01-01T00:00:00.000Z" };
  // @ts-expect-error `idempotencyKey` must survive every retry unchanged.
  const idempotencyKey: SessionPatch = { idempotencyKey: "regenerated" };
  // @ts-expect-error `ctx` is the write destination, decided once at open.
  const ctx: SessionPatch = { ctx: { jobId: "other" } };
  // @ts-expect-error `ref` is what the session is for, decided once at open.
  const ref: SessionPatch = { ref: "other" };

  expect([id, openedAt, idempotencyKey, ctx, ref]).toHaveLength(5);
});

/** A minimal session document that parses, for the negative cases to mutate. */
function validSession() {
  return {
    id: "s1",
    status: "open" as const,
    openedAt: "2026-08-28T10:00:00.000Z",
    ctx: { jobId: "job-1" },
    ref: "job-1",
    attempts: 0,
    nextAttemptAt: "2026-08-28T10:00:00.000Z",
    idempotencyKey: "k",
  };
}
