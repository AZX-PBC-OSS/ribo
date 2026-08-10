# Durable capture — audio survives a crash mid-recording

**Status:** Design, revision 4. Piece 1 of 2. Not yet planned or implemented.
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
  fixed-width slice index — `audio-chunk-000123-04` — so lexical order is chronological without
  exception.

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

### 3.1.1 What returns: one owner token, checked on writes

```
capture: { owner: string }    // persisted, top-level on the outbox item. No leaseAt.
```

Every mutation of a recording item — each chunk attachment, the canonical write, the status transition —
happens inside a **guarded `incrementalModify`** that compares `capture.owner` and rejects on mismatch.
Because comparison and mutation are one write against one document, RxDB's retry-against-latest works in
our favour: a stale writer's modifier re-runs, sees a different owner, and throws instead of applying.

**This is much less than revision 2 carried.** No heartbeat, no `leaseAt`, no staleness threshold, no
recovery-lease renewal, no tuning — Web Locks still answers _"is anyone recording?"_ and _"did that tab
die?"_ far better than a wall clock could. The token answers only the question locks cannot: _"is this
write still authorised?"_ Liveness detection and write authorisation are different problems, and
revision 3's mistake was assuming one primitive settled both.

**On resume, a restored context must re-validate before writing anything** — the item still exists, is
still `recording`, and still carries its owner. Failing that check means the session was taken over: stop
capture and surface it. This is the specific path a released-on-bfcache lock creates.

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

**Order: (1) write canonical attachment → (2) status `recording → queued` → (3) delete chunks.**

| Interrupted after | On-disk state                         | Recovery                                          |
| ----------------- | ------------------------------------- | ------------------------------------------------- |
| — (before 1)      | `recording`, chunks only              | Merge, decode-verify, write canonical → (2) → (3) |
| 1                 | `recording`, canonical **and** chunks | Canonical exists: **skip the merge**, go to (2)   |
| 2                 | `queued`, canonical and chunks        | Harmless; run (3) idempotently                    |
| 3                 | `queued`, canonical only              | Nothing to do                                     |

Recovery's first question is always **"does the canonical attachment exist?"**, never "are there chunks?".
`queued` before canonical would recreate the relay race `recording` exists to prevent; deleting chunks
before the canonical commit could lose the recording. Both orderings are forbidden.

Because all of this runs inside the lock (§3), it needs no additional guard to be idempotent under
concurrent recoverers — there cannot be one.

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
- **`durationMs` is `0` while recording**, written at commit.
- **A narrow `finalizeRecording(id, { durationMs })`**, legal only on the guarded `recording → queued`
  transition, rather than widening `OutboxPatch`.

### 5.1 Start ordering and ownership

**`Recorder.start()` is already `async`** — revision 1 wrongly claimed it "becomes async". What changes is
its result and its dependencies, both of which are published contract.

1. **Acquire `ribo-capture` with `ifAvailable`** — refuse early if another tab holds it, before touching
   the microphone.
2. Request microphone permission.
3. Negotiate the MIME type from the live `MediaRecorder` (it must exist first; the type is what the real
   recorder reports, never a guess).
4. Insert the outbox row in `recording` with that type and `capturedAt`.
5. Start `MediaRecorder` with the timeslice.

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

Without these three, "start returns the item id", "useWorkSafety composes session health" and "durable
capture is a separate collaborator" do not compose into one ownership model.

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

So: the gap is computed from the **timestamp carried into the resume**, before any late event is
accepted as healthy. A resumed session that observes a gap past the threshold reports `stalled` for that
interval even though audio ultimately arrived — because the report is about the window in which a crash
would have lost it, not about the eventual outcome. The detector reads the recorder phase to
distinguish this from `stopped` or `paused`; it does **not** try to infer _why_ emission stalled, which
it cannot and does not need to.

- `workSafety()` accepts it as an optional ambient input alongside storage persistence and connectivity —
  the same shape as the facts it already takes.
- `useWorkSafety()` composes it from the active session, as it already composes outbox, storage and
  connectivity.
- `WorkSafety` gains a reason for the recording case and one for `stalled`.

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

## 7. Schema migration: v2, for `capture` alone

Revision 3 claimed no migration was needed. **Restoring the owner token (§3.1.1) puts one persisted
field back**, so `outboxRxSchema` goes to **version 2** with a migration strategy. The strategy is
mechanical: no v1 document can have been recording, so v1 documents pass through with `capture` absent.

Everything else still needs no migration, and the checks hold:

- `capturedAt` — meaning changes, shape does not.
- `durationMs: 0` — already legal.
- error marker — `lastError` already exists.
- `audioReady` / `audioBytes` — in `DERIVED_OUTBOX_ITEM_KEYS`, projected and never stored.

**One correction to revision 3's reasoning.** It said `status` "has no enum". That is true of the **RxDB
storage schema**, which stores a bounded string — so the new value needs no storage migration. It is
**false at the zod trust boundary**, where `status: z.enum(OUTBOX_STATUSES)`. The practical consequence
is a mixed-version concern rather than a migration one: an older tab running older code will _reject_ a
`recording` document it reads. A version bump does not teach an old reader a new value, so this is noted
as a deployment property, not solved here.

## 8. Startup discovery, hand-off, and relay coordination

Recovery scans for **two** conditions, both inside the `ribo-capture` lock:

- **`recording` rows** — if the lock was grantable, no live session holds it, so they are abandoned. Full
  recovery per §4.
- **`queued` rows that still hold chunk attachments** — interrupted after step 2. Run step 3's deletion
  idempotently; no merge, no status change.

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
- Recovery still calls `syncNow()`, now as an optimisation rather than the mechanism.

### 8.2 Relay work needs its own cross-tab exclusion

Deleting the leader-election plugin (§3.2) removed the only thing that would have stopped two tabs
running relays over one queue. The relay's serialization is **per-instance**, and `nextPending()`
performs no claim — so two relays can read the same `queued` item and begin the same step. The remote
idempotency key protects the vendor write, but not duplicate transcription and extraction, which are the
expensive parts.

This is partly pre-existing, but this design makes it worse by specifying simultaneous multi-tab startup,
so it is in scope: **the relay drains under a second Web Lock, `ribo-relay`**, held for the duration of a
drain. Distinct from `ribo-capture`, because recording and relaying may legitimately proceed in different
tabs.

A bfcache release mid-drain is tolerable here in a way it is not for capture: the failure mode is
duplicated work, not corrupted or lost audio. Claim-on-select — transitioning an item's status as part of
selecting it, so the claim is storage-level rather than lock-level — is the more robust answer and is
noted as a follow-up rather than folded in.

## 9. Consumer-visible API changes, declared

`OutboxStatus` and `OutboxItem` are public. Adding `recording` grows a union consumers may switch on
exhaustively — a compile-time break — and `hasAudio` → `audioReady` renames a projected field.
`Recorder.start()` gains a return value and a collaborator. These are **breaking changes and the changeset
must say so**, not be described as additive.

## 10. Testing

**Eight that must be able to fail:**

- **Two tabs starting simultaneously: exactly one wins**, via `ifAvailable`. A sequential test proves
  nothing about the race.
- **A write from a session that no longer owns the item is rejected.** The fence, directly: set a
  different `capture.owner`, then attempt a chunk write. This is the test revision 3 had no need for and
  was wrong not to have.
- **A restored context re-validates before writing.** Simulate the bfcache path — lock released, another
  session takes over, original resumes — and assert it stops rather than writing. **This is the case that
  invalidated revision 3**; a test that only covers destroyed contexts proves the wrong half.
- **`workSafety` reports `at-risk` when a stall is only observable after resume** — the late
  `dataavailable` must not reset the gap first. A detector that processes the event before computing the
  gap passes a naive stall test and fails this one.
- **A recovered item is drained even if the recovering tab dies before `syncNow()`.** Kill the recoverer
  after the status transition; another open tab's relay must still pick it up.
- **Two tabs cannot drain the relay concurrently** — the `ribo-relay` lock, asserted with both tabs live.
- **A truncated final chunk recovers via drop-last-and-retry; one that cannot decode at all leaves the
  item recoverable with chunks intact** — and **the chunk-write-failure fallback decode-verifies before
  writing canonical**, and assembles from **attachments**, not from an assumed in-memory buffer.
- **`audioReady` is `false` while `audioBytes` is non-zero mid-recording**, plus `recording` membership
  asserted directly in each status list alongside the relay behaviour test.

Also: every row of the §4 table against a reopened database, including a `queued` row with leftover
chunks; an oversized chunk sliced into ordered attachments **with a non-empty MIME type** and a lexical
order that holds past 9999; merge ordering and decode-verification in real Chromium; `start()` unwinding
cleanly when permission is denied after the lock is acquired, and when the unwind itself fails;
`useRecorder({ enqueue: false })` still working with no durability; and the v1→v2 migration on a database
with existing documents.

**One honest limit on all of it:** the bfcache behaviour these tests simulate is _modelled_, not
observed. Playwright can destroy and restore contexts, but "what a real Safari does to a held lock on
bfcache entry" is not something this harness establishes — see §11.

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
