# Durable Capture Implementation Plan

> **Executing this:** one task at a time, in order, each ending with its own test cycle and its own
> review. Steps use checkbox (`- [ ]`) syntax so progress is trackable. Every task's final step runs a
> mutation and reports what it saw — a test nobody has watched fail is not a gate.

**Goal:** Audio becomes durable _during_ capture, so a crash partway through a recording no longer loses the whole thing.

**Architecture:** `MediaRecorder` runs with a 5-second timeslice; each `dataavailable` is written as its own RxDB attachment named from an immutable `capture.sourceId`. At stop, the chunks are merged, decode-verified, written as the ordinary `AUDIO_ATTACHMENT_ID` attachment, and the row transitions `recording → queued`. Cross-tab exclusion uses the Web Locks API — exclusion only, not write authorisation. Recovery at startup writes a **new** row for each interrupted recording, never mutating the interrupted one: an interrupted recording becomes a visible orphan the operator resolves, not something the app silently repairs.

**Tech Stack:** TypeScript 6.0.3 (ESM-only), RxDB 17.4.0 (Dexie storage, attachments plugin), zod 4, Vitest 4 (`unit` = node, `browser` = real Chromium via Playwright), React 19.

**Design:** [`durable-capture-design.md`](durable-capture-design.md) — revision 9. Read it before Task 1. Where this plan and the design disagree, the design wins and the plan is wrong.

## Global Constraints

- **ESM only.** Relative imports carry a `.js` extension though the source is `.ts`.
- **`import type`** for type-only imports — lint-enforced.
- **Comments explain WHY, not what.** This codebase comments heavily on rationale and not at all on mechanics. Match that.
- **`ribo-core` must not depend on any engine package** (`ribo-transcriber-ondevice`, adapters). Seams are defined in core; engines implement them.
- **No back-compat burden.** The SDK has no users; breaking changes are fine and migrations need no compatibility logic. Deleting persisted fields is free.
- **Every test must be able to fail.** Before finishing a task, break the implementation the test covers and confirm _that_ test goes red. Report which mutations you ran.
- **Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check` after every task; `./check.sh` before the final commit of the plan.
- **Whisper's window is 30 s at 16 kHz** — irrelevant here, but do not "helpfully" touch `ribo-transcriber-ondevice`. This plan does not implement live transcription preview.

## File Structure

**Created:**

| File                                                | Responsibility                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/ribo-core/src/queue/chunk-names.ts`       | Pure attachment naming/parsing and oversize slicing                         |
| `packages/ribo-core/src/queue/capture-lock.ts`      | Web Locks wrapper: `ifAvailable` probing and the two-promise handshake      |
| `packages/ribo-core/src/queue/capture-session.ts`   | Ingestion→persistence pipeline, health, the session object, decode-verify   |
| `packages/ribo-core/src/queue/recovery.ts`          | Startup discovery, merge, decode-verify, insert new row, mark original dead |
| `packages/ribo-ui-react/src/capture-coordinator.ts` | Observable registry so `useRecorder` and `useWorkSafety` share one session  |

**Modified:** `queue/schema.ts`, `queue/database.ts`, `queue/outbox.ts`, `queue/index.ts`, `work-safety.ts`, `recorder.ts`, `ribo-ui-react/src/{context.ts,use-recorder.ts,use-work-safety.ts,index.ts}`, `playground/src/ItemAudio.tsx`, and test fixtures across `ribo-core`, `ribo-adapter-snuggpro`, and `ribo-ui-react` that reference the removed fields.

**Why these boundaries:** `chunk-names` and `capture-lock` are pure and node-testable (capture-lock needs a browser for `navigator.locks`, but its logic is trivial), which is where the fiddly logic goes. `capture-session` owns the one piece of genuinely stateful sequencing (ingest vs persist) and the decode-verify step. `recovery` is separate because it runs at startup and is the only code that reads another session's chunks to build a new row.

---

## Task 1: Schema cleanup — remove revision 8's dead fields

The `recording` status, `audioReady`/`audioBytes`, and schema v2 shipped against revision 8. Revision 9 deletes `capture.owner`, `canonicalAttachmentId` and `step` — there is no takeover, no fence, no pointer. This task removes them and reduces `capture` to `{ sourceId }`, fixing `audioReady`/`getAudio`/`dropAudio` to read the `AUDIO_ATTACHMENT_ID` constant directly instead of through the deleted pointer.

**Files:**

- Modify: `packages/ribo-core/src/queue/schema.ts`
- Modify: `packages/ribo-core/src/queue/database.ts`
- Modify: `packages/ribo-core/src/queue/outbox.ts`
- Test: `packages/ribo-core/src/queue/schema.test.ts`, `packages/ribo-core/src/queue/outbox.browser.test.ts`
- Modify fixtures: `packages/ribo-core/src/write-step.test.ts`, `packages/ribo-adapter-snuggpro/src/round-trip.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `OutboxDocument.capture` is `z.object({ sourceId: z.string().min(1) }).optional()`; `canonicalAttachmentId` and `step` are gone from the zod schema, the RxDB mirror, `OutboxPatch`'s `Omit` list, and the migration strategy.

- [ ] **Step 1: Write the failing tests**

In `schema.test.ts`, update the optional-fields test to drop `canonicalAttachmentId` and `step`:

```ts
test("the optional fields are the step outputs, the error message, and capture", () => {
  expect(optionalKeys).toEqual([
    "capture",
    "extracted",
    "lastError",
    "reviewOutcome",
    "transcript",
    "writeResult",
  ]);
});
```

Replace the two revision-8 invariant tests with a single simplified one — the "must not claim committed audio" half is gone because `canonicalAttachmentId` no longer exists:

```ts
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
```

Delete the "a committed row must name its canonical attachment" test entirely — that invariant belonged to the deleted pointer.

Remove `canonicalAttachmentId: "audio"` from `validDocument()`:

```ts
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
```

In `outbox.browser.test.ts`, the migration test asserts `canonicalAttachmentId` — remove that assertion:

```ts
test("an outbox stored at schema version 0 opens and migrates to version 2", async () => {
  const name = uniqueName();
  await seedVersionZeroOutbox(name, v0Document());

  const outbox = await open(name);
  const items = await outbox.list({});

  expect(items).toHaveLength(1);
  expect(items[0]?.reviewOutcome).toBeUndefined();
  expect(items[0]?.status).toBe("queued");
});
```

Update the v0 schema type and helpers to omit only the fields v0 lacks (`reviewOutcome` and `capture` — `canonicalAttachmentId` and `step` no longer exist on `OutboxDocument`):

```ts
const OUTBOX_RX_SCHEMA_V0: RxJsonSchema<Omit<OutboxDocument, "reviewOutcome" | "capture">> = {
```

And the same `Omit` on `v0Document()` and `seedVersionZeroOutbox`.

In the `audioReady` test, remove the assertion on `canonicalAttachmentId`:

```ts
test("audioReady tracks the attachment, not a pointer", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.enqueue({ recording, audio: audioBlob() });
  expect(item.audioReady).toBe(true);
  await outbox.dropAudio(item.id);
  const after = await outbox.get(item.id);
  expect(after!.audioReady).toBe(false);
  expect(after!.audioBytes).toBe(0);
});
```

In `write-step.test.ts` and `round-trip.test.ts`, remove the `canonicalAttachmentId: "audio"` line from the fixture objects and their comments.

- [ ] **Step 2: Run them and watch them fail**

```
pnpm vitest run --project unit packages/ribo-core/src/queue/schema.test.ts
pnpm vitest run --project browser packages/ribo-core/src/queue/outbox.browser.test.ts
```

Expected: FAIL — the optional-keys test still lists `canonicalAttachmentId` and `step`; the `owner` test passes against the old schema (which accepts `owner`); the migration test still asserts the pointer.

- [ ] **Step 3: Remove the fields from the zod schema**

In `schema.ts`, reduce `capture` to `{ sourceId }` and delete `canonicalAttachmentId` and `step`:

```ts
  /**
   * Capture identity, present on a row recorded through the durable path. `sourceId`
   * names the chunk attachments and must NEVER change — recovery finds every chunk of
   * a recording through it. Revision 8's `owner` is deleted: nothing takes over, so
   * nothing needs authorising.
   */
  capture: z.object({ sourceId: z.string().min(1) }).optional(),
```

Replace the `superRefine` block — the `canonicalAttachmentId` invariants are gone, only the "a recording row must carry capture" check survives:

```ts
  .superRefine((doc, ctx) => {
    if (doc.status === "recording" && !doc.capture) {
      ctx.addIssue({ code: "custom", message: "a recording row must carry capture" });
    }
  });
```

Update `RECORDING_OUTBOX_STATUSES`'s comment — remove the `canonicalAttachmentId` reference:

```ts
/**
 * In-flight capture. Its own category because it is neither: the relay must not
 * act on it (there is no committed audio yet), and it is plainly not finished.
 * The status-partition test fails for any status that belongs to no named bucket,
 * and naming this one is how that invariant is kept rather than weakened.
 */
```

Update `outboxItemSchema`'s `audioReady` comment — it reads the constant, not a pointer:

```ts
  /** Whether the `AUDIO_ATTACHMENT_ID` attachment exists **right now**. */
  audioReady: z.boolean(),
```

Update `OutboxPatch`'s `Omit` list and comment — `capture` stays (its `sourceId` must never change), `canonicalAttachmentId` and `step` are gone:

```ts
/**
 * The fields a caller may change after enqueue.
 *
 * `capture` is absent because `sourceId` names the chunk attachments and must
 * NEVER change — it is set once by `beginRecording` and not patchable through
 * the ordinary public API.
 */
export type OutboxPatch = Partial<
  Omit<OutboxDocument, "id" | "seq" | "enqueuedAt" | "recording" | "idempotencyKey" | "capture">
>;
```

- [ ] **Step 4: Remove the fields from the RxDB schema mirror**

In `outboxRxSchema.properties`, delete `canonicalAttachmentId` and `step`:

```ts
    recording: { type: "object" },
    transcript: { type: "object" },
    extracted: { type: "object" },
    writeResult: { type: "object" },
    reviewOutcome: { type: "object" },
    capture: { type: "object" },
```

- [ ] **Step 5: Update the migration strategy**

In `database.ts`, the v2 strategy no longer populates `canonicalAttachmentId` — it is identity, same as v1:

```ts
export const OUTBOX_MIGRATION_STRATEGIES = {
  1: (doc: OutboxDocument) => doc,
  // v2 added `capture` (optional) — identity, since an absent optional field
  // needs no transformation. Revision 9 removed `canonicalAttachmentId` and
  // `step`, so the strategy no longer populates anything.
  2: (doc: OutboxDocument) => doc,
};
```

- [ ] **Step 6: Fix `audioReady`, `getAudio`, `dropAudio` to use the constant**

In `outbox.ts`'s `#toItem`, replace the pointer-based read with the constant:

```ts
  #toItem(doc: RxDocument<OutboxDocument>): OutboxItem {
    // `audioReady` reads the `AUDIO_ATTACHMENT_ID` attachment directly: with the
    // canonical pointer deleted in revision 9, there is only one canonical audio
    // attachment, and its id is the constant.
    const canonical = doc.getAttachment(AUDIO_ATTACHMENT_ID);
    const audioBytes =
      canonical?.length ??
      (doc.status === "recording" && doc.capture ? sumChunkBytes(doc, doc.capture.sourceId) : 0);
    return outboxItemSchema.parse({
      ...doc.toJSON(),
      audioReady: canonical !== null,
      audioBytes,
    });
  }
```

`getAudio` — read the constant, no pointer:

```ts
  /** The captured audio, or `undefined` once it has been dropped. */
  async getAudio(id: string): Promise<Blob | undefined> {
    const doc = await this.#collection.findOne(id).exec();
    const attachment = doc?.getAttachment(AUDIO_ATTACHMENT_ID);
    return attachment ? await attachment.getData() : undefined;
  }
```

`dropAudio` — drop the constant, no pointer:

```ts
  async dropAudio(id: string): Promise<void> {
    const doc = await this.#collection.findOne(id).exec();
    await doc?.getAttachment(AUDIO_ATTACHMENT_ID)?.remove();
  }
```

`enqueue` — remove the `canonicalAttachmentId` line from the parsed document:

```ts
const document = outboxDocumentSchema.parse({
  id: this.#createId(),
  seq: (await this.#highestSeq()) + 1,
  status: "queued",
  idempotencyKey: this.#createIdempotencyKey(),
  attempts: 0,
  nextAttemptAt: this.#nowIso(),
  enqueuedAt: this.#nowIso(),
  recording: baseRecordingSchema.parse(recording),
  // The non-durable enqueue path has no `capture` — audio is committed in
  // one write, not chunked.
} satisfies OutboxDocument);
```

- [ ] **Step 7: Run the tests**

```
pnpm vitest run --project unit packages/ribo-core/src/queue/schema.test.ts
pnpm vitest run --project browser packages/ribo-core/src/queue/outbox.browser.test.ts
pnpm typecheck
```

Expected: PASS. The typecheck catches any fixture across the workspace that still references the deleted fields — fix what it reports.

- [ ] **Step 8: Mutate to prove the tests bite**

Remove `capture` from `OutboxPatch`'s `Omit` list (making it patchable); the `capture carries only sourceId` test still passes but a future `patch(id, { capture: ... })` would now compile — that is the hole the `Omit` closes, so the test is the typecheck itself. Delete the `superRefine` block; the "a recording document must carry capture" test must fail. Restore, re-run, report.

- [ ] **Step 9: Commit**

```bash
git add packages/ribo-core/src packages/ribo-adapter-snuggpro/src
git commit -m "feat(core)!: remove revision 8's owner, canonicalAttachmentId and step from the outbox schema"
```

---

## Task 2: Chunk naming and Web Locks

Two pure helpers that the capture session and recovery depend on. Chunk naming is node-testable; Web Locks needs a real browser.

**Files:**

- Create: `packages/ribo-core/src/queue/chunk-names.ts`
- Create: `packages/ribo-core/src/queue/chunk-names.test.ts`
- Create: `packages/ribo-core/src/queue/capture-lock.ts`
- Create: `packages/ribo-core/src/queue/capture-lock.browser.test.ts`
- Modify: `packages/ribo-core/src/queue/outbox.ts` (replace the local `chunkPrefix` with the import)
- Modify: `packages/ribo-core/src/queue/index.ts` (export the new names)

**Interfaces:**

- Consumes: nothing.
- Produces: `chunkPrefix(sourceId)`, `chunkName(sourceId, chunkIndex, sliceIndex)`, `isChunkOf(id, sourceId)`, `sliceOversized(blob, mimeType, max)`, `MAX_CHUNK_INDEX`, `MAX_SLICE_INDEX`; `CAPTURE_LOCK`, `holdLock(name, run)`, `isLockFree(name)`.

- [ ] **Step 1: Write the failing tests for chunk naming**

```ts
import { expect, test } from "vitest";

import {
  chunkName,
  chunkPrefix,
  isChunkOf,
  MAX_CHUNK_INDEX,
  MAX_SLICE_INDEX,
  sliceOversized,
} from "./chunk-names.js";

test("names sort chronologically", () => {
  const names = [chunkName("s", 9, 0), chunkName("s", 10, 0), chunkName("s", 9, 1)];
  expect([...names].sort()).toEqual([
    chunkName("s", 9, 0),
    chunkName("s", 9, 1),
    chunkName("s", 10, 0),
  ]);
});

test("an index that would overflow fails loudly rather than sorting wrongly", () => {
  // Six digits is ~58 days at 5s, and two is 100 slices — ample, but "ample" is
  // not "impossible", and a silently wrong sort corrupts merge ORDER, which is
  // unrecoverable.
  expect(() => chunkName("s", MAX_CHUNK_INDEX + 1, 0)).toThrow(/overflow/i);
  expect(() => chunkName("s", 0, MAX_SLICE_INDEX + 1)).toThrow(/overflow/i);
});

test("chunks of one source are distinguishable from another's", () => {
  expect(isChunkOf(chunkName("abc", 1, 0), "abc")).toBe(true);
  expect(isChunkOf(chunkName("abc", 1, 0), "abd")).toBe(false);
});

test("an oversized blob slices into byte-identical parts that carry the MIME type", async () => {
  const blob = new Blob([new Uint8Array(2500)], { type: "audio/webm" });
  const parts = sliceOversized(blob, "audio/webm", 1000);
  expect(parts).toHaveLength(3);
  // Blob.slice() returns an empty type unless one is supplied, and RxDB rejects an
  // empty attachment content type.
  expect(parts.every((p) => p.type === "audio/webm")).toBe(true);
  const rejoined = new Uint8Array(await new Blob(parts).arrayBuffer());
  expect(rejoined).toEqual(new Uint8Array(await blob.arrayBuffer()));
});
```

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project unit packages/ribo-core/src/queue/chunk-names.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement chunk naming**

```ts
/**
 * @file Attachment names for durable capture, and the slicing of oversized events.
 *
 * Chunks are named from the recording's IMMUTABLE `capture.sourceId`. Recovery
 * must find every chunk of a recording, and `sourceId` never changes — so naming
 * by `sourceId` means recovery always finds them.
 */

export const MAX_CHUNK_INDEX = 999_999;
export const MAX_SLICE_INDEX = 99;

export const chunkPrefix = (sourceId: string): string => `audio-${sourceId}-`;

export function chunkName(sourceId: string, chunkIndex: number, sliceIndex: number): string {
  if (chunkIndex > MAX_CHUNK_INDEX)
    throw new Error(
      `chunk index overflow at ${chunkIndex}: capture must stop before names mis-sort`,
    );
  if (sliceIndex > MAX_SLICE_INDEX)
    throw new Error(
      `slice index overflow at ${sliceIndex}: capture must stop before names mis-sort`,
    );
  return `${chunkPrefix(sourceId)}${String(chunkIndex).padStart(6, "0")}-${String(sliceIndex).padStart(2, "0")}`;
}

export const isChunkOf = (id: string, sourceId: string): boolean =>
  id.startsWith(chunkPrefix(sourceId));

/**
 * Split a blob larger than `max` into ordered parts.
 *
 * A timeslice does not bound chunk size: a Chrome desktop sleep/wake has been
 * measured producing 23 MB in one event. Byte-slicing is safe — concatenating
 * the parts in order reproduces the original exactly — but each slice must carry
 * the negotiated MIME type explicitly, because `Blob.slice()` returns an empty
 * `type` and RxDB rejects an empty attachment content type.
 */
export function sliceOversized(blob: Blob, mimeType: string, max: number): Blob[] {
  if (blob.size <= max) return [blob.type ? blob : blob.slice(0, blob.size, mimeType)];
  const parts: Blob[] = [];
  for (let offset = 0; offset < blob.size; offset += max) {
    parts.push(blob.slice(offset, Math.min(offset + max, blob.size), mimeType));
  }
  return parts;
}
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Drop the `padStart(6, "0")` to `padStart(4, "0")` and extend the sort test past 9999 — it must fail. Remove the `mimeType` argument from `blob.slice(...)`; the MIME test must fail. Restore, re-run, report.

- [ ] **Step 6: Write the failing tests for Web Locks** (browser tier — `navigator.locks` needs a real browser)

```ts
import { expect, test } from "vitest";

import { CAPTURE_LOCK, holdLock, isLockFree } from "./capture-lock.js";

test("only one holder at a time, proven with a barrier", async () => {
  // A SEQUENTIAL test proves nothing about the race: the point is that the second
  // request arrives while the first is still inside its callback.
  let releaseFirst!: () => void;
  const first = await holdLock(
    "t",
    () => new Promise<string>((r) => (releaseFirst = () => r("a"))),
  );
  expect(first).toBeDefined();
  const second = await holdLock("t", () => Promise.resolve("b"));
  expect(second).toBeUndefined(); // refused, not queued
  releaseFirst();
  await first!.ready;
});

test("start resolves before the lock does — otherwise start() never returns", async () => {
  let releaseIt!: () => void;
  const held = await holdLock(
    "t2",
    () => new Promise<string>((r) => (releaseIt = () => r("done"))),
  );
  // The two-promise handshake: `holdLock` resolved while the lock callback is
  // still pending. Awaiting locks.request() directly would block for the whole
  // recording, which is the shape bug this test exists to pin.
  expect(held).toBeDefined();
  releaseIt();
  await expect(held!.ready).resolves.toBe("done");
});

test("a released lock is available again", async () => {
  const held = await holdLock("t3", () => Promise.resolve(1));
  await held!.ready;
  expect(await isLockFree("t3")).toBe(true);
});

test("CAPTURE_LOCK is a stable string", () => {
  expect(typeof CAPTURE_LOCK).toBe("string");
  expect(CAPTURE_LOCK.length).toBeGreaterThan(0);
});
```

- [ ] **Step 7: Run and watch fail** — `pnpm vitest run --project browser packages/ribo-core/src/queue/capture-lock.browser.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 8: Implement the Web Locks helper**

```ts
/**
 * @file Cross-tab exclusion for capture, on the Web Locks API.
 *
 * Baseline Widely Available since 2024-09-14, comfortably inside this project's
 * browser floor.
 *
 * **This is exclusion only, and that is the whole of its job.** Revision 8 needed
 * the lock to also imply write authorisation, which it cannot do — a lock can be
 * released while its holder's context survives (bfcache). With recovery writing a
 * new row, being wrong about liveness costs an orphan, not corruption. The bfcache
 * question stops mattering.
 */
export const CAPTURE_LOCK = "ribo-capture";

export interface HeldLock<T> {
  /** Resolves when `run` finishes — NOT when the lock is released. */
  readonly ready: Promise<T>;
}

/**
 * Take `name` if it is free and run `run` while holding it.
 *
 * Returns `undefined` immediately when the lock is held, rather than queueing:
 * a second tab must be told "capture is busy" now, not eventually.
 *
 * **Two promises, deliberately.** `navigator.locks.request()` does not resolve
 * until its callback ends, so awaiting it would mean `start()` blocked for the
 * entire recording. This resolves as soon as `run` has been entered, while the
 * lock stays held until `run` settles.
 */
export async function holdLock<T>(
  name: string,
  run: () => Promise<T>,
  locks: LockManager = navigator.locks,
): Promise<HeldLock<T> | undefined> {
  let entered!: (held: HeldLock<T>) => void;
  const acquired = new Promise<HeldLock<T> | undefined>((resolve) => {
    entered = resolve as (held: HeldLock<T>) => void;
  });

  void locks
    .request(name, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        entered(undefined as never);
        return Promise.resolve();
      }
      const ready = run();
      entered({ ready });
      // Swallowed HERE only: the caller still sees the rejection through `ready`.
      return ready.then(
        () => undefined,
        () => undefined,
      );
    })
    .catch(() => entered(undefined as never));

  return acquired;
}

/** Whether `name` could be taken right now. Used by recovery to tell an abandoned
 * recording from a live one. */
export async function isLockFree(
  name: string,
  locks: LockManager = navigator.locks,
): Promise<boolean> {
  return (await locks.request(name, { ifAvailable: true }, (lock) => lock !== null)) as boolean;
}
```

- [ ] **Step 9: Run the tests** — Expected: PASS.

- [ ] **Step 10: Mutate**

Change `{ ifAvailable: true }` to `{}` in `holdLock`. The barrier test must fail (the second request queues instead of being refused). Resolve `entered` _after_ `await run()` instead of before; the handshake test must hang. Restore both, re-run, report.

- [ ] **Step 11: Replace the local `chunkPrefix` in `outbox.ts`**

In `outbox.ts`, delete the local `chunkPrefix` helper and import from `chunk-names.ts`:

```ts
import { chunkPrefix as chunkPrefixForSource, isChunkOf } from "./chunk-names.js";
```

Update `sumChunkBytes` to use the imported helper (rename to avoid the local collision, or just use the import directly). Export the new names from `queue/index.ts`:

```ts
export {
  chunkName,
  chunkPrefix,
  isChunkOf,
  MAX_CHUNK_INDEX,
  MAX_SLICE_INDEX,
  sliceOversized,
} from "./chunk-names.js";
export { CAPTURE_LOCK, holdLock, isLockFree } from "./capture-lock.js";
export type { HeldLock } from "./capture-lock.js";
```

- [ ] **Step 12: Commit**

```bash
git add packages/ribo-core/src/queue
git commit -m "feat(core): add durable-capture chunk naming and Web Locks exclusion"
```

---

## Task 3: Outbox capture methods and the capture session

The core durability mechanism: `beginRecording` inserts a `recording` row, `appendChunk` writes chunk attachments during capture, `mergeChunks` reads them back in order, and `commitRecording` writes the canonical audio, transitions to `queued`, and sweeps the chunks. The capture session ties these together with the split ingestion/persistence pipeline and the health signal. This task also closes the known untested gap — a `recording` row carrying chunks — because `beginRecording` finally makes that state constructible.

**Files:**

- Modify: `packages/ribo-core/src/queue/outbox.ts`
- Create: `packages/ribo-core/src/queue/capture-session.ts`
- Create: `packages/ribo-core/src/queue/capture-session.test.ts`
- Test: `packages/ribo-core/src/queue/outbox.browser.test.ts`
- Modify: `packages/ribo-core/src/queue/index.ts`

**Interfaces:**

- Consumes: Tasks 1, 2.
- Produces: `Outbox.beginRecording({ recording, sourceId }): Promise<OutboxItem>`, `Outbox.appendChunk(id, name, blob): Promise<void>`, `Outbox.mergeChunks(id): Promise<Blob>`, `Outbox.commitRecording(id, audio, durationMs): Promise<OutboxItem>`; `openCaptureSession(options): Promise<CaptureSession>`, `CaptureHealth`, `CaptureSession`, `CaptureSessionOptions`.

- [ ] **Step 1: Write the failing tests for the outbox methods** (browser tier — needs real attachments)

```ts
test("beginRecording creates a recording row with capture.sourceId and no committed audio", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.beginRecording({
    recording: { ...recording, durationMs: 0 },
    sourceId: "s1",
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
  const outbox = await open(uniqueName());
  const item = await outbox.beginRecording({
    recording: { ...recording, durationMs: 0 },
    sourceId: "s1",
  });
  await outbox.appendChunk(item.id, chunkName("s1", 0, 0), audioBlob());
  const merged = await outbox.mergeChunks(item.id);
  const committed = await outbox.commitRecording(item.id, merged, 4200);
  expect(committed.status).toBe("queued");
  expect(committed.audioReady).toBe(true);
  expect(committed.audioBytes).toBe(audioBytes.byteLength);
  expect(committed.recording.durationMs).toBe(4200);
  // Chunks are gone — only the canonical attachment remains.
  const audio = await outbox.getAudio(item.id);
  expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(audioBytes);
});

test("mergeChunks concatenates chunk attachments in name order", async () => {
  const outbox = await open(uniqueName());
  const item = await outbox.beginRecording({
    recording: { ...recording, durationMs: 0 },
    sourceId: "s1",
  });
  const partA = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const partB = new Blob([new Uint8Array([4, 5, 6])], { type: "audio/webm" });
  await outbox.appendChunk(item.id, chunkName("s1", 0, 0), partA);
  await outbox.appendChunk(item.id, chunkName("s1", 1, 0), partB);
  const merged = await outbox.mergeChunks(item.id);
  expect(new Uint8Array(await merged.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
});
```

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project browser packages/ribo-core/src/queue/outbox.browser.test.ts` — Expected: FAIL, `beginRecording` is not a method.

- [ ] **Step 3: Implement the outbox methods**

In `outbox.ts`, add the four methods:

```ts
  /**
   * Begin a durable recording: insert a `recording` row with `capture: { sourceId }`
   * and no committed audio. Chunk attachments are written by {@link appendChunk};
   * {@link commitRecording} finalises the row into `queued`.
   */
  async beginRecording({
    recording,
    sourceId,
  }: {
    recording: Recording;
    sourceId: string;
  }): Promise<OutboxItem> {
    return this.#serialized(async () => {
      const document = outboxDocumentSchema.parse({
        id: this.#createId(),
        seq: (await this.#highestSeq()) + 1,
        status: "recording",
        idempotencyKey: this.#createIdempotencyKey(),
        attempts: 0,
        nextAttemptAt: this.#nowIso(),
        enqueuedAt: this.#nowIso(),
        recording: baseRecordingSchema.parse(recording),
        capture: { sourceId },
      } satisfies OutboxDocument);
      const doc = await this.#collection.insert(document);
      return this.#toItem(doc);
    });
  }

  /**
   * Write one chunk attachment. The `name` is a `chunkName(sourceId, …)` string;
   * the caller is responsible for naming and ordering.
   */
  async appendChunk(id: string, name: string, blob: Blob): Promise<void> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    await doc.putAttachment({
      id: name,
      type: blob.type || "application/octet-stream",
      data: blob,
    });
  }

  /**
   * Read all chunk attachments for `id`'s `capture.sourceId`, in name order, and
   * concatenate them into one `Blob`. Used at commit and at recovery.
   */
  async mergeChunks(id: string): Promise<Blob> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    const sourceId = doc.capture?.sourceId;
    if (!sourceId) throw new Error(`outbox: item ${id} has no capture.sourceId`);
    const chunks = doc
      .allAttachments()
      .filter((a) => isChunkOf(a.id, sourceId))
      .sort((a, b) => a.id.localeCompare(b.id));
    const parts: Blob[] = [];
    for (const chunk of chunks) {
      parts.push(await chunk.getData());
    }
    return new Blob(parts, { type: doc.recording.mimeType });
  }

  /**
   * Commit a durable recording: write the canonical `AUDIO_ATTACHMENT_ID`
   * attachment, transition `recording → queued` with the decoded `durationMs`,
   * and delete the chunk attachments. The caller has already merge-verified the
   * audio; this method writes what it is given.
   */
  async commitRecording(id: string, audio: Blob, durationMs: number): Promise<OutboxItem> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    // 1. Write the canonical audio.
    await doc.putAttachment({
      id: AUDIO_ATTACHMENT_ID,
      type: audio.type || "application/octet-stream",
      data: audio,
    });
    // 2. Transition recording → queued and set durationMs from the decoded audio.
    await doc.incrementalModify((data) => {
      if (data.status !== "recording")
        throw new Error(`outbox: ${id} is ${data.status}, not recording — commit refused`);
      return {
        ...data,
        status: "queued" as const,
        recording: { ...data.recording, durationMs },
      };
    });
    // 3. Sweep the chunk attachments — the canonical audio is the only audio now.
    const sourceId = doc.capture?.sourceId;
    if (sourceId) {
      for (const attachment of doc.allAttachments()) {
        if (isChunkOf(attachment.id, sourceId)) await attachment.remove();
      }
    }
    // Re-read for the projection — the attachment stubs changed.
    const settled = await this.#collection.findOne(id).exec();
    if (!settled) throw new Error(`outbox: item ${id} vanished during commit`);
    return this.#toItem(settled);
  }
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

In `commitRecording`, remove the chunk sweep (step 3). The "chunks are gone" assertion in the commit test must fail — `audioBytes` would still include chunk bytes alongside the canonical. Restore, re-run, report.

In `mergeChunks`, drop the `.sort((a, b) => a.id.localeCompare(b.id))`. The merge-order test must fail if chunks are inserted out of order. Restore, re-run, report.

- [ ] **Step 6: Write the failing tests for the capture session** (node tier — `ingest` takes blobs, no browser needed with a fake outbox)

```ts
import { expect, test, vi } from "vitest";
import { firstValueFrom } from "rxjs";

import { openCaptureSession, type CaptureHealth } from "./capture-session.js";
import type { Outbox } from "./outbox.js";
import type { Recording } from "../recording.js";

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 0,
  mimeType: "audio/webm",
  ctx: {},
};

/** A fake outbox that records calls and never blocks. */
function fakeOutbox(): Pick<
  Outbox,
  "beginRecording" | "appendChunk" | "mergeChunks" | "commitRecording" | "remove"
> & {
  chunkNames: string[];
} {
  const chunkNames: string[] = [];
  return {
    chunkNames,
    async beginRecording({ sourceId }: { recording: Recording; sourceId: string }) {
      return {
        id: "item-1",
        seq: 0,
        status: "recording",
        idempotencyKey: "k",
        attempts: 0,
        nextAttemptAt: "2026-07-23T10:00:00.000Z",
        enqueuedAt: "2026-07-23T10:00:00.000Z",
        recording,
        capture: { sourceId },
        audioReady: false,
        audioBytes: 0,
      } as any;
    },
    async appendChunk(_id: string, name: string, _blob: Blob) {
      chunkNames.push(name);
    },
    async mergeChunks(_id: string) {
      return new Blob(
        chunkNames.map(() => new Uint8Array([1])),
        { type: "audio/webm" },
      );
    },
    async commitRecording(_id: string, _audio: Blob, durationMs: number) {
      return {
        id: "item-1",
        status: "queued",
        recording: { ...recording, durationMs },
        audioReady: true,
        audioBytes: 1,
      } as any;
    },
    async remove(_id: string) {},
  };
}

function blobOf(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: "audio/webm" });
}

test("ingestion is synchronous and persistence is a separate stage", async () => {
  // ONE queue deadlocks: a chunk op that detects a write failure must finalize,
  // but the final dataavailable may already be queued BEHIND it — so awaiting
  // finalization waits on an operation that waits on it.
  const session = await openCaptureSession({
    outbox: fakeOutbox() as any,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => 0,
  });
  session.ingest(blobOf(10));
  session.ingest(blobOf(10));
  const done = session.finalize(); // must not hang
  await expect(done).resolves.toMatchObject({ durationMs: expect.any(Number) });
});

test("finalize drains everything ingested before it", async () => {
  const outbox = fakeOutbox();
  const session = await openCaptureSession({
    outbox: outbox as any,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => 0,
  });
  session.ingest(blobOf(10));
  session.ingest(blobOf(10));
  await session.finalize();
  expect(outbox.chunkNames).toHaveLength(2); // the last chunk is not dropped
});

test("a stall is observed even when the late event arrives before the detector runs", async () => {
  // The detector is frozen alongside the page it watches, so a timer cannot fire
  // while backgrounded. The dataavailable handler must compute now - lastEmission
  // BEFORE updating it, or the stall is never seen at all.
  let t = 0;
  const session = await openCaptureSession({
    outbox: fakeOutbox() as any,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => t,
  });
  session.ingest(blobOf(10));
  t = 60_000;
  session.ingest(blobOf(10)); // the late event
  expect(await firstValueFrom(session.health$)).toBe("stalled");
});

test("a user pause is not a stall", async () => {
  let t = 0;
  const session = await openCaptureSession({
    outbox: fakeOutbox() as any,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => t,
  });
  session.ingest(blobOf(10));
  t = 60_000;
  session.resumed(); // user-initiated Recorder.resume()
  session.ingest(blobOf(10));
  expect(await firstValueFrom(session.health$)).toBe("flushing");
});
```

- [ ] **Step 7: Run and watch fail** — `pnpm vitest run --project unit packages/ribo-core/src/queue/capture-session.test.ts`

- [ ] **Step 8: Implement the capture session**

```ts
import type { Observable } from "rxjs";
import { Subject } from "rxjs";

import type { Outbox, OutboxItem } from "./outbox.js";
import type { Recording } from "../recording.js";
import { chunkName, isChunkOf, sliceOversized } from "./chunk-names.js";

/**
 * Capture health — the signal `workSafety` reads to distinguish a healthy
 * recording from one whose persistence has fallen behind.
 *
 * - `"flushing"` — chunks are being written; the unflushed tail is the expected
 *   state of a live recording, not a warning.
 * - `"stalled"` — a chunk write failed, or no `dataavailable` has fired past a
 *   threshold. The recording is still in memory, but nothing new has reached disk.
 */
export type CaptureHealth = "flushing" | "stalled";

/** Placeholder — the real threshold needs a real backgrounded device to choose. */
const STALL_AFTER_MS = 30_000;

/** Max bytes per chunk attachment before byte-slicing kicks in. */
const MAX_CHUNK_BYTES = 10_000_000;

export interface CaptureSessionOptions {
  outbox: Outbox;
  recording: Recording;
  sourceId: string;
  mimeType: string;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable decode function: returns `durationMs` from the merged blob, or
   * throws if it cannot decode. Defaults to `decodeAudioData` on the main thread.
   * Injected so tests can fake it.
   */
  decode?: (blob: Blob) => Promise<number>;
}

export interface CaptureSession {
  /** Synchronous ingestion — appends to an ordered buffer and returns. */
  ingest(blob: Blob): void;
  /** User-initiated `Recorder.resume()` — resets the emission baseline. */
  resumed(): void;
  /** Close ingestion, drain, merge, decode-verify, commit. Resolves when done. */
  finalize(): Promise<{ audio: Blob; durationMs: number; item: OutboxItem }>;
  /** Abort: stop accepting data and remove the row. Fire-and-forget. */
  abort(): void;
  readonly itemId: string;
  readonly sourceId: string;
  readonly health$: Observable<CaptureHealth>;
}

/**
 * Open a capture session — inserts the `recording` row and returns a session
 * that ingests `dataavailable` events and finalises at `stop()`.
 */
export async function openCaptureSession(options: CaptureSessionOptions): Promise<CaptureSession> {
  const outbox = options.outbox;
  const sourceId = options.sourceId;
  const now = options.now ?? (() => Date.now());
  const decode = options.decode ?? decodeAudioDuration;

  const item = await outbox.beginRecording({ recording: options.recording, sourceId });

  const health$ = new Subject<CaptureHealth>();
  health$.next("flushing");

  return new CaptureSessionImpl(item.id, sourceId, options.mimeType, outbox, now, decode, health$);
}

class CaptureSessionImpl implements CaptureSession {
  readonly #itemId: string;
  readonly #sourceId: string;
  readonly #mimeType: string;
  readonly #outbox: Outbox;
  readonly #now: () => number;
  readonly #decode: (blob: Blob) => Promise<number>;
  readonly #health$: Subject<CaptureHealth>;

  /** Ordered buffer of ingested blobs, drained by the persistence loop. */
  readonly #buffer: Blob[] = [];
  /** Monotonic chunk counter. */
  #chunkIndex = 0;
  /** Whether ingestion is closed (finalize or abort has been called). */
  #closed = false;
  /** Whether the drain loop is running. */
  #draining = false;
  /** Resolves when the drain loop has caught up to the buffer. */
  #drained: Promise<void> = Promise.resolve();
  /** Last `dataavailable` timestamp, for stall detection. */
  #lastEmission: number;
  /** Whether `resumed()` has reset the baseline since the last emission. */
  #baselineReset = false;
  /** Whether the health has latched to `stalled`. */
  #stalled = false;

  constructor(
    itemId: string,
    sourceId: string,
    mimeType: string,
    outbox: Outbox,
    now: () => number,
    decode: (blob: Blob) => Promise<number>,
    health$: Subject<CaptureHealth>,
  ) {
    this.#itemId = itemId;
    this.#sourceId = sourceId;
    this.#mimeType = mimeType;
    this.#outbox = outbox;
    this.#now = now;
    this.#decode = decode;
    this.#health$ = health$;
    this.#lastEmission = now();
  }

  get itemId(): string {
    return this.#itemId;
  }

  get sourceId(): string {
    return this.#sourceId;
  }

  get health$(): Observable<CaptureHealth> {
    return this.#health$;
  }

  /**
   * Ingestion is SYNCHRONOUS: it appends to an ordered buffer and returns.
   * Persistence drains that buffer separately. One queue would deadlock — a chunk
   * operation that detects a write failure must finalize, and the final
   * `dataavailable` may already be queued behind it.
   */
  ingest(blob: Blob): void {
    if (this.#closed) return;
    const gap = this.#now() - this.#lastEmission;
    // BEFORE updating the timestamp: a late event must detect the interval it
    // missed, or a stall that only becomes observable on resume is never seen.
    if (!this.#baselineReset && gap > STALL_AFTER_MS) {
      this.#latchStalled();
    }
    this.#baselineReset = false;
    this.#lastEmission = this.#now();
    this.#buffer.push(blob);
    void this.#drain();
  }

  /** A user-initiated `Recorder.resume()`. Resets the emission baseline —
   * deliberately NOT called on page restore, which is the whole distinction:
   * one is the user choosing to stop capturing, the other is capture being
   * taken away. */
  resumed(): void {
    this.#baselineReset = true;
    this.#lastEmission = this.#now();
  }

  async finalize(): Promise<{ audio: Blob; durationMs: number; item: OutboxItem }> {
    this.#closed = true;
    // Await the drain of everything ingested before finalize was called.
    await this.#drained;
    const audio = await this.#outbox.mergeChunks(this.#itemId);
    const durationMs = await this.#decode(audio);
    const item = await this.#outbox.commitRecording(this.#itemId, audio, durationMs);
    this.#health$.complete();
    return { audio, durationMs, item };
  }

  abort(): void {
    this.#closed = true;
    this.#health$.complete();
    // Fire-and-forget: if the removal fails, startup recovery collects the row.
    void this.#outbox.remove(this.#itemId).catch(() => undefined);
  }

  #latchStalled(): void {
    if (this.#stalled) return;
    this.#stalled = true;
    this.#health$.next("stalled");
  }

  /** Drain the buffer: write each blob as chunk attachment(s). */
  #drain(): Promise<void> {
    // Chain onto the previous drain so they run serially.
    this.#drained = this.#drained.then(() => this.#drainOnce());
    return this.#drained;
  }

  async #drainOnce(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#buffer.length > 0) {
        const blob = this.#buffer.shift()!;
        const slices = sliceOversized(blob, this.#mimeType, MAX_CHUNK_BYTES);
        for (const slice of slices) {
          const sliceIndex = 0;
          const name = chunkName(this.#sourceId, this.#chunkIndex, sliceIndex);
          this.#chunkIndex += 1;
          try {
            await this.#outbox.appendChunk(this.#itemId, name, slice);
          } catch {
            // A failed chunk write latches stalled. The session continues —
            // finalize will still try to merge what did land.
            this.#latchStalled();
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}

/**
 * Decode-verify: prove the merged blob is decodable, and return its duration in
 * milliseconds. Uses `decodeAudioData` on the main thread (`AudioContext` is
 * Window-only). The transcriber decodes through the same route, so a blob that
 * decodes here will decode there.
 *
 * This proves **decodability, not completeness** — it cannot establish that every
 * emitted chunk was persisted, or that a permissive decoder did not accept a
 * truncated tail.
 */
export async function decodeAudioDuration(blob: Blob): Promise<number> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const buffer = await audioContext.decodeAudioData(arrayBuffer);
    return Math.round(buffer.duration * 1000);
  } finally {
    void audioContext.close().catch(() => undefined);
  }
}
```

- [ ] **Step 9: Run** — Expected: PASS.

- [ ] **Step 10: Mutate**

Move the gap computation to after `this.#lastEmission = this.#now()`; the late-event stall test must fail. Make `finalize()` await the buffer through the same queue that `ingest` writes to (i.e., remove the separate `#drained` chain and drain inline); the deadlock test must hang. Make `resumed()` a no-op; the pause test must fail. Restore all three, re-run, report.

- [ ] **Step 11: Export from the queue barrel**

In `queue/index.ts`:

```ts
export { CaptureHealth, openCaptureSession, decodeAudioDuration } from "./capture-session.js";
export type { CaptureSession, CaptureSessionOptions } from "./capture-session.js";
```

- [ ] **Step 12: Commit**

```bash
git add packages/ribo-core/src/queue
git commit -m "feat(core): add durable capture outbox methods and the capture session"
```

---

## Task 4: Recovery and startup discovery

At startup, in a tab that can take `CAPTURE_LOCK`, for each `recording` row: merge its chunks, decode-verify, and either insert a **new** `queued` row carrying the recovered audio (marking the original `dead` with a reason naming its successor) or mark the original `dead` with `lastError` and leave its chunks intact. There is no half-recovered state — recovery either produces a complete row or produces nothing and says so.

**Files:**

- Create: `packages/ribo-core/src/queue/recovery.ts`
- Create: `packages/ribo-core/src/queue/recovery.browser.test.ts`
- Modify: `packages/ribo-core/src/queue/index.ts`

**Interfaces:**

- Consumes: Tasks 2, 3.
- Produces: `recoverInterrupted({ outbox, decode, onRecovered }): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "vitest";

import { openOutbox, type Outbox } from "./outbox.js";
import { removeOutboxDatabase } from "./database.js";
import { chunkName, CAPTURE_LOCK, holdLock } from "./chunk-names.js";
import { recoverInterrupted } from "./recovery.js";
import type { Recording } from "../recording.js";

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 0,
  mimeType: "audio/webm",
  ctx: {},
};

/** Plant a `recording` row with N chunk attachments, simulating a crash. */
async function plantInterrupted(
  outbox: Outbox,
  sourceId: string,
  chunks: number,
  truncateLast = false,
): Promise<string> {
  const item = await outbox.beginRecording({ recording, sourceId });
  for (let i = 0; i < chunks; i++) {
    const isLast = i === chunks - 1;
    const bytes =
      isLast && truncateLast ? new Uint8Array([0, 0, 0, 0]) : new Uint8Array(2048).fill(42);
    await outbox.appendChunk(
      item.id,
      chunkName(sourceId, i, 0),
      new Blob([bytes], { type: "audio/webm" }),
    );
  }
  return item.id;
}

/** A decode that always succeeds and returns a fixed duration. */
const okDecode = async (_blob: Blob): Promise<number> => 4200;

/** A decode that always fails. */
const alwaysFails = async (_blob: Blob): Promise<number> => {
  throw new Error("unrecoverable: cannot decode");
};

/** A decode that fails on the full blob but succeeds if the last chunk is dropped. */
const failsUnlessLastDropped = {
  calls: 0,
  async decode(blob: Blob): Promise<number> {
    this.calls += 1;
    // First call (full blob) fails; second call (blob without last chunk) succeeds.
    if (this.calls === 1) throw new Error("truncated tail");
    return 3800;
  },
};

test("recovery produces a complete new queued row and marks the original dead", async () => {
  const outbox = await openOutbox({ name: `ribo-recovery-${crypto.randomUUID()}` });
  try {
    const id = await plantInterrupted(outbox, "s1", 3);
    const recovered = await recoverInterrupted({
      outbox,
      decode: okDecode,
      onRecovered: () => undefined,
    });
    expect(recovered).toHaveLength(1);
    const newRow = await outbox.get(recovered[0]!);
    expect(newRow).toBeDefined();
    expect(newRow!.status).toBe("queued");
    expect(newRow!.audioReady).toBe(true);
    expect(newRow!.audioBytes).toBeGreaterThan(0);
    expect(newRow!.recording.id).toBe(recording.id);
    expect(newRow!.id).not.toBe(id); // a NEW row, not the original
    // The original is dead, with a reason naming its successor.
    const original = await outbox.get(id);
    expect(original!.status).toBe("dead");
    expect(original!.lastError).toMatch(new RegExp(recovered[0]!));
  } finally {
    await outbox.close();
    await removeOutboxDatabase(outbox.database.name);
  }
});

test("undecodable audio leaves the original dead with chunks intact", async () => {
  const outbox = await openOutbox({ name: `ribo-recovery-${crypto.randomUUID()}` });
  try {
    const id = await plantInterrupted(outbox, "s1", 2);
    await recoverInterrupted({ outbox, decode: alwaysFails, onRecovered: () => undefined });
    const original = await outbox.get(id);
    expect(original!.status).toBe("dead");
    expect(original!.lastError).toMatch(/unrecoverable|cannot decode/i);
    // Chunks are NOT swept — never silently discard bytes.
    const audio = await outbox.getAudio(id);
    expect(audio).toBeUndefined(); // no canonical audio on a dead row
    // But the chunk attachments are still there (mergeChunks would find them).
    const merged = await outbox.mergeChunks(id);
    expect(merged.size).toBeGreaterThan(0);
  } finally {
    await outbox.close();
    await removeOutboxDatabase(outbox.database.name);
  }
});

test("a truncated final chunk recovers by dropping it", async () => {
  const outbox = await openOutbox({ name: `ribo-recovery-${crypto.randomUUID()}` });
  try {
    const id = await plantInterrupted(outbox, "s1", 3, true);
    const decoder = failsUnlessLastDropped;
    const recovered = await recoverInterrupted({
      outbox,
      decode: decoder.decode.bind(decoder),
      onRecovered: () => undefined,
    });
    expect(recovered).toHaveLength(1);
    const newRow = await outbox.get(recovered[0]!);
    expect(newRow!.status).toBe("queued");
    expect(newRow!.audioReady).toBe(true);
  } finally {
    await outbox.close();
    await removeOutboxDatabase(outbox.database.name);
  }
});

test("recovery does nothing when the lock is held — a live session owns it", async () => {
  const outbox = await openOutbox({ name: `ribo-recovery-${crypto.randomUUID()}` });
  try {
    await plantInterrupted(outbox, "s1", 2);
    // Hold the capture lock — simulating a live recording in another tab.
    const release = await holdLock(CAPTURE_LOCK, () => new Promise<void>(() => {}));
    expect(release).toBeDefined();
    const recovered = await recoverInterrupted({
      outbox,
      decode: okDecode,
      onRecovered: () => undefined,
    });
    expect(recovered).toEqual([]); // nothing recovered — the row is left alone
    release!.ready.catch(() => undefined); // don't let it reject unhandled
  } finally {
    await outbox.close();
    await removeOutboxDatabase(outbox.database.name);
  }
});

test("recovery with no interrupted rows returns empty", async () => {
  const outbox = await openOutbox({ name: `ribo-recovery-${crypto.randomUUID()}` });
  try {
    const recovered = await recoverInterrupted({
      outbox,
      decode: okDecode,
      onRecovered: () => undefined,
    });
    expect(recovered).toEqual([]);
  } finally {
    await outbox.close();
    await removeOutboxDatabase(outbox.database.name);
  }
});
```

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project browser packages/ribo-core/src/queue/recovery.browser.test.ts`

- [ ] **Step 3: Implement recovery**

```ts
import type { Outbox } from "./outbox.js";
import { CAPTURE_LOCK, holdLock, isLockFree } from "./capture-lock.js";
import { chunkName, isChunkOf } from "./chunk-names.js";

export interface RecoveryOptions {
  outbox: Outbox;
  /**
   * Decode-verify the merged blob: returns `durationMs`, or throws if undecodable.
   * Injected so tests can fake it.
   */
  decode: (blob: Blob) => Promise<number>;
  /** Called with the ids of the new rows recovery created, so the caller can `syncNow()`. */
  onRecovered?: (ids: string[]) => void;
}

/**
 * Recover interrupted recordings at startup.
 *
 * For each row in `recording` (nothing else holds `CAPTURE_LOCK`, so none is
 * live):
 *
 * - If its chunks merge and decode → insert a NEW row, `queued`, with that
 *   audio, carrying the original's `recording` metadata and a fresh id. Then
 *   mark the original `dead` with a reason naming its successor.
 * - If its chunks cannot be decoded even after dropping the last one → leave it
 *   `dead` with `lastError` set and its chunks intact. Never write audio that
 *   does not decode; never silently discard bytes.
 *
 * There is no half-recovered state: recovery either produces a complete row or
 * produces nothing and says so.
 */
export async function recoverInterrupted(options: RecoveryOptions): Promise<string[]> {
  const { outbox, decode } = options;

  // If a live session holds the lock, do nothing — the row is not abandoned.
  if (!(await isLockFree(CAPTURE_LOCK))) return [];

  const recording = await outbox.list({ status: ["recording"] });
  if (recording.length === 0) return [];

  // Take the lock for the duration of recovery, so a second tab does not race.
  return new Promise<string[]>((resolve) => {
    void holdLock(CAPTURE_LOCK, async () => {
      const recoveredIds: string[] = [];
      for (const item of recording) {
        const id = await recoverOne(outbox, item.id, decode);
        if (id) recoveredIds.push(id);
      }
      options.onRecovered?.(recoveredIds);
      resolve(recoveredIds);
    }).then((held) => {
      // holdLock returns undefined if the lock was taken between the isLockFree
      // check and here — a race with a live session starting. In that case,
      // resolve empty: the live session owns the rows.
      if (held === undefined) resolve([]);
    });
  });
}

/**
 * Recover one interrupted row. Returns the id of the new row, or `undefined` if
 * the row was marked dead without recovery.
 */
async function recoverOne(
  outbox: Outbox,
  id: string,
  decode: (blob: Blob) => Promise<number>,
): Promise<string | undefined> {
  const item = await outbox.get(id);
  if (!item || item.status !== "recording") return undefined;

  const sourceId = item.capture?.sourceId;
  if (!sourceId) {
    await outbox.patch(id, { status: "dead", lastError: "unrecoverable: no capture.sourceId" });
    return undefined;
  }

  // Try to merge and decode. On failure, retry without the last chunk.
  const merged = await outbox.mergeChunks(id);
  let durationMs: number;
  try {
    durationMs = await decode(merged);
  } catch {
    // Drop the last chunk and retry.
    const trimmed = await mergeWithoutLastChunk(outbox, id, sourceId);
    if (trimmed === null) {
      // Only one chunk and it failed — nothing to drop.
      await outbox.patch(id, { status: "dead", lastError: "unrecoverable: cannot decode audio" });
      return undefined;
    }
    try {
      durationMs = await decode(trimmed);
    } catch {
      // Still undecodable — leave dead with chunks intact.
      await outbox.patch(id, { status: "dead", lastError: "unrecoverable: cannot decode audio" });
      return undefined;
    }
  }

  // Success: insert a NEW row, queued, with the recovered audio.
  const audio =
    durationMs === (await decode(merged))
      ? merged
      : (await mergeWithoutLastChunk(outbox, id, sourceId))!;
  const newItem = await outbox.enqueue({
    recording: { ...item.recording, durationMs },
    audio,
  });

  // Mark the original dead with a reason naming its successor.
  await outbox.patch(id, {
    status: "dead",
    lastError: `recovered as ${newItem.id}`,
  });

  return newItem.id;
}

/**
 * Merge chunks excluding the last one. Returns `null` if there is only one chunk.
 */
async function mergeWithoutLastChunk(
  outbox: Outbox,
  id: string,
  sourceId: string,
): Promise<Blob | null> {
  const item = await outbox.get(id);
  if (!item) return null;
  // Read the doc's attachments, filter to chunks, sort, drop the last.
  const doc = await (outbox as any).#collection.findOne(id).exec();
  if (!doc) return null;
  const chunks = doc
    .allAttachments()
    .filter((a: { id: string }) => isChunkOf(a.id, sourceId))
    .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  if (chunks.length <= 1) return null;
  const parts: Blob[] = [];
  for (let i = 0; i < chunks.length - 1; i++) {
    parts.push(await chunks[i].getData());
  }
  return new Blob(parts, { type: item.recording.mimeType });
}
```

Note: `mergeWithoutLastChunk` reaches into `Outbox`'s private `#collection` — that is a test-only convenience. In the implementation, add a package-private `mergeChunksExcludingLast(id)` method to `Outbox` if the private field access is awkward, or inline the logic. The clean approach is a second `Outbox` method:

```ts
  /**
   * Merge chunk attachments excluding the last one, for recovery's
   * drop-and-retry. Returns `null` if there is only one chunk.
   */
  async mergeChunksExcludingLast(id: string): Promise<Blob | null> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    const sourceId = doc.capture?.sourceId;
    if (!sourceId) throw new Error(`outbox: item ${id} has no capture.sourceId`);
    const chunks = doc
      .allAttachments()
      .filter((a) => isChunkOf(a.id, sourceId))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (chunks.length <= 1) return null;
    const parts: Blob[] = [];
    for (let i = 0; i < chunks.length - 1; i++) {
      parts.push(await chunks[i].getData());
    }
    return new Blob(parts, { type: doc.recording.mimeType });
  }
```

Then `recoverOne` calls `outbox.mergeChunksExcludingLast(id)` instead of the private-field hack. Add this method in Step 3 alongside `recovery.ts`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

In `recoverOne`, mark the original `dead` _before_ inserting the new row. The "original is dead with a reason naming its successor" test must still pass (the new row exists), but the `lastError` would not contain the new id — wait, it would if the ordering is: insert new, get id, then mark dead. If you mark dead first, you don't have the new id yet, so `lastError` would be a generic message — the test asserting `lastError` matches the successor id must fail. Restore, re-run, report.

Remove the `isLockFree` guard at the top of `recoverInterrupted`; the "lock is held" test must fail (recovery would proceed and recover the row despite a live session). Restore, re-run, report.

- [ ] **Step 6: Export from the queue barrel**

In `queue/index.ts`:

```ts
export { recoverInterrupted } from "./recovery.js";
export type { RecoveryOptions } from "./recovery.js";
```

- [ ] **Step 7: Commit**

```bash
git add packages/ribo-core/src/queue
git commit -m "feat(core): recover interrupted recordings by writing a new row"
```

---

## Task 5: Recorder integration, capture health, and React wiring

The final integration: `Recorder.start()` acquires the capture lock, opens a capture session, and starts `MediaRecorder` with a timeslice; `stop()` finalises the session (merge, decode-verify, commit). `workSafety` gets an optional `captureHealth` parameter. A `CaptureCoordinator` in `ribo-ui-react` lets `useRecorder` and `useWorkSafety` share one session.

**Files:**

- Modify: `packages/ribo-core/src/recorder.ts`
- Modify: `packages/ribo-core/src/work-safety.ts`, `packages/ribo-core/src/work-safety.test.ts`
- Create: `packages/ribo-ui-react/src/capture-coordinator.ts`
- Modify: `packages/ribo-ui-react/src/{context.ts,use-recorder.ts,use-work-safety.ts,index.ts}`
- Test: `packages/ribo-core/src/recorder.browser.test.ts`, `packages/ribo-ui-react/src/capture-coordinator.browser.test.tsx`

**Interfaces:**

- Consumes: Tasks 2, 3.
- Produces: `RecorderOptions.captureSession?`; `Recorder.start(): Promise<string | undefined>`; `Recorder.captureSession` getter; `workSafety(work, persistence, connectivity, captureHealth?)`; `CaptureCoordinator`, `createCaptureCoordinator()`; `RiboInstances.captureCoordinator?`.

- [ ] **Step 1: Write the failing tests for capture health in `workSafety`**

In `work-safety.test.ts`:

```ts
test("healthy recording is protected, with a reason that names the unflushed tail", () => {
  // NOT at-risk. A warning that fires on every single recording is noise that
  // teaches the user to ignore the one time it matters.
  const result = workSafety(
    { pending: 1, dead: 0, synced: 0, awaitingReview: 0 },
    "granted",
    "online",
    "flushing",
  );
  expect(result).toMatchObject({ level: "protected", reason: "recording" });
});

test("a stalled capture is at-risk", () => {
  const result = workSafety(
    { pending: 1, dead: 0, synced: 0, awaitingReview: 0 },
    "granted",
    "online",
    "stalled",
  );
  expect(result).toMatchObject({ level: "at-risk", reason: "capture-stalled" });
});

test("the existing precedence is unchanged — a dead item still outranks a stall", () => {
  // action-required > at-risk > protected > safe, and `dead` is checked BEFORE
  // capture health. The new reason slots INTO that order; it does not redefine it.
  const result = workSafety(
    { pending: 1, dead: 1, synced: 0, awaitingReview: 0 },
    "denied",
    "online",
    "stalled",
  );
  expect(result).toMatchObject({ level: "action-required", reason: "failed-permanently" });
});

test("omitting capture health behaves exactly as today", () => {
  expect(
    workSafety({ pending: 1, dead: 0, synced: 0, awaitingReview: 0 }, "granted", "online"),
  ).toMatchObject({ level: "protected", reason: "awaiting-sync" });
});
```

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project unit packages/ribo-core/src/work-safety.test.ts`

- [ ] **Step 3: Implement capture health in `workSafety`**

Add the optional fourth parameter and the two union members. Insert `capture-stalled` **inside** the existing `at-risk` tier (after the `dead` check, alongside `not-persisted`), and `recording` as a `protected` reason:

```ts
import type { CaptureHealth } from "./queue/capture-session.js";

export type WorkSafety =
  | { readonly level: "safe"; readonly reason: "nothing-captured" | "all-synced" }
  | {
      readonly level: "protected";
      readonly reason: "awaiting-sync" | "recording";
      readonly pending: number;
      readonly connectivity: ConnectivityStatus;
    }
  | {
      readonly level: "at-risk";
      readonly reason: "not-persisted" | "capture-stalled";
      readonly pending: number;
      readonly persistence?: Exclude<StoragePersistence, "granted">;
    }
  | {
      readonly level: "action-required";
      readonly reason: "failed-permanently";
      readonly dead: number;
    };

export const workSafety = (
  work: WorkOnDevice,
  persistence: StoragePersistence,
  connectivity: ConnectivityStatus,
  captureHealth?: CaptureHealth,
): WorkSafety => {
  if (work.dead > 0) {
    return { level: "action-required", reason: "failed-permanently", dead: work.dead };
  }

  // A stalled capture is at-risk regardless of persistence: persistence has
  // actually fallen behind — a failed chunk write or no dataavailable past a
  // threshold — and the recording in memory is not reaching disk.
  if (captureHealth === "stalled") {
    return { level: "at-risk", reason: "capture-stalled", pending: work.pending };
  }

  if (work.pending === 0) {
    return { level: "safe", reason: work.synced > 0 ? "all-synced" : "nothing-captured" };
  }

  // Healthy recording is protected — the unflushed tail is the expected state of
  // a live recording, not a warning.
  if (captureHealth === "flushing") {
    return { level: "protected", reason: "recording", pending: work.pending, connectivity };
  }

  if (persistence !== "granted") {
    return { level: "at-risk", reason: "not-persisted", pending: work.pending, persistence };
  }

  return { level: "protected", reason: "awaiting-sync", pending: work.pending, connectivity };
};
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Move the `capture-stalled` check above the `dead` check; the precedence test must fail. Restore, re-run, report.

- [ ] **Step 6: Write the failing tests for recorder integration**

In `recorder.browser.test.ts`:

```ts
test("start refuses when another tab holds the lock, WITHOUT prompting for the microphone", async () => {
  // Refusing before the microphone matters: the recording indicator must not
  // light on the way to throwing.
  const getUserMedia = vi.fn();
  const release = await holdLock(CAPTURE_LOCK, () => new Promise(() => {}));
  expect(release).toBeDefined();
  const recorder = new Recorder({
    media: { getUserMedia },
    captureSession: factory,
  } as any);
  await expect(recorder.start()).rejects.toThrow(/another tab|busy/i);
  expect(getUserMedia).not.toHaveBeenCalled();
});

test("a failure after the row is created unwinds it and releases the lock", async () => {
  const recorder = new Recorder({
    captureSession: factoryThatFailsOnStart,
  } as any);
  await expect(recorder.start()).rejects.toThrow();
  expect(await isLockFree(CAPTURE_LOCK)).toBe(true);
  expect(await outbox.list({ status: ["recording"] })).toHaveLength(0);
});

test("enqueue-free recording still takes the lock and still gets no durability", async () => {
  const recorder = new Recorder({}); // no captureSession
  const id = await recorder.start();
  expect(id).toBeUndefined();
  expect(await isLockFree(CAPTURE_LOCK)).toBe(false); // two tabs recording at once is wrong either way
  await recorder.stop();
});
```

- [ ] **Step 7: Run and watch fail**

- [ ] **Step 8: Implement the recorder integration**

Add `captureSession` and `timesliceMs` to `RecorderOptions`:

```ts
export interface RecorderOptions<C = EmptyContext> {
  // ... existing options ...
  /**
   * Durable-capture session factory. When provided, `start()` acquires the
   * capture lock, opens a session (inserting a `recording` row), and starts
   * `MediaRecorder` with a timeslice; each `dataavailable` is written as a chunk
   * attachment. `stop()` finalises: merges, decode-verifies, and commits. When
   * absent, the recorder works as before — non-durable, one blob at `stop()`.
   */
  readonly captureSession?: (opts: {
    recording: Omit<Recording, "ctx"> & { ctx: C };
    sourceId: string;
    mimeType: string;
  }) => Promise<CaptureSession>;
  /** Timeslice for `MediaRecorder.start()`. Defaults to 5000 ms. */
  readonly timesliceMs?: number;
}
```

`start()` becomes, in this order:

1. `holdLock(CAPTURE_LOCK, …)`; `undefined` → throw `RecorderError("capture-busy", …)`.
2. `negotiateMimeType(this.#mimeTypes)` — before the microphone.
3. `#openMicrophone()`.
4. `#beginSession(stream, mimeType)` — constructs `MediaRecorder`.
5. Read `session.recorder.mimeType` — the live, negotiated value.
6. If `captureSession` is configured: create `Recording` with `durationMs: 0`, open a capture session (calls `beginRecording`), wire `dataavailable` to `session.ingest`, start `MediaRecorder` with `timesliceMs`. Store the capture session on the session object.
7. If not: start `MediaRecorder` with no timeslice (as today), wire `dataavailable` to push to `session.chunks`.
8. Return the item id (or `undefined` in non-durable mode).

```ts
  /** The active capture session, if recording durably. Exposed so a host can
   * register it with a coordinator for health reporting. */
  get captureSession(): CaptureSession | undefined {
    return this.#session?.captureSession;
  }

  async start(): Promise<string | undefined> {
    if (this.#phase !== "idle") {
      throw new RecorderError("already-recording", "...");
    }

    // Acquire the capture lock BEFORE the microphone: a second tab must be told
    // "capture is busy" before it lights the recording indicator.
    const lockHeld = this.#captureSessionFactory
      ? await holdLock(CAPTURE_LOCK, () => new Promise<void>(() => {}))
      : undefined;
    if (this.#captureSessionFactory && lockHeld === undefined) {
      throw new RecorderError(
        "capture-busy",
        "Another tab is recording. Durable capture is exclusive — close it and try again.",
      );
    }

    const mimeType = negotiateMimeType(this.#mimeTypes);
    const stream = await this.#openMicrophone();

    try {
      this.#session = this.#beginSession(stream, mimeType);
    } catch (error) {
      releaseStream(stream);
      if (lockHeld) await this.#abortCapture();
      throw new RecorderError("capture-failed", "The MediaRecorder could not be started.", {
        cause: error,
      });
    }

    this.#failure = undefined;
    this.#accumulatedMs = 0;
    this.#resumedAt = performance.now();
    this.#phase = "recording";
    this.#emit();

    if (this.#captureSessionFactory && lockHeld) {
      const recording = baseRecordingSchema.parse({
        id: this.#createId(),
        capturedAt: new Date().toISOString(),
        durationMs: 0,
        mimeType: this.#session.recorder.mimeType,
        ctx: this.#ctx,
      });
      const captureSession = await this.#captureSessionFactory({
        recording,
        sourceId: recording.id,
        mimeType: this.#session.recorder.mimeType,
      });
      this.#session.captureSession = captureSession;
      this.#session.recorder.start(this.#timesliceMs);
      return captureSession.itemId;
    }

    this.#session.recorder.start();
    return undefined;
  }
```

`stop()` awaits `captureSession.finalize()` before constructing the `Capture`:

```ts
  async stop(): Promise<Capture<C>> {
    const session = this.#session;
    if (session === undefined || (this.#phase !== "recording" && this.#phase !== "paused" && this.#phase !== "failed")) {
      throw new RecorderError("not-recording", "...");
    }

    const durationMs = this.elapsedMs;
    const mimeType = session.recorder.mimeType || negotiateMimeType(this.#mimeTypes);
    this.#phase = "stopping";
    this.#emit();

    try {
      await stopRecorder(session.recorder);
      if (this.#failure !== undefined) throw this.#failure;

      if (session.captureSession) {
        // Durable path: finalize merges, decode-verifies, and commits.
        const result = await session.captureSession.finalize();
        const recording = baseRecordingSchema.parse({
          id: this.#createId(),
          capturedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          mimeType,
          ctx: this.#ctx,
        });
        return { recording: { ...recording, ctx: this.#ctx }, audio: result.audio };
      }

      // Non-durable path: assemble from in-memory chunks, as today.
      const audio = new Blob(session.chunks, { type: mimeType });
      const recording = baseRecordingSchema.parse({
        id: this.#createId(),
        capturedAt: new Date().toISOString(),
        durationMs,
        mimeType,
        ctx: this.#ctx,
      });
      return { recording: { ...recording, ctx: this.#ctx }, audio };
    } finally {
      this.#teardown(session);
    }
  }
```

The `Session` interface gains an optional `captureSession`:

```ts
interface Session {
  readonly stream: MediaStream;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly audioContext: AudioContext | undefined;
  readonly analyser: AnalyserNode | undefined;
  readonly samples: Uint8Array<ArrayBuffer> | undefined;
  readonly ticker: ReturnType<typeof setInterval>;
  captureSession?: CaptureSession;
}
```

In `#beginSession`, wire `dataavailable` to the capture session if present (it is set after `#beginSession` returns, so the handler checks at event time):

```ts
recorder.addEventListener("dataavailable", (event) => {
  if (event.data.size > 0) {
    if (this.#session?.captureSession) {
      this.#session.captureSession.ingest(event.data);
    } else {
      chunks.push(event.data);
    }
  }
});
```

`#teardown` aborts the capture session if it hasn't been finalised:

```ts
  #teardown(session: Session): void {
    // If a capture session exists and finalize() was not called (failure path),
    // abort it to remove the recording row.
    session.captureSession?.abort();
    clearInterval(session.ticker);
    releaseStream(session.stream);
    void session.audioContext?.close().catch(() => undefined);
    this.#session = undefined;
    this.#level = 0;
    this.#accumulatedMs = 0;
    this.#resumedAt = 0;
    this.#failure = undefined;
    this.#phase = "idle";
    this.#emit();
  }
```

`resume()` calls `session.captureSession?.resumed()` so a user pause is not detected as a stall:

```ts
  resume(): void {
    // ... existing code ...
    session.recorder.resume();
    session.captureSession?.resumed();
    this.#resumedAt = performance.now();
    this.#phase = "recording";
    this.#emit();
  }
```

- [ ] **Step 9: Run** — Expected: PASS.

- [ ] **Step 10: Mutate**

Move `negotiateMimeType` after `#openMicrophone`; the no-prompt test must fail (the microphone is prompted before the MIME negotiation fails). Remove `abort()` from `#teardown`; the unwind test must fail (the recording row is left behind). Restore, re-run, report.

- [ ] **Step 11: Write the failing tests for the React coordinator**

In `capture-coordinator.browser.test.tsx`:

```tsx
test("a session registered by useRecorder is visible to a SIBLING useWorkSafety", async () => {
  // A session created inside a descendant hook cannot publish itself by mutating
  // the provider's value — RiboProvider passes the host's object straight
  // through. The coordinator is the shared, observable thing that makes this work.
  const { result } = renderHooks({ captureCoordinator, recorder, outbox });
  await act(() => result.current.recorder.start());
  await waitFor(() =>
    expect(result.current.safety).toMatchObject({ level: "protected", reason: "recording" }),
  );
});

test("the session disappears on stop AND on a failed start", async () => {
  const { result } = renderHooks({ captureCoordinator, recorder: failingRecorder, outbox });
  await act(() => result.current.recorder.start().catch(() => undefined));
  expect(captureCoordinator.active()).toBeUndefined();
});

test("no coordinator means no durable capture and today's behaviour", async () => {
  const { result } = renderHooks({ recorder, outbox }); // no coordinator
  await act(() => result.current.recorder.start());
  expect(result.current.safety.reason).not.toBe("recording");
});
```

- [ ] **Step 12: Implement the coordinator and React wiring**

`capture-coordinator.ts`:

```ts
import type { Observable } from "rxjs";
import { BehaviorSubject } from "rxjs";

import type { CaptureHealth, CaptureSession } from "@azx/ribo-core";

/**
 * The shared handle through which `useRecorder` publishes the active capture
 * session and `useWorkSafety` reads its health.
 *
 * It exists because a session created inside one hook cannot reach a sibling:
 * `RiboProvider` passes the host's instance object through unchanged and
 * deliberately constructs nothing, so mutating that object notifies nobody.
 *
 * **The host constructs it**, like every other instance, rather than the provider
 * creating one silently. It is OPTIONAL: absent, there is no capture health and
 * `useWorkSafety` behaves as it does today.
 */
export interface CaptureCoordinator {
  register(session: CaptureSession): () => void;
  active(): CaptureSession | undefined;
  readonly health$: Observable<CaptureHealth | undefined>;
}

export function createCaptureCoordinator(): CaptureCoordinator {
  const health$ = new BehaviorSubject<CaptureHealth | undefined>(undefined);
  let session: CaptureSession | undefined;
  let unsub: (() => void) | undefined;
  return {
    register(s: CaptureSession): () => void {
      session = s;
      unsub = s.health$.subscribe((h) => health$.next(h));
      return () => {
        unsub?.();
        session = undefined;
        health$.next(undefined);
      };
    },
    active(): CaptureSession | undefined {
      return session;
    },
    health$,
  };
}
```

In `context.ts`, add the coordinator to `RiboInstances`:

```ts
import type { CaptureCoordinator } from "./capture-coordinator.js";

export interface RiboInstances {
  readonly recorder?: AnyRecorder;
  readonly outbox?: Outbox;
  readonly connectivity?: Connectivity;
  readonly captureCoordinator?: CaptureCoordinator;
}
```

In `use-recorder.ts`, register the session after `start()` and unregister after `stop()` or on failure:

```ts
const captureCoordinator = useOptionalRiboInstance(
  "captureCoordinator",
  options.captureCoordinator,
);

const start = useCallback(async () => {
  setError(undefined);
  setBusy(true);
  try {
    const id = await recorder.start();
    setItemId(id);
    if (captureCoordinator && recorder.captureSession) {
      const unregister = captureCoordinator.register(recorder.captureSession);
      setUnregister(() => unregister);
    }
  } catch (cause) {
    setError(asRecorderError(cause));
  } finally {
    setBusy(false);
  }
}, [recorder, captureCoordinator]);
```

In `use-work-safety.ts`, read the coordinator's health and pass it to `workSafety`:

```ts
const captureCoordinator = useOptionalRiboInstance("captureCoordinator", undefined);
const captureHealth = useSubscribed(
  useCallback(
    (listener: (h: CaptureHealth | undefined) => void) => {
      if (!captureCoordinator) return () => {};
      const sub = captureCoordinator.health$.subscribe(listener);
      return () => sub.unsubscribe();
    },
    [captureCoordinator],
  ),
  () => undefined,
);

const safety = useMemo(
  () =>
    work === undefined
      ? undefined
      : workSafety(work, persistence, connectivity.status, captureHealth),
  [connectivity.status, persistence, work, captureHealth],
);
```

Export the coordinator from `index.ts`:

```ts
export { createCaptureCoordinator } from "./capture-coordinator.js";
export type { CaptureCoordinator } from "./capture-coordinator.js";
```

- [ ] **Step 13: Run** — Expected: PASS.

- [ ] **Step 14: Mutate**

Make `useWorkSafety` read the coordinator from its own arguments rather than context; the sibling test must fail. Skip unregistering on a failed start; the second test must fail. Restore, re-run, report.

- [ ] **Step 15: Run the full gate**

```
./check.sh
```

Expected: PASS — typecheck, lint, format:check, build:packages, resolve, build:app, pkg:gates, and all three Vitest projects.

- [ ] **Step 16: Add a changeset**

```bash
pnpm changeset
```

`@azx/ribo-core` **major**, `@azx/ribo-ui-react` **major**. These are breaking: `OutboxDocument` loses `canonicalAttachmentId` and `step`, `capture` loses `owner`, `Recorder.start()` returns an id, `workSafety` gains a parameter, and `RiboInstances` gains a field. Say so plainly. Include the §1 limitation: **each flushed chunk is safe; emission can stall for as long as the app is backgrounded.**

- [ ] **Step 17: Commit**

```bash
git add .
git commit -m "feat(core,ui-react)!: acquire the capture lock, persist chunks during recording, and report capture health"
```

---

## Self-review notes

**Spec coverage.**

| Design section                                              | Task(s)                |
| ----------------------------------------------------------- | ---------------------- |
| §1 — Capture writes chunks as it goes                       | 2, 3, 5                |
| §1 — Ingestion/persistence as separate stages               | 3                      |
| §1 — Oversize slicing, MIME type, overflow                  | 2                      |
| §1 — `stop()` awaits outstanding writes                     | 3, 5                   |
| §2 — The `recording` status                                 | 1 (cleanup of shipped) |
| §2 — `capture: { sourceId }` only                           | 1                      |
| §3 — One recording at a time, via Web Locks                 | 2, 5                   |
| §3 — Exclusion only, not authorisation                      | 2 (comment), 5         |
| §4 — Commit: merge, decode-verify, write, transition, sweep | 3, 5                   |
| §4 — Recovery: new row, mark original dead                  | 4                      |
| §4 — Recovery: undecodable → dead, chunks intact            | 4                      |
| §4 — Recovery: truncated final chunk → drop and retry       | 4                      |
| §4 — Then call `syncNow()`                                  | 4 (`onRecovered`)      |
| §5 — `workSafety` `protected` during healthy recording      | 5                      |
| §5 — Downgrades to `at-risk` when behind                    | 3 (health), 5          |
| §5 — `audioReady`/`audioBytes` gap closed                   | 3                      |
| §6 — Visible orphan                                         | 4                      |

**Deliberately not covered, and why:**

- **The emission-stall threshold** (`STALL_AFTER_MS`) needs a real backgrounded device to choose well. Task 3 uses a placeholder constant with a comment saying so; tune it after measuring, not before. The design's §7 names this as an open question.
- **MP4 chunk recovery** cannot be verified in this harness (Playwright is Chromium, so a passing test proves WebM only). Task 4's tests prove WebM. The failure is honest — an undecodable merge leaves the row dead with chunks intact — but the Safari success rate is unknown. The design's §7 names this as an open question.
- **Multi-tab relay claiming** is a real pre-existing problem — `nextPending()` takes no claim, so two tabs drain the same item. Revision 8 adopted it; revision 9 hands it back. It deserves its own design (§7). This plan does not touch `relay.ts`.
- **The bfcache spike** (old Task 1) is gone entirely. Revision 9's recovery-writes-a-new-row decision makes the bfcache question stop mattering: being wrong about liveness costs an orphan, not corruption. There is no fence to justify measuring.
- **A `RELAY_LOCK`** is not introduced. The old plan added one for relay draining; revision 9 does not mention it, and the relay claim problem is out of scope.
