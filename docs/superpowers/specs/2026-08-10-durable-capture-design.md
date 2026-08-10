# Durable capture — audio survives a crash mid-recording

**Status:** Design, revision 8. Piece 1 of 2. Not yet planned or implemented.
**Date:** 2026-08-10

> **Why this document exists.** Split out of `2026-08-08-live-transcription-design.md` after two review
> rounds on that combined design failed to converge. Every critical finding in both rounds landed in
> durability and ownership, none in the live preview itself. This piece ships on its own merits; live
> preview (piece 2) builds on it.
>
> **Revision 3 replaces hand-rolled coordination with the Web Locks API**, after the observation that
> this problem has surely been solved before. It had. Revisions 1 and 2 built a lease, a heartbeat, a
> staleness threshold and a fencing token to answer _"is that other tab dead or merely asleep?"_ — a
> question `navigator.locks` never has to ask, because the browser owns tab lifetime. That deleted the
> lock document, the leader-election plugin, the fencing token, the persisted `capture` field, and with
> it the schema migration.
>
> Research also produced a **worse durability fact than any review found** (§1.2): on a backgrounded
> phone, `dataavailable` stops firing entirely. Incremental persistence does not protect the period that
> matters most. The design still helps, but the claim had to change.
>
> **Revision 4 restores a write fence, because revision 3's central inference was wrong.** It assumed a
> Web Lock is held exactly as long as the holder's JavaScript context lives, and therefore that no other
> context could ever write concurrently. **Lock release and context death are not equivalent** — see
> §3.1. Web Locks remain the mechanism for acquisition, exclusion and crash detection, where they are
> far better than a hand-rolled lease; they are **not** sufficient for fencing writes. The heartbeat,
> the staleness threshold and the recovery-lease renewal stay deleted; a single owner token returns.
> Revision 4 also fixes a recovery hand-off that could strand an item, coordinates the relay across
> tabs, and defines resume ordering for the emission-stall detector.

## The problem

Audio only becomes durable at `stop()`. `MediaRecorder` accumulates chunks in memory, `stop()` assembles
one `Blob`, and `enqueue` writes document and Blob in a single storage transaction. Kill the tab, or
crash the renderer at minute four of a five-minute walkthrough, and **the entire recording is gone** —
there was never anything on disk.

For a field app whose premise is that an auditor drove to a house to make this recording, that is the
most expensive failure available.

## Scope

**In:** audio persisted incrementally during capture; a recording lifecycle the outbox can represent;
single-recorder exclusion and crash recovery via Web Locks; recovery that verifies before it commits;
honest work-safety and `audioReady` reporting.

**Out:** the live transcription preview, the `AudioWorklet` PCM tap, the `LiveTranscriber` seam, rolling
VAD, and worker contention. All piece 2. Nothing here mentions transcription except where recovery hands
an item to the existing relay.

## 1. Incremental persistence

`MediaRecorder.start(timeslice)` at **5 seconds**. Each `dataavailable` writes one RxDB attachment,
zero-padded so lexical order is chronological:

```
audio-chunk-0000, audio-chunk-0001, … ─► (at commit) merge ─► AUDIO_ATTACHMENT_ID, chunks deleted
```

Per-chunk rather than rewriting one growing attachment: RxDB attachments are not appendable, so rewriting
a growing Blob every 5 seconds is quadratic I/O where N chunks merged once is linear.

**`stop()` must await outstanding chunk writes.** `dataavailable` is currently synchronous bookkeeping
into an in-memory array, and `MediaRecorder`'s `stop` event guarantees the final handler _fired_, not that
an async IndexedDB write it started has committed. The session keeps a persistence chain that `stop()`
awaits before merging. Without it the merge can silently omit the last chunk.

### 1.1 Oversized chunks must be sliced before writing

A `timeslice` chunk is not bounded by the timeslice. Documented in production by a vendor who does this
commercially: a Chrome desktop sleep/wake produced a **23 MB** chunk; twenty minutes of Chrome Android
with the screen locked produced **15 MB** in one event.

Writing a 23 MB Blob as a single attachment is a long transaction at exactly the worst moment. Chunks
above a threshold are therefore **`Blob.slice()`d into several attachments** before writing — the same
mitigation that vendor adopted.

Byte-slicing is safe for container framing: concatenating the slices in byte order reproduces the
original exactly, for WebM and MP4 alike. Two details that are not free, though:

- **`Blob.slice()` returns an empty `type` unless one is supplied**, and RxDB requires a non-empty
  attachment content type — `enqueue` already carries a fallback for exactly this reason. Each slice must
  be given the negotiated MIME type explicitly.
- **The naming scheme needs a defined total order.** `audio-chunk-NNNN` alone stops sorting correctly
  past 9999 and says nothing about slices within a chunk. Use a fixed-width chunk index plus a
  fixed-width slice index — `audio-<sourceId>-000123-04` — so lexical order is chronological. **Define
  the overflow**: six digits and two are ample (a million chunks is ~58 days at 5 s), but "ample" is not
  "impossible". Capture **fails safely and stops** before an index would overflow, rather than silently
  emitting a name that sorts wrongly and corrupts the merge order.

### 1.2 What this does NOT protect — the honest bound

Revision 1 claimed exposure was "bounded at one timeslice". Revision 2 softened it to "grows when writes
fall behind". **Both understate it, and the real behaviour is worse in the case that matters most.**

On **Chrome Android with the screen locked**, the video track mutes and `dataavailable` **stops firing
altogether** until unlock — one large chunk then arrives containing everything captured meanwhile. This is
documented as expected behaviour, not a bug. The same class of stall occurs on desktop sleep/wake and on
Safari/iOS around track mute-unmute.

So: **while a phone is locked or backgrounded, nothing reaches disk at all**, however long that lasts. An
auditor pocketing their phone mid-walkthrough is not an edge case, and incremental persistence gives them
nothing for that period.

This does not sink the design — it is still strictly better than today, where _any_ interruption loses
_everything_ — but it changes two things:

- The durability claim is **"each flushed chunk is safe; emission can stall for as long as the app is
  backgrounded"**, stated in the changeset and in `work-safety.ts`'s own docs. Not "one timeslice".
- **The emission stall is the detectable condition** §6.1 keys on, rather than write-queue depth.

**Two conditions lose already-captured audio**, and revision 3 named only the first — which contradicted
§1.2's own account of emission stalls:

1. **A chunk write fails.** Settlement: stop capture immediately; assemble the canonical Blob from the
   chunk attachments **already on disk** plus whatever the current `dataavailable` carried, decode-verify
   it (§4.1), and write it. **Not "the in-memory Blob"** — revision 3 assumed the session still holds
   every prior chunk in memory, which is either false, or true only because we kept the unbounded memory
   accumulation this design exists to replace. Prior chunks are re-read from attachments.

   If the canonical write also fails, set `lastError` and leave the item in `recording` so it stays
   recoverable. **And be honest about the limit:** the likely causes — quota exhaustion, IndexedDB
   failure, origin eviction — can defeat the `lastError` write too, and an origin eviction may leave no
   row at all. There is no on-disk outcome to guarantee in that case; the design records that rather
   than pretending otherwise.

2. **Emission stalls and the tab then dies.** Everything captured but not yet emitted is lost, and no
   write failed. This is the §1.2 case, it has no fix at this layer, and it is why §6.1 reports the
   stall.

## 2. The `recording` status

```
recording ─► queued ─► transcribing ─► extracting ─► awaiting-review ─► writing ─► done
```

Four registrations, each failing differently if missed:

- **NOT in `ACTIVE_OUTBOX_STATUSES`** — that list drives `nextPending()`, and an item still recording has
  no canonical attachment, so the relay would try to transcribe nothing.
- **NOT in `FINISHED_OUTBOX_STATUSES`** — not terminal.
- **Counted as PENDING by `summarizeWork`** — otherwise it falls through uncounted and `workSafety`
  returns `safe` while the only copy of the audio is local, violating its _never overstate safety_
  contract.
- **Named as its own category in the status-partition test**, which deliberately fails when a status
  belongs to no named bucket. Satisfy it by naming a category, never by weakening it.

`status` is stored as a bounded string with **no enum**, so this needs no storage migration (§7).

**The relay test needs a direct membership assertion, not only behaviour** — "the relay does not pick up a
`recording` item" can pass even if the status were wrongly added to the active list, because another guard
might still skip it.

## 3. Coordination: the Web Locks API

Revisions 1 and 2 hand-rolled a lease, a heartbeat, a staleness threshold, a fencing token and a singleton
lock document. All of it existed to answer one question — _is that other tab dead, or merely suspended?_ —
that a wall clock genuinely cannot answer.

`navigator.locks` does not have to answer it. **Baseline Widely Available since 2024-09-14** (Chrome 69,
Edge 79, Firefox 96, Safari/iOS 15.4), comfortably inside this project's `chrome121 / edge121 / firefox122
/ ios17.2 / safari17.2` floor. Secure-context only, which localhost and production HTTPS both satisfy.

**One lock name, `ribo-capture`, held for the whole of a capture or recovery session.**

```ts
navigator.locks.request("ribo-capture", async () => {
  // ... entire recording session, or entire recovery ...
}); // released when this resolves — or when the tab dies
```

### 3.1 Web Locks are NOT sufficient to fence writes

Revision 3 argued that because a lock is released only when the callback settles or the context is
destroyed, a previous holder has either finished all its writes or ceased to exist — and therefore no
fence is needed. **That inference is unsafe.**

Lock release and context death are not the same event. The dangerous middle state is **bfcache**: a page
can be frozen and later restored, and browsers resolve the resulting tension — a frozen tab holding a
lock blocks every other tab — in one of two ways, either refusing to cache a lock-holding page or
**releasing the lock on entry while preserving the JavaScript context**. Chromium and WebKit have made
these choices independently and have changed them over time.

Both resolutions are bad for revision 3's argument:

- **Release-on-entry** re-opens the split-brain exactly: the lock is gone, another tab acquires and
  recovers, and the original context later resumes with work in flight and no signal it lost ownership.
  `Lock` exposes nothing to the holder when this happens.
- **Refuse-to-cache** is correct but means holding a lock across a multi-minute recording makes the page
  bfcache-ineligible, with its own cost.

There is a second, narrower hole even on genuine destruction: IndexedDB closes a destroyed context's
connection by **waiting for outstanding transactions to finish**, so a transaction created before
unloading can still commit after Web Locks' cleanup released the lock — with no JavaScript running to
observe it.

The conclusion does not depend on which browser does which thing today. **"Lock held ⟺ context alive" is
an invariant this design cannot verify, that differs between engines, and that has demonstrably
changed.** It is not a safe foundation, and revision 3 built on it.

### 3.1.1 Two identities, not one

Revision 5 had a single `owner` doing two jobs, and the two jobs have **opposite** requirements. It must
rotate on takeover, or the fence is inert; and it must **never** rotate, or the chunks it names become
unfindable. Revision 5 rotated it and then read chunks by it — so recovery found zero chunks and swept
the real audio as orphans. **The design deleted the recording it exists to save.**

Separating them resolves it cleanly:

```
capture: {
  sourceId: string   // IMMUTABLE. Minted once when the row is created. Names the chunks. Never rotates.
  owner:    string   // ROTATES on every takeover. Authorises document writes. Names nothing.
}
```

- **`sourceId` is the audio's identity.** Chunk attachments are named from it, so every chunk of a given
  recording carries one stable prefix regardless of how many times ownership changes. Recovery reads by
  `sourceId` and therefore always finds the crash-surviving chunks.
- **`owner` is the write authorisation.** Recovery rotates it as its first operation, under
  `ribo-capture`, atomically while confirming `status === "recording"`. A restored predecessor then
  fails every guarded document write.

**Why delaying rotation is not an alternative.** Keeping the old owner so chunks stay findable would let
a restored writer keep appending under the live prefix, contaminating the audio recovery is about to
merge. Rotation must be immediate; the immutable `sourceId` is what makes that safe.

Every **document** mutation of a recording item compares **both** `capture.owner` and
`status === "recording"`, and rejects on either mismatch. Comparison and mutation are one write against
one document, so RxDB's retry-against-latest works in our favour: a stale writer's modifier re-runs,
sees a different owner, and throws. **Owner equality alone is insufficient** — after the row reaches
`queued` the original owner is still recorded, so a stale writer would pass an owner-only check.

With rotation plus a stable `sourceId`, the token is sufficient against both races:

- An old IndexedDB transaction committing _first_ is folded into the revision takeover then retries
  against.
- If takeover commits first, the stale transaction conflicts and cannot overwrite the newer revision.
- Revalidate-then-taken-over-again is safe, because authorisation is re-checked atomically on every
  write rather than once.

Still much less than revision 2 carried: no heartbeat, no `leaseAt`, no staleness threshold, no lease
renewal. Web Locks answer _"is anyone recording?"_ and _"did that tab die?"_; the token answers only
_"is this write still authorised?"_

### 3.1.2 Attachment writes cannot be fenced — so make stale ones inert

Attachment mutations cannot test ownership atomically, and this is a property of RxDB, not an oversight:

- `putAttachment()` submits its **own** modifier to the incremental write queue. That modifier sees the
  whole document and _could_ compare a field, but there is no way to inject the comparison.
- Public `RxDocument.incrementalModify()` runs through `modifierFromPublicToInternal`, which **strips
  `_attachments` before the public modifier and restores the old value afterwards**, so a public
  modifier cannot mutate attachments at all.

The same applies to deletion and replacement, not only insertion. **So stop trying to prevent stale
attachment writes and make them inert.**

```
audio-<sourceId>-000123-04         // chunk 123, slice 4, of THIS recording
```

Chunks are named from the immutable `sourceId`, so a restored predecessor writing a chunk writes it into
the same logical recording rather than a rival one — and because chunk and slice indices are assigned
from the recorder's own monotonic sequence, it cannot overwrite a chunk another session already wrote.
Recovery reads every chunk under the recording's `sourceId`, so nothing is lost and nothing is orphaned.

**A late chunk arriving after commit is the residual case**, and it is handled by ordering rather than
by fencing: recovery and commit take their chunk inventory **before** writing canonical, and the sweep
deletes every attachment under that `sourceId` **after** the status transition. A chunk landing between
those points is deleted by the sweep; one landing after the sweep is orphaned on an item that is no
longer `recording`, and is collected by startup discovery (§8), which already scans for exactly that.

### 3.1.3 Canonical authority is a guarded POINTER, not a fixed id

Canonical cannot keep the fixed `AUDIO_ATTACHMENT_ID`. Revision 6 tried to fix this with an
`audioCommitted` flag, which settled _authority_ but not _bytes_:

1. Recorder A begins `putAttachment("audio", staleBlob)`.
2. Recovery B takes ownership, writes and **verifies** the correct canonical blob.
3. B atomically sets the commit flag and transitions to `queued`.
4. A's write conflicts, **retries against B's latest revision, and overwrites `"audio"` after the
   commit**.

The row still reads as committed, and the relay consumes A's unverified bytes. RxDB's attachment
modifier assigns unconditionally by id, and conflicts retry against the current document — so any fixed
id is clobberable by anyone who ever held a handle to it. Revision 6 covered only the ordering where the
stale write lands _first_.

**So the canonical attachment is owner-scoped too, and a guarded pointer says which one is real:**

```
audio-canonical-<owner>              // the attachment; a new one per owner
canonicalAttachmentId: string        // persisted pointer, set ONLY in the guarded transition
```

Recovery writes `audio-canonical-<owner>`, decode-verifies it, and then **atomically publishes that id
while transitioning `recording → queued`**. A stale writer can still land bytes — under _its own_ name,
which nothing points at. It cannot overwrite the published attachment, and it cannot become
authoritative.

This also replaces `audioCommitted`: the pointer's presence **is** the commitment, so one field does
both jobs.

**But `audioReady` is not simply "the pointer is set."** `dropAudio()` removes the attachment and does
not clear the pointer, and §6.2 requires a dropped recording to project `audioReady: false` — so pointer
presence alone would report deleted or evicted audio as playable. The three facts are distinct:

|                         | Meaning                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `canonicalAttachmentId` | **which** attachment is authoritative — historical, survives deletion |
| `audioReady`            | the attachment that pointer names **physically exists**               |
| `audioBytes`            | that attachment's live stub size                                      |

The pointer records authority; `audioReady` records presence. Keeping the pointer after a deliberate
drop is correct — it is still the answer to "which one _was_ the real audio".

**Revision 6 rejected this on the grounds that renaming canonical would fork the attachment every
consumer reads. That was wrong** — `Outbox.getAudio()` already abstracts the lookup, so resolving a
pointer instead of a constant is a change in one place.

**There is no fallback path**, because there are no existing users (§7). `canonicalAttachmentId` is
simply present on every committed row and absent on every uncommitted one, so `getAudio()` resolves a
pointer and nothing else. A dual-read path would be a second code path to test and to keep honest, for a
population that does not exist.

### 3.3 The restored-context protocol

"Re-validate on resume" is easy to write and hard to guarantee, because a `dataavailable` handler can
fire before an asynchronous check completes. Revision 4 named the requirement without specifying the
mechanism.

- **Mark the session suspended synchronously** on `pagehide` with `event.persisted === true`, through an
  injected lifecycle seam so it is testable and so `ribo-core` does not reach for `window` directly.
  `pageshow` with `persisted` is the portable restore signal; Chromium's Page Lifecycle `resume` is not
  a portable foundation and lifecycle ordering is not consistently implemented across engines.
- **Route every mutation through one serialized session queue** — `dataavailable`, finalisation, the
  error fallback. `Recorder` currently installs `dataavailable` straight onto the `MediaRecorder`, so
  this is a real change, and it is what makes ordering a property of our code rather than of the
  browser's event scheduling.

  **Ingestion and persistence must be separate stages, or the failure path deadlocks.** A single queue
  cannot work: a chunk operation that detects a write failure must finalise, but the final
  `dataavailable` may already be queued _behind_ it — so awaiting finalisation waits on an operation
  that waits on it, and not awaiting it drops the last bytes. So `dataavailable` **ingests**
  synchronously into an ordered buffer and returns; a separate persistence loop drains that buffer.
  Finalisation closes ingestion first, then drains what remains, then commits. Nothing awaits anything
  behind it.

- **The first post-suspension operation awaits revalidation.** Anything queued behind it waits; on
  failure, capture stops and the operation is discarded rather than written.
- **The per-write fence stays regardless**, because takeover can happen _after_ a successful
  revalidation. Revalidation reduces wasted work; the fence is what provides safety.

### 3.2 Exclusion and abandonment, with one primitive

`{ ifAvailable: true }` grants the lock or immediately passes `null` instead of queueing — which answers
both questions without a heartbeat:

- **Starting a recording.** Request with `ifAvailable`. `null` means **the lock is held** — by a
  recording, a recovery, a start awaiting microphone permission, or a start unwinding after a failure.
  Refuse to start, **before touching the microphone**, and say "capture is busy in another tab" rather
  than asserting a recording is in progress, which would sometimes be untrue.
- **Finding abandoned recordings.** Query for items in `recording`; if the lock is grantable, no live
  session holds it, so every such item is abandoned and recoverable. **No staleness threshold, no clock
  comparison, no tuning.** Recovery runs inside the lock, which also excludes a second recoverer and a
  concurrent new recording.

Multiple abandoned items can coexist (crash, restart, crash again); recovery processes all of them under
the one lock.

RxDB's `leader-election` plugin is **not** used. It is built on `broadcast-channel`'s userland election
(unload handlers plus heartbeats), a weaker mechanism than the browser-native one for exactly this
question.

## 4. Commit and crash-interruption states

RxDB cannot span the canonical write, the status change, and chunk deletion in one transaction. The order
is load-bearing.

**Order: (1) write and verify `audio-canonical-<owner>` → (2) publish the pointer and transition
`recording → queued`, atomically → (3) delete chunks.**

| Interrupted after | On-disk state                                          | Recovery                                                                                                  |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| — (before 1)      | `recording`, chunks, no pointer                        | Merge, decode-verify, write canonical → (2) → (3)                                                         |
| 1                 | `recording`, an owner-scoped canonical, **no pointer** | Bytes exist but were never published. **Re-verify and re-publish** rather than trusting them — see below. |
| 2                 | `queued`, pointer published, chunks remain             | Harmless; run (3) idempotently                                                                            |
| 3                 | `queued`, pointer published, chunks gone               | Nothing to do                                                                                             |

**Recovery's first question is "is `canonicalAttachmentId` published?"**, never "does an attachment
exist?". Revision 6 added §3.1.3 and left this table asserting the opposite rule — an internal
contradiction that would have reintroduced the exact stale-write hole the section was written to close.

Row 1 deserves its own note. An unpublished owner-scoped canonical is _probably_ the interrupted work of
the current owner, but it may equally be a stale writer's bytes. Recovery therefore re-runs
decode-verification against it before publishing, or simply re-merges from chunks — both are safe, and
the choice is a cost question, not a correctness one, because the pointer is what confers authority.

`queued` before publishing would recreate the relay race `recording` exists to prevent; deleting chunks
before publishing could lose the recording. Both orderings are forbidden.

Because all of this runs inside the `ribo-capture` lock (§3), it needs no additional guard to be
idempotent under concurrent recoverers — there cannot be one.

### 4.1 Recovery decode-verifies — what that proves, and what it does not

`MediaRecorder`'s container is negotiated, not assumed: `recorder.ts` supports `audio/webm;codecs=opus`,
`audio/mp4;codecs=opus` and `audio/mp4` so Safari works. Concatenated WebM chunks form a valid file
because chunk 0 carries the header and the rest are clusters — **that argument does not hold for MP4**,
which can depend on metadata written at finalisation.

So recovery never assumes a merge worked:

1. Merge the chunks.
2. **Decode-verify** with `decodeAudioData`, on the main thread — `AudioContext` is Window-only.
3. On failure, retry with the last chunk dropped (a crash can leave a partial final cluster).
4. On repeated failure, leave the item in `recording` with `lastError` set and chunks **intact**. Surface
   it. Never write a canonical attachment that does not decode; never silently discard bytes.

The transcriber decodes through the same `decodeAudioData` route, so a blob that decodes here will decode
there.

**What it does not prove**, stated plainly because revision 1 overclaimed: decodability, not completeness.
It cannot establish that every emitted chunk was persisted, that a permissive decoder did not accept a
truncated tail, or that dropping the last chunk did not discard good audio — after a crash there is no
expected duration to compare against. **Container-independence extends to detecting outright decode
failure, not to detecting silent truncation.**

**MP4 chunk recovery remains unverified.** The harness is Playwright Chromium, so a passing test proves
WebM only.

**Also note a Safari/iOS defect** (WebKit 279432): around track mute/unmute a recording can contain audio
from the _paused_ period. Since `durationMs` is derived from the decoded audio, a recovered Safari
recording may carry a duration and content that do not match what was spoken. Recorded as a known platform
hazard, not something this design can fix.

**§1's chunk-write-failure fallback must itself decode-verify** before writing canonical. Otherwise it
writes a canonical attachment that recovery then trusts (per §4's table) without ever checking it.

## 5. Recording metadata lifecycle

The item exists before capture ends, and today's contracts cannot express that: `capturedAt` means "when
capture finished", `durationMs` is the final duration, the recorder mints neither until `stop()`, and
**`OutboxPatch` deliberately excludes `recording`** so no final duration is writable at all.

- **`capturedAt` becomes capture START.** Natural for an item that exists during capture. No in-repo
  runtime reader depends on the old meaning — ordering uses `seq`, display uses `enqueuedAt` — but its
  documented meaning and tests change, since `recording.ts` currently declares capture-finish.
- **`durationMs` is `0` while recording**, and at commit is **always derived from the decoded audio** —
  on the normal path as well as on recovery. An earlier revision specified decoded duration only for
  recovery, which would have given the same recording different metadata semantics depending on how it
  ended. Decoded duration is what is actually on disk, and because a paused `MediaRecorder` emits no
  data, it closely tracks the elapsed-active time the recorder measures today.
- **A narrow `finalizeRecording(id, { durationMs })`**, legal only on the guarded `recording → queued`
  transition, rather than widening `OutboxPatch`.

### 5.1 Start ordering and ownership

**`Recorder.start()` is already `async`** — revision 1 wrongly claimed it "becomes async". What changes is
its result and its dependencies, both of which are published contract.

1. **Acquire `ribo-capture` with `ifAvailable`** — refuse early if another tab holds it, before touching
   the microphone.
2. **Select a supported requested MIME type** from the preference list. This must happen **before** the
   microphone, not after: the current recorder deliberately refuses an unsupported configuration without
   ever prompting, and an earlier revision's ordering regressed that.
3. Request microphone permission.
4. Construct `MediaRecorder` with the requested type.
5. **Read the type the live recorder actually reports** — negotiated, never assumed, since it may differ
   from what was requested.
6. Insert the outbox row in `recording` with the reported type, `capturedAt` and `capture`.
7. `start(timeslice)`.

An earlier revision collapsed 2 and 5 into "negotiate from the live `MediaRecorder`", which is circular:
constructing one requires already having chosen a requested type.

**Failure at any step unwinds the earlier ones** through the existing teardown, so the instance returns to
`idle` and stays reusable: permission denial releases the lock, and a failure after row creation deletes
the provisional row. **If the unwind itself fails**, the lock is released by resolving the callback and the
orphan row is collected by startup discovery (§8) like any other interrupted recording — no force-clearing,
because with Web Locks there is nothing stale to force.

**Ownership.** The current separation is deliberate: `Recorder.stop()` returns a `Capture`, the React hook
optionally enqueues it, and `useRecorder({ enqueue: false })` is a supported outbox-free mode. That
survives:

- **`Recorder` does not gain an `Outbox`.** Durable capture is a separate collaborator — a capture session
  constructed with the outbox — that the recorder reports chunks to. Recorder keeps `MediaRecorder`, MIME
  negotiation and its state machine.
- **`useRecorder({ enqueue: false })` keeps working and gets no durability**, which is honest: no outbox
  means nowhere to persist. Said out loud, since a caller might otherwise assume crash-safety came free.
- **`start()` returns the item id** when durable capture is active, so a caller can subscribe immediately.
  `Capture` and `StopResult` keep their shapes; with durable capture, enqueueing is a status transition
  rather than a first write.
- **Startup discovery (§8) belongs to the outbox side**, and reaches the relay through the injected seam the
  host already wires — storage does not acquire relay policy.

**Three identities the design must settle, because they are currently split across two owners:**

- **Who mints the id.** `Recorder` mints a recording id at `stop()`; `Outbox` has its own id factory and
  mints in `enqueue()`. Durable capture needs **one authoritative id before the row is inserted**, so the
  capture session mints it at `start()` and both later paths use it. `enqueue()`'s factory stays for the
  non-durable path.
- **What the hook returns.** `useRecorder`'s `start()` is typed `Promise<void>` and discards any recorder
  result. It must surface the item id, which is a published signature change.
- **Where the session lives.** `RiboProvider`'s context holds recorder, outbox and connectivity — there is
  no capture-session instance for `useWorkSafety()` to read health from (§6.1). The active session must be
  published on the context, with a defined lifetime: created at `start()`, disposed at `stop()` or on
  unwind, and absent when `enqueue: false`.

**The lock forces a two-promise handshake.** `navigator.locks.request()` does not resolve until its
callback ends — so `start()` cannot await it, or it would block for the entire recording. The callback
holds the lock and stays pending until stop or unwind; a separate deferred resolves as soon as setup
succeeds and is what `start()` returns. Getting this backwards produces a `start()` that never returns.

```
start()  ─► request(lock, async () => {         // pending for the whole session
              …setup…
              setupDone.resolve(itemId)         // ← start() resolves here
              await sessionEnded                // ← lock held until stop/unwind
            })
         ─► return setupDone.promise
```

**The id flows one way.** The capture session mints it at `start()` and it is passed _into_ the recorder
for `stop()` to stamp onto the `Recording`, rather than the recorder minting its own and the session
adopting it. `enqueue()`'s factory stays for the non-durable path.

**Outbox-free recording still takes the lock.** §3 requires one capture lock per recording, and that is
about the microphone and the recorder, not about storage — two tabs recording at once is wrong whether
or not either persists. So `enqueue: false` still acquires `ribo-capture`; it simply has no outbox, no
chunks, no `capture` row, and no durability. The session object exists to own the lock either way.

**The context needs a coordinator, not a field.** A session created inside a descendant `useRecorder()`
cannot publish itself to a sibling `useWorkSafety()` by mutating the provider's value —
`RiboProvider` passes a host-owned object straight through. So the host (or provider) constructs a
**stable, observable capture coordinator** that both hooks read: `useRecorder` registers the active
session on it, `useWorkSafety` subscribes to its health. Explicit `recorder`/`outbox` hook overrides
publish through the same coordinator, or they silently lose health reporting.

**The coordinator is a named, published thing, not an implementation detail.** `RiboProvider`
deliberately constructs nothing today — it passes host instances straight through — so the design must
say which side builds this one:

- A `CaptureCoordinator` is added to `RiboInstances` alongside recorder, outbox and connectivity, with a
  factory exported from `ribo-core`. **The host constructs it**, consistent with how every other
  instance is supplied; the provider does not quietly create one, which would make its behaviour depend
  on whether a field was passed.
- It is **optional in `RiboInstances`**. Absent, there is no durable capture and no capture health —
  `useWorkSafety` behaves exactly as today. That keeps this additive for hosts that do not want it.
- It exposes: register/unregister an active session, an observable `health`, and the active session's
  item id. `useRecorder` registers; `useWorkSafety` subscribes.
- **Explicit `recorder`/`outbox` hook overrides read the coordinator from context regardless**, so a
  host that overrides one instance does not silently lose health reporting.
- `Recorder` receives the capture session as a **constructor collaborator**, not per-call, so its state
  machine owns one relationship for its lifetime.

**`useRecorder.start()` returns `string | undefined`** — the id when durable capture is active,
`undefined` when `enqueue: false`. It currently swallows start failures deliberately, and that stays:
refusal because another tab holds the lock is surfaced as recorder state, not a rejection, so the
existing error-handling contract does not change.

## 6. Reporting contracts that change

### 6.1 `workSafety` keeps `protected` during healthy recording — and the signal is plumbed

**The policy.** An earlier draft downgraded `protected` for every recording. That is the wrong trade: the
risk that the last moment of a recording may be lost is well understood, `workSafety` answers _"is the work
I have already done safe?"_, and a warning firing on **every single recording** is noise that teaches the
user to ignore the one time it matters.

**What warrants a downgrade is emission actually stalling** — and §1.2 makes this the important signal
rather than a nicety, because a backgrounded phone stops flushing entirely:

- **no `dataavailable` for longer than a documented multiple of the timeslice** while recording, or
- a chunk write has **failed**.

Either reports `at-risk`.

**The honesty problem.** `protected` is documented as meaning on-device work survives _"reload / crash /
eviction"_, which audio still in the recorder does not. Rather than weaken the report, narrow what the
level claims: `protected` means _everything flushed to disk is safe_, and `recording` carries a distinct
**reason** naming the unflushed tail. The level stays stable so it keeps its signalling value; the reason
carries the nuance. `work-safety.ts`'s documentation changes with it — a level whose stated meaning does not
match its computation is worse than either option.

**The signal must be plumbed, which an earlier draft assumed rather than specified.** It cannot work today:
`summarizeWork()` takes only `status`, `workSafety()` receives counts plus the storage grant plus
connectivity, and emission timing is ephemeral session state that never reaches the classifier. So:

- The capture session exposes **capture health**: `flushing` (healthy) or `stalled` (no `dataavailable`
  past the threshold, or a failed write).

**Resume ordering is load-bearing, because the detector is frozen alongside the page.** A timer-based
"no event for N timeslices" check cannot fire while the tab is backgrounded — which is exactly when the
condition it watches for occurs — and on resume the browser may deliver the accumulated `dataavailable`
_before_ the detector runs. If that handler simply resets the last-emission timestamp, **the stall is
never observed at all** and the signal is worthless.

The robust implementation does not depend on a timer winning an event-loop race: **the `dataavailable`
handler itself computes `now - lastEmission` before updating it**, so a late event detects the interval
it missed.

So: the gap is computed from the **timestamp carried into the resume**, before any late event is
accepted as healthy. A resumed session that observes a gap past the threshold reports `stalled` for that
interval even though audio ultimately arrived — because the report is about the window in which a crash
would have lost it, not about the eventual outcome.

**A user pause is not a stall, and the recorder phase cannot tell you so.** By the time the first
post-resume `dataavailable` arrives the recorder has already returned to `recording`, so a long
intentional pause would be reported as a stall. The emission baseline is therefore **reset on a
user-initiated `Recorder.resume()`**, and deliberately **not** reset on page restoration — which is the
whole distinction: one is the user choosing to stop capturing, the other is capture being taken away.

**Latching requires a clearing rule, which revision 4 left undefined**, and without one the signal is
useless in either direction: if the same handler returns straight to `flushing`, React may never render
`at-risk` at all; if it never clears, the value stops meaning current health. So capture health is
**latched**: entering `stalled` holds it for a defined minimum interval, and it clears only after
emission has been healthy for that long. The value then means "emission is healthy _and_ has been
recently", which is what a safety report should say. The detector reads the recorder phase to
distinguish this from `stopped` or `paused`; it does **not** try to infer _why_ emission stalled, which
it cannot and does not need to.

- `workSafety()` accepts it as an optional ambient input alongside storage persistence and connectivity —
  the same shape as the facts it already takes.
- `useWorkSafety()` composes it from the active session, as it already composes outbox, storage and
  connectivity.
- `WorkSafety` gains a reason for the recording case and one for `stalled`.

**The new reasons slot into the EXISTING precedence; they do not redefine it.** An earlier revision
wrote a precedence table from scratch and got the current contract wrong twice — it claimed persistence
denial "outranks everything", and filed permanent failure under `at-risk`. Neither is true. The real
order is documented in `work-safety.ts` and stays exactly as it is:

```
action-required  >  at-risk  >  protected  >  safe
```

and a permanently-failed item is `action-required` / `failed-permanently`, checked **before**
persistence, because it is the one state that never resolves on its own.

So the two new reasons take their place inside that order rather than around it:

| Situation                                             | Result                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| A `dead` item                                         | `action-required` / `failed-permanently` — unchanged, still outranks the rest |
| Persistence denied                                    | `at-risk` / `not-persisted` — unchanged                                       |
| Capture stalled (§1.2)                                | `at-risk` / `capture-stalled` — **new**, same level as other at-risk causes   |
| Healthy recording (with or without other queued work) | `protected` / `recording` — **new** reason at an existing level               |
| No recording                                          | exactly as today                                                              |

Two new reasons, no new levels, and no change to how levels rank. That is the smallest change that
carries the information, and it keeps a public discriminated union predictable.

Absent the input — no recording, or a host that does not wire it — behaviour is exactly as today.

### 6.2 `hasAudio` is renamed, because during recording it is simply wrong

`hasAudio` is projected from the existence of `AUDIO_ATTACHMENT_ID`. A recording row holds chunk attachments
but no canonical one, so it would project `hasAudio: false` — which the playground renders as **"the bytes
were dropped"**. That is not ambiguous, it is false: the item demonstrably has audio, in chunks, on disk.

Adding a second field beside a misleading one preserves the wrong name. **Rename instead:**

```
hasAudio  ─►  audioReady    // the canonical, playable attachment exists
```

`audioBytes` widens to mean **durable bytes on disk**, summing chunk attachments while recording and the
canonical attachment afterwards.

"Not yet" and "dropped" are then derivable with no third field:

| State                       | `status`            | `audioReady` | `audioBytes`   |
| --------------------------- | ------------------- | ------------ | -------------- |
| Capturing                   | `recording`         | `false`      | growing        |
| Ready                       | `queued`+           | `true`       | canonical size |
| Dropped after transcription | past `transcribing` | `false`      | `0`            |

Both keys are in `DERIVED_OUTBOX_ITEM_KEYS` — projected, never stored — so this is a public API rename with
**no storage migration**. It is a breaking consumer change and the changeset must say so.

## 7. Schema changes

Three persisted fields are added, and **all three must appear in both the zod document schema and the
RxDB schema** — the two descriptions are deliberately pinned against each other field-for-field, and a
field in one but not the other is exactly the drift that pinning exists to catch:

```
capture: { sourceId: string; owner: string }   // present iff status === "recording"
canonicalAttachmentId?: string                  // published in the guarded commit transition
step?: { generation: string }                   // rotated on every relay claim (§8.2)
```

`outboxRxSchema` goes to **version 2** with a migration strategy, because RxDB requires one for every
version.

**The strategy is trivial and needs no compatibility logic: there are no users yet**, so no v1 database
exists that anyone depends on. An earlier revision specified a fallback from a missing
`canonicalAttachmentId` to `AUDIO_ATTACHMENT_ID` so that legacy audio would keep reporting `audioReady`.
That was solving for a population that does not exist, and it bought a permanent second read path in
`getAudio()`. Deleted.

**The invariants, stated rather than merely allowed — and an earlier revision contradicted itself here**,
saying `capture` was present _iff_ `recording` and then that committed rows retain `sourceId`. Both
cannot hold. What is actually true:

- `status === "recording"` ⇒ `capture.sourceId` **and** `capture.owner` present, and
  `canonicalAttachmentId` **absent** (nothing is committed yet, by definition).
- A row that **has been** through `recording` **retains** `capture.sourceId`, because it identifies
  chunks that may still need sweeping (§8). Its `owner` authorises nothing outside `recording`.
- **Every committed row has a `canonicalAttachmentId`** — including rows created by the surviving
  non-durable `enqueue()` path, which never had a capture session. That path mints a unique canonical
  attachment id and persists the pointer like any other; it simply has no `capture`.
- Dropping the physical attachment does **not** clear the pointer (see `audioReady` above).

These are conditional relationships between fields, so they are validated at the **zod boundary** with
refinements, not expressed as bare optional properties. An optional-only schema would let a `recording`
document parse while being unfenceable, or a committed one parse with no authoritative audio.

A merely-optional `capture` would let a `recording` document pass the trust boundary while being
unfenceable and unrecoverable.

## 8. Startup discovery, hand-off, and relay coordination

Recovery scans for **two** conditions, both inside the `ribo-capture` lock:

- **`recording` rows** — if the lock was grantable, no live session holds it, so they are abandoned. Full
  recovery per §4.
- **Any non-`recording` row carrying leftover attachments.** Not just `queued` — an earlier revision
  scanned only that status and would have leaked in a plausible sequence: recovery publishes the pointer
  and reaches `queued`, its tab dies before sweeping, another tab's outbox subscription immediately
  advances the item to `transcribing`, and on the next startup the row no longer matches. Its chunks are
  then never collected.

  On every non-`recording` row, delete:
  - every chunk attachment under its retained `capture.sourceId`;
  - **every `audio-canonical-*` attachment except the one named by `canonicalAttachmentId`.** §3.1.3
    deliberately lets stale canonical writes land inert, and each one is a **whole recording** — so
    leaving them uncollected is a storage-quota leak and a retention problem, not untidiness.

  The sweep is idempotent and runs every startup, which is also what collects writes that landed after a
  previous sweep.

This runs **before `relay.start()`** in the recovering tab, so a recovered item is `queued` with its
canonical attachment in place before that tab's relay could select it.

### 8.1 The hand-off must not depend on the recovering tab surviving

Revision 3 had recovery call `syncNow()` and stopped there. That strands an item in a plausible
sequence: tab A takes the lock and recovers; tab B is refused, starts its relay, and drains an empty
queue; A finishes the recovery but **dies before calling `syncNow()`**. B is still open, its startup
drain has already ended, and the relay has no timer and does not subscribe to outbox changes — so the
recovered item waits for an unrelated connectivity edge or a manual sync.

Two changes, and the first is the real fix:

- **The relay subscribes to the outbox** and drains when an item becomes eligible. It already has
  `watch()`; today it drains only on `syncNow()`, startup, or a connectivity edge. This closes the
  general gap, not just this instance of it — any path that produces a `queued` item without an explicit
  trigger has the same problem.

  **Wire it on eligibility edges, not on every emission.** `watch()` fires on every matching document
  write, and the relay itself produces several active-to-active writes per item, so calling `syncNow()`
  per emission appends a drain to the chain for each one. That is serialized rather than re-entrant, so
  it is not a correctness bug, but it leaves a tail of redundant drains each contending for
  `ribo-relay`. Detect the transition into eligibility and **coalesce "drain requested while draining"
  into at most one follow-up**. The relay also needs a **separate unsubscribe handle** for this
  subscription; it currently keeps only one, for connectivity.

- Recovery still calls `syncNow()`, now as an optimisation rather than the mechanism.

### 8.2 Relay work needs claim-on-select, not just a lock

Deleting the leader-election plugin removed the only thing stopping two tabs running relays over one
queue. The relay's serialization is per-instance, and `nextPending()` performs no claim, so two relays
can read the same `queued` item and begin the same step.

**Revision 4 answered this with a second Web Lock, `ribo-relay`, and dismissed the residual risk as
"merely duplicated work". That was wrong**, and wrong for the same reason revision 3 was: under this
design's own bfcache premise, a lock can be released while the holder's context survives.

The concrete failure, which is corruption rather than waste:

1. Relay A selects a `queued` item, starts transcription, and is frozen.
2. A's lock is released; relay B transcribes and extracts the item to `awaiting-review`.
3. A resumes and writes its stale transcription result with `status: "extracting"`.

**The item has regressed out of `awaiting-review`.** A stale failure handler can equally overwrite
success with `failed` or `dead`. If review or writing had already happened, it is worse still. Relay
step mutations are unconditional patches today, so nothing stops any of this.

So relay work needs **the same class of protection as capture**, and the mechanism is decided rather
than offered: **a persisted relay generation**.

```
step: { generation: string }    // rotated on every claim; compared by every step mutation
```

**Claim-on-select alone does not work**, which is why this is not a choice between two options. Merely
transitioning the status while selecting leaves the item in a status that is deliberately _active and
recoverable_, and the relay derives the next step from **persisted outputs** rather than from status
(`relay.ts:139`). A successor relay and a restored predecessor can therefore both conclude they are
working the same logical step, whatever the status says.

**The claim itself must be atomic, not just the mutations it protects.** "Selecting rotates the
generation" is under-specified: a relay frozen _after_ `nextPending()` returns but _before_ it rotates
can resume later, perform its delayed rotation, and steal the item back from a successor that has already
advanced it — or claim one that has since parked or finished. Selection is a plain query today, and the
relay patches separately afterwards.

So a claim is a **guarded `incrementalModify` that compares the generation and status observed at
selection, re-derives eligibility and the next step from the current revision, and only then rotates**.
A mismatch means _"claim lost"_ — the item is skipped, not failed, because nothing went wrong with it.

Thereafter every mutation of that step — success **and** failure —
compares the generation inside a guarded modify and rejects on mismatch. A restored predecessor writing a stale
transcript, or a stale failure handler writing `failed`/`dead` over a completed step, both throw instead
of applying. The external idempotency key continues to protect the vendor write; the generation protects
local state, which is what the key never covered.

`ribo-relay` is still worth holding: it prevents routine contention between two live tabs, exactly as
`ribo-capture` does. It is the acquisition mechanism, not the authorisation one — the same division as
§3.1.

## 9. Consumer-visible API changes, declared

`OutboxStatus` and `OutboxItem` are public. Adding `recording` grows a union consumers may switch on
exhaustively — a compile-time break — and `hasAudio` → `audioReady` renames a projected field.
`Recorder.start()` gains a return value and a collaborator. These are **breaking changes and the changeset
must say so**, not be described as additive.

## 10. Testing

**Nine that must be able to fail.** Several of revision 4's would have passed a broken implementation;
where that is so, the discriminating version is described.

- **Two tabs starting simultaneously: exactly one wins.** Only discriminating if the first lock callback
  is **held at a barrier** while the second `ifAvailable` request runs. Sequential acquisition proves
  nothing.
- **A stale write cannot land, tested as a real race.** Revision 4 set a different owner and _then_
  called the writer — which a non-atomic pre-flight check passes. Instead: **pause the old mutation
  mid-flight, commit the takeover, release the old mutation**, and assert the conflict retry rejects it
  with no status change.
- **Recovery rotates the owner.** Without this the fence is inert and every other fence test passes
  anyway, because they set the owner by hand. **This is the test that would have caught revision 4.**
- **Recovery finds the chunks AFTER rotating the owner.** Rotate, then recover, and assert the audio is
  merged rather than swept. **This is the test that would have caught revision 5's data-loss bug**, in
  which rotation orphaned every chunk the recording depended on.
- **A dropped recording reports `audioReady: false` while keeping its pointer.** The two facts are
  distinct, and pointer-presence-alone passes every other test while failing this one.
- **An unpointed canonical attachment is swept, on a row well past `queued`.** Advance the item to
  `transcribing` before the sweep runs; a sweep scanning only `queued` leaks a whole recording.
- **A stale canonical write cannot overwrite a PUBLISHED one.** Both orderings, because revision 6
  tested only the easy one: (a) the stale write lands _before_ commit, and (b) the stale write is
  **in flight across** the commit — begun before, conflicting, retried against the committed revision,
  landing after. In (b) assert the pointer still names the verified attachment and `getAudio()` returns
  the verified bytes. A fixed-id canonical fails (b) while passing (a).
- **A late chunk landing between inventory and sweep is deleted; one landing after the sweep is
  collected by startup discovery.** The ordering §3.1.2 relies on, asserted rather than assumed.
- **A restored context revalidates before any write.** Drive the actual lifecycle seam, **deliver
  `dataavailable` while revalidation is still pending**, and assert no attachment, canonical or status
  mutation occurs — not merely that the recorder eventually stops.
- **A relay frozen between selection and claim cannot steal the item back.** Freeze after
  `nextPending()` returns but before the claim, let a successor claim and advance, then resume and
  attempt the delayed claim. It must lose, and lose as "claim lost" rather than as a step failure.
- **A user pause is not reported as a stall**, while a page suspension of the same duration is. The pair
  — either alone passes an implementation that confuses the two.
- **A frozen relay cannot regress an item.** Model release mid-step: A selects and freezes, B advances
  to `awaiting-review`, A resumes and writes. Assert the item does not regress. The two-live-tab lock
  test does **not** cover this and is not a substitute. Assert the **failure** path too — a stale handler
  writing `failed`/`dead` over a completed step must also be rejected.
- **The failure path does not deadlock.** Fail a chunk write with a final `dataavailable` already
  queued, and assert finalisation completes **and** includes the last bytes. A single-queue
  implementation hangs here.
- **`workSafety` surfaces a stall observable only after resume**, exercised **through `useWorkSafety`
  and the session detector** — not by calling `workSafety(…, "stalled")` directly, which only tests the
  classifier. Assert the latch holds and then clears.
- **A recovered item drains even if the recovering tab dies before `syncNow()`**, with the surviving
  relay receiving **no** manual, startup or connectivity trigger.
- **`audioReady` is `false` while `audioBytes` is non-zero mid-recording**, plus `recording` membership
  asserted directly in each status list alongside the relay behaviour test.

Also: every row of the §4 table against a reopened database, including a `queued` row with leftover
chunks; **one id proven identical across `start()`, the provisional row and the final `Capture`**; the
active session appearing on the coordinator at `start()` and disappearing at stop **and** on unwind;
oversized chunks sliced with a non-empty MIME type and an order that holds past 9999; merge ordering and
decode-verification in real Chromium; `start()` unwinding cleanly when permission is denied after the
lock is acquired and when the unwind itself fails; `useRecorder({ enqueue: false })` still working with
no durability; and the v1→v2 migration on a database with existing documents.

**One honest limit:** the bfcache behaviour these tests model is not observed. Playwright can destroy and
restore contexts, but what a real Safari does to a held lock on bfcache entry is not established here —
see §11.

## 11. Open questions

- **Actual bfcache/lock behaviour is unmeasured.** The fence in §3.1.1 exists because the invariant
  cannot be verified from documentation and differs between engines. A spike — hold a lock, force
  bfcache entry and restore, in real Chromium and real Safari — would say whether the fence is defending
  against a live path or a theoretical one. It is cheap insurance either way, so this is not a blocker,
  but the answer would inform how much of §3 can eventually be simplified.
- **MP4 chunk recovery is unverified** (§4.1) — it fails honestly rather than silently, but the success rate
  on Safari cannot be measured in this harness.
- **The emission-stall threshold** (§6.1) must be long enough not to fire on ordinary jitter and short enough
  to be useful. Needs a measurement on a real backgrounded device, not a guess.
- **OPFS** (`FileSystemSyncAccessHandle`) is the established pattern for incremental media persistence and
  would delete the chunk attachments, the merge and most of §4. Not adopted here: sync access handles are
  reported to be left open after a crash, sometimes requiring a browser restart to recover — which would be
  fatal for a crash-recovery feature. Worth a scoped spike (possibly via
  `createWritable({ keepExistingData: true })`, which has different locking semantics), not a fold-in-now
  decision.
- **Taking over from a suspended tab** is possible later via `navigator.locks.request(name, { steal:
true })`, which releases the held lock (the previous holder's promise rejects with `AbortError`) and
  preempts the queue. Deliberately not adopted now, for two reasons. The spec's own caveat is exactly the
  hazard §3.1 removes — _"any code running in tabs that assume they hold the lock will continue to
  execute"_ — so stealing **buys back the fencing token** on that path, though a cheaper one, since it
  need only cover the window between the steal and the victim noticing. And a suspended tab is often
  still legitimately recording (§1.2: on Android, capture continues while emission stalls), so an
  automatic steal would truncate a live recording. If this is built, it should be a **user-initiated**
  takeover — "another tab is recording: switch to it, or take over and end it" — not an app decision.
  Note the case is partly self-limiting: when the OS reclaims a backgrounded tab the context is destroyed
  and the lock frees on its own.
