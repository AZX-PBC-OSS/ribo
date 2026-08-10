# Durable Capture Implementation Plan

> **Executing this:** one task at a time, in order, each ending with its own test cycle and its own
> review. Steps use checkbox (`- [ ]`) syntax so progress is trackable. Every task's final step runs a
> mutation and reports what it saw — a test nobody has watched fail is not a gate.

**Goal:** Audio becomes durable _during_ capture, so a crash partway through a recording no longer loses the whole thing.

**Architecture:** `MediaRecorder` runs with a timeslice; each `dataavailable` is written as its own RxDB attachment named from an immutable `capture.sourceId`. At stop, the chunks are merged, decode-verified, written as an owner-scoped canonical attachment, and published by a guarded `canonicalAttachmentId` pointer in the same modify that transitions `recording → queued`. Cross-tab exclusion and crash detection use the Web Locks API; write _authorisation_ uses a rotating `capture.owner` token compared inside every guarded `incrementalModify`, because a lock can be released while its holder's context survives (bfcache).

**Tech Stack:** TypeScript 6.0.3 (ESM-only), RxDB 17.4.0 (Dexie storage, attachments plugin), zod 4, Vitest 4 (`unit` = node, `browser` = real Chromium via Playwright), React 19.

**Design:** [`durable-capture-design.md`](durable-capture-design.md) — revision 8. Read it before Task 1. Where this plan and the design disagree, the design wins and the plan is wrong.

## Global Constraints

- **ESM only.** Relative imports carry a `.js` extension though the source is `.ts`.
- **`import type`** for type-only imports — lint-enforced.
- **Comments explain WHY, not what.** This codebase comments heavily on rationale and not at all on mechanics. Match that.
- **`ribo-core` must not depend on any engine package** (`ribo-transcriber-ondevice`, adapters). Seams are defined in core; engines implement them.
- **No back-compat burden.** The SDK has no users; breaking changes are fine and migrations need no compatibility logic.
- **Every test must be able to fail.** Before finishing a task, break the implementation the test covers and confirm _that_ test goes red. Report which mutations you ran.
- **Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check` after every task; `./check.sh` before the final commit of the plan.
- **Whisper's window is 30 s at 16 kHz** — irrelevant here, but do not "helpfully" touch `ribo-transcriber-ondevice`. This plan is piece 1 of 2 and does not implement live transcription preview.

## File Structure

**Created:**

| File                                                | Responsibility                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/ribo-core/src/queue/capture-lock.ts`      | Web Locks wrapper: `ifAvailable` probing and the two-promise handshake     |
| `packages/ribo-core/src/queue/chunk-names.ts`       | Pure attachment naming/parsing and oversize slicing                        |
| `packages/ribo-core/src/queue/capture-session.ts`   | Ingestion→persistence pipeline, health, the session object                 |
| `packages/ribo-core/src/queue/recovery.ts`          | Startup discovery, merge, decode-verify, publish, sweep                    |
| `packages/ribo-ui-react/src/capture-coordinator.ts` | Observable registry so `useRecorder` and `useWorkSafety` share one session |

**Modified:** `queue/schema.ts`, `queue/outbox.ts`, `queue/database.ts`, `queue/relay.ts`, `work-safety.ts`, `recorder.ts`, `queue/index.ts`, `index.ts`, `ribo-ui-react/src/{context.ts,use-recorder.ts,use-work-safety.ts,index.ts}`, `playground/src/ItemAudio.tsx`.

**Why these boundaries:** `capture-lock` and `chunk-names` are pure and node-testable, which is where the fiddly logic goes. `capture-session` owns the one piece of genuinely stateful sequencing (ingest vs persist). `recovery` is separate because it runs at startup under a different owner and is the only code that reads another session's chunks.

---

## Task 1: Measure what a real browser does to a held Web Lock

The whole fencing design exists because **lock release and context death are not the same event** (spec §3.1). That claim is from documentation, not observation, and it decides how much of §3 is necessary. Measure it before building on it.

**Files:**

- Create: `spikes/web-locks-bfcache/README.md`
- Create: `spikes/web-locks-bfcache/index.html`

**Interfaces:**

- Consumes: nothing.
- Produces: a written answer in `README.md`. No production code.

- [ ] **Step 1: Write the probe page**

`spikes/web-locks-bfcache/index.html` — a page that takes a lock, records what happens to it across a bfcache round trip, and survives being restored:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Web Locks × bfcache</title>
<pre id="log"></pre>
<a href="https://example.com">navigate away, then press Back</a>
<script type="module">
  const log = (m) => {
    document.getElementById("log").textContent += `${m}\n`;
    // Survives the round trip so the restored page can print what it saw.
    sessionStorage.setItem("log", document.getElementById("log").textContent);
  };
  document.getElementById("log").textContent = sessionStorage.getItem("log") ?? "";

  let released = false;
  navigator.locks
    .request("spike", async () => {
      log(`acquired @ ${new Date().toISOString()}`);
      await new Promise(() => {}); // hold forever
    })
    .catch((e) => {
      released = true;
      log(`lock promise rejected: ${e.name}`);
    });

  addEventListener("pagehide", (e) => log(`pagehide persisted=${e.persisted}`));
  addEventListener("pageshow", async (e) => {
    log(`pageshow persisted=${e.persisted} rejectedSoFar=${released}`);
    // The question that matters: can a SECOND acquirer get it while we still exist?
    const got = await navigator.locks.request("spike", { ifAvailable: true }, (l) => l !== null);
    log(`second acquire while restored context is alive: ${got}`);
  });
</script>
```

- [ ] **Step 2: Run it in real Chromium and real Safari**

Serve it (`npx serve spikes/web-locks-bfcache`), open it, navigate away, press Back. Record for **each** browser: whether `pageshow` fired with `persisted=true`, whether the lock promise rejected, and whether a second acquire succeeded while the restored context was alive.

- [ ] **Step 3: Write down the answer**

`spikes/web-locks-bfcache/README.md` records, per browser and version: what was observed, and which of the three states in spec §3.1 it corresponds to (frozen-lock-held / destroyed / **bfcache-released-context-alive**).

State the consequence explicitly:

- If **no** browser releases the lock while the context survives → say so, and note that the `capture.owner` fence is defence against a documented-but-unobserved behaviour. **Keep it anyway** — it is cheap, and this measurement is a point-in-time observation of behaviour that has already changed once.
- If **any** browser does → the fence is load-bearing. Say which.

- [ ] **Step 4: Commit**

```bash
git add spikes/web-locks-bfcache
git commit -m "spike: measure Web Lock behaviour across bfcache in Chromium and Safari"
```

---

## Task 2: Schema — the `recording` status and three persisted fields

**Files:**

- Modify: `packages/ribo-core/src/queue/schema.ts`
- Modify: `packages/ribo-core/src/queue/database.ts`
- Modify: `packages/ribo-core/src/work-safety.ts`
- Test: `packages/ribo-core/src/queue/schema.test.ts`, `packages/ribo-core/src/work-safety.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `OutboxStatus` includes `"recording"`; `RECORDING_OUTBOX_STATUSES`; `OutboxDocument` gains `capture?: { sourceId: string; owner: string }`, `canonicalAttachmentId?: string`, `step?: { generation: string }`; `outboxRxSchema.version === 2`.

- [ ] **Step 1: Write the failing tests**

In `schema.test.ts`:

```ts
test("recording is a status, and it is in exactly one category", () => {
  expect(OUTBOX_STATUSES).toContain("recording");
  // The partition test already fails for a status in no bucket. This asserts the
  // membership DIRECTLY, because the behavioural relay test can pass even if
  // `recording` were wrongly added to the active set — some other guard might
  // still skip it.
  expect(ACTIVE_OUTBOX_STATUSES).not.toContain("recording");
  expect(FINISHED_OUTBOX_STATUSES).not.toContain("recording");
  expect(RECORDING_OUTBOX_STATUSES).toEqual(["recording"]);
});

test("a recording document must carry capture, and must not claim committed audio", () => {
  const base = validDocument();
  expect(() =>
    outboxDocumentSchema.parse({ ...base, status: "recording", capture: undefined }),
  ).toThrow();
  expect(() =>
    outboxDocumentSchema.parse({
      ...base,
      status: "recording",
      capture: { sourceId: "s1", owner: "o1" },
      canonicalAttachmentId: "audio-canonical-o1",
    }),
  ).toThrow();
});

test("a committed row must name its canonical attachment", () => {
  // Including the non-durable enqueue() path, which has no capture at all.
  expect(() =>
    outboxDocumentSchema.parse({ ...validDocument(), canonicalAttachmentId: undefined }),
  ).toThrow();
});
```

In `work-safety.test.ts`:

```ts
test("a recording in progress is pending work, never invisible", () => {
  // Without this, `recording` — correctly not in ACTIVE — falls through uncounted
  // and workSafety answers `safe` while the only copy of the audio is local.
  expect(summarizeWork([{ status: "recording" }])).toMatchObject({ pending: 1 });
});
```

- [ ] **Step 2: Run them and watch them fail**

```
pnpm vitest run --project unit packages/ribo-core/src/queue/schema.test.ts packages/ribo-core/src/work-safety.test.ts
```

Expected: FAIL — `recording` is not a status, `RECORDING_OUTBOX_STATUSES` is not exported.

- [ ] **Step 3: Add the status and its category**

In `schema.ts`, add `"recording"` as the **first** member of `OUTBOX_STATUSES` (it precedes `queued` in the lifecycle), and beside the existing category exports:

```ts
/**
 * In-flight capture. Its own category because it is neither: the relay must not
 * act on it (there is no committed audio yet — see `canonicalAttachmentId`), and
 * it is plainly not finished. The status-partition test fails for any status that
 * belongs to no named bucket, and naming this one is how that invariant is kept
 * rather than weakened.
 */
export const RECORDING_OUTBOX_STATUSES = ["recording"] as const;
```

- [ ] **Step 4: Add the three persisted fields with their invariants**

In `outboxDocumentSchema`, add the fields, then attach the conditional invariants with `.superRefine` — they are relationships between fields, so an optional-only schema would let a `recording` document parse while being unfenceable:

```ts
  /**
   * Capture identity, present while (and after) this row was recorded through the
   * durable path. TWO fields because they have opposite requirements: `sourceId`
   * names the chunk attachments and must NEVER change or recovery cannot find
   * them; `owner` authorises writes and MUST rotate on takeover or a restored tab
   * keeps writing. Conflating them made recovery delete the audio it was
   * recovering (design §3.1.1).
   */
  capture: z.object({ sourceId: z.string().min(1), owner: z.string().min(1) }).optional(),
  /**
   * WHICH attachment is the authoritative audio. Published only in the guarded
   * `recording → queued` transition, so a stale writer's bytes can land under
   * their own name and never become authoritative. Survives `dropAudio` — it is
   * still the answer to "which one WAS the real audio", which is why `audioReady`
   * is a separate, presence-based fact.
   */
  canonicalAttachmentId: z.string().min(1).optional(),
  /** Relay claim token, rotated on every claim and compared by every step write. */
  step: z.object({ generation: z.string().min(1) }).optional(),
```

```ts
.superRefine((doc, ctx) => {
  if (doc.status === "recording") {
    if (!doc.capture)
      ctx.addIssue({ code: "custom", message: "a recording row must carry capture" });
    if (doc.canonicalAttachmentId)
      ctx.addIssue({ code: "custom", message: "a recording row has committed nothing yet" });
  } else if (!doc.canonicalAttachmentId) {
    // Every non-recording row was created as playable — including via the
    // non-durable enqueue() path, which has no capture but still mints a pointer.
    ctx.addIssue({ code: "custom", message: "a committed row must name its canonical attachment" });
  }
});
```

Mirror all three fields in `outboxRxSchema.properties` (`capture` and `step` as `{ type: "object" }`, `canonicalAttachmentId` as `{ type: "string", maxLength: 128 }`) — the two descriptions are pinned field-for-field and drift is what the pinning exists to catch.

- [ ] **Step 5: Bump the schema version**

`outboxRxSchema.version: 2`, and in `database.ts`:

```ts
export const OUTBOX_MIGRATION_STRATEGIES = {
  1: (doc: OutboxDocument) => doc,
  // No users yet, so no compatibility logic is owed. RxDB simply requires a
  // strategy per version.
  2: (doc: OutboxDocument) => doc,
};
```

- [ ] **Step 6: Count `recording` as pending**

In `work-safety.ts`'s `summarizeWork`, add before the `ACTIVE` branch:

```ts
    // Pending, deliberately, even though the relay will not touch it: the audio
    // exists only on this device, so reporting it as no work at all would let
    // workSafety answer `safe` mid-recording — the one thing this module must
    // never do.
    if ((RECORDING_OUTBOX_STATUSES as readonly string[]).includes(status)) pending += 1;
    else if (...)
```

- [ ] **Step 7: Run the tests**

```
pnpm vitest run --project unit packages/ribo-core/src/queue/ packages/ribo-core/src/work-safety.test.ts
```

Expected: PASS.

- [ ] **Step 8: Mutate to prove the tests bite**

Remove `recording` from `RECORDING_OUTBOX_STATUSES`; the membership test must fail. Delete the `superRefine` block; both invariant tests must fail. Remove the `summarizeWork` branch; the pending test must fail. Restore all three, re-run, report what you saw.

- [ ] **Step 9: Commit**

```bash
git add packages/ribo-core/src
git commit -m "feat(core): add the recording status and durable-capture fields to the outbox schema"
```

---

## Task 3: `hasAudio` → `audioReady`, and `audioBytes` widens

**Files:**

- Modify: `packages/ribo-core/src/queue/schema.ts`, `packages/ribo-core/src/queue/outbox.ts`
- Modify: `playground/src/ItemAudio.tsx`
- Test: `packages/ribo-core/src/queue/outbox.browser.test.ts`

**Interfaces:**

- Consumes: `canonicalAttachmentId` from Task 2.
- Produces: `OutboxItem.audioReady: boolean`; `OutboxItem.audioBytes` = durable bytes on disk; `DERIVED_OUTBOX_ITEM_KEYS = ["audioBytes", "audioReady"]`.

- [ ] **Step 1: Write the failing tests** (browser tier — needs real attachments)

```ts
test("audioReady tracks the POINTED attachment, not the pointer", async () => {
  const item = await outbox.enqueue({ recording, audio });
  expect(item.audioReady).toBe(true);
  await outbox.dropAudio(item.id);
  const after = await outbox.get(item.id);
  // dropAudio removes the attachment and leaves the pointer — the pointer records
  // WHICH attachment was authoritative and is still true after deletion. Reading
  // audioReady off pointer presence would report deleted audio as playable.
  expect(after!.canonicalAttachmentId).toBeDefined();
  expect(after!.audioReady).toBe(false);
  expect(after!.audioBytes).toBe(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

```
pnpm vitest run --project browser packages/ribo-core/src/queue/outbox.browser.test.ts
```

Expected: FAIL — `audioReady` is not a property.

- [ ] **Step 3: Rename the derived key and reproject**

In `schema.ts`: `DERIVED_OUTBOX_ITEM_KEYS = ["audioBytes", "audioReady"] as const`, and in `outboxItemSchema` replace `hasAudio` with:

```ts
  /** Whether the attachment named by `canonicalAttachmentId` exists **right now**. */
  audioReady: z.boolean(),
  /** Durable bytes on disk for this item: the canonical attachment, or the
   * accumulated chunks while still recording. `0` when there are neither. */
  audioBytes: z.number().int().nonnegative(),
```

In `outbox.ts`'s projection (currently reading `AUDIO_ATTACHMENT_ID` directly):

```ts
const canonical = doc.canonicalAttachmentId ? doc.getAttachment(doc.canonicalAttachmentId) : null;
// While recording there is no canonical yet, but the chunks ARE durable — so a
// UI can show capture progressing instead of reporting nothing, and cannot
// mistake "not yet" for "the bytes were dropped".
const chunkBytes = doc.capture
  ? doc
      .allAttachments()
      .filter((a) => a.id.startsWith(chunkPrefix(doc.capture!.sourceId)))
      .reduce((total, a) => total + a.length, 0)
  : 0;
return outboxItemSchema.parse({
  ...doc.toJSON(),
  audioReady: canonical !== null,
  audioBytes: canonical?.length ?? chunkBytes,
});
```

`getAudio(id)` resolves `canonicalAttachmentId` instead of the constant; if the pointer is absent it returns `undefined`.

- [ ] **Step 4: Update the playground consumer**

`ItemAudio.tsx` reads `hasAudio`; rename to `audioReady`. Its "the bytes were dropped" copy is now only reachable for a genuinely dropped recording, which is what it always meant — but a `recording` row must not render it, so branch on `status === "recording"` first and show capture progress from `audioBytes`.

- [ ] **Step 5: Run the tests** — `pnpm vitest run --project browser packages/ribo-core/src/queue/` — Expected: PASS.

- [ ] **Step 6: Mutate**

Change the projection to `audioReady: doc.canonicalAttachmentId != null`. The drop test must fail. Restore, re-run, report.

- [ ] **Step 7: Commit**

```bash
git add packages/ribo-core/src playground/src
git commit -m "feat(core)!: rename hasAudio to audioReady and widen audioBytes to durable bytes"
```

---

## Task 4: The capture lock

**Files:**

- Create: `packages/ribo-core/src/queue/capture-lock.ts`
- Test: `packages/ribo-core/src/queue/capture-lock.browser.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `CAPTURE_LOCK`, `RELAY_LOCK`, `holdLock(name, run): Promise<{ ready: Promise<T>; release: () => void } | undefined>`, `isLockFree(name): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** (browser tier — `navigator.locks` needs a real browser)

```ts
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
```

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project browser packages/ribo-core/src/queue/capture-lock.browser.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * @file Cross-tab exclusion for capture and relay work, on the Web Locks API.
 *
 * Chosen over a hand-rolled lease because the question a lease cannot answer —
 * *is that other tab dead, or merely suspended?* — is one the browser answers
 * authoritatively: a suspended tab keeps its lock, a destroyed one's is released.
 * Baseline Widely Available since 2024-09-14, comfortably inside this project's
 * browser floor.
 *
 * **This is exclusion, not authorisation.** A lock can be released while its
 * holder's JavaScript context survives (bfcache), so it cannot fence writes.
 * That is `capture.owner`'s job — see the design's §3.1.
 */
export const CAPTURE_LOCK = "ribo-capture";
export const RELAY_LOCK = "ribo-relay";

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
      // Letting it escape would reject the lock promise itself, which says nothing
      // useful and produces an unhandled rejection.
      return ready.then(
        () => undefined,
        () => undefined,
      );
    })
    .catch(() => entered(undefined as never));

  return acquired;
}

/** Whether `name` could be taken right now. Used to tell an abandoned recording
 * from a live one without any clock comparison. */
export async function isLockFree(
  name: string,
  locks: LockManager = navigator.locks,
): Promise<boolean> {
  return (await locks.request(name, { ifAvailable: true }, (lock) => lock !== null)) as boolean;
}
```

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Mutate**

Change `{ ifAvailable: true }` to `{}` in `holdLock`. The barrier test must fail (the second request queues instead of being refused). Resolve `entered` _after_ `await run()` instead of before; the handshake test must hang or fail. Restore both, re-run, report.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-core/src/queue/capture-lock.ts packages/ribo-core/src/queue/capture-lock.browser.test.ts
git commit -m "feat(core): add Web Locks based capture and relay exclusion"
```

---

## Task 5: Attachment naming and oversize slicing

**Files:**

- Create: `packages/ribo-core/src/queue/chunk-names.ts`
- Test: `packages/ribo-core/src/queue/chunk-names.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `chunkPrefix(sourceId)`, `chunkName(sourceId, chunkIndex, sliceIndex)`, `canonicalName(owner)`, `isChunkOf(id, sourceId)`, `isCanonical(id)`, `sliceOversized(blob, mimeType, max)`, `MAX_CHUNK_INDEX`, `MAX_SLICE_INDEX`.

- [ ] **Step 1: Write the failing tests**

```ts
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

test("chunks of one source are distinguishable from another's and from canonicals", () => {
  expect(isChunkOf(chunkName("abc", 1, 0), "abc")).toBe(true);
  expect(isChunkOf(chunkName("abc", 1, 0), "abd")).toBe(false);
  expect(isChunkOf(canonicalName("o1"), "abc")).toBe(false);
  expect(isCanonical(canonicalName("o1"))).toBe(true);
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

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project unit packages/ribo-core/src/queue/chunk-names.test.ts`

- [ ] **Step 3: Implement**

```ts
/**
 * @file Attachment names for durable capture, and the slicing of oversized events.
 *
 * Chunks are named from the recording's IMMUTABLE `capture.sourceId`, never from
 * its rotating `owner`: recovery must find every chunk of a recording however
 * many times ownership changed, and naming them by owner made recovery orphan
 * the audio it was recovering.
 *
 * Canonical attachments ARE owner-scoped, so a stale writer cannot overwrite a
 * published one — authority comes from the `canonicalAttachmentId` pointer.
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

export const canonicalName = (owner: string): string => `audio-canonical-${owner}`;
export const isChunkOf = (id: string, sourceId: string): boolean =>
  id.startsWith(chunkPrefix(sourceId));
export const isCanonical = (id: string): boolean => id.startsWith("audio-canonical-");

/**
 * Split a blob larger than `max` into ordered parts.
 *
 * A timeslice does not bound chunk size: a Chrome desktop sleep/wake has been
 * measured producing 23 MB in one event, and 20 minutes of screen-locked Chrome
 * Android producing 15 MB. Writing that as one attachment is a long transaction
 * at the worst possible moment. Byte-slicing is safe for container framing —
 * concatenating the parts in order reproduces the original exactly.
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

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-core/src/queue/chunk-names.ts packages/ribo-core/src/queue/chunk-names.test.ts
git commit -m "feat(core): add durable-capture attachment naming and oversize slicing"
```

---

## Task 6: Guarded outbox writes for capture

**Files:**

- Modify: `packages/ribo-core/src/queue/outbox.ts`
- Test: `packages/ribo-core/src/queue/outbox.browser.test.ts`

**Interfaces:**

- Consumes: Tasks 2, 3, 5.
- Produces: `beginRecording({ recording, sourceId, owner }): Promise<OutboxItem>`, `appendChunk(id, owner, name, blob, mimeType): Promise<void>`, `rotateOwner(id, owner): Promise<string>`, `commitRecording(id, owner, { canonicalAttachmentId, durationMs }): Promise<OutboxItem>`, `sweepAttachments(id): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a write from a superseded owner is rejected — as a real race, not a pre-check", async () => {
  const item = await outbox.beginRecording({ recording, sourceId: "s1", owner: "o1" });
  // Setting the owner and THEN calling the writer would pass a non-atomic
  // pre-flight check. The race is what matters: begin the write, take over while
  // it is in flight, then let it land.
  const inFlight = outbox.appendChunk(item.id, "o1", chunkName("s1", 0, 0), blob, "audio/webm");
  await outbox.rotateOwner(item.id, "o2");
  await expect(inFlight).rejects.toThrow(/owner/i);
  const after = await outbox.get(item.id);
  expect(after!.audioBytes).toBe(0);
});

test("owner equality alone is not enough once the row has committed", async () => {
  const item = await outbox.beginRecording({ recording, sourceId: "s1", owner: "o1" });
  await outbox.commitRecording(item.id, "o1", {
    canonicalAttachmentId: canonicalName("o1"),
    durationMs: 1000,
  });
  // Same owner, but the row is no longer `recording`. A check on owner alone
  // would let this land on a committed item.
  await expect(
    outbox.appendChunk(item.id, "o1", chunkName("s1", 1, 0), blob, "audio/webm"),
  ).rejects.toThrow(/status/i);
});

test("the sweep removes every chunk and every unpointed canonical", async () => {
  // A stale canonical is a WHOLE RECORDING; leaving it is a quota and retention
  // leak, not untidiness.
  const item = await outbox.beginRecording({ recording, sourceId: "s1", owner: "o1" });
  await outbox.appendChunk(item.id, "o1", chunkName("s1", 0, 0), blob, "audio/webm");
  await putRaw(item.id, canonicalName("stale"), blob);
  await outbox.commitRecording(item.id, "o1", {
    canonicalAttachmentId: canonicalName("o1"),
    durationMs: 1000,
  });
  await outbox.sweepAttachments(item.id);
  const names = await attachmentIdsOf(item.id);
  expect(names).toEqual([canonicalName("o1")]);
});
```

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project browser packages/ribo-core/src/queue/outbox.browser.test.ts`

- [ ] **Step 3: Implement the guard and the methods**

```ts
  /**
   * Assert this write is still authorised, atomically with performing it.
   *
   * Both facts are compared, not just the owner: after the row reaches `queued`
   * the original owner is still recorded, so an owner-only check would let a
   * restored recorder write onto a committed item.
   */
  async #guarded(id: string, owner: string, change: (doc: OutboxDocument) => OutboxDocument) {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    return doc.incrementalModify((data) => {
      if (data.status !== "recording")
        throw new Error(`outbox: ${id} is ${data.status}, not recording — write refused`);
      if (data.capture?.owner !== owner)
        throw new Error(`outbox: owner ${owner} no longer holds ${id} — write refused`);
      return change(data);
    });
  }
```

`beginRecording` inserts a row with `status: "recording"`, `durationMs: 0`, `capturedAt` = capture **start**, and `capture: { sourceId, owner }`.

`rotateOwner(id, owner)` mints a new owner and installs it through a modify that re-checks `status === "recording"` — recovery's **first** operation, and the thing that makes the fence work at all.

`appendChunk` runs `#guarded` as a **pre-check that throws on mismatch**, and only then calls `putAttachment`. RxDB gives no way to compare a field inside an attachment write, which is exactly why a stale write must be _inert_ rather than _prevented_ — the naming from Task 5 is what makes it so. The guard still runs because it turns the common case into a clean rejection instead of a silent orphan.

`commitRecording` publishes `canonicalAttachmentId`, writes `durationMs`, and sets `status: "queued"` in **one** guarded modify.

`sweepAttachments(id)` removes every `isChunkOf(name, sourceId)` and every `isCanonical(name)` that is not `canonicalAttachmentId`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Drop the `status !== "recording"` clause from `#guarded`; the committed-row test must fail. Make the sweep skip canonicals; the sweep test must fail. Restore, re-run, report.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-core/src/queue
git commit -m "feat(core): add owner-guarded outbox writes for durable capture"
```

---

## Task 7: The capture session

**Files:**

- Create: `packages/ribo-core/src/queue/capture-session.ts`
- Test: `packages/ribo-core/src/queue/capture-session.test.ts`

**Interfaces:**

- Consumes: Tasks 4, 5, 6.
- Produces: `openCaptureSession({ outbox, recording, mimeType, now })`, and on it: `ingest(blob)`, `finalize(): Promise<{ chunkNames: string[] }>`, `abort()`, `itemId`, `sourceId`, `owner`, `health$`, `CaptureHealth = "flushing" | "stalled"`.

- [ ] **Step 1: Write the failing tests** (node — `ingest` takes blobs, no browser needed with a fake outbox)

```ts
test("ingestion is synchronous and persistence is a separate stage", async () => {
  // ONE queue deadlocks: a chunk op that detects a write failure must finalize,
  // but the final dataavailable may already be queued BEHIND it — so awaiting
  // finalization waits on an operation that waits on it.
  const session = openCaptureSession({ outbox: slowFake, recording, mimeType: "audio/webm", now });
  session.ingest(blobOf(10));
  session.ingest(blobOf(10));
  const done = session.finalize(); // must not hang
  await expect(done).resolves.toMatchObject({ chunkNames: expect.any(Array) });
});

test("finalize drains everything ingested before it", async () => {
  const session = openCaptureSession({ outbox: fake, recording, mimeType: "audio/webm", now });
  session.ingest(blobOf(10));
  session.ingest(blobOf(10));
  const { chunkNames } = await session.finalize();
  expect(chunkNames).toHaveLength(2); // the last chunk is not dropped
});

test("a stall is observed even when the late event arrives before the detector runs", async () => {
  // The detector is frozen alongside the page it watches, so a timer cannot fire
  // while backgrounded. The dataavailable handler must compute now - lastEmission
  // BEFORE updating it, or the stall is never seen at all.
  const clock = fakeClock();
  const session = openCaptureSession({
    outbox: fake,
    recording,
    mimeType: "audio/webm",
    now: clock.now,
  });
  session.ingest(blobOf(10));
  clock.advance(60_000);
  session.ingest(blobOf(10)); // the late event
  expect(await firstValueFrom(session.health$)).toBe("stalled");
});

test("a user pause is not a stall", async () => {
  const clock = fakeClock();
  const session = openCaptureSession({
    outbox: fake,
    recording,
    mimeType: "audio/webm",
    now: clock.now,
  });
  session.ingest(blobOf(10));
  clock.advance(60_000);
  session.resumed(); // user-initiated Recorder.resume()
  session.ingest(blobOf(10));
  expect(await firstValueFrom(session.health$)).toBe("flushing");
});
```

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project unit packages/ribo-core/src/queue/capture-session.test.ts`

- [ ] **Step 3: Implement**

Two stages, deliberately:

```ts
  /**
   * Ingestion is SYNCHRONOUS: it appends to an ordered buffer and returns.
   * Persistence drains that buffer separately. One queue would deadlock — a chunk
   * operation that detects a write failure must finalize, and the final
   * `dataavailable` may already be queued behind it.
   */
  ingest(blob: Blob): void {
    const gap = this.#now() - this.#lastEmission;
    // BEFORE updating the timestamp: a late event must detect the interval it
    // missed, or a stall that only becomes observable on resume is never seen.
    if (!this.#baselineReset && gap > STALL_AFTER_MS) this.#latchStalled();
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
```

`finalize()` closes ingestion, drains what remains, then returns the chunk names. Health latches into `stalled` for `STALL_LATCH_MS` and clears only after emission has been healthy that long — without a clearing rule the value either never surfaces or never clears.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Move the gap computation to after `this.#lastEmission = this.#now()`; the late-event stall test must fail. Make `finalize()` await the buffer through the same queue that `ingest` writes to; the deadlock test must hang. Make `resumed()` a no-op; the pause test must fail. Restore all three, re-run, report.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-core/src/queue/capture-session.ts packages/ribo-core/src/queue/capture-session.test.ts
git commit -m "feat(core): add the capture session with split ingestion and persistence"
```

---

## Task 8: Recovery and startup discovery

**Files:**

- Create: `packages/ribo-core/src/queue/recovery.ts`
- Test: `packages/ribo-core/src/queue/recovery.browser.test.ts`

**Interfaces:**

- Consumes: Tasks 4, 5, 6.
- Produces: `recoverInterrupted({ outbox, decode, onRecovered }): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("recovery finds the chunks AFTER rotating the owner", async () => {
  // THE regression test. Rotation must happen first (or the fence is inert), and
  // chunks are named by the IMMUTABLE sourceId (or rotation orphans them). An
  // implementation that names chunks by owner recovers zero bytes and sweeps the
  // real audio.
  const id = await plantInterruptedRecording({ sourceId: "s1", owner: "o1", chunks: 3 });
  const recovered = await recoverInterrupted({ outbox, decode: okDecode, onRecovered: noop });
  expect(recovered).toEqual([id]);
  const item = await outbox.get(id);
  expect(item!.status).toBe("queued");
  expect(item!.audioReady).toBe(true);
  expect(item!.audioBytes).toBeGreaterThan(0);
});

test("a stale canonical write in flight ACROSS the commit cannot become authoritative", async () => {
  const id = await plantInterruptedRecording({ sourceId: "s1", owner: "o1", chunks: 2 });
  const stale = putRaw(id, canonicalName("o1"), garbageBlob); // begun before takeover
  await recoverInterrupted({ outbox, decode: okDecode, onRecovered: noop });
  await stale; // lands after
  const item = await outbox.get(id);
  // The pointer names the VERIFIED attachment, so the stale bytes are inert.
  expect(item!.canonicalAttachmentId).not.toBe(canonicalName("o1"));
  expect(await outbox.getAudio(id)).not.toBe(garbageBlob);
});

test("audio that will not decode stays recoverable rather than being committed", async () => {
  const id = await plantInterruptedRecording({ sourceId: "s1", owner: "o1", chunks: 2 });
  await recoverInterrupted({ outbox, decode: alwaysFails, onRecovered: noop });
  const item = await outbox.get(id);
  expect(item!.status).toBe("recording"); // not queued
  expect(item!.lastError).toMatch(/unrecoverable/i);
  expect(await attachmentIdsOf(id)).toHaveLength(2); // chunks intact, not swept
});

test("a truncated final chunk recovers by dropping it", async () => {
  const id = await plantInterruptedRecording({
    sourceId: "s1",
    owner: "o1",
    chunks: 3,
    truncateLast: true,
  });
  await recoverInterrupted({ outbox, decode: failsUnlessLastDropped, onRecovered: noop });
  expect((await outbox.get(id))!.status).toBe("queued");
});
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Order matters and is the design's §4:

1. `isLockFree(CAPTURE_LOCK)` — if not, a live session owns it; do nothing.
2. Inside `holdLock(CAPTURE_LOCK, …)`, for each `status === "recording"` row: **rotate the owner first**.
3. Take the chunk inventory by `capture.sourceId`, merge in name order, `decode`-verify; on failure retry without the last chunk; on repeated failure set `lastError` and leave the row `recording` with chunks intact.
4. Write `canonicalName(newOwner)`, then `commitRecording` — publishing the pointer and the status in one modify.
5. `sweepAttachments`.
6. Also sweep any **non-`recording`** row carrying leftover chunks or unpointed canonicals — not just `queued`, because a recovered row can be advanced past `queued` by another tab before its sweep runs.
7. Call `onRecovered` so the caller can `syncNow()`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Rotate the owner _after_ taking the chunk inventory, and change the inventory to read by `owner` instead of `sourceId` — the first test must fail with zero recovered bytes. Restrict the sweep to `queued` rows only and advance a row to `transcribing` in the fixture; the leftover-attachment assertion must fail. Restore, re-run, report.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-core/src/queue/recovery.ts packages/ribo-core/src/queue/recovery.browser.test.ts
git commit -m "feat(core): recover interrupted recordings with decode verification"
```

---

## Task 9: Recorder integration

**Files:**

- Modify: `packages/ribo-core/src/recorder.ts`
- Test: `packages/ribo-core/src/recorder.browser.test.ts`

**Interfaces:**

- Consumes: Task 7 (`CaptureSession`).
- Produces: `RecorderOptions.captureSession?: CaptureSessionFactory`; `Recorder.start(): Promise<string | undefined>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("start refuses when another tab holds the lock, WITHOUT prompting for the microphone", async () => {
  // Refusing before the microphone matters: the recording indicator must not
  // light on the way to throwing.
  const getUserMedia = vi.fn();
  await holdLock(CAPTURE_LOCK, () => new Promise(() => {}));
  const recorder = new Recorder({ media: { getUserMedia }, captureSession: factory });
  await expect(recorder.start()).rejects.toThrow(/another tab|busy/i);
  expect(getUserMedia).not.toHaveBeenCalled();
});

test("MIME is chosen before the microphone and read back after construction", async () => {
  // Already true today and must stay: negotiate first so an unsupported container
  // fails without prompting, then read what the LIVE recorder reports, which may
  // differ from what was requested.
  const recorder = new Recorder({ mimeTypes: ["audio/nope"], captureSession: factory });
  await expect(recorder.start()).rejects.toThrow(/unsupported-mime-type/);
  expect(getUserMedia).not.toHaveBeenCalled();
});

test("a failure after the row is created unwinds it and releases the lock", async () => {
  const recorder = new Recorder({ captureSession: factoryThatFailsOnStart });
  await expect(recorder.start()).rejects.toThrow();
  expect(await isLockFree(CAPTURE_LOCK)).toBe(true); // or one refusal locks capture out
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

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement the ordering**

`start()` becomes, in this order — and note steps 2 and 5 are **already** how the recorder behaves, so this preserves rather than changes them:

1. `holdLock(CAPTURE_LOCK, …)`; `undefined` → throw `RecorderError("capture-busy", …)`.
2. `negotiateMimeType(this.#mimeTypes)` — before the microphone.
3. `#openMicrophone()`.
4. `#beginSession(stream, mimeType)` — constructs `MediaRecorder`.
5. Read `session.recorder.mimeType` — the live, negotiated value.
6. `captureSession.open({ recording, mimeType })` → inserts the `recording` row; returns the item id.
7. `session.recorder.start(TIMESLICE_MS)` and wire `dataavailable` to `captureSession.ingest`.

Every failure unwinds the steps before it through the existing `#teardown`, then releases the lock by resolving the held callback. If the unwind itself fails, leave the row: startup discovery (Task 8) collects it, and there is nothing stale to force-clear because the lock releases with the context.

`stop()` awaits `captureSession.finalize()` before merging, so the persistence chain has settled.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Move `negotiateMimeType` after `#openMicrophone`; the no-prompt test must fail. Remove the lock release from the failure path; the unwind test must fail. Restore, re-run, report.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-core/src/recorder.ts packages/ribo-core/src/recorder.browser.test.ts
git commit -m "feat(core)!: acquire the capture lock and persist chunks during recording"
```

---

## Task 10: Capture health in `workSafety`

**Files:**

- Modify: `packages/ribo-core/src/work-safety.ts`
- Test: `packages/ribo-core/src/work-safety.test.ts`

**Interfaces:**

- Consumes: Task 7 (`CaptureHealth`).
- Produces: `workSafety(work, persistence, connectivity, capture?)`; new reasons `"recording"` (on `protected`) and `"capture-stalled"` (on `at-risk`).

- [ ] **Step 1: Write the failing tests**

```ts
test("healthy recording is protected, with a reason that names the unflushed tail", () => {
  // NOT at-risk. A warning that fires on every single recording is noise that
  // teaches the user to ignore the one time it matters, and the question this
  // module answers is "is the work I have already DONE safe?".
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
  // persistence. The new reasons slot INTO that order; they do not redefine it.
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

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Add the optional fourth parameter and the two union members. Insert `capture-stalled` **inside** the existing `at-risk` tier (after the `dead` check, alongside `not-persisted`), and `recording` as a `protected` reason. Do not touch the tier order.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Move the `capture-stalled` check above the `dead` check; the precedence test must fail. Restore, re-run, report.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-core/src/work-safety.ts packages/ribo-core/src/work-safety.test.ts
git commit -m "feat(core): report capture health through workSafety"
```

---

## Task 11: The capture coordinator and React wiring

**Files:**

- Create: `packages/ribo-ui-react/src/capture-coordinator.ts`
- Modify: `packages/ribo-ui-react/src/{context.ts,use-recorder.ts,use-work-safety.ts,index.ts}`
- Test: `packages/ribo-ui-react/src/capture-coordinator.browser.test.tsx`

**Interfaces:**

- Consumes: Tasks 7, 10.
- Produces: `createCaptureCoordinator()`; `RiboInstances.captureCoordinator?: CaptureCoordinator`; `useRecorder().start(): Promise<string | undefined>`.

- [ ] **Step 1: Write the failing tests**

```ts
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

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

```ts
/**
 * The shared handle through which `useRecorder` publishes the active capture
 * session and `useWorkSafety` reads its health.
 *
 * It exists because a session created inside one hook cannot reach a sibling:
 * `RiboProvider` passes the host's instance object through unchanged and
 * deliberately constructs nothing, so mutating that object notifies nobody.
 *
 * **The host constructs it**, like every other instance, rather than the provider
 * creating one silently — a provider whose behaviour depended on whether a field
 * was passed would be the surprising option. It is OPTIONAL: absent, there is no
 * durable capture and no capture health, and `useWorkSafety` behaves as it does
 * today.
 */
export interface CaptureCoordinator {
  register(session: CaptureSession): () => void;
  active(): CaptureSession | undefined;
  readonly health$: Observable<CaptureHealth | undefined>;
}
```

Both hooks read the coordinator **from context** even when `recorder`/`outbox` are passed explicitly, so overriding one instance does not silently lose health reporting.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Make `useWorkSafety` read the coordinator from its own arguments rather than context; the sibling test must fail. Skip unregistering on a failed start; the second test must fail. Restore, re-run, report.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-ui-react/src
git commit -m "feat(ui-react): share the active capture session through a coordinator"
```

---

## Task 12: Relay claim and hand-off

**Files:**

- Modify: `packages/ribo-core/src/queue/relay.ts`, `packages/ribo-core/src/queue/outbox.ts`
- Test: `packages/ribo-core/src/queue/relay.browser.test.ts`

**Interfaces:**

- Consumes: Tasks 2, 4, 8.
- Produces: `Outbox.claimStep(id, observedGeneration): Promise<string | undefined>`; the relay drains under `RELAY_LOCK` and subscribes to the outbox.

- [ ] **Step 1: Write the failing tests**

```ts
test("a relay frozen between select and claim cannot steal the item back", async () => {
  // Selection is a plain query today. A relay frozen AFTER nextPending returns but
  // BEFORE it claims can resume, perform its delayed claim, and take an item a
  // successor already advanced.
  const item = await outbox.nextPending();
  const observed = item!.step?.generation;
  await outbox.claimStep(item!.id, observed); // successor claims
  await outbox.patch(item!.id, { status: "awaiting-review" });
  // The frozen predecessor finally claims, with the generation it saw at selection.
  await expect(outbox.claimStep(item!.id, observed)).resolves.toBeUndefined(); // claim LOST, not an error
});

test("a stale step result cannot regress a finished item", async () => {
  const item = await outbox.nextPending();
  const stale = item!.step!.generation;
  await outbox.claimStep(item!.id, stale);
  await outbox.patch(item!.id, { status: "awaiting-review" });
  await expect(outbox.completeStep(item!.id, stale, { status: "extracting" })).rejects.toThrow(
    /generation/i,
  );
  expect((await outbox.get(item!.id))!.status).toBe("awaiting-review");
});

test("a stale FAILURE cannot overwrite a completed step", async () => {
  const item = await outbox.nextPending();
  const stale = item!.step!.generation;
  await outbox.claimStep(item!.id, stale);
  await outbox.patch(item!.id, { status: "done" });
  await expect(outbox.failStep(item!.id, stale, "boom")).rejects.toThrow(/generation/i);
  expect((await outbox.get(item!.id))!.status).toBe("done");
});

test("a recovered item drains even though the recovering tab died before syncNow", async () => {
  // No manual, startup, or connectivity trigger after recovery — only the
  // subscription. The relay has no timer and does not otherwise watch the outbox.
  const relay = createRelay({ outbox, transcriber, extractor, writer });
  await relay.start();
  await drainToEmpty(relay);
  await plantRecoveredQueuedItem(outbox); // as if another tab recovered it
  await waitFor(async () => expect((await outbox.get(id))!.status).not.toBe("queued"));
});
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

`claimStep(id, observedGeneration)` is a guarded `incrementalModify` that compares the generation **and** re-derives eligibility from the current revision before rotating. Mismatch resolves `undefined` — _claim lost_, which is not a step failure and must not consume an attempt.

`completeStep` / `failStep` compare the generation and reject on mismatch.

The relay drains inside `holdLock(RELAY_LOCK, …)`, and subscribes to `outbox.watch()` on **eligibility edges** — not every emission, since the relay itself produces several active-to-active writes per item — coalescing "drain requested while draining" into at most one follow-up. Keep a separate unsubscribe handle from the connectivity one.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Mutate**

Make `claimStep` rotate unconditionally without comparing; the steal-back test must fail. Remove the generation check from `failStep`; the stale-failure test must fail. Call `syncNow()` on every `watch()` emission rather than on edges; assert the drain count in the hand-off test and watch it balloon. Restore, re-run, report.

- [ ] **Step 6: Run the full gate**

```
./check.sh
```

Expected: PASS — typecheck, lint, format:check, build:packages, resolve, build:app, pkg:gates, and all three Vitest projects.

- [ ] **Step 7: Add a changeset**

```bash
pnpm changeset
```

`@azx/ribo-core` **major**, `@azx/ribo-ui-react` **major**. These are breaking: `OutboxStatus` grows a member consumers may switch on exhaustively, `hasAudio` is renamed to `audioReady`, `Recorder.start()` returns an id, and `RiboInstances` gains a field. Say so plainly rather than describing it as additive. Include the §1.2 durability limitation: **each flushed chunk is safe; emission can stall for as long as the app is backgrounded.**

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat(core)!: fence relay steps with a claim generation and drain on outbox edges"
```

---

## Self-review notes

**Spec coverage.** §1 → Tasks 5, 7, 9. §1.1 → Task 5. §1.2 → Tasks 7, 10 (and the changeset). §2 → Task 2. §3, §3.1–3.1.3 → Tasks 4, 6, 8. §3.2 → Tasks 4, 9. §3.3 → Task 7 (`resumed()`), Task 9 (unwind). §4, §4.1 → Task 8. §5, §5.1 → Tasks 6, 9, 11. §6.1 → Tasks 7, 10, 11. §6.2 → Task 3. §7 → Task 2. §8, §8.1, §8.2 → Tasks 8, 12. §9 → Task 12's changeset. §10 → distributed across every task's mutation step.

**Deliberately not covered, and why:**

- **The restored-context `pagehide`/`pageshow` seam** (spec §3.3) is specified but has **no task**, because Task 1 decides whether it is needed. If the spike shows no engine releases a lock while the context survives, the revalidation path is dead code guarding an unobservable state and should not be built on speculation. **If the spike shows any engine does, add a task after Task 9** wiring the lifecycle seam and gating the first post-resume operation on revalidation. The `capture.owner` fence is built either way — it is cheap, and it is what makes being wrong here safe.
- **MP4 chunk recovery** cannot be verified in this harness (Playwright is Chromium). Task 8's tests prove WebM. The failure is honest — an undecodable merge leaves the row recoverable — but the Safari success rate is unknown.
- **The emission-stall threshold** (`STALL_AFTER_MS`) needs a real backgrounded device to choose well. Task 7 uses a placeholder constant with a comment saying so; tune it after measuring, not before.

**One risk worth naming to whoever executes this.** Task 6's `appendChunk` guard is a **pre-check, not an atomic fence** — RxDB exposes no way to compare a document field inside an attachment write. That is why Task 5's owner-scoped naming exists: the safety property is that a stale write is _inert_, not that it is _prevented_. If you find yourself "fixing" the guard to be atomic, read the design's §3.1.2 first — three revisions tried and the API does not permit it.
