import { expect, test } from "vitest";
import { z } from "zod";

import { captureDocumentSchema } from "../capture-schema.js";
import { CAPTURE_DOCUMENT_VERSION } from "./captures.js";
import { PLUGIN_STORAGE_DOCUMENT_VERSION } from "./plugin-storage.js";
import { SESSION_DOCUMENT_VERSION } from "./sessions.js";
import { pluginStorageDocumentSchema } from "../plugin-storage-schema.js";
import { sessionDocumentSchema } from "../session-schema.js";
import { shapeSignature } from "./signature.js";

/**
 * @file The shapes that exist on real devices, pinned per version.
 *
 * Read `persisted-names.test.ts` first — this is the same idea for a different
 * hazard. That file pins the names rows are filed under; this one pins what a row
 * IS at each version.
 *
 * **If one of these assertions fails, do not edit the expected string.** A
 * failure means a persisted document's shape changed, and the shape is half of a
 * contract whose other half is the version number. RxDB validates a declared
 * schema against the one a collection was CREATED with, so a changed shape at an
 * unchanged version is refused at `addCollections` with DB6 — on every device
 * that has ever opened the app, whether or not it holds a row of the collection
 * you touched. All three collections are added in one call on one database, so
 * that refusal is never scoped: it takes the captures down with it and an
 * auditor's recordings become unreachable, with clearing the origin's IndexedDB
 * as the only way out.
 *
 * That is not hypothetical. It shipped in #38 and was fixed in #40, and the
 * commit message for the fix is worth reading before you decide this is a
 * formality.
 *
 * **What this adds, stated honestly, because it is narrower than it looks.**
 * `@azx/ribo-storage-rxdb` already catches a field appearing or disappearing on
 * all three documents — `schema.test.ts`, `session-schema.test.ts` and
 * `plugin-storage-schema.test.ts` each pin their optional-field list as a
 * literal, and I verified that by adding a probe field to both descriptions of
 * each document and watching them fail. So this is not the only guard, and a
 * claim that nothing else catches it would be false.
 *
 * What it adds is *where it lives*. Those pins are one backend's private
 * discipline, in a package a second backend does not depend on. This one is in
 * core, beside the schema it describes, so every backend inherits it — which is
 * the entire thesis of moving migrations into core. A second backend written
 * against the port today gets the ladders, the rungs and this guard for free,
 * and gets none of the RxDB package's care.
 *
 * It is also the only one that ties the shape to a *version*. The RxDB pins say
 * "these two descriptions agree"; this says "this shape belongs to version N".
 *
 * So the fix for a red assertion here is the whole job: bump the version
 * constant, add a rung to the ladder saying why, and add a NEW row below with the
 * new signature. The old rows stay — they are the record of what each version
 * was, and a future rung author reads them to know what they are transforming
 * from.
 */

// Written out as literals, never computed from the schema. A table that derived
// its expected value from the thing it checks would pass forever and guard
// nothing — the same trap as deriving a version constant from a ladder's length.
//
// Only the current version is checked mechanically. The earlier entries are the
// record of what each version was, for a future rung author to read.
const CAPTURE_SIGNATURES: Record<number, string> = {
  7:
    "attempts,capture?,enqueuedAt,id,lastError?,legacy?,nextAttemptAt,preview?," +
    "recording,seq,sessionId,status,transcript?",
};

const SESSION_SIGNATURES: Record<number, string> = {
  2:
    "attempts,closedAt?,ctx?,extracted?,extractedBy?,extractedFromRecordingIds?," +
    "extractionUsage?,id,idempotencyKey,lastError?,nextAttemptAt,openedAt,receipts?," +
    "ref,reviewOutcome?,statedEmptyGroups?,status,writeResult?",
  3:
    "attempts,closedAt?,ctx?,extracted?,extractedBy?,extractedFromRecordingIds?," +
    "extractionUsage?,id,idempotencyKey,lastError?,nextAttemptAt,openedAt,receipts?," +
    "ref,reviewOutcome?,skippedItems?,statedEmptyGroups?,status,writeResult?",
};

const PLUGIN_STORAGE_SIGNATURES: Record<number, string> = {
  1: "id,key,owner,scopeId,scopeKind,value",
};

test("the capture document's shape matches the signature recorded for its version", () => {
  expect(shapeSignature(captureDocumentSchema)).toBe(CAPTURE_SIGNATURES[CAPTURE_DOCUMENT_VERSION]);
});

test("the session document's shape matches the signature recorded for its version", () => {
  expect(shapeSignature(sessionDocumentSchema)).toBe(SESSION_SIGNATURES[SESSION_DOCUMENT_VERSION]);
});

test("the entry document's shape matches the signature recorded for its version", () => {
  expect(shapeSignature(pluginStorageDocumentSchema)).toBe(
    PLUGIN_STORAGE_SIGNATURES[PLUGIN_STORAGE_DOCUMENT_VERSION],
  );
});

// Proof the guard fires. Without this, a signature test that has never failed is
// indistinguishable from one that cannot fail — and the #38 replay is exactly
// what it has to catch: an OPTIONAL field added at an unchanged version, which is
// the shape that feels harmless enough to ship.
test("adding an optional field changes the signature, which is what catches a missing bump", () => {
  const before = z.strictObject({ id: z.string(), status: z.string() });
  const after = before.extend({ extractionUsage: z.string().optional() });

  expect(shapeSignature(before)).toBe("id,status");
  expect(shapeSignature(after)).toBe("extractionUsage?,id,status");
  expect(shapeSignature(after)).not.toBe(shapeSignature(before));
});

test("a field becoming optional changes the signature too", () => {
  const required = z.strictObject({ id: z.string(), ctx: z.object({}) });
  const optional = z.strictObject({ id: z.string(), ctx: z.object({}).optional() });

  expect(shapeSignature(required)).toBe("ctx,id");
  expect(shapeSignature(optional)).toBe("ctx?,id");
});
