import { addRxPlugin, createRxDatabase } from "rxdb";
import type { RxCollection, RxDatabase, RxJsonSchema } from "rxdb";
import { RxDBAttachmentsPlugin } from "rxdb/plugins/attachments";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { firstValueFrom } from "rxjs";
import { afterEach, expect, test, vi } from "vitest";

import type { Recording } from "../recording.js";
import { openOutbox, type Outbox } from "./outbox.js";
import { OUTBOX_MIGRATION_STRATEGIES, removeOutboxDatabase } from "./database.js";
import { chunkName } from "./chunk-names.js";
import {
  ACTIVE_OUTBOX_STATUSES,
  AUDIO_ATTACHMENT_ID,
  FINISHED_OUTBOX_STATUSES,
  OUTBOX_COLLECTION_NAME,
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

const SESSION_ID = "test-session";

/** Recognisable, non-trivial bytes: a zero-filled blob would compare equal to a bug. */
const audioBytes = new Uint8Array(2048).map((_, i) => (i * 31 + 7) % 256);

function audioBlob(): Blob {
  return new Blob([audioBytes], { type: "audio/webm;codecs=opus" });
}

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
  const enqueued = await first.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
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
  const enqueued = await first.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
  await first.patch(enqueued.id, {
    status: "transcribed",
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
    status: "transcribed",
    transcript: {
      recordingId: "rec-1",
      text: "the attic is R-19",
      engine: "ondevice-whisper",
    },
    attempts: 2,
    nextAttemptAt: "2026-07-23T10:05:00.000Z",
    lastError: "network unreachable",
    seq: enqueued.seq,
  });
});

// ---------------------------------------------------------------------------
// The v0 → v6 schema migration.
//
// A reopen does not test this: `openOutbox` can only ever create a v6 store, so
// two opens against the same name both see version 6, nothing migrates, and the
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
// `mustMigrate()` — RxDB just creates a fresh v6 collection and never looks at
// the row, so the test would report a pass while testing nothing, which is a
// worse failure mode than the reopen it was meant to replace.
//
// So the v0 store here is seeded through RxDB's own public API instead: a real
// collection, created at `version: 0` with the schema this file *used* to have
// before this change, populates that internal bookkeeping for real. Opening a
// v6 database over the same name then runs the actual migration path, not an
// imitation of it.
// ---------------------------------------------------------------------------

/** The outbox document shape as it was at schema version 0, before the session split. */
interface V0OutboxDocument {
  id: string;
  seq: number;
  status: string;
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt: string;
  enqueuedAt: string;
  lastError?: string;
  recording: Record<string, unknown>;
  transcript?: Record<string, unknown>;
  extracted?: Record<string, unknown>;
  writeResult?: Record<string, unknown>;
}

/** The outbox's RxDB schema exactly as it was before this task's version bump. */
const OUTBOX_RX_SCHEMA_V0: RxJsonSchema<V0OutboxDocument> = {
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

/** The v0 document shape: everything the original schema had, minimally populated. */
function v0Document(): V0OutboxDocument {
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
async function seedVersionZeroOutbox(name: string, document: V0OutboxDocument): Promise<void> {
  addRxPlugin(RxDBAttachmentsPlugin);
  const database: RxDatabase<{ outbox: RxCollection<V0OutboxDocument> }> = await createRxDatabase({
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

test("an outbox stored at schema version 0 opens and migrates to version 6", async () => {
  const name = uniqueName();
  await seedVersionZeroOutbox(name, v0Document());

  const outbox = await open(name);
  const items = await outbox.list({});

  expect(items).toHaveLength(1);
  // v5 → v6 migration: `sessionId` is added, and the old
  // session-level fields (`extracted`, `reviewOutcome`, etc.) are dropped.
  expect(items[0]?.sessionId).toBeDefined();
  expect(items[0]?.status).toBe("queued");
  await outbox.close();
});

test("v5 recordings with extracted/reviewOutcome migrate to sessions", async () => {
  // Seed a v0 outbox with two recordings sharing an assessmentId.
  const name = uniqueName();
  addRxPlugin(RxDBAttachmentsPlugin);
  const db0 = await createRxDatabase({
    name,
    storage: getRxStorageDexie(),
    multiInstance: true,
    eventReduce: true,
    cleanupPolicy: {},
  });
  await db0.addCollections({ [OUTBOX_COLLECTION_NAME]: { schema: OUTBOX_RX_SCHEMA_V0 } });
  const outboxCol = db0.collections.outbox!;
  const baseRec = {
    id: "r",
    capturedAt: "2026-07-23T10:00:00.000Z",
    durationMs: 1,
    mimeType: "audio/webm",
    ctx: { assessmentId: "job-42" },
  };
  await outboxCol.insert({
    id: "a",
    seq: 0,
    status: "awaiting-review",
    idempotencyKey: "k",
    attempts: 0,
    nextAttemptAt: "2026-07-23T10:00:00.000Z",
    enqueuedAt: "2026-07-23T10:00:00.000Z",
    recording: baseRec,
  });
  await outboxCol.insert({
    id: "b",
    seq: 1,
    status: "queued",
    idempotencyKey: "k2",
    attempts: 0,
    nextAttemptAt: "2026-07-23T10:00:00.000Z",
    enqueuedAt: "2026-07-23T10:00:00.000Z",
    recording: { ...baseRec, id: "r2" },
  });
  await db0.close();

  const outbox = await open(name);
  const items = await outbox.list({});
  expect(items).toHaveLength(2);

  // Both recordings have a sessionId derived from their assessmentId.
  const sessionIds = new Set(items.map((r) => r.sessionId));
  expect(sessionIds.size).toBe(1); // same session — same assessmentId

  // A session was created by the post-migration step.
  const sessionId = items[0]!.sessionId;
  const session = await outbox.getSession(sessionId);
  expect(session).toBeDefined();
  // The recording statuses were mapped: "awaiting-review" → "transcribed",
  // "queued" stays "queued".
  expect(items.find((r) => r.id === "a")?.status).toBe("transcribed");
  expect(items.find((r) => r.id === "b")?.status).toBe("queued");
  await outbox.close();
});

test("v5 recordings with no assessmentId get singleton sessions", async () => {
  const name = uniqueName();
  await seedVersionZeroOutbox(name, {
    id: "solo",
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
      ctx: {}, // no assessmentId
    },
  } as V0OutboxDocument);

  const outbox = await open(name);
  const items = await outbox.list({});
  expect(items).toHaveLength(1);
  // A session was created — a singleton.
  const session = await outbox.getSession(items[0]!.sessionId);
  expect(session).toBeDefined();
  expect(session?.status).toBe("done"); // no extraction → done
  await outbox.close();
});

// ---------------------------------------------------------------------------
// Enqueue invariants
// ---------------------------------------------------------------------------

test("enqueue assigns monotonically increasing seq values that continue across reopen", async () => {
  const name = uniqueName();

  const first = await open(name);
  const a = await first.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
  const b = await first.enqueue({
    recording: { ...recording, id: "rec-2" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  expect(b.seq).toBeGreaterThan(a.seq);
  await first.close();

  const second = await open(name);
  const c = await second.enqueue({
    recording: { ...recording, id: "rec-3" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  expect(c.seq).toBeGreaterThan(b.seq);
});

test("concurrent enqueues never collide on seq", async () => {
  const outbox = await open(uniqueName());
  const items = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      outbox.enqueue({
        recording: { ...recording, id: `rec-${i}` },
        audio: audioBlob(),
        sessionId: SESSION_ID,
      }),
    ),
  );
  const seqs = items.map((item) => item.seq).sort((a, b) => a - b);
  expect(new Set(seqs).size).toBe(8);
  expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("enqueue starts an item queued, with zero attempts and a session id", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });

  expect(item.status).toBe("queued");
  expect(item.attempts).toBe(0);
  expect(item.sessionId).toBe(SESSION_ID);
  expect(item.recording).toEqual(recording);
  expect(item.transcript).toBeUndefined();
});

test("list returns items in seq order", async () => {
  const outbox = await open(uniqueName());
  for (const id of ["a", "b", "c"]) {
    await outbox.enqueue({
      recording: { ...recording, id },
      audio: audioBlob(),
      sessionId: SESSION_ID,
    });
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
  const item = await first.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });

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
  const item = await outbox.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
  expect(item.audioReady).toBe(true);
  await outbox.dropAudio(item.id);
  const after = await outbox.get(item.id);
  expect(after!.audioReady).toBe(false);
  expect(after!.audioBytes).toBe(0);
});

test("audioReady is true from the moment of enqueue, with the attachment's size", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });

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
    const item = await outbox.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
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
  const kept = await withAudio.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
  await withAudio.close();

  const withoutAudio = await open(droppedName);
  const dropped = await withoutAudio.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
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
  const item = await first.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
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
    await outbox.enqueue({
      recording: { ...recording, id },
      audio: audioBlob(),
      sessionId: SESSION_ID,
    });
  }

  expect(await outbox.clear()).toBe(3);
  expect(await outbox.list()).toEqual([]);
  await outbox.close();

  const reopened = await open(name);
  expect(await reopened.list()).toEqual([]);
});

test("clear can be scoped, leaving unfinished work alone", async () => {
  const outbox = await open(uniqueName());
  const a = await outbox.enqueue({
    recording: { ...recording, id: "a" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  const b = await outbox.enqueue({
    recording: { ...recording, id: "b" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  await outbox.patch(a.id, { status: "transcribed" });

  // The "tidy up what has landed" gesture, as opposed to the device reset.
  expect(await outbox.clear({ status: FINISHED_OUTBOX_STATUSES })).toBe(1);
  expect((await outbox.list()).map((item) => item.id)).toEqual([b.id]);
});

test("removeMany deletes the named items and is idempotent", async () => {
  const outbox = await open(uniqueName());
  const a = await outbox.enqueue({
    recording: { ...recording, id: "a" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  const b = await outbox.enqueue({
    recording: { ...recording, id: "b" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  const c = await outbox.enqueue({
    recording: { ...recording, id: "c" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });

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
// Filtered reads
// ---------------------------------------------------------------------------

test("list and watch can filter by status and cap the result", async () => {
  const outbox = await open(uniqueName());
  const a = await outbox.enqueue({
    recording: { ...recording, id: "a" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  const b = await outbox.enqueue({
    recording: { ...recording, id: "b" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  const c = await outbox.enqueue({
    recording: { ...recording, id: "c" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  await outbox.patch(b.id, { status: "transcribed" });

  // The no-argument calls keep their old meaning: every item, seq-ascending.
  expect((await outbox.list()).map((item) => item.id)).toEqual([a.id, b.id, c.id]);

  expect((await outbox.list({ status: "transcribed" })).map((item) => item.id)).toEqual([b.id]);
  expect((await outbox.list({ status: ["queued", "transcribed"] })).map((item) => item.id)).toEqual(
    [a.id, b.id, c.id],
  );
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
    const a = await outbox.enqueue({
      recording: { ...recording, id: "a" },
      audio: audioBlob(),
      sessionId: SESSION_ID,
    });
    await outbox.enqueue({
      recording: { ...recording, id: "b" },
      audio: audioBlob(),
      sessionId: SESSION_ID,
    });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["a", "b"]));

    await outbox.patch(a.id, { status: "transcribed" });
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
  const a = await outbox.enqueue({
    recording: { ...recording, id: "a" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });
  const b = await outbox.enqueue({
    recording: { ...recording, id: "b" },
    audio: audioBlob(),
    sessionId: SESSION_ID,
  });

  expect((await outbox.nextPending())?.id).toBe(a.id);
  await outbox.patch(a.id, { status: "transcribed" });
  expect((await outbox.nextPending())?.id).toBe(b.id);
  await outbox.patch(b.id, { status: "dead" });
  expect(await outbox.nextPending()).toBeUndefined();
});

test("a persisted stream of documents is observable for the UI", async () => {
  const outbox = await open(uniqueName());
  const seen: number[] = [];
  const subscription = outbox.items$.subscribe((items) => seen.push(items.length));
  await outbox.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
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
    await outbox.enqueue({ recording, audio: audioBlob(), sessionId: SESSION_ID });
    const { item, audio } = await atFirstSighting;

    expect(audio).toBeInstanceOf(Blob);
    expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(audioBytes);
    expect(item.audioReady).toBe(true);
    expect(item.audioBytes).toBe(audioBytes.byteLength);
  } finally {
    subscription?.unsubscribe();
  }
});

// ---------------------------------------------------------------------------
/**
 * Attachment ids on an item, read from storage after the Outbox is closed.
 *
 * Necessary because the projection deliberately hides this: `audioBytes` returns the
 * canonical length and only sums chunks while `status === "recording"`, so **leftover
 * chunks on a committed row are invisible to every public reading**. That is a real
 * observability gap — an un-swept recording is a silent quota leak nothing can report —
 * and it is why the sweep cannot be asserted through the API it belongs to.
 *
 * Closing first, rather than opening a second live handle: RxDB does not support two
 * databases of one name in a single context, which the v0-migration seeding above works
 * around the same way.
 */
async function attachmentIdsAfterClose(outbox: Outbox, name: string, id: string) {
  await outbox.close();
  addRxPlugin(RxDBAttachmentsPlugin);
  addRxPlugin(RxDBMigrationSchemaPlugin);
  const database: RxDatabase<{ outbox: RxCollection<OutboxDocument> }> = await createRxDatabase({
    name,
    storage: getRxStorageDexie(),
    multiInstance: true,
    eventReduce: true,
    cleanupPolicy: {},
  });
  await database.addCollections({
    [OUTBOX_COLLECTION_NAME]: {
      schema: outboxRxSchema,
      migrationStrategies: OUTBOX_MIGRATION_STRATEGIES,
    },
  });
  try {
    const doc = await database.collections.outbox.findOne(id).exec();
    return doc!
      .allAttachments()
      .map((a) => a.id)
      .sort();
  } finally {
    await database.close();
  }
}

// Durable capture — beginRecording, appendChunk, mergeChunks, commitRecording.
//
// These methods implement the chunk-by-chunk persistence path from the durable
// capture design (revision 9). `beginRecording` finally makes a `recording` row
// with chunks constructible through the public API, closing the untested gap
// noted in Task 1's `audioReady`/`audioBytes` projection: before it existed, no
// public method could build a row that carries chunk attachments, so the state
// "audioReady: false, audioBytes: non-zero" was unreachable from any test.
// ---------------------------------------------------------------------------

test("beginRecording creates a recording row with capture.sourceId and no committed audio", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.beginRecording({
    recording: { ...recording, durationMs: 0 },
    sourceId: "s1",
    sessionId: SESSION_ID,
  });
  expect(item.status).toBe("recording");
  expect(item.capture).toEqual({ sourceId: "s1" });
  expect(item.audioReady).toBe(false);
  expect(item.audioBytes).toBe(0);
});

test("appendChunk writes a chunk attachment and audioBytes reflects it", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.beginRecording({
    recording: { ...recording, durationMs: 0 },
    sourceId: "s1",
    sessionId: SESSION_ID,
  });
  await outbox.appendChunk(item.id, chunkName("s1", 0, 0), audioBlob());
  const after = await outbox.get(item.id);
  // THE untested gap from Task 1: a recording row carrying chunks reports
  // audioReady: false (no canonical yet) but non-zero audioBytes (chunks ARE
  // durable). Before beginRecording, no public API could build this state.
  expect(after!.audioReady).toBe(false);
  expect(after!.audioBytes).toBe(audioBytes.byteLength);
});

test("commitRecording writes canonical audio, transitions to queued, and sweeps chunks", async () => {
  const name = uniqueName();
  const outbox = await open(name);
  const item = await outbox.beginRecording({
    recording: { ...recording, durationMs: 0 },
    sourceId: "s1",
    sessionId: SESSION_ID,
  });
  await outbox.appendChunk(item.id, chunkName("s1", 0, 0), audioBlob());
  const merged = await outbox.mergeChunks(item.id);
  const committed = await outbox.commitRecording(item.id, merged, 4200);
  expect(committed.status).toBe("queued");
  expect(committed.audioReady).toBe(true);
  expect(committed.audioBytes).toBe(audioBytes.byteLength);
  expect(committed.recording.durationMs).toBe(4200);
  const audio = await outbox.getAudio(item.id);
  expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(audioBytes);

  // The chunks are ACTUALLY gone — and proving it needs a trick, because the projection
  // hides them. `audioBytes` returns the canonical length and only falls through to
  // summing chunks when NO canonical exists, so once one is written a full set of
  // leftover chunks is invisible. Verified by mutation: removing the sweep left every
  // other assertion in this test green.
  //
  // Read from storage, because no public reading can see it — see the helper's note.
  expect(await attachmentIdsAfterClose(outbox, name, item.id)).toEqual([AUDIO_ATTACHMENT_ID]);
});

test("mergeChunks concatenates chunk attachments in name order", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.beginRecording({
    recording: { ...recording, durationMs: 0 },
    sourceId: "s1",
    sessionId: SESSION_ID,
  });
  const partA = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const partB = new Blob([new Uint8Array([4, 5, 6])], { type: "audio/webm" });
  const partC = new Blob([new Uint8Array([7, 8, 9])], { type: "audio/webm" });

  // Inserted OUT of index order, and deliberately so. Appending 0,1,2 proves nothing:
  // `allAttachments()` returns them in insertion order, so the merge would produce the
  // right bytes with no sort at all — verified by mutation, removing the sort left the
  // in-order version of this test green. Audio assembled in the wrong order is
  // unrecoverable and silent, so the ordering has to be the thing under test.
  await outbox.appendChunk(item.id, chunkName("s1", 2, 0), partC);
  await outbox.appendChunk(item.id, chunkName("s1", 0, 0), partA);
  await outbox.appendChunk(item.id, chunkName("s1", 1, 0), partB);

  const merged = await outbox.mergeChunks(item.id);
  expect(new Uint8Array(await merged.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );
});
