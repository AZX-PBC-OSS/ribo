import { expect, test } from "vitest";

import {
  ACTIVE_OUTBOX_STATUSES,
  DERIVED_OUTBOX_ITEM_KEYS,
  FINISHED_OUTBOX_STATUSES,
  OUTBOX_STATUSES,
  outboxDocumentSchema,
  outboxItemSchema,
  outboxRxSchema,
} from "./schema.js";

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

test("the optional fields are the step outputs and the error message", () => {
  expect(optionalKeys).toEqual(["extracted", "lastError", "transcript", "writeResult"]);
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
  // The whole point of computing them: a stored `hasAudio` would be a second
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
    outboxItemSchema.safeParse({ ...document, hasAudio: true, audioBytes: 2048 }).success,
  ).toBe(true);
  expect(outboxItemSchema.safeParse({ ...document, hasAudio: false, audioBytes: -1 }).success).toBe(
    false,
  );
});

test("the projection's extra keys do not leak back into a document parse", () => {
  // `outboxDocumentSchema` is what `enqueue` validates before the storage write,
  // and it is strict — so an item accidentally handed to it fails loudly rather
  // than writing `hasAudio` into IndexedDB.
  expect(
    outboxDocumentSchema.safeParse({ ...validDocument(), hasAudio: true, audioBytes: 2048 })
      .success,
  ).toBe(false);
});

test("the active and finished status sets partition the state machine", () => {
  expect([...ACTIVE_OUTBOX_STATUSES, ...FINISHED_OUTBOX_STATUSES].sort()).toEqual(
    [...OUTBOX_STATUSES].sort(),
  );
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
