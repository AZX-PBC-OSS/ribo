import { createMemoryBackend, removeMemoryDatabase } from "./memory-backend.js";
import { afterEach, expect, test } from "vitest";

import type { DocumentCapture } from "../capture-item.js";
import type { Recording } from "../recording.js";
import type { PersistedReviewOutcome } from "../review.js";
import { openStorage, type Storage } from "./storage.js";

// The proof that `@azx/ribo-core` runs with no RxDB anywhere.
//
// This drives the ordinary public API — open a session, enqueue, read the item
// and its audio back — over the port's in-memory backend. Nothing in this file,
// or in anything it imports, touches RxDB: the package's dependencies are
// `rxjs` and `zod`, and a regression that dragged a storage engine back into
// core would fail to resolve here rather than being noticed in review.
//
// It is a node `unit` test on purpose — no IndexedDB, no browser — which is
// what makes the domain suite fast. It deliberately does NOT stand in for the
// durability test in `storage.browser.test.ts`, and the conformance kit is what
// proves the memory backend and the RxDB one agree
// (`@azx/ribo-core/testing`).

const opened: { storage: Storage; name: string }[] = [];

afterEach(async () => {
  for (const { storage, name } of opened.splice(0)) {
    if (!storage.closed) await storage.close();
    // A memory database outlives its handle, exactly as an IndexedDB one does, so
    // a cold start is explicit rather than implied by closing.
    removeMemoryDatabase(name);
  }
});

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  kind: "audio",
  durationMs: 4200,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
};

const audioBytes = new Uint8Array(2048).map((_, i) => (i * 31 + 7) % 256);

function audioBlob(): Blob {
  return new Blob([audioBytes], { type: "audio/webm;codecs=opus" });
}

test("the memory backend drives the whole Storage API with no RxDB present", async () => {
  const name = `ribo-storage-memory-${crypto.randomUUID()}`;

  const storage = await openStorage({ backend: createMemoryBackend(name) });
  opened.push({ storage, name });

  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const enqueued = await storage.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });

  // Same projection contract the Dexie-backed tests assert.
  expect(enqueued.status).toBe("queued");
  expect(enqueued.audioReady).toBe(true);
  expect(enqueued.audioBytes).toBe(audioBytes.byteLength);

  // Read the item back through the public API — off the injected engine, in a
  // node process with no IndexedDB at all.
  const read = await storage.captures.get(enqueued.id);
  expect(read).toEqual(enqueued);
  expect((await storage.captures.list()).map((item) => item.id)).toEqual([enqueued.id]);

  // The bytes round-trip through the injected engine unchanged.
  const audio = await storage.captures.getAudio(enqueued.id);
  expect(audio).toBeInstanceOf(Blob);
  expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(audioBytes);
});

test("a nested review outcome with dotted paths round-trips storage with no migration", async () => {
  // R1.5 design §4 asserts that moving review to nested values and dotted leaf paths
  // needs NO document version bump: `reviewOutcomeSchema.fields` is
  // `z.record(z.string(), z.unknown())`, which accepts a nested object, and the
  // touched-field lists are `z.array(z.string())`, which accept a dotted path. That
  // claim is about PERSISTENCE, so checking it against the zod schema alone would not
  // settle it — the RxDB collection carries its own JSON schema and its own `version`.
  // This drives the real thing: a nested outcome through `submitSessionReview`, out to
  // storage and back through `getSession`, on the sessions collection.
  const name = `ribo-storage-memory-${crypto.randomUUID()}`;

  const storage = await openStorage({ backend: createMemoryBackend(name) });
  opened.push({ storage, name });

  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  await storage.captures.enqueue({ recording, audio: audioBlob(), sessionId: session.id });
  await storage.sessions.patch(session.id, { status: "awaiting-review" });

  const outcome: PersistedReviewOutcome = {
    status: "edited",
    fields: {
      atticRValue: 19,
      healthSafety: { ambientCo: "passed", gasLeak: null },
    },
    editedFields: ["healthSafety.ambientCo"],
    rejectedFields: ["healthSafety.asbestos"],
  };

  const submitted = await storage.sessions.submitReview(session.id, outcome);
  expect(submitted.status).toBe("writing");

  const read = await storage.sessions.get(session.id);

  // Nesting survives as nesting, not flattened or stringified, and the dotted paths
  // survive as the strings they are.
  expect(read?.reviewOutcome).toEqual(outcome);
});

test("a document round-trips real storage — kind and pageCount survive, bytes come back", async () => {
  // Per D2 the zod parse on read is the only interior check on `recording`, so
  // this is the test that catches the whole corruption class — the
  // `commitRecording` hazard included.
  const name = `ribo-storage-memory-${crypto.randomUUID()}`;
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  opened.push({ storage, name });

  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const doc: DocumentCapture = {
    id: "doc-1",
    capturedAt: "2026-07-23T10:00:00.000Z",
    kind: "document",
    pageCount: 3,
    mimeType: "application/pdf",
    ctx: { jobId: "job-7" },
  };
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  const enqueued = await storage.captures.enqueue({
    recording: doc,
    audio: new Blob([pdfBytes], { type: "application/pdf" }),
    sessionId: session.id,
  });

  expect(enqueued.recording.kind).toBe("document");
  expect(enqueued.audioReady).toBe(true);

  // get() and list() return it with kind and pageCount intact.
  const read = await storage.captures.get(enqueued.id);
  expect(read).toEqual(enqueued);
  expect(read?.recording.kind).toBe("document");
  if (read?.recording.kind === "document") {
    expect(read.recording.pageCount).toBe(3);
  }

  const listed = await storage.captures.list();
  expect(listed.map((item) => item.id)).toEqual([enqueued.id]);
  expect(listed[0]?.recording.kind).toBe("document");

  // The bytes round-trip unchanged.
  const audio = await storage.captures.getAudio(enqueued.id);
  expect(audio).toBeInstanceOf(Blob);
  expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(pdfBytes);
});

test("commitRecording refuses a non-audio row — the spread the compiler does not catch", async () => {
  // `commitRecording`'s `{ ...data.recording, durationMs }` spread produces no
  // typecheck error while writing a document row carrying a bogus `durationMs`
  // that the strict schema then rejects on the next read. Silent persistence
  // corruption on a path the compiler blessed — so the guard is runtime.
  // The state is unreachable through the public API (`beginRecording` takes
  // `Recording`, so a document cannot enter `recording` status that way), so
  // the test casts to construct it. The cast is not laziness — it is the only
  // way to reach the code path the guard protects.
  const name = `ribo-storage-memory-${crypto.randomUUID()}`;
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  opened.push({ storage, name });

  const session = await storage.sessions.open({ ctx: {}, ref: "test" });

  // Begin a real audio recording to get a `recording`-status row.
  const item = await storage.captures.beginRecording({
    recording: { ...recording, id: "rec-commit-guard" },
    sourceId: "src-1",
    sessionId: session.id,
  });

  // Cast the row's recording to a document shape, simulating the unreachable
  // state the guard exists for. This goes straight through the backend,
  // bypassing the public API that would refuse it.
  await storage.backend.modify("captures", item.id, (data) => ({
    ...data,
    recording: {
      id: "rec-commit-guard",
      capturedAt: "2026-07-23T10:00:00.000Z",
      kind: "document",
      pageCount: 1,
      mimeType: "application/pdf",
      ctx: {},
    },
  }));

  // commitRecording must refuse — not silently corrupt the row.
  await expect(storage.captures.commitRecording(item.id, new Blob([]), 1000)).rejects.toThrow(
    /document/,
  );
});
