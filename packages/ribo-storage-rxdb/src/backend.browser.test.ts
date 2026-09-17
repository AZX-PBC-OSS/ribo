import { addRxPlugin } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { describe, expect, it } from "vitest";

import { runStorageConformance } from "@azx/ribo-core/testing";

import { openRxdbBackend } from "./open.js";

/**
 * @file The RxDB backend against the conformance kit, in real Chromium.
 *
 * A browser test, not a node one, and that is the point: the obligations this
 * kit pins are about what IndexedDB does across an await boundary — a document
 * published before its attachment lands, two tabs racing a sequence. Running
 * them against a synchronous fake would prove nothing.
 *
 * The document factories carry what the port does not know: these documents have
 * to satisfy real `RxJsonSchema`s with required fields and indexed bounds, which
 * is exactly why the kit takes factories instead of building documents itself.
 */
// Dev-mode is what unlocks `ignoreDuplicate` (RxDB refuses it otherwise, DB9),
// and `ignoreDuplicate` is what lets the kit open two contexts on one database
// to prove obligations 2 and 6. Registered HERE, never in the backend:
// `addRxPlugin` is a PROCESS-GLOBAL side effect, and production should carry
// neither the bundle cost nor the per-write validation.
//
// Dev-mode then requires, unconditionally, that every `createRxDatabase` in this
// context use a schema-validating storage (DVM1). `wrappedValidateAjvStorage`
// adds no dependency of this package's own -- `ajv` is rxdb's own, resolved
// through rxdb. The stricter validation is a bonus: these documents are checked
// harder here than in production.
//
// Vitest's browser project isolates each test FILE in its own page, which is why
// the global registration cannot reach any other suite.
// `outbox-reopen-cross-tab.browser.test.ts` established this pattern and its
// header explains it at length.
addRxPlugin(RxDBDevModePlugin);

runStorageConformance("rxdb", {
  describe,
  it,
  expect,
  // `ignoreDuplicate` is what lets the kit open two contexts on one database.
  // See `OpenRxdbBackendOptions` -- it is a test-only flag, and with
  // multiInstance on the two instances behave as two tabs.
  createBackend: (databaseName) =>
    openRxdbBackend({
      name: databaseName,
      storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie() }),
      ignoreDuplicate: true,
    }),

  makeCapture: ({ id, seq, status, sessionId }) => ({
    id,
    seq,
    status,
    sessionId,
    attempts: 0,
    nextAttemptAt: "2026-01-01T00:00:00.000Z",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    recording: { id, kind: "audio", durationMs: 1000, startedAt: "2026-01-01T00:00:00.000Z" },
  }),

  makeSession: ({ id, status, openedAt, ref }) => ({
    id,
    status,
    openedAt,
    ref,
    ctx: {},
    attempts: 0,
    nextAttemptAt: openedAt,
    idempotencyKey: `idem-${id}`,
  }),

  makeEntry: ({ id, scopeKind, scopeId, owner, key, value }) => ({
    id,
    scopeKind,
    scopeId,
    owner,
    key,
    value,
  }),
});
