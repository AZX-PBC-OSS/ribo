# Durable capture — audio survives a crash mid-recording

**Status:** Design, revision 3. Piece 1 of 2. Not yet planned or implemented.
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
mitigation that vendor adopted. Ordering is preserved by the existing zero-padded naming.

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

**Chunk-write failure is the only failure here that loses audio already captured.** Settlement: stop
capture immediately, attempt to write the in-memory Blob as canonical (decode-verified per §4.1), and if
that also fails leave the item in `recording` with `lastError` set so it stays recoverable. Never delete
it, never report success.

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

### 3.1 Why this removes the fencing token entirely

The lock is released **only** when the callback settles or the holding context is destroyed. Therefore:

- A **suspended** tab still holds its lock. No other tab can take over while it sleeps, so the split-brain
  the fencing token defended against **cannot occur**.
- A **crashed** tab's lock is released by the browser, authoritatively, with no timeout to tune.
- When another tab does acquire, the previous holder either finished (all writes settled) or no longer
  exists (no writes can land).

So no other context can write to the item concurrently, and the persisted `capture: { owner, leaseAt }`
field, the heartbeat, the staleness threshold and the recovery-lease renewal are all unnecessary.

**The one discipline this imposes:** every write must happen _inside_ the lock callback, and the callback
must not resolve until the persistence chain has settled. Releasing the lock while a write is in flight
would reintroduce the race by hand. That is a rule to test, not a mechanism to build.

### 3.2 Exclusion and abandonment, with one primitive

`{ ifAvailable: true }` grants the lock or immediately passes `null` instead of queueing — which answers
both questions without a heartbeat:

- **Starting a recording.** Request with `ifAvailable`. `null` means another tab is recording: refuse to
  start, with a clear reason, **before touching the microphone**.
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

- The capture session exposes **capture health**: `flushing` (healthy) or `stalled` (no `dataavailable` past
  the threshold, or a failed write).
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

## 7. No schema migration is required

Revision 1 asserted schema v2; revision 2 justified it by the persisted `capture` field. **Web Locks deleted
that field, and with it the migration.** Checking each change against `outboxRxSchema`:

- `recording` — `status` is stored as a bounded string with **no enum**. No migration.
- `capturedAt` — meaning changes, shape does not.
- `durationMs: 0` — already legal.
- error marker — `lastError` already exists.
- `audioReady` / `audioBytes` — projected, never stored.

So `outboxRxSchema` stays at **version 1**. If a later change does add a persisted field, that is when the
version bumps.

## 8. Startup discovery

Recovery scans for **two** conditions, both inside the `ribo-capture` lock:

- **`recording` rows** — if the lock was grantable, no live session exists, so they are abandoned. Full
  recovery per §4.
- **`queued` rows that still hold chunk attachments** — interrupted after step 2. Run step 3's deletion
  idempotently; no merge, no status change.

This runs **before `relay.start()`**, so a recovered item is `queued` with its canonical attachment in place
before the relay could select it. Recovery then calls `syncNow()`, because the relay drains only on
`syncNow()`, startup, or a connectivity edge — it has no timer and does not subscribe to outbox changes, so
without the call a recovered recording waits for something unrelated.

The relay's own concurrency guard is per-instance, not cross-tab; the lock is what makes recovery
single-writer across tabs.

## 9. Consumer-visible API changes, declared

`OutboxStatus` and `OutboxItem` are public. Adding `recording` grows a union consumers may switch on
exhaustively — a compile-time break — and `hasAudio` → `audioReady` renames a projected field.
`Recorder.start()` gains a return value and a collaborator. These are **breaking changes and the changeset
must say so**, not be described as additive.

## 10. Testing

**Six that must be able to fail:**

- **Two tabs starting simultaneously: exactly one wins**, via `ifAvailable`. A sequential test proves nothing
  about the race.
- **A recording tab that is suspended is NOT taken over**, and one whose context is destroyed **is**. This is
  the pair that justifies dropping the fencing token; either alone proves half the claim.
- **The lock is not released while writes are in flight** — the one discipline §3.1 imposes. Resolve the
  callback early in a mutant and this must go red.
- **`workSafety` reports `protected` with a distinct reason during healthy recording, and `at-risk` when
  emission stalls past the threshold.** An earlier draft's test asserted recording "does not claim full
  `protected`", contradicting §6.1 — both could not pass. This replaces it.
- **A truncated final chunk recovers via drop-last-and-retry; one that cannot decode at all leaves the item
  recoverable with chunks intact** — and **the chunk-write-failure fallback decode-verifies before writing
  canonical**, the path around the rule.
- **`audioReady` is `false` while `audioBytes` is non-zero mid-recording**, plus `recording` membership
  asserted directly in each status list alongside the relay behaviour test.

Also: every row of the §4 table against a reopened database, including a `queued` row with leftover chunks;
an oversized chunk sliced into ordered attachments; merge ordering and decode-verification in real Chromium;
`start()` unwinding cleanly when permission is denied after the lock is acquired, and when the unwind itself
fails; and `useRecorder({ enqueue: false })` still working with no durability.

## 11. Open questions

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
