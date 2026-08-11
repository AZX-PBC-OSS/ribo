import { addRxPlugin, createRxDatabase } from "rxdb";
import type { RxCollection, RxDatabase, RxJsonSchema } from "rxdb";
import { RxDBAttachmentsPlugin } from "rxdb/plugins/attachments";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { firstValueFrom } from "rxjs";
import { afterEach, expect, test, vi } from "vitest";

import type { Recording } from "../recording.js";
import type { PersistedReviewOutcome } from "../review.js";
import type { Transcript } from "../transcript.js";
import { openOutbox, type Outbox } from "./outbox.js";
import { removeOutboxDatabase } from "./database.js";
import {
  ACTIVE_OUTBOX_STATUSES,
  FINISHED_OUTBOX_STATUSES,
  OUTBOX_COLLECTION_NAME,
  OUTBOX_STATUSES,
  outboxRxSchema,
  type OutboxDocument,
  type OutboxItem,
} from "./schema.js";

// Browser-mode, not jsdom, and that is the entire point of this file.
// `fake-indexeddb` (what jsdom tests would reach for) is an in-memory shim: a
// "close and reopen" round trip against it proves nothing at all, because the
// bytes never left the JS heap. Everything here runs against Chromium's real
// IndexedDB via RxDB's Dexie RxStorage, so "survives a reload" means what it
// says.

const openDatabases: Outbox[] = [];
const usedNames: string[] = [];

/**
 * A database name nobody else in this run will touch. IndexedDB is per-origin
 * and every browser test file shares one origin, so a fixed name would let one
 * test's leftovers satisfy another test's assertions.
 */
function uniqueName(): string {
  const name = `ribo-outbox-test-${crypto.randomUUID()}`;
  usedNames.push(name);
  return name;
}

async function open(name: string, options: Parameters<typeof openOutbox>[0] = { name }) {
  const outbox = await openOutbox({ ...options, name });
  openDatabases.push(outbox);
  return outbox;
}

afterEach(async () => {
  for (const outbox of openDatabases.splice(0)) {
    if (!outbox.closed) await outbox.close();
  }
  for (const name of usedNames.splice(0)) await removeOutboxDatabase(name);
});

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 4200,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
};

/** Recognisable, non-trivial bytes: a zero-filled blob would compare equal to a bug. */
const audioBytes = new Uint8Array(2048).map((_, i) => (i * 31 + 7) % 256);

function audioBlob(): Blob {
  return new Blob([audioBytes], { type: "audio/webm;codecs=opus" });
}

/**
 * A transcript for the `reopenForReview` fixtures below.
 *
 * A genuine `dead` item that carries `extracted` data always has one too:
 * `relay.ts`'s `nextStep` never returns `"extract"` until a transcript is
 * already persisted, so extraction — and therefore a review-worthy `dead`
 * item — cannot exist without it. A fixture built with `extracted` but no
 * transcript would construct a state the real pipeline never produces, and
 * `reopenForReview` would then be asserted successful on exactly that
 * fiction rather than on anything reachable in production.
 */
const dyingTranscript: Transcript = {
  recordingId: recording.id,
  text: "the attic is R-19",
  engine: "fake",
};

// ---------------------------------------------------------------------------
// Raw IndexedDB access — deliberately not going through RxDB.
//
// The Dexie RxStorage lays one IndexedDB database out per collection, named
// `rxdb-dexie-<database>--<schemaVersion>--<collection>`, with `docs` and
// `attachments` object stores. Reading those directly is coupled to an RxDB
// implementation detail, and that coupling is the price of an assertion that
// cannot be satisfied by anything in our own code — see the note on the
// durability test below for why nothing weaker is enough.
// ---------------------------------------------------------------------------

function idbDatabaseName(outboxName: string, schemaVersion = outboxRxSchema.version): string {
  // The `--N--` segment is RxDB's schema version. Read it from the schema rather
  // than hardcoding it, so a version bump does not send this test looking in a
  // database that was never created.
  return `rxdb-dexie-${outboxName}--${String(schemaVersion)}--outbox`;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Read an object store with plain IndexedDB, with no RxDB in the call stack. */
async function readRawStore(outboxName: string, store: "docs" | "attachments"): Promise<unknown[]> {
  const open = indexedDB.open(idbDatabaseName(outboxName));
  // `onupgradeneeded` firing means the database did not exist: the caller is
  // asserting on persisted bytes that are not there. Fail loudly rather than
  // silently creating an empty database and reporting zero rows.
  let created = false;
  open.onupgradeneeded = () => {
    created = true;
  };
  const database = await promisify(open);
  try {
    if (created || !database.objectStoreNames.contains(store)) {
      throw new Error(
        `IndexedDB database "${idbDatabaseName(outboxName)}" has no "${store}" store — nothing was persisted`,
      );
    }
    return await promisify(database.transaction(store, "readonly").objectStore(store).getAll());
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// The durability test. Task 3 exists for this assertion.
// ---------------------------------------------------------------------------

test("an item and its audio survive being closed and reopened, and are physically in IndexedDB", async () => {
  const name = uniqueName();

  const first = await open(name);
  const enqueued = await first.enqueue({ recording, audio: audioBlob() });
  // Closing is what turns this from a cache test into a durability test: the
  // RxDatabase, its collection, its document cache and Dexie's own connection
  // are all torn down here.
  await first.close();
  expect(first.closed).toBe(true);

  // -- Part 1: the bytes are on disk, proven without RxDB. ------------------
  //
  // Close-then-reopen ALONE does not prove durability, and this was checked
  // rather than assumed: swapping `getRxStorageDexie()` for
  // `getRxStorageMemory()` in database.ts leaves every close/reopen assertion
  // in this file passing, because RxDB's memory storage keeps a module-global
  // store keyed by database name and a `close()` does not clear it. An
  // in-memory fake really can satisfy the obvious version of this test. The
  // raw-IndexedDB reads below are the part it cannot fake: under memory storage
  // there is no `rxdb-dexie-…` database at all and `readRawStore` throws.
  const rawDocs = (await readRawStore(name, "docs")) as { id: string; seq: number }[];
  expect(rawDocs.map((doc) => doc.id)).toEqual([enqueued.id]);
  expect(rawDocs[0]?.seq).toBe(enqueued.seq);

  const rawAttachments = (await readRawStore(name, "attachments")) as {
    id: string;
    data: Blob;
  }[];
  expect(rawAttachments.map((entry) => entry.id)).toEqual([`${enqueued.id}||audio`]);
  const rawAudio = rawAttachments[0]!.data;
  expect(new Uint8Array(await rawAudio.arrayBuffer())).toEqual(audioBytes);

  // -- Part 2: a fresh instance reads it back through the public API. -------
  const second = await open(name);
  expect(second.database).not.toBe(first.database);

  const reloaded = await second.get(enqueued.id);
  expect(reloaded).toEqual(enqueued);

  const audio = await second.getAudio(enqueued.id);
  expect(audio).toBeInstanceOf(Blob);
  expect(audio?.type).toBe("audio/webm;codecs=opus");
  expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(audioBytes);
});

test("step outputs written before a close are readable after a reopen", async () => {
  const name = uniqueName();

  const first = await open(name);
  const enqueued = await first.enqueue({ recording, audio: audioBlob() });
  await first.patch(enqueued.id, {
    status: "extracting",
    transcript: {
      recordingId: recording.id,
      text: "the attic is R-19",
      engine: "ondevice-whisper",
    },
    attempts: 2,
    nextAttemptAt: "2026-07-23T10:05:00.000Z",
    lastError: "network unreachable",
  });
  await first.close();

  const second = await open(name);
  const reloaded = await second.get(enqueued.id);
  expect(reloaded).toMatchObject({
    status: "extracting",
    transcript: {
      recordingId: "rec-1",
      text: "the attic is R-19",
      engine: "ondevice-whisper",
    },
    attempts: 2,
    nextAttemptAt: "2026-07-23T10:05:00.000Z",
    lastError: "network unreachable",
    // Unchanged by the patch, and specifically NOT regenerated on reopen.
    idempotencyKey: enqueued.idempotencyKey,
    seq: enqueued.seq,
  });
});

// ---------------------------------------------------------------------------
// The v0 → v2 schema migration.
//
// A reopen does not test this: `openOutbox` can only ever create a v2 store, so
// two opens against the same name both see version 2, nothing migrates, and the
// test would pass whether or not the migration plugin and strategy exist at all
// — the exact "passes while production is broken" shape this file's own header
// warns about for the durability test above.
//
// A genuine test needs a database whose *stored* version is 0. The task brief
// for this change suggested faking that by writing a raw row into the physical
// `rxdb-dexie-<name>--0--outbox` IndexedDB database, the same way `readRawStore`
// above reads one. That was tried and rejected: RxDB decides whether a
// collection needs migrating from a bookkeeping document in its own *internal*
// store (one per `<collection>-<version>`, holding that version's schema), not
// from the presence of rows in the versioned physical database. A hand-written
// `docs` row with no matching internal meta document is invisible to
// `mustMigrate()` — RxDB just creates a fresh v2 collection and never looks at
// the row, so the test would report a pass while testing nothing, which is a
// worse failure mode than the reopen it was meant to replace.
//
// So the v0 store here is seeded through RxDB's own public API instead: a real
// collection, created at `version: 0` with the schema this file *used* to have
// before this change, populates that internal bookkeeping for real. Opening a
// v2 database over the same name then runs the actual migration path, not an
// imitation of it.
// ---------------------------------------------------------------------------

/** The outbox's RxDB schema exactly as it was before this task's version bump. */
const OUTBOX_RX_SCHEMA_V0: RxJsonSchema<Omit<OutboxDocument, "reviewOutcome" | "capture">> = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    seq: { type: "number", minimum: 0, maximum: 1_000_000_000, multipleOf: 1 },
    status: { type: "string", maxLength: 16 },
    idempotencyKey: { type: "string", maxLength: 64 },
    attempts: { type: "integer", minimum: 0 },
    nextAttemptAt: { type: "string", maxLength: 32 },
    enqueuedAt: { type: "string", maxLength: 32 },
    lastError: { type: "string" },
    recording: { type: "object" },
    transcript: { type: "object" },
    extracted: { type: "object" },
    writeResult: { type: "object" },
  },
  required: [
    "id",
    "seq",
    "status",
    "idempotencyKey",
    "attempts",
    "nextAttemptAt",
    "enqueuedAt",
    "recording",
  ],
  indexes: ["seq"],
  attachments: {},
};

/** The v0 document shape: everything the current schema has, minus `reviewOutcome`. */
function v0Document(): Omit<OutboxDocument, "reviewOutcome" | "capture"> {
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
      durationMs: 1,
      mimeType: "audio/webm",
      ctx: {},
    },
  };
}

/**
 * Builds a real outbox collection at schema version 0 and writes one document
 * into it, through RxDB's own API rather than raw IndexedDB — see the note
 * above for why that is the part that makes this a genuine migration fixture.
 */
async function seedVersionZeroOutbox(
  name: string,
  document: Omit<OutboxDocument, "reviewOutcome" | "capture">,
): Promise<void> {
  addRxPlugin(RxDBAttachmentsPlugin);
  const database: RxDatabase<{
    outbox: RxCollection<Omit<OutboxDocument, "reviewOutcome" | "capture">>;
  }> = await createRxDatabase({
    name,
    storage: getRxStorageDexie(),
    multiInstance: true,
    eventReduce: true,
    cleanupPolicy: {},
  });
  await database.addCollections({
    [OUTBOX_COLLECTION_NAME]: { schema: OUTBOX_RX_SCHEMA_V0 },
  });
  await database.collections.outbox.insert(document);
  await database.close();
}

test("an outbox stored at schema version 0 opens and migrates to version 2", async () => {
  const name = uniqueName();
  await seedVersionZeroOutbox(name, v0Document());

  const outbox = await open(name);
  const items = await outbox.list({});

  expect(items).toHaveLength(1);
  expect(items[0]?.reviewOutcome).toBeUndefined();
  expect(items[0]?.status).toBe("queued");
});

// ---------------------------------------------------------------------------
// Enqueue invariants
// ---------------------------------------------------------------------------

test("enqueue assigns monotonically increasing seq values that continue across reopen", async () => {
  const name = uniqueName();

  const first = await open(name);
  const a = await first.enqueue({ recording, audio: audioBlob() });
  const b = await first.enqueue({ recording: { ...recording, id: "rec-2" }, audio: audioBlob() });
  expect(b.seq).toBeGreaterThan(a.seq);
  await first.close();

  const second = await open(name);
  const c = await second.enqueue({ recording: { ...recording, id: "rec-3" }, audio: audioBlob() });
  expect(c.seq).toBeGreaterThan(b.seq);
});

test("concurrent enqueues never collide on seq", async () => {
  const outbox = await open(uniqueName());
  const items = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      outbox.enqueue({ recording: { ...recording, id: `rec-${i}` }, audio: audioBlob() }),
    ),
  );
  const seqs = items.map((item) => item.seq).sort((a, b) => a - b);
  expect(new Set(seqs).size).toBe(8);
  expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("enqueue starts an item queued, with zero attempts and an idempotency key", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });

  expect(item.status).toBe("queued");
  expect(item.attempts).toBe(0);
  expect(item.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(item.recording).toEqual(recording);
  expect(item.transcript).toBeUndefined();
  expect(item.extracted).toBeUndefined();
});

test("each enqueue gets its own idempotency key", async () => {
  const outbox = await open(uniqueName());
  const a = await outbox.enqueue({ recording, audio: audioBlob() });
  const b = await outbox.enqueue({ recording: { ...recording, id: "rec-2" }, audio: audioBlob() });
  expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
});

test("list returns items in seq order", async () => {
  const outbox = await open(uniqueName());
  for (const id of ["a", "b", "c"]) {
    await outbox.enqueue({ recording: { ...recording, id }, audio: audioBlob() });
  }
  const listed = await outbox.list();
  expect(listed.map((item) => item.recording.id)).toEqual(["a", "b", "c"]);
});

test("get returns undefined for an unknown id", async () => {
  const outbox = await open(uniqueName());
  expect(await outbox.get("nope")).toBeUndefined();
  expect(await outbox.getAudio("nope")).toBeUndefined();
});

test("audio can be dropped once it is no longer needed, leaving the item intact", async () => {
  const name = uniqueName();
  const first = await open(name);
  const item = await first.enqueue({ recording, audio: audioBlob() });

  await first.dropAudio(item.id);
  expect(await first.getAudio(item.id)).toBeUndefined();
  await first.close();

  const second = await open(name);
  expect(await second.get(item.id)).toBeDefined();
  expect(await second.getAudio(item.id)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// audioReady / audioBytes — attachment presence as an observable fact.
//
// Without these, "audio was never attached", "audio was dropped" and "audio is
// still being written" are one indistinguishable state on `OutboxItem`, because
// `toJSON()` strips `_attachments`. A UI cannot legitimately report a dropped
// recording without them, and that is a real state the moment
// `dropAudioAfterTranscription` is on or iOS evicts the origin.
// ---------------------------------------------------------------------------

test("audioReady tracks the attachment, not a pointer", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  expect(item.audioReady).toBe(true);
  await outbox.dropAudio(item.id);
  const after = await outbox.get(item.id);
  expect(after!.audioReady).toBe(false);
  expect(after!.audioBytes).toBe(0);
});

test("audioReady is true from the moment of enqueue, with the attachment's size", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });

  expect(item.audioReady).toBe(true);
  expect(item.audioBytes).toBe(audioBytes.byteLength);
  // The value the caller got back and the value a reader sees must agree — the
  // return of `enqueue` is a projection of the very document that was written,
  // not a hand-assembled optimistic copy.
  expect(await outbox.get(item.id)).toEqual(item);
  expect((await outbox.list())[0]).toEqual(item);
});

test("audioReady goes false after dropAudio, and items$ re-emits to say so", async () => {
  const outbox = await open(uniqueName());
  const seen: { audioReady: boolean; audioBytes: number }[] = [];
  const subscription = outbox.items$.subscribe((items) => {
    const item = items[0];
    if (item) seen.push({ audioReady: item.audioReady, audioBytes: item.audioBytes });
  });

  try {
    const item = await outbox.enqueue({ recording, audio: audioBlob() });
    await vi.waitFor(() => expect(seen.at(-1)?.audioReady).toBe(true));

    await outbox.dropAudio(item.id);

    // The document's own fields are byte-identical across a `dropAudio`, so
    // before `audioReady` existed this re-emission carried no information at all
    // and a memoizing consumer could not tell anything had happened.
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ audioReady: false, audioBytes: 0 }));
    expect(await outbox.getAudio(item.id)).toBeUndefined();
    expect((await outbox.get(item.id))?.audioReady).toBe(false);
  } finally {
    subscription.unsubscribe();
  }
});

test("audioReady survives a close and reopen, and matches what is physically in IndexedDB", async () => {
  const keptName = uniqueName();
  const droppedName = uniqueName();

  const withAudio = await open(keptName);
  const kept = await withAudio.enqueue({ recording, audio: audioBlob() });
  await withAudio.close();

  const withoutAudio = await open(droppedName);
  const dropped = await withoutAudio.enqueue({ recording, audio: audioBlob() });
  await withoutAudio.dropAudio(dropped.id);
  await withoutAudio.close();

  // Read the raw stores rather than trusting the RxDB handle: `audioReady` is a
  // claim about the attachment store, so the assertion that it is *true* has to
  // come from that store, not from the layer computing the claim.
  expect(
    ((await readRawStore(keptName, "attachments")) as { id: string }[]).map((a) => a.id),
  ).toEqual([`${kept.id}||audio`]);
  expect(await readRawStore(droppedName, "attachments")).toEqual([]);

  const reopenedKept = await open(keptName);
  expect(await reopenedKept.get(kept.id)).toMatchObject({
    audioReady: true,
    audioBytes: audioBytes.byteLength,
  });

  const reopenedDropped = await open(droppedName);
  expect(await reopenedDropped.get(dropped.id)).toMatchObject({ audioReady: false, audioBytes: 0 });
});

test("remove deletes the item and its attachment for good", async () => {
  const name = uniqueName();
  const first = await open(name);
  const item = await first.enqueue({ recording, audio: audioBlob() });
  await first.remove(item.id);
  await first.close();

  const second = await open(name);
  expect(await second.get(item.id)).toBeUndefined();
  expect(await second.getAudio(item.id)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Bulk delete
// ---------------------------------------------------------------------------

test("clear empties the queue, attachments included, in one pass", async () => {
  const name = uniqueName();
  const outbox = await open(name);
  for (const id of ["a", "b", "c"]) {
    await outbox.enqueue({ recording: { ...recording, id }, audio: audioBlob() });
  }

  expect(await outbox.clear()).toBe(3);
  expect(await outbox.list()).toEqual([]);
  await outbox.close();

  const reopened = await open(name);
  expect(await reopened.list()).toEqual([]);
});

test("clear can be scoped, leaving unfinished work alone", async () => {
  const outbox = await open(uniqueName());
  const a = await outbox.enqueue({ recording: { ...recording, id: "a" }, audio: audioBlob() });
  const b = await outbox.enqueue({ recording: { ...recording, id: "b" }, audio: audioBlob() });
  await outbox.patch(a.id, { status: "done" });

  // The "tidy up what has landed" gesture, as opposed to the device reset.
  expect(await outbox.clear({ status: FINISHED_OUTBOX_STATUSES })).toBe(1);
  expect((await outbox.list()).map((item) => item.id)).toEqual([b.id]);
});

test("removeMany deletes the named items and is idempotent", async () => {
  const outbox = await open(uniqueName());
  const a = await outbox.enqueue({ recording: { ...recording, id: "a" }, audio: audioBlob() });
  const b = await outbox.enqueue({ recording: { ...recording, id: "b" }, audio: audioBlob() });
  const c = await outbox.enqueue({ recording: { ...recording, id: "c" }, audio: audioBlob() });

  expect(await outbox.removeMany([a.id, c.id])).toBe(2);
  expect((await outbox.list()).map((item) => item.id)).toEqual([b.id]);
  expect(await outbox.getAudio(a.id)).toBeUndefined();

  // A second pass over ids that are already gone must not throw: a "clear
  // queue" button clicked twice is not an error.
  expect(await outbox.removeMany([a.id, c.id])).toBe(0);
  expect(await outbox.removeMany([])).toBe(0);
  expect((await outbox.list()).map((item) => item.id)).toEqual([b.id]);
});

// ---------------------------------------------------------------------------
// submitReview — the only way out of `awaiting-review`
// ---------------------------------------------------------------------------

test("an accepted review moves the item to writing and persists the outcome", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "awaiting-review", extracted: { atticRValue: {} } });

  const outcome = { status: "accepted", fields: { atticRValue: 19 } } as const;
  const updated = await outbox.submitReview(item.id, outcome);

  expect(updated.status).toBe("writing");
  expect(updated.reviewOutcome).toEqual(outcome);
  expect(updated.attempts).toBe(0);
});

test("an edited review moves the item to writing with the touched fields named", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "awaiting-review" });

  const updated = await outbox.submitReview(item.id, {
    status: "edited",
    fields: { atticRValue: 30 },
    editedFields: ["atticRValue"],
    rejectedFields: ["blowerDoorCfm50"],
  });

  expect(updated.status).toBe("writing");
  expect(updated.reviewOutcome).toMatchObject({ editedFields: ["atticRValue"] });
});

test("a discarded review is terminal and drops the audio", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  expect(await outbox.getAudio(item.id)).toBeDefined();
  await outbox.patch(item.id, { status: "awaiting-review" });

  const updated = await outbox.submitReview(item.id, {
    status: "discarded",
    reason: "misspoke",
  });

  expect(updated.status).toBe("discarded");
  expect(updated.audioReady).toBe(false);
  expect(await outbox.getAudio(item.id)).toBeUndefined();
  expect(updated.reviewOutcome).toEqual({ status: "discarded", reason: "misspoke" });
});

test("a discard commits the status BEFORE it drops the audio", async () => {
  // The end-state test above passes whichever order the two writes happen in, so on
  // its own it guards nothing: the ordering is the thing at risk, because dropping
  // first would remove the need for `submitReview`'s post-drop re-read and therefore
  // reads like a tidy-up waiting to happen.
  //
  // It is not a tidy-up. A crash between the two steps in the reverse order leaves
  // an `awaiting-review` row whose recording is already gone — it looks reviewable,
  // the audio is unrecoverable, and nothing on the row says why. Committing the
  // status first makes the worst case a `discarded` row that still holds its bytes,
  // which is merely untidy.
  //
  // `items$` re-emits across an attachment change (that is what `audioReady` is for,
  // proven in its own test above), so the emission sequence is the observable form
  // of the ordering.
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "awaiting-review" });

  const seen: [string, boolean][] = [];
  const subscription = outbox.items$.subscribe((items) => {
    const row = items.find((entry) => entry.id === item.id);
    if (row) seen.push([row.status, row.audioReady]);
  });

  try {
    await outbox.submitReview(item.id, { status: "discarded", reason: "misspoke" });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["discarded", false]));
  } finally {
    subscription.unsubscribe();
  }

  // The row was observably `discarded` while the audio was still there...
  expect(seen).toContainEqual(["discarded", true]);
  // ...and never `awaiting-review` with the audio already gone, which is exactly
  // what the reverse order would publish.
  expect(seen).not.toContainEqual(["awaiting-review", false]);
});

test("an edited review that rejected every field still goes to writing", async () => {
  // resolveReview's rule: rejecting every field is a statement about the
  // extraction, not the recording, so it must not be collapsed into a discard —
  // which would also drop audio the human never asked to throw away. The refusal
  // to *write* an empty field set lives in the relay's `#write`, which is where
  // every other "may this reach the host tool?" question is already asked;
  // `relay.browser.test.ts` pins it.
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "awaiting-review" });

  const updated = await outbox.submitReview(item.id, {
    status: "edited",
    fields: {},
    editedFields: [],
    rejectedFields: ["atticRValue"],
  });

  expect(updated.status).toBe("writing");
});

test("a nested review outcome with dotted paths persists to IndexedDB with no migration", async () => {
  // R1.5 design §4 claims moving review to nested values and dotted leaf paths needs
  // NO outbox document version bump. `queue/outbox-memory.test.ts` drives the same
  // round trip, but memory storage cannot settle it: as the durability test above
  // records, it keeps a module-global map, so a close/reopen assertion passes there
  // whether or not anything was written. The structured-clone step that could in
  // principle flatten or drop a nested object exists only on the Dexie/IndexedDB path.
  //
  // So this closes the database and reads the raw store with no RxDB in the call
  // stack — the same technique the durability test uses, for the same reason.
  const name = uniqueName();
  const outbox = await open(name);
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "awaiting-review" });

  const outcome: PersistedReviewOutcome = {
    status: "edited",
    fields: {
      atticRValue: 19,
      healthSafety: { ambientCo: "passed", gasLeak: null },
    },
    editedFields: ["healthSafety.ambientCo"],
    rejectedFields: ["healthSafety.asbestos"],
  };

  await outbox.submitReview(item.id, outcome);
  await outbox.close();

  const rawDocs = (await readRawStore(name, "docs")) as {
    id: string;
    reviewOutcome: unknown;
  }[];

  // The nesting is on disk AS nesting — not flattened to dotted keys, not stringified
  // — and the dotted touched-field paths survived as the strings they are. At the
  // unchanged `outboxRxSchema.version`, which `idbDatabaseName` reads off the schema:
  // a version bump would send this read to a database that never existed, and throw.
  expect(rawDocs.map((doc) => doc.id)).toEqual([item.id]);
  expect(rawDocs[0]?.reviewOutcome).toEqual(outcome);
});

test("submitting a review for an unknown id rejects", async () => {
  const outbox = await open(uniqueName());
  await expect(outbox.submitReview("nope", { status: "accepted", fields: {} })).rejects.toThrow(
    /nope/,
  );
});

test("a second submission for the same item fails rather than rewriting it", async () => {
  // Two tabs, or two clicks. The second must not patch a row that has moved on —
  // most importantly it must not take a `done` item back to `writing`, which would
  // cause a second write to the host tool.
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "awaiting-review" });

  await outbox.submitReview(item.id, { status: "accepted", fields: { atticRValue: 19 } });
  await expect(
    outbox.submitReview(item.id, { status: "discarded", reason: "changed my mind" }),
  ).rejects.toThrow(/awaiting-review/);

  const settled = await outbox.get(item.id);
  expect(settled?.status).toBe("writing");
  expect(settled?.audioReady).toBe(true);
});

test("two submissions in flight at once settle as one winner and one refusal", async () => {
  // The sequential test above cannot reach the case the guard is actually built
  // for. These two are in flight together, and they take the **409-and-re-run**
  // path — deterministically, not incidentally, which is the whole reason this test
  // is worth its lines.
  //
  // Why it cannot be the cheaper "both folded into one batch, modifiers chained"
  // route (rxdb 17's `incremental-write.ts`): `addWrite` calls `triggerRun()`
  // synchronously inside its promise executor, and `triggerRun` swaps the pending
  // map out synchronously too, before its first `await`. So by the time the first
  // submission's `addWrite` returns, the batch is already closed, and the second
  // always lands in a fresh one carrying a `lastKnownDocumentState` read before the
  // first write committed — a genuinely stale revision. Nor is the ordering luck:
  // both `submitReview` calls issue `findOne(id).exec()` in the same synchronous
  // burst and RxDB caches the query, so their continuations run in one microtask
  // drain, well inside the first write's IndexedDB transaction.
  //
  // What that buys: the second submission's modifier runs once against the stale
  // revision (where the status still reads `awaiting-review`, so the guard passes),
  // the write is rejected 409, and RxDB re-runs the modifier against the document
  // actually in the database — where the status is `writing` and the guard finally
  // refuses. The refusal therefore comes from the retry, which is the mechanism the
  // cross-tab case depends on and the one no test can drive directly.
  //
  // Deleting the guard makes this fail as `['fulfilled', 'fulfilled']`: the discard
  // lands on top of the accept and the accepted outcome the relay was about to write
  // is simply gone. That is a lost update, not merely a missing rejection.
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "awaiting-review" });

  const results = await Promise.allSettled([
    outbox.submitReview(item.id, { status: "accepted", fields: { atticRValue: 19 } }),
    outbox.submitReview(item.id, { status: "discarded", reason: "changed my mind" }),
  ]);

  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  const settled = await outbox.get(item.id);
  expect(settled?.status).toBe("writing");
  // The discard lost, so the recording is still on the device: a refused
  // submission must have no side effects at all, audio included.
  expect(settled?.audioReady).toBe(true);
  expect(await outbox.getAudio(item.id)).toBeDefined();
});

test("a review cannot be submitted for an item that was never parked", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await expect(outbox.submitReview(item.id, { status: "accepted", fields: {} })).rejects.toThrow(
    /queued/,
  );
});

// The scenario the guard exists for, stated as itself. `submitReview`'s doc comment
// names a stale tab submitting a review for an item that has since reached `done` —
// which would patch a completed row back to `writing` and cause a second write to a
// customer's audit — and the tests above only ever reach it via `queued` or via a
// row this method itself moved on. Every finished status, driven from the constant,
// so a status added to it is covered without anyone remembering to come back here.
test.each([...FINISHED_OUTBOX_STATUSES])(
  "a review cannot be submitted for a %s item",
  async (status) => {
    const outbox = await open(uniqueName());
    const item = await outbox.enqueue({ recording, audio: audioBlob() });
    await outbox.patch(item.id, { status });

    await expect(
      outbox.submitReview(item.id, { status: "accepted", fields: { atticRValue: 19 } }),
    ).rejects.toThrow(new RegExp(`"${status}"`));

    // Nothing moved. The row is the most important part: a finished item taken back
    // to `writing` is the double-write this guard is here to prevent.
    const settled = await outbox.get(item.id);
    expect(settled?.status).toBe(status);
    expect(settled?.reviewOutcome).toBeUndefined();
  },
);

// ---------------------------------------------------------------------------
// reopenForReview — the supported way back into `awaiting-review` from `dead`
// ---------------------------------------------------------------------------

test("a dead item is reopened for review with a clean slate", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, {
    status: "dead",
    transcript: dyingTranscript,
    extracted: { atticRValue: {} },
    reviewOutcome: { status: "accepted", fields: { atticRValue: 19 } },
    attempts: 3,
    lastError: "the reviewed values are not a valid patch",
  });

  const reopened = await outbox.reopenForReview(item.id);

  expect(reopened.status).toBe("awaiting-review");
  expect(reopened.reviewOutcome).toBeUndefined();
  expect(reopened.attempts).toBe(0);
  // The diagnostic that explains why the item died is not what is being cleared,
  // so it survives the reopen for whoever looks at the row next.
  expect(reopened.lastError).toBe("the reviewed values are not a valid patch");
  expect(reopened.extracted).toEqual({ atticRValue: {} });
  expect(reopened.transcript).toEqual(dyingTranscript);
});

test("reopening drops the stale reviewOutcome from the STORED document, not merely from a live read", async () => {
  // Two independent reads could each fail to catch a bug here on their own:
  //
  //   - `settled?.reviewOutcome` read through `get()` goes through this SAME
  //     `Outbox`'s own RxDB connection and document cache. An implementation
  //     that persisted `reviewOutcome: undefined` instead of deleting the key
  //     would still read back as `undefined` through that live object model —
  //     property access cannot tell "key absent" from "key present with value
  //     `undefined`" apart, and neither read proves the WRITE actually dropped
  //     the key rather than merely not showing it back.
  //   - Even reading raw storage, `settled.reviewOutcome === undefined` is
  //     STILL true either way, for the identical reason. Only `Object.hasOwn`
  //     on the raw persisted object can tell the two cases apart.
  //
  // So this closes the outbox and reads the raw IndexedDB store with no RxDB in
  // the call stack — the technique the nested-review-outcome test above uses,
  // for the same underlying reason (structured clone is the only step in this
  // whole path that could plausibly preserve an `undefined`-valued key) — and
  // asserts key ABSENCE rather than value equality.
  const name = uniqueName();
  const outbox = await open(name);
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, {
    status: "dead",
    transcript: dyingTranscript,
    extracted: { atticRValue: {} },
    reviewOutcome: { status: "discarded", reason: "an earlier, unrelated discard" },
  });

  await outbox.reopenForReview(item.id);
  await outbox.close();

  const rawDocs = (await readRawStore(name, "docs")) as Record<string, unknown>[];
  const raw = rawDocs.find((doc) => doc.id === item.id);
  expect(raw).toBeDefined();
  expect(Object.hasOwn(raw!, "reviewOutcome")).toBe(false);
});

test("a reopened item leaves nextPending's active set, exactly like any other parked item", async () => {
  // Proves the interaction the finding named explicitly: ACTIVE_OUTBOX_STATUSES
  // omits `awaiting-review` regardless of how an item got there, and this asserts
  // it through the REAL reopenForReview path rather than through a hand-patch —
  // which is the gap this method exists to close in the first place.
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  const other = await outbox.enqueue({
    recording: { ...recording, id: "other" },
    audio: audioBlob(),
  });
  await outbox.patch(item.id, {
    status: "dead",
    transcript: dyingTranscript,
    extracted: { atticRValue: {} },
  });

  await outbox.reopenForReview(item.id);

  // `item` has the lower seq, so if reopening it were active it would win here.
  // It does not: `other` does, because a reopened item is parked, not active.
  expect((await outbox.nextPending())?.id).toBe(other.id);
});

test("reopening an unknown id rejects", async () => {
  const outbox = await open(uniqueName());
  await expect(outbox.reopenForReview("nope")).rejects.toThrow(/nope/);
});

test("a dead item with nothing extracted refuses to be reopened", async () => {
  // Died during transcribe, or during a host `extract` step, before anything
  // reached review — reopening it to `awaiting-review` would hand a human a
  // review card with nothing on it, which is not a state anything else in this
  // package produces.
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "dead" });

  await expect(outbox.reopenForReview(item.id)).rejects.toThrow(/no extracted data/);

  const settled = await outbox.get(item.id);
  expect(settled?.status).toBe("dead");
});

test("a dead item with extracted data but no transcript refuses to be reopened", async () => {
  // The real pipeline cannot construct this combination on its own — extraction
  // never runs before a transcript is persisted (`relay.ts`'s `nextStep`) — but
  // `patch()` is public and unrestricted, so a document built by hand (or by a
  // future migration, or another build) could still carry `extracted` without a
  // `transcript`. Reopening it would park an item at `awaiting-review` that
  // `buildReviewRequest` cannot build an honest review card for: there would be
  // nothing to check an extracted span's groundedness against.
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, { status: "dead", extracted: { atticRValue: {} } });

  await expect(outbox.reopenForReview(item.id)).rejects.toThrow(/no transcript/);

  const settled = await outbox.get(item.id);
  expect(settled?.status).toBe("dead");
});

// Every status but `dead`, driven from the constant so a status added later is
// covered without anyone remembering to come back here — the same reasoning as
// the FINISHED_OUTBOX_STATUSES table above, over the wider list this guard
// actually has to refuse. `done` would risk a second write; `discarded` would
// undo an audited human decision this method has no business reversing;
// everything else is a status the relay still owns, where reopening would only
// race it.
// `recording` is excluded alongside `dead` for a different reason: this fixture
// builds its row with `enqueue`, which by construction produces a `queued` row
// with committed audio and no `capture`. A `recording` row must carry `capture`,
// which this test cannot legally construct here. It gets covered once
// `beginRecording` exists and can build one honestly — until then, asserting on
// a row this test cannot legally create would prove nothing.
test.each(OUTBOX_STATUSES.filter((status) => status !== "dead" && status !== "recording"))(
  "a %s item cannot be reopened for review",
  async (status) => {
    const outbox = await open(uniqueName());
    const item = await outbox.enqueue({ recording, audio: audioBlob() });
    await outbox.patch(item.id, {
      status,
      transcript: dyingTranscript,
      extracted: { atticRValue: {} },
    });

    await expect(outbox.reopenForReview(item.id)).rejects.toThrow(new RegExp(`"${status}"`));

    const settled = await outbox.get(item.id);
    expect(settled?.status).toBe(status);
  },
);

test("two reopenForReview calls in flight at once, on ONE Outbox, settle as one winner and one refusal", async () => {
  // The same genuinely-concurrent 409-and-re-run path `submitReview`'s own
  // equivalent test drives, exercised here because `reopenForReview` shares the
  // exposure `incrementalModify` closes: without it, two reopens racing could
  // both read `status: "dead"` before either write lands and both "win", which
  // is a lost update, not merely a missing rejection.
  //
  // This proves the guard survives two CALLS racing on one connection — it does
  // NOT prove it survives two TABS, i.e. two independent `RxDatabase` connections
  // over the same IndexedDB name: an implementation guarded only by an in-memory
  // mutex scoped to this one `Outbox` instance would also make this test pass
  // while doing nothing to stop a second, independent connection. That case is
  // covered separately, in `outbox-reopen-cross-tab.browser.test.ts` — see that
  // file's header for why it could not simply be added here.
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  await outbox.patch(item.id, {
    status: "dead",
    transcript: dyingTranscript,
    extracted: { atticRValue: {} },
  });

  const results = await Promise.allSettled([
    outbox.reopenForReview(item.id),
    outbox.reopenForReview(item.id),
  ]);

  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  const settled = await outbox.get(item.id);
  expect(settled?.status).toBe("awaiting-review");
});

// ---------------------------------------------------------------------------
// Filtered reads
// ---------------------------------------------------------------------------

test("list and watch can filter by status and cap the result", async () => {
  const outbox = await open(uniqueName());
  const a = await outbox.enqueue({ recording: { ...recording, id: "a" }, audio: audioBlob() });
  const b = await outbox.enqueue({ recording: { ...recording, id: "b" }, audio: audioBlob() });
  const c = await outbox.enqueue({ recording: { ...recording, id: "c" }, audio: audioBlob() });
  await outbox.patch(b.id, { status: "done" });

  // The no-argument calls keep their old meaning: every item, seq-ascending.
  expect((await outbox.list()).map((item) => item.id)).toEqual([a.id, b.id, c.id]);

  expect((await outbox.list({ status: "done" })).map((item) => item.id)).toEqual([b.id]);
  expect((await outbox.list({ status: ["queued", "done"] })).map((item) => item.id)).toEqual([
    a.id,
    b.id,
    c.id,
  ]);
  expect((await outbox.list({ status: ACTIVE_OUTBOX_STATUSES })).map((item) => item.id)).toEqual([
    a.id,
    c.id,
  ]);
  // Still lowest-seq first, so a limit takes the head of the queue rather than
  // an arbitrary slice.
  expect((await outbox.list({ limit: 2 })).map((item) => item.id)).toEqual([a.id, b.id]);
  expect((await outbox.list({ status: "queued", limit: 1 })).map((item) => item.id)).toEqual([
    a.id,
  ]);

  const watched = await firstValueFrom(outbox.watch({ status: "queued" }));
  expect(watched.map((item) => item.id)).toEqual([a.id, c.id]);
});

test("a filtered watch re-emits when an item moves in or out of the filter", async () => {
  const outbox = await open(uniqueName());
  const seen: string[][] = [];
  const subscription = outbox
    .watch({ status: ACTIVE_OUTBOX_STATUSES })
    .subscribe((items) => seen.push(items.map((item) => item.recording.id)));

  try {
    const a = await outbox.enqueue({ recording: { ...recording, id: "a" }, audio: audioBlob() });
    await outbox.enqueue({ recording: { ...recording, id: "b" }, audio: audioBlob() });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["a", "b"]));

    await outbox.patch(a.id, { status: "done" });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["b"]));
  } finally {
    subscription.unsubscribe();
  }
});

// ---------------------------------------------------------------------------
// Claim ordering — the input to the relay
// ---------------------------------------------------------------------------

test("nextPending returns the lowest-seq item that is not finished", async () => {
  const outbox = await open(uniqueName());
  const a = await outbox.enqueue({ recording: { ...recording, id: "a" }, audio: audioBlob() });
  const b = await outbox.enqueue({ recording: { ...recording, id: "b" }, audio: audioBlob() });

  expect((await outbox.nextPending())?.id).toBe(a.id);
  await outbox.patch(a.id, { status: "done" });
  expect((await outbox.nextPending())?.id).toBe(b.id);
  await outbox.patch(b.id, { status: "dead" });
  expect(await outbox.nextPending()).toBeUndefined();
});

test("a persisted stream of documents is observable for the UI", async () => {
  const outbox = await open(uniqueName());
  const seen: number[] = [];
  const subscription = outbox.items$.subscribe((items) => seen.push(items.length));
  await outbox.enqueue({ recording, audio: audioBlob() });
  await vi.waitFor(() => expect(seen.at(-1)).toBe(1));
  subscription.unsubscribe();
});

// ---------------------------------------------------------------------------
// The publication race. A consumer may never observe a half-written item.
// ---------------------------------------------------------------------------

test("the first items$ emission carrying a new item already has its audio", async () => {
  const outbox = await open(uniqueName());

  // The read is issued **synchronously inside the subscription callback**, at
  // the very first instant the item is observable. No `waitFor`, no retry, no
  // extra tick: a consumer rendering this emission can do nothing earlier than
  // this, so if the bytes are not queryable here they are not queryable at all
  // for that render. Only the *settling* of the promise is awaited, and it is
  // captured before `enqueue` resolves.
  let subscription: { unsubscribe(): void } | undefined;
  const atFirstSighting = new Promise<{ item: OutboxItem; audio: Blob | undefined }>((resolve) => {
    subscription = outbox.items$.subscribe((items) => {
      const item = items[0];
      if (!item) return; // the initial empty emission
      resolve(outbox.getAudio(item.id).then((audio) => ({ item, audio })));
    });
  });

  try {
    await outbox.enqueue({ recording, audio: audioBlob() });
    const { item, audio } = await atFirstSighting;

    expect(audio).toBeInstanceOf(Blob);
    expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(audioBytes);
    expect(item.audioReady).toBe(true);
    expect(item.audioBytes).toBe(audioBytes.byteLength);
  } finally {
    subscription?.unsubscribe();
  }
});
