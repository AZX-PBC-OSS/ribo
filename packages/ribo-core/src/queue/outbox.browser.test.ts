import { firstValueFrom } from "rxjs";
import { afterEach, expect, test, vi } from "vitest";

import type { Recording } from "../recording.js";
import { openOutbox, type Outbox } from "./outbox.js";
import { removeOutboxDatabase } from "./database.js";
import { ACTIVE_OUTBOX_STATUSES, FINISHED_OUTBOX_STATUSES, type OutboxItem } from "./schema.js";

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

function idbDatabaseName(outboxName: string): string {
  return `rxdb-dexie-${outboxName}--0--outbox`;
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
// hasAudio / audioBytes — attachment presence as an observable fact.
//
// Without these, "audio was never attached", "audio was dropped" and "audio is
// still being written" are one indistinguishable state on `OutboxItem`, because
// `toJSON()` strips `_attachments`. A UI cannot legitimately report a dropped
// recording without them, and that is a real state the moment
// `dropAudioAfterTranscription` is on or iOS evicts the origin.
// ---------------------------------------------------------------------------

test("hasAudio is true from the moment of enqueue, with the attachment's size", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });

  expect(item.hasAudio).toBe(true);
  expect(item.audioBytes).toBe(audioBytes.byteLength);
  // The value the caller got back and the value a reader sees must agree — the
  // return of `enqueue` is a projection of the very document that was written,
  // not a hand-assembled optimistic copy.
  expect(await outbox.get(item.id)).toEqual(item);
  expect((await outbox.list())[0]).toEqual(item);
});

test("hasAudio goes false after dropAudio, and items$ re-emits to say so", async () => {
  const outbox = await open(uniqueName());
  const seen: { hasAudio: boolean; audioBytes: number }[] = [];
  const subscription = outbox.items$.subscribe((items) => {
    const item = items[0];
    if (item) seen.push({ hasAudio: item.hasAudio, audioBytes: item.audioBytes });
  });

  try {
    const item = await outbox.enqueue({ recording, audio: audioBlob() });
    await vi.waitFor(() => expect(seen.at(-1)?.hasAudio).toBe(true));

    await outbox.dropAudio(item.id);

    // The document's own fields are byte-identical across a `dropAudio`, so
    // before `hasAudio` existed this re-emission carried no information at all
    // and a memoizing consumer could not tell anything had happened.
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ hasAudio: false, audioBytes: 0 }));
    expect(await outbox.getAudio(item.id)).toBeUndefined();
    expect((await outbox.get(item.id))?.hasAudio).toBe(false);
  } finally {
    subscription.unsubscribe();
  }
});

test("hasAudio survives a close and reopen, and matches what is physically in IndexedDB", async () => {
  const keptName = uniqueName();
  const droppedName = uniqueName();

  const withAudio = await open(keptName);
  const kept = await withAudio.enqueue({ recording, audio: audioBlob() });
  await withAudio.close();

  const withoutAudio = await open(droppedName);
  const dropped = await withoutAudio.enqueue({ recording, audio: audioBlob() });
  await withoutAudio.dropAudio(dropped.id);
  await withoutAudio.close();

  // Read the raw stores rather than trusting the RxDB handle: `hasAudio` is a
  // claim about the attachment store, so the assertion that it is *true* has to
  // come from that store, not from the layer computing the claim.
  expect(
    ((await readRawStore(keptName, "attachments")) as { id: string }[]).map((a) => a.id),
  ).toEqual([`${kept.id}||audio`]);
  expect(await readRawStore(droppedName, "attachments")).toEqual([]);

  const reopenedKept = await open(keptName);
  expect(await reopenedKept.get(kept.id)).toMatchObject({
    hasAudio: true,
    audioBytes: audioBytes.byteLength,
  });

  const reopenedDropped = await open(droppedName);
  expect(await reopenedDropped.get(dropped.id)).toMatchObject({ hasAudio: false, audioBytes: 0 });
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
    expect(item.hasAudio).toBe(true);
    expect(item.audioBytes).toBe(audioBytes.byteLength);
  } finally {
    subscription?.unsubscribe();
  }
});
