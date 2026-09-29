import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  ACTIVE_SESSION_STATUSES,
  FINISHED_SESSION_STATUSES,
  SESSION_COLLECTION_NAME,
  SESSION_STATUSES,
  sessionDocumentSchema,
  sessionItemSchema,
} from "@azx/ribo-core";
import { SESSION_MIGRATION_STRATEGIES, sessionRxSchema } from "./schemas.js";
import type { SessionDocument, SessionPatch, SessionStatus } from "@azx/ribo-core";

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

test("the optional fields are the step outputs, the error, the close timestamp, receipts, statedEmptyGroups, and skippedItems", () => {
  expect(optionalKeys).toEqual([
    "closedAt",
    "extracted",
    "extractedBy",
    "extractedFromRecordingIds",
    "extractionUsage",
    "lastError",
    "receipts",
    "reviewOutcome",
    "skippedItems",
    "statedEmptyGroups",
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

test("the collection name is not the storage's", () => {
  expect(SESSION_COLLECTION_NAME).toBe("sessions");
  expect(SESSION_COLLECTION_NAME).not.toBe("storage");
});

test("the RxDB schema is at version 3, with a strategy for each step it took", () => {
  // v0 → v1 added `extractionUsage`. v1 → v2 added `receipts` and backfills
  // `reviewOutcome.instanceKeys` for pre-existing accepted/edited outcomes.
  // v2 → v3 added `skippedItems` (identity — an absent optional field is the
  // correct state for every pre-existing session). An OPTIONAL addition still
  // needs the bump: RxDB validates the declared schema against the one the
  // collection was created with, so adding a property at the same version
  // fails at `addCollections` with DB6 — a database that will not open. Every
  // version must also have a strategy, or `addCollections` fails with COL12
  // instead.
  expect(sessionRxSchema.version).toBe(3);
  expect(Object.keys(SESSION_MIGRATION_STRATEGIES)).toEqual(["1", "2", "3"]);
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

describe("SESSION_MIGRATION_STRATEGIES[2] — v1 → v2 backfills instanceKeys", () => {
  const migrate = SESSION_MIGRATION_STRATEGIES;

  test("a v1 accepted outcome with collection-group fields gets instanceKeys", () => {
    const v1 = {
      ...validSession(),
      status: "writing" as const,
      reviewOutcome: {
        status: "accepted" as const,
        fields: {
          hvac: [{ hvacSystemEquipmentType: "Boiler" }, { hvacSystemEquipmentType: "Furnace" }],
        },
      },
    } as SessionDocument;
    const migrated = migrate[2]!(v1);
    expect(
      (migrated.reviewOutcome as { instanceKeys?: Record<string, string[]> } | undefined)
        ?.instanceKeys,
    ).toEqual({ hvac: ["k1", "k2"] });
  });

  test("a v1 document with no reviewOutcome migrates unchanged", () => {
    const v1 = validSession() as SessionDocument;
    const migrated = migrate[2]!(v1);
    expect(migrated).toEqual(v1);
    expect(migrated.receipts).toBeUndefined();
    expect(migrated.reviewOutcome).toBeUndefined();
  });

  test("a v1 discarded outcome migrates unchanged", () => {
    const v1 = {
      ...validSession(),
      reviewOutcome: { status: "discarded" as const },
    } as SessionDocument;
    const migrated = migrate[2]!(v1);
    expect(migrated).toEqual(v1);
  });

  test("a v2 document already carrying receipts and instanceKeys round-trips unchanged", () => {
    const v2 = {
      ...validSession(),
      status: "done" as const,
      reviewOutcome: {
        status: "accepted" as const,
        fields: { hvac: [{ hvacSystemEquipmentType: "Boiler" }] },
        instanceKeys: { hvac: ["k1"] },
      },
      receipts: { singleton: "uuid-1" },
    } as SessionDocument;
    const migrated = migrate[2]!(v2);
    expect(migrated).toEqual(v2);
  });
});

describe("statedEmptyGroups — additive optional field on v2, cleared on re-extraction", () => {
  test("a v1 document with no statedEmptyGroups migrates to a v2 document still lacking it", () => {
    const v1 = {
      ...validSession(),
      status: "writing" as const,
      reviewOutcome: {
        status: "accepted" as const,
        fields: { hvac: [{ hvacSystemEquipmentType: "Boiler" }] },
      },
    } as SessionDocument;
    const migrated = SESSION_MIGRATION_STRATEGIES[2]!(v1);
    expect(migrated.statedEmptyGroups).toBeUndefined();
  });

  test("re-extraction clears a prior statedEmptyGroups — the field is content, not transport metadata", () => {
    // Simulates what #sessionExtract does: the relay patch unconditionally sets
    // statedEmptyGroups (to `undefined` when the new extraction reports none),
    // rather than conditionally spreading it. A stale quote from a prior run
    // must not survive a re-extraction whose roster no longer states a group
    // is empty — same reasoning as `lastError: undefined` clearing a prior error.
    const prior = sessionDocumentSchema.parse({
      ...validSession(),
      status: "awaiting-review" as const,
      extracted: { hvac: [] },
      statedEmptyGroups: { hvac: "there's no HVAC in this unit" },
    });

    // The relay's patch: { ..., statedEmptyGroups: result.statedEmptyGroups, ... }
    // where `result.statedEmptyGroups` is `undefined` because the new extraction
    // reported no stated-empty groups.
    const reExtractedPatch: SessionPatch = {
      extracted: { hvac: [{ hvacSystemEquipmentType: "Boiler" }] },
      statedEmptyGroups: undefined,
      status: "awaiting-review" as const,
      attempts: 0,
    };

    // patchSession validates the merged document before writing — this is
    // exactly what storage.patchSession does: `sessionItemSchema.parse({ ...doc, ...patch })`.
    const merged = { ...prior, ...reExtractedPatch };
    const parsed = sessionItemSchema.parse(merged);
    expect(parsed.statedEmptyGroups).toBeUndefined();
  });
});

describe("skippedItems — additive optional field on v3, cleared on re-extraction", () => {
  test("a v2 document migrates to a v3 document still lacking skippedItems", () => {
    const v2 = {
      ...validSession(),
      status: "awaiting-review" as const,
      extracted: { hvac: [] },
      statedEmptyGroups: { hvac: "there's no HVAC in this unit" },
    } as SessionDocument;
    const migrated = SESSION_MIGRATION_STRATEGIES[3]!(v2);
    expect(migrated.skippedItems).toBeUndefined();
    // The v2 field the document does carry survives the identity rung.
    expect(migrated.statedEmptyGroups).toEqual({ hvac: "there's no HVAC in this unit" });
  });

  test("a persisted skippedItems round-trips the zod boundary with its coordinates intact", () => {
    const doc = sessionDocumentSchema.parse({
      ...validSession(),
      status: "awaiting-review" as const,
      extracted: { hvac: [{ hvacSystemEquipmentType: null }] },
      skippedItems: [
        { phaseId: "fill", key: "hvac", instance: 1, instances: 1, part: 2, parts: 2 },
      ],
    });
    expect(doc.skippedItems).toEqual([
      { phaseId: "fill", key: "hvac", instance: 1, instances: 1, part: 2, parts: 2 },
    ]);
  });

  test("re-extraction clears a prior skippedItems — content, not transport metadata, and absent stays distinct from []", () => {
    // The relay patches skippedItems unconditionally: an extraction that
    // reports skips must clear a prior run's stale report, and an extraction
    // with no skip path must leave the field ABSENT — not write `[]`, which
    // would claim "verified nothing skipped" for a run that cannot report.
    const prior = sessionDocumentSchema.parse({
      ...validSession(),
      status: "awaiting-review" as const,
      extracted: { hvac: [{ hvacSystemEquipmentType: null }] },
      skippedItems: [{ phaseId: "fill", key: "hvac", instance: 1, instances: 1 }],
    });

    const clearedPatch: SessionPatch = {
      extracted: { hvac: [{ hvacSystemEquipmentType: "Boiler" }] },
      skippedItems: undefined,
      status: "awaiting-review" as const,
      attempts: 0,
    };
    const cleared = sessionItemSchema.parse({ ...prior, ...clearedPatch });
    expect(cleared.skippedItems).toBeUndefined();

    const emptyReportPatch: SessionPatch = {
      extracted: { hvac: [{ hvacSystemEquipmentType: "Boiler" }] },
      skippedItems: [],
      status: "awaiting-review" as const,
      attempts: 0,
    };
    const emptyReport = sessionItemSchema.parse({ ...cleared, ...emptyReportPatch });
    expect(emptyReport.skippedItems).toEqual([]);
  });
});
