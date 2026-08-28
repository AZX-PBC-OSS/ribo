import { addRxPlugin, createRxDatabase } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { afterEach, expect, test } from "vitest";

import type { Recording } from "../recording.js";
import type { Transcript } from "../transcript.js";
import { SESSION_COLLECTION_NAME, sessionRxSchema } from "./session-schema.js";
import {
  OUTBOX_MIGRATION_STRATEGIES,
  removeOutboxDatabase,
  type OutboxCollection,
  type OutboxDatabase,
  type SessionCollection,
} from "./database.js";
import { openOutbox, Outbox } from "./outbox.js";
import { OUTBOX_COLLECTION_NAME, outboxRxSchema } from "./schema.js";

/**
 * @file The genuinely cross-tab case for `reopenForReview`'s concurrency guard —
 * two independent `Outbox` instances, each its own `RxDatabase` connection over
 * the SAME IndexedDB database, rather than two calls issued through one.
 *
 * ## Why this could not simply be added to `outbox.browser.test.ts`
 *
 * Opening a second `RxDatabase` with a name already open in the same JS
 * process throws RxDB's DB8 ("already exists") by default — a check that has
 * nothing to do with real browser tabs (two actual tabs are two separate JS
 * heaps, each with its own module-level bookkeeping, and never see this at
 * all) and everything to do with one process opening the same name twice.
 * RxDB's own escape hatch, `ignoreDuplicate: true`, is how RxDB tests its own
 * multi-instance behaviour, but it throws DB9 instead unless
 * `RxDBDevModePlugin` has been registered first — and that registration is a
 * PROCESS-GLOBAL side effect (`Outbox.submitReview`'s own doc comment records
 * this as the reason its cross-tab case went untested). Vitest's browser
 * project isolates each test FILE in its own page, so paying that cost here
 * cannot change how any of `outbox.browser.test.ts`'s ~60 other assertions
 * run; that isolation is the entire reason this is its own file rather than a
 * few more tests appended to that one.
 *
 * Dev mode has a second, unconditional requirement once registered: EVERY
 * `createRxDatabase` call in this JS context — not only the `ignoreDuplicate`
 * one — must use a storage wrapped by one of RxDB's `validate-*` plugins
 * (`preCreateRxDatabase`'s dev-mode hook throws `DVM1` otherwise, discovered
 * empirically: the plain `openOutbox({ name })` this file's FIRST connection
 * would otherwise use failed with it too). `wrappedValidateAjvStorage` is used
 * below for both connections; it adds no dependency of this package's own —
 * `ajv` is `rxdb`'s own direct dependency, resolved through `rxdb`'s package,
 * not this one's.
 *
 * ## What this proves, and what it does not
 *
 * It proves `reopenForReview`'s `incrementalModify` guard survives a genuine
 * write race between two independent connections to the same underlying
 * IndexedDB store — the case an in-memory mutex scoped to a single `Outbox`
 * object cannot be fooled into passing, unlike the single-instance test in
 * `outbox.browser.test.ts`. It does not exercise `submitReview`'s identical
 * guard directly (see that method's own doc comment for why the two should be
 * weighed the same way regardless), and it does not exercise RxDB's own
 * multi-instance change-propagation (`eventReduce`, leader election) — this
 * file's `ignoreDuplicate` seam is a way to get two connections in one
 * process, not a claim that two tabs behave identically to it in every way.
 */

addRxPlugin(RxDBDevModePlugin);

const openOutboxes: Outbox[] = [];
const usedNames: string[] = [];

function uniqueName(): string {
  const name = `ribo-outbox-cross-tab-test-${crypto.randomUUID()}`;
  usedNames.push(name);
  return name;
}

afterEach(async () => {
  for (const outbox of openOutboxes.splice(0)) {
    if (!outbox.closed) await outbox.close();
  }
  for (const name of usedNames.splice(0)) await removeOutboxDatabase(name);
});

/**
 * A second, independent connection to an ALREADY-OPEN outbox database —
 * everything `openOutboxDatabase` (`database.ts`) does, plus the
 * `ignoreDuplicate: true` production code has no reason to ever pass, since a
 * real second tab is a separate process with no duplicate to ignore. Kept
 * local to this file rather than added as an option on `openOutbox` for
 * exactly that reason: it is a test-only way to simulate "a second tab" within
 * one JS heap, not a knob a host should be able to reach for.
 */
async function openSecondConnection(name: string): Promise<Outbox> {
  const database: OutboxDatabase = await createRxDatabase<{
    outbox: OutboxCollection;
    sessions: SessionCollection;
  }>({
    name,
    storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie() }),
    multiInstance: true,
    eventReduce: true,
    ignoreDuplicate: true,
    cleanupPolicy: {},
  });
  await database.addCollections({
    [OUTBOX_COLLECTION_NAME]: {
      schema: outboxRxSchema,
      migrationStrategies: OUTBOX_MIGRATION_STRATEGIES,
    },
    [SESSION_COLLECTION_NAME]: {
      schema: sessionRxSchema,
    },
  });
  const outbox = new Outbox(database);
  openOutboxes.push(outbox);
  return outbox;
}

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 4200,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
};

const dyingTranscript: Transcript = {
  recordingId: recording.id,
  text: "the attic is R-19",
  engine: "fake",
};

function audioBlob(): Blob {
  return new Blob([new Uint8Array(64)], { type: "audio/webm;codecs=opus" });
}

test("two reopenForReview calls from two independent Outbox connections settle as one winner and one refusal", async () => {
  const name = uniqueName();
  // `storage` is the existing seam `OpenOutboxOptions` already exposes for a
  // host that wants a different engine — used here for a validate wrapper
  // instead, so the FIRST connection can go through the real `openOutbox` and
  // still satisfy dev mode's DVM1 check.
  const first = await openOutbox({
    name,
    storage: wrappedValidateAjvStorage({ storage: getRxStorageDexie() }),
  });
  openOutboxes.push(first);

  const item = await first.enqueue({ recording, audio: audioBlob() });
  await first.patch(item.id, {
    status: "dead",
    transcript: dyingTranscript,
    extracted: { atticRValue: {} },
  });

  const second = await openSecondConnection(name);

  const results = await Promise.allSettled([
    first.reopenForReview(item.id),
    second.reopenForReview(item.id),
  ]);

  // Exactly one connection's write landed. An implementation guarded only by an
  // in-memory mutex scoped to one `Outbox` object would do nothing to prevent
  // BOTH of these from reading "dead" and BOTH from believing they won — this
  // is the shape of bug this file exists to catch that the single-instance test
  // cannot.
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);

  // Read back through a THIRD lens — the first connection's own `get`, after
  // the race has settled — so the assertion is not merely "one promise
  // resolved", but "the row actually ended up parked, once, not twice".
  const settled = await first.get(item.id);
  expect(settled?.status).toBe("awaiting-review");
  expect(settled?.reviewOutcome).toBeUndefined();
});
