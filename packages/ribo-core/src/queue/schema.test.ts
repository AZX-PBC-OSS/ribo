import { expect, test } from "vitest";

import {
  ACTIVE_OUTBOX_STATUSES,
  DERIVED_OUTBOX_ITEM_KEYS,
  FINISHED_OUTBOX_STATUSES,
  OUTBOX_STATUSES,
  RECORDING_OUTBOX_STATUSES,
  outboxDocumentSchema,
  outboxItemSchema,
  outboxRxSchema,
} from "./schema.js";
import type { OutboxPatch, OutboxStatus } from "./schema.js";

// One document, described twice: once in zod (the read/write trust boundary) and
// once in RxDB's JSON schema (which carries the primary key, indexes and
// attachment flag zod has no concept of). Two descriptions of one thing drift,
// and the drift would show up as a persisted document that fails to parse after
// a reload — the worst possible place to find it. These tests are the seam.
//
// There are now *three* descriptions, and the third is deliberately not pinned
// to the other two. `outboxItemSchema` is the projection consumers see: the
// document plus the attachment facts (`DERIVED_OUTBOX_ITEM_KEYS`), which are
// computed per read and never stored. So the drift guard below pins
// `outboxDocumentSchema` ↔ `outboxRxSchema` — the two descriptions of what is on
// disk — and a separate guard pins the projection to "the document plus exactly
// the derived keys", which is the property that would otherwise rot the moment
// someone added a field to one and not the other.

const zodKeys = Object.keys(outboxDocumentSchema.shape).sort();

const optionalKeys = Object.entries(outboxDocumentSchema.shape)
  .filter(([, field]) => field.safeParse(undefined).success)
  .map(([key]) => key)
  .sort();

test("the RxDB schema describes exactly the fields the zod schema does", () => {
  expect(Object.keys(outboxRxSchema.properties).sort()).toEqual(zodKeys);
});

test("the RxDB required list is exactly zod's non-optional fields", () => {
  const required = [...(outboxRxSchema.required ?? [])].sort();
  expect(required).toEqual(zodKeys.filter((key) => !optionalKeys.includes(key)));
});

test("the optional fields are the step outputs, the error message, capture, and preview", () => {
  expect(optionalKeys).toEqual([
    "capture",
    "extracted",
    "lastError",
    "preview",
    "reviewOutcome",
    "transcript",
    "writeResult",
  ]);
});

test("the primary key is a required field, as RxDB demands", () => {
  expect(outboxRxSchema.primaryKey).toBe("id");
  expect(outboxRxSchema.required).toContain("id");
});

test("every indexed field is required and carries the bounds RxDB needs to encode it", () => {
  for (const index of outboxRxSchema.indexes ?? []) {
    const fields = Array.isArray(index) ? index : [index];
    for (const field of fields) {
      expect(outboxRxSchema.required).toContain(field);
      const property = outboxRxSchema.properties[field as keyof typeof outboxRxSchema.properties];
      // RxDB builds fixed-width sortable index keys, so a string needs a length
      // bound and a number needs a range and a step. Omitting them is not a
      // warning — the collection refuses to be created.
      if (property && "type" in property && property.type === "string") {
        expect(property).toHaveProperty("maxLength");
      } else if (property && "type" in property && property.type === "number") {
        expect(property).toMatchObject({
          minimum: expect.any(Number),
          maximum: expect.any(Number),
          multipleOf: expect.any(Number),
        });
      }
    }
  }
});

test("attachments are enabled — audio is an attachment, never a base64 field", () => {
  expect(outboxRxSchema.attachments).toBeDefined();
  expect(zodKeys).not.toContain("audio");
});

// ---------------------------------------------------------------------------
// The projection: document + derived attachment facts.
// ---------------------------------------------------------------------------

test("the projection is the persisted document plus exactly the derived keys", () => {
  expect(Object.keys(outboxItemSchema.shape).sort()).toEqual(
    [...zodKeys, ...DERIVED_OUTBOX_ITEM_KEYS].sort(),
  );
});

test("the derived keys are never persisted", () => {
  // The whole point of computing them: a stored `audioReady` would be a second
  // copy of a truth the attachment store already holds, and iOS eviction can
  // remove the bytes without touching the document.
  for (const key of DERIVED_OUTBOX_ITEM_KEYS) {
    expect(Object.keys(outboxRxSchema.properties)).not.toContain(key);
    expect(zodKeys).not.toContain(key);
  }
});

test("the derived keys are required on the projection — absence is not a third state", () => {
  const document = validDocument();
  // A projection missing them would put a consumer right back where it started:
  // unable to tell "no audio" from "not known yet".
  expect(outboxItemSchema.safeParse(document).success).toBe(false);
  expect(
    outboxItemSchema.safeParse({ ...document, audioReady: true, audioBytes: 2048 }).success,
  ).toBe(true);
  expect(
    outboxItemSchema.safeParse({ ...document, audioReady: false, audioBytes: -1 }).success,
  ).toBe(false);
});

test("the projection's extra keys do not leak back into a document parse", () => {
  // `outboxDocumentSchema` is what `enqueue` validates before the storage write,
  // and it is strict — so an item accidentally handed to it fails loudly rather
  // than writing `audioReady` into IndexedDB.
  expect(
    outboxDocumentSchema.safeParse({ ...validDocument(), audioReady: true, audioBytes: 2048 })
      .success,
  ).toBe(false);
});

test("every status is active, finished, recording, or explicitly parked for a human", () => {
  // `awaiting-review` is in neither set on purpose — that omission is the review
  // gate. It is named here rather than left as a hole, so a future status added
  // to neither set fails this test instead of silently joining it.
  const PARKED: readonly OutboxStatus[] = ["awaiting-review"];
  expect(
    [
      ...ACTIVE_OUTBOX_STATUSES,
      ...FINISHED_OUTBOX_STATUSES,
      ...RECORDING_OUTBOX_STATUSES,
      ...PARKED,
    ].sort(),
  ).toEqual([...OUTBOX_STATUSES].sort());
});

test("awaiting-review is a status but is deliberately not active", () => {
  // The gate. `nextPending()` selects on ACTIVE_OUTBOX_STATUSES, so keeping
  // awaiting-review out of it is the only thing that stops the relay writing an
  // un-reviewed item — see the design §2.3 and §3.3.
  expect(OUTBOX_STATUSES).toContain("awaiting-review");
  expect(ACTIVE_OUTBOX_STATUSES as readonly string[]).not.toContain("awaiting-review");
  expect(FINISHED_OUTBOX_STATUSES as readonly string[]).not.toContain("awaiting-review");
});

test("discarded is terminal and distinct from dead", () => {
  expect(FINISHED_OUTBOX_STATUSES as readonly string[]).toContain("discarded");
  expect(ACTIVE_OUTBOX_STATUSES as readonly string[]).not.toContain("discarded");
});

test("every status fits the indexed maxLength the RxDB schema declares", () => {
  // `status` is stored with maxLength 16. A longer status name silently breaks
  // RxDB's fixed-width index encoding, so this is pinned rather than assumed.
  const bound = outboxRxSchema.properties.status.maxLength!;
  for (const status of OUTBOX_STATUSES) expect(status.length).toBeLessThanOrEqual(bound);
});

test("a document carries an optional review outcome", () => {
  const base = {
    id: "a",
    seq: 0,
    status: "awaiting-review",
    idempotencyKey: "k",
    attempts: 0,
    nextAttemptAt: new Date(0).toISOString(),
    enqueuedAt: new Date(0).toISOString(),
    recording: {
      id: "r",
      capturedAt: new Date(0).toISOString(),
      durationMs: 1,
      mimeType: "audio/webm",
      ctx: {},
    },
  };
  expect(outboxDocumentSchema.parse(base).reviewOutcome).toBeUndefined();

  const reviewed = outboxDocumentSchema.parse({
    ...base,
    reviewOutcome: { status: "accepted", fields: { atticRValue: 19 } },
  });
  expect(reviewed.reviewOutcome).toEqual({ status: "accepted", fields: { atticRValue: 19 } });
});

test("the RxDB schema is at version 3", () => {
  expect(outboxRxSchema.version).toBe(3);
});

/** A minimal document that parses, for the negative cases to mutate. */
function validDocument() {
  return {
    id: "a",
    seq: 0,
    status: "queued",
    idempotencyKey: "k",
    attempts: 0,
    nextAttemptAt: "2026-07-23T10:00:00.000Z",
    enqueuedAt: "2026-07-23T10:00:00.000Z",
    recording: {
      id: "r",
      capturedAt: "2026-07-23T10:00:00.000Z",
      durationMs: 0,
      mimeType: "audio/webm",
      ctx: {},
    },
  };
}

test("a status not in the state machine is rejected at the boundary", () => {
  const valid = validDocument();
  expect(outboxDocumentSchema.safeParse(valid).success).toBe(true);
  expect(outboxDocumentSchema.safeParse({ ...valid, status: "uploading" }).success).toBe(false);
  expect(outboxDocumentSchema.safeParse({ ...valid, nextAttemptAt: "soon" }).success).toBe(false);
  expect(outboxDocumentSchema.safeParse({ ...valid, seq: -1 }).success).toBe(false);
});

test("recording is a status, and it is in exactly one category", () => {
  expect(OUTBOX_STATUSES).toContain("recording");
  // The partition test already fails for a status in no bucket. This asserts the
  // membership DIRECTLY, because the behavioural relay test can pass even if
  // `recording` were wrongly added to the active set — some other guard might
  // still skip it.
  expect(ACTIVE_OUTBOX_STATUSES).not.toContain("recording");
  expect(FINISHED_OUTBOX_STATUSES).not.toContain("recording");
  expect(RECORDING_OUTBOX_STATUSES).toEqual(["recording"]);
});

test("a recording document must carry capture", () => {
  const base = validDocument();
  expect(() =>
    outboxDocumentSchema.parse({ ...base, status: "recording", capture: undefined }),
  ).toThrow();
});

test("capture carries only sourceId — owner is gone", () => {
  const base = validDocument();
  const doc = outboxDocumentSchema.parse({
    ...base,
    status: "recording",
    capture: { sourceId: "s1" },
  });
  expect(doc.capture).toEqual({ sourceId: "s1" });
  // An owner field is now unrecognized — strictObject rejects it.
  expect(() =>
    outboxDocumentSchema.parse({
      ...base,
      status: "recording",
      capture: { sourceId: "s1", owner: "o1" },
    }),
  ).toThrow();
});

/**
 * The unpatchable fields, asserted at the TYPE level because nothing else can.
 *
 * `OutboxPatch` is derived by `Omit`, so a field dropping out of that list is invisible to
 * every runtime test — the schema still parses, the tests still pass, and a caller quietly
 * gains the ability to rewrite something that was never meant to change. Verified: removing
 * `capture` from the omit list breaks neither `pnpm typecheck` nor any test in this file.
 *
 * `capture.sourceId` is the one that would hurt. It names a recording's chunk attachments,
 * so a patched `sourceId` orphans every chunk already on disk — the same class of data loss
 * that an earlier revision of the durable-capture design shipped and had to withdraw. The
 * others are here for the reason their own doc comment gives: decided once, and re-deciding
 * any of them breaks ordering, provenance or idempotency.
 *
 * Each `@ts-expect-error` IS the assertion. If the field becomes patchable the directive
 * goes unused, and an unused directive is a typecheck error — so this fails loudly in the
 * one place a runtime test cannot reach.
 */
test("the fields decided once stay decided — none of them is patchable", () => {
  // @ts-expect-error `capture` names the chunk attachments; patching sourceId orphans them.
  const capture: OutboxPatch = { capture: { sourceId: "s1" } };
  // @ts-expect-error `id` is the primary key.
  const id: OutboxPatch = { id: "other" };
  // @ts-expect-error `seq` is the queue's ordering key.
  const seq: OutboxPatch = { seq: 99 };
  // @ts-expect-error `idempotencyKey` must survive every retry unchanged.
  const key: OutboxPatch = { idempotencyKey: "regenerated" };
  // @ts-expect-error `recording` is capture provenance, not queue state.
  const recording: OutboxPatch = { recording: undefined };
  // @ts-expect-error `enqueuedAt` is when it entered the queue, once.
  const enqueuedAt: OutboxPatch = { enqueuedAt: "2026-01-01T00:00:00.000Z" };
  // @ts-expect-error `preview` is append-only through `appendPreviewSegment` and
  // deleted only in the same modification that writes `transcript`. A patch could
  // bypass the stale-reply guard and let a half-applied state reach subscribers.
  const preview: OutboxPatch = { preview: { segments: ["overwritten"] } };

  // The values are irrelevant — the directives above are the test. Referencing them keeps
  // the linter from removing what looks like dead code and taking the assertions with it.
  expect([capture, id, seq, key, recording, enqueuedAt, preview]).toHaveLength(7);
});
