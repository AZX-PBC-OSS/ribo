# Durable capture — audio survives a crash mid-recording

**Status:** Design, revision 2. Piece 1 of 2. Not yet planned or implemented.
**Date:** 2026-08-10

> **Why this document exists.** It was split out of
> `2026-08-08-live-transcription-design.md` after two review rounds on that
> combined design failed to converge. Every critical finding in both rounds landed in
> **durability and ownership**, none in the live preview itself. This piece is therefore
> specified and shipped first, on its own merits; live preview (piece 2) builds on it.
>
> **Revision 2** after review. The central fix: **the fencing token moves onto the outbox document.**
> Revision 1 kept it in the lock document, where it could not be atomic with the attachment writes it
> was supposed to guard — `putAttachment`'s modifier only ever sees the outbox document's own
> `_attachments`, and RxDB's conflict retry re-applies a stale write against the _latest_ revision.
> Also fixed: the recovery claim is now a renewable lease; `workSafety`'s new health signal is actually
> plumbed rather than assumed; decode-verification's reach is stated honestly; the loss bound is no
> longer described as a bound; and `Recorder.start()` was already async, so §5.1 no longer claims
> otherwise.

## The problem

Audio only becomes durable at `stop()`. `MediaRecorder` accumulates chunks in memory, `stop()`
assembles one `Blob`, and `enqueue` writes the document and that Blob in a single storage transaction.
Kill the tab, background the phone until it is discarded, or crash the renderer at minute four of a
five-minute walkthrough, and **the entire recording is gone** — there was never anything on disk.

For a field app whose whole premise is that an auditor drove to a house to make this recording, that
is the most expensive failure available.

## Scope

**In:** audio persisted incrementally during capture; a recording lifecycle the outbox can represent;
ownership that survives suspension and multiple tabs; recovery that verifies before it commits;
honest work-safety and `hasAudio` reporting; a schema migration.

**Out:** live transcription preview, the `AudioWorklet` PCM tap, the `LiveTranscriber` seam, rolling
VAD, and worker contention between live and batch work. All of that is piece 2. Nothing here mentions
transcription except where recovery hands an item to the existing relay.

**Deliberately out:** making the _last few hundred milliseconds_ durable. There is always a window
between `dataavailable` events, and closing it would mean abandoning `MediaRecorder`. Bounded loss is
the goal, not zero loss — see the `workSafety` section, which says so out loud rather than implying
otherwise.

## 1. Incremental persistence

`MediaRecorder.start(timeslice)` at **5 seconds**. Each `dataavailable` writes one RxDB attachment,
zero-padded so lexical order is chronological:

```
audio-chunk-0000, audio-chunk-0001, … ─► (at commit) merge ─► AUDIO_ATTACHMENT_ID, chunks deleted
```

Per-chunk rather than rewriting one growing attachment: RxDB attachments are not appendable, so
rewriting a growing Blob every 5 seconds is quadratic I/O where N chunks merged once is linear.

**The exposure is "roughly one timeslice", not a guarantee.** `timeslice` _requests_ periodic
`dataavailable` events; it does not promise them on schedule. Background throttling and suspension
delay delivery, and an unbounded persistence chain can leave several already-emitted chunks unwritten
at once. Revision 1 called this "bounded at one timeslice" while §6.1 simultaneously acknowledged
outstanding-write lag — the two cannot both be true. The honest statement is that exposure is normally
about one timeslice and **grows when writes fall behind**, which is precisely the condition §6.1 now
reports.

**`stop()` must await outstanding chunk writes.** `dataavailable` is currently synchronous bookkeeping
into an in-memory array, and `MediaRecorder`'s `stop` event guarantees the final handler _fired_, not
that an async IndexedDB write it started has committed. The session keeps a **persistence chain** of
chunk writes that `stop()` awaits before merging. Without it the merge can silently omit the last
chunk, or race a slow earlier one.

**Chunk-write failure is the only failure here that can lose audio**, so its settlement is concrete:
stop capture immediately, attempt to write the in-memory Blob as the canonical attachment, and if that
also fails leave the item in `recording` with an error marker so it stays recoverable. Never delete
it, and never report success.

## 2. The `recording` status

```
recording ─► queued ─► transcribing ─► extracting ─► awaiting-review ─► writing ─► done
```

Four separate registrations, each of which fails differently if missed:

- **NOT in `ACTIVE_OUTBOX_STATUSES`.** That list drives `nextPending()`; an item still recording has
  no canonical attachment, so the relay would try to transcribe nothing.
- **NOT in `FINISHED_OUTBOX_STATUSES`.** It is not terminal.
- **Counted as PENDING by `summarizeWork`.** Otherwise `recording` — correctly not active — falls
  through uncounted and `workSafety` returns **`safe`** while the only copy of the audio is
  accumulating locally, violating that module's _never overstate safety_ contract.
- **Named as its own category in the status-partition test.** `schema.test.ts` deliberately fails when
  a status belongs to no named bucket. Satisfy it by naming a category, never by weakening it.

`status` is indexed at `maxLength: 16`; `recording` fits.

**The relay test needs a direct membership assertion, not only behaviour.** "The relay does not pick up
a `recording` item" can pass even if `recording` is wrongly added to `ACTIVE_OUTBOX_STATUSES`, because
some other guard might still skip it. Assert the membership _and_ the behaviour.

## 3. Ownership: exclusion in a lock document, fencing on the item

Two mechanisms with two different jobs. Revision 1 had both, but put the fencing token in the wrong
place, which made it unimplementable.

### 3.1 Exclusion — a singleton lock document says WHICH item is live

"Look for a live recording, then create one" is a check-then-insert across **different primary keys**,
so two tabs starting simultaneously both see nothing and both insert. RxDB conflict handling cannot
help: conflicts are per-document, and these are different documents.

Acquisition therefore contends on **one document with a fixed key**, via RxDB's `local-documents`
plugin. It holds only the pointer:

```
local document "capture-lock" = { itemId }
```

Two requirements review found missing:

- **`localDocuments: true` must be passed at database creation.** Registering the plugin is not enough;
  without the option `getLocalDocStateByParent()` throws `LD8`, and the current `createRxDatabase` call
  does not pass it.
- **An init protocol, because `incrementalModify` needs the document to exist.** Two first-ever callers
  cannot both modify a missing document, and `upsertLocal` is an unconditional replace that would let
  the loser clobber the winner. So: `insertLocal` and treat a conflict as "someone else created it",
  then re-read and contend through `incrementalModify`. Never `upsertLocal`.

Once it exists, `incrementalModify` on a local document goes through RxDB's incremental write queue and
retries against the current stored document after a 409 — genuine compare-and-set. **Only one tab may
record at a time**; the loser refuses to start with a clear reason.

### 3.2 Fencing — the owner token lives ON the outbox item

A lease alone cannot be safe, because **wall-clock staleness cannot distinguish "tab died" from "phone
backgrounded and suspended timers."** A suspended tab is still alive and still holds the
`MediaRecorder`; it will wake and try to keep appending.

**Revision 1's fix does not work.** It kept the token in the lock document and required every
attachment write to re-check it "inside the guarded modify". That is not implementable: `putAttachment`
hashes the blob and submits a modifier that receives only the outbox document's `_attachments` map, with
no opportunity to read the local document atomically. Worse, RxDB's conflict retry re-runs that modifier
against the **latest** revision, so this ordering stays possible — and the retry is what makes it land:

1. Suspended tab A wakes and reads its still-current token.
2. Tab B claims recovery and replaces the token.
3. B writes canonical, queues the item, deletes the chunks.
4. A's already-issued `putAttachment` commits **on top of B's recovered state**.

So the fence must participate in the same mutation as the thing it guards. A top-level field on the
outbox document:

```
capture: { owner: string; leaseAt: string }   // persisted, top-level, NOT nested in preview
```

Every chunk write, canonical write, heartbeat, stop and finalisation is a **single guarded
`incrementalModify` on that document** that compares `capture.owner` and rejects on mismatch. Because
the comparison and the mutation are one write against one document, the retry-against-latest behaviour
now works _for_ us: a stale writer's modifier re-runs, sees the new owner, and throws instead of
applying.

This does not recreate the nesting problem that moved the lease out of `preview` in the first place.
That problem was a _shallow-patch_ hazard from burying ownership inside the preview object; `capture` is
a sibling of `status`, written only through guarded modifies that reconstruct what they touch.

**Two residual hazards the design must name, because a token check alone does not cover them:**

- **A write already issued before takeover.** The guarded modify is what stops it landing — not the
  session's own bookkeeping. Any code path that writes an attachment without the guard is a bug.
- **`MediaRecorder` emits a final `dataavailable` when stopped.** That event fires _after_ a takeover is
  detected, so its handler must pass the same fence rather than assuming "we already stopped".

### 3.3 Recovery holds a renewable lease, not a one-shot claim

Recovery spans attachment reads, merge, main-thread decode, canonical write and cleanup. **None of that
can run inside `incrementalModify`**, which takes a synchronous modifier — so revision 1's "recovery
runs inside an incrementalModify" was not implementable.

Recovery therefore has three phases, and **the claim is itself a lease**:

1. **Claim.** A guarded modify that re-checks staleness and writes a fresh `capture.owner` plus
   `leaseAt`. Losing means another tab owns recovery; stop.
2. **Work.** Merge, decode-verify, write canonical, finalise — every mutation guarded by the token per
   §3.2, and **`leaseAt` renewed on a timer throughout**, because this phase is unbounded in duration.
3. **Release.** Delete chunks, clear the lock document.

Revision 1 left the claim non-expiring, which review correctly identified as broken in both directions:
without renewal, another leader eventually decides a long recovery is stale and enters phase 2
concurrently; without expiry, a tab that dies mid-recovery blocks the item forever. **A renewed lease is
the only shape that handles both.** The recovery lease gets its own, shorter duration than the recording
lease, since a recovering tab is actively working rather than possibly asleep.

**Belt and braces:** register RxDB's `leader-election` plugin and run recovery **only in the leader
tab**. `database.ts:108` already says multi-instance mode _"is what gives us leader election later"_ —
this is later. It is not sufficient alone (leadership can transfer mid-recovery), which is why phase 1
still fences.

## 4. Commit and crash-interruption states

RxDB cannot span the canonical write, the status change, and chunk deletion in one transaction. The
order is load-bearing and every interruption point needs a defined answer.

**Order: (1) write canonical attachment → (2) status `recording → queued` → (3) delete chunks.**

| Interrupted after | On-disk state                         | Recovery                                          |
| ----------------- | ------------------------------------- | ------------------------------------------------- |
| — (before 1)      | `recording`, chunks only              | Merge, decode-verify, write canonical → (2) → (3) |
| 1                 | `recording`, canonical **and** chunks | Canonical exists: **skip the merge**, go to (2)   |
| 2                 | `queued`, canonical and chunks        | Harmless; run (3) idempotently                    |
| 3                 | `queued`, canonical only              | Nothing to do                                     |

Recovery's first question is always **"does the canonical attachment exist?"**, never "are there
chunks?". `queued` before canonical would recreate the exact relay race `recording` exists to prevent;
deleting chunks before the canonical commit could lose the recording. Both orderings are forbidden.

**After recovery queues an item it calls `syncNow()`.** The relay drains only on `syncNow()`, startup,
or a connectivity edge — it has no timer and does not subscribe to outbox changes. Without this
explicit trigger a recovered recording sits in `queued` until something unrelated wakes the relay.

### 4.1 Recovery decode-verifies — what that does and does not prove

`MediaRecorder`'s container is **negotiated, not assumed**: `recorder.ts` supports
`audio/webm;codecs=opus`, `audio/mp4;codecs=opus` and `audio/mp4` so Safari works. Concatenated WebM
chunks form a valid file because chunk 0 carries the header and the rest are clusters — **that argument
does not hold for MP4**, which can depend on container metadata written at finalisation.

So recovery never assumes a merge worked:

1. Merge the chunks.
2. **Decode-verify** with `decodeAudioData` — on the main thread, since `AudioContext` is Window-only
   and the worker cannot decode.
3. On failure, retry with the last chunk dropped (a crash can leave a partial final cluster).
4. On repeated failure, leave the item in `recording` with an `unrecoverable-audio` marker in
   `lastError` and the chunks **intact**. Surface it. Never write a canonical attachment that does not
   decode, and never silently discard the bytes.

Verification is worth having for a concrete reason: the transcriber decodes through the same
main-thread `decodeAudioData` route, so a blob that decodes here will decode there.

**What it does not prove, stated plainly because revision 1 overclaimed.** It establishes decodability,
not completeness. It cannot tell us that every emitted chunk was persisted, that the decoded duration
contains all recoverable speech, that a permissive decoder did not accept a truncated tail, or that
dropping the last chunk did not discard a timeslice of perfectly good audio — after a crash there is no
expected duration to compare against. So **what becomes container-independent is detection of outright
decode failure**, not detection of silent truncation. Revision 1 said "correctness is
container-independent", which was too strong.

**MP4 chunk recovery remains unverified.** The harness is Playwright Chromium, so a passing test proves
WebM only.

**One path around this rule must be closed.** §1's chunk-write-failure fallback writes the in-memory
Blob directly as canonical — and §4's recovery treats canonical existence as sufficient and skips the
merge _and the verification_. So a bad canonical could be queued having never passed the check. **That
fallback write must itself decode-verify before committing**, on the same terms as step 2.

`durationMs` on a recovered recording comes from the **decoded** audio, not the wall clock, which died
with the app.

## 5. Recording metadata lifecycle

The item now exists before capture ends, and the current contracts cannot express that:

- `capturedAt` means "when capture finished" and `durationMs` is the final duration; the recorder does
  not mint the id or metadata until `stop()`.
- **`OutboxPatch` deliberately excludes `recording`**, so no final `durationMs` is writable at all.

The changes:

- **`capturedAt` becomes capture START.** Natural for an item that exists during capture, and available
  at `start()`. No in-repo runtime reader depends on the old meaning — queue ordering uses `seq`,
  display uses `enqueuedAt` — but its **documented meaning and tests must change**, since
  `recording.ts` currently declares capture-finish.
- **`durationMs` is `0` while recording**, written at commit.
- **A narrow `finalizeRecording(id, { durationMs })`**, legal only on the guarded `recording → queued`
  transition, rather than widening `OutboxPatch`. The exclusion exists for good reason; a dedicated
  method keeps it intact for everything else.

### 5.1 Start ordering, and who owns what

**`Recorder.start()` is already `async`** — revision 1 claimed it "becomes async", which is simply
wrong. What changes is its _result_ and its _dependencies_, and both are published contract rather than
implementation detail.

The ordering, which is observable:

1. **Acquire the lock (§3.1)** — refuse early if another tab is recording, **before** touching the mic.
2. Request microphone permission.
3. Negotiate the MIME type from the live `MediaRecorder` (it must exist first; the type is what the
   real recorder reports, never a guess).
4. Insert the outbox row in `recording` with that type, `capturedAt`, and `capture.owner`.
5. Start `MediaRecorder` with the timeslice.

**Failure at any step unwinds the ones before it**, using the existing teardown path so the instance
returns to `idle` and stays reusable. Specifically: permission denial after acquiring the lock must
release it, or one refusal locks recording out until the lease expires; and a failure _after_ row
creation must delete the provisional row. **If the unwind itself fails** — the row cannot be deleted, or
the lock cannot be released — the lock is left to expire by lease rather than being force-cleared, and
the orphan row is picked up by startup discovery (§8) like any other interrupted recording.

**Ownership, which revision 1 did not address at all.** The new sequence needs an `Outbox` at capture
time, and today the separation is deliberate: `Recorder.stop()` returns a `Capture`, and the React hook
optionally enqueues it afterwards, with `useRecorder({ enqueue: false })` an explicitly supported
outbox-free mode.

The resolution keeps that split intact:

- **`Recorder` does not gain an `Outbox`.** Durable capture is a _separate collaborator_ — a capture
  session object constructed with the outbox — that the recorder reports chunks to. Recorder keeps
  owning `MediaRecorder`, MIME negotiation and its state machine.
- **`useRecorder({ enqueue: false })` keeps working and gets no durability**, which is the honest
  behaviour: no outbox means nowhere to persist. This must be said out loud, since a caller might
  otherwise assume crash-safety came for free.
- **`start()` returns the item id** when durable capture is active, so the caller can subscribe to the
  item immediately. `Capture` and `StopResult` keep their shapes; with durable capture the audio is
  already on disk, so enqueueing is a status transition rather than a first write.
- **Startup discovery (§8) is owned by the outbox side, not the recorder**, and it calls the relay's
  `syncNow()` through the same injected seam the host already wires — storage does not acquire relay
  policy.

## 6. Reporting contracts that change

### 6.1 `workSafety` stays `protected` during healthy recording — and the signal is plumbed

**The policy.** An earlier draft downgraded `protected` for the whole duration of every recording, on
the grounds that the tail between `dataavailable` events is not on disk. That is the wrong trade: the
risk that the last moment of a recording may be lost is well understood by anyone who has used a
recording app, `workSafety` answers _"is the work I have already done safe?"_, and a warning that fires
on **every single recording** is noise that teaches the user to ignore the one time it matters.

**What warrants a downgrade is persistence actually falling behind** — a real, detectable condition:

- a chunk write has **failed**, or
- outstanding writes in the persistence chain **exceed a documented threshold**, so materially more than
  one timeslice is at risk.

Either reports `at-risk`.

**The honesty problem, and how it is resolved.** `protected` is currently documented as meaning on-device
work survives _"reload/crash/eviction"_, and audio sitting in the current timeslice does not. Review is
right that keeping `protected` overstates that level as written. The resolution is **not** to weaken the
report but to narrow what the level claims: `protected` means _everything flushed to disk is safe_, and
`recording` carries a distinct **reason** naming the unflushed tail. The level stays stable so it retains
its signalling value; the reason carries the nuance. `work-safety.ts`'s own documentation changes with
it, because a level whose stated meaning no longer matches its computation is worse than either option.

**The signal has to be plumbed, which revision 1 assumed rather than specified.** It cannot work today:
`summarizeWork()` takes only `status`; `workSafety()` receives aggregate counts, the storage grant and
connectivity; and persistence-chain depth is **ephemeral capture-session state that never reaches the
classifier**. A failed chunk write leaves `status: recording` plus a marker, which the current classifier
would still call `protected`.

So:

- The capture session exposes a small **capture-health** value: `flushing` (healthy) or `behind` (a write
  failed, or outstanding writes exceed the threshold).
- `workSafety()` accepts it as an optional input alongside storage persistence and connectivity — the
  same shape as the other ambient facts it already takes, so nothing about its purity changes.
- `useWorkSafety()` composes it from the active capture session, exactly as it already composes the
  outbox, the storage grant and connectivity.
- `WorkSafety` gains the new reason for the recording case, and `at-risk` gains one for `behind`.

Absent the input — no recording in progress, or a host that does not wire it — behaviour is exactly as
today.

### 6.2 `hasAudio` is renamed, because during recording it is simply wrong

`hasAudio` is projected from the existence of `AUDIO_ATTACHMENT_ID`. A recording row holds chunk
attachments but no canonical one, so it would project `hasAudio: false` — and the playground renders
that as **"the bytes were dropped"** (`ItemAudio.tsx`). That is not ambiguous, it is false: the item
demonstrably _has_ audio, in chunks, on disk.

Adding a second field beside a misleading one would preserve the wrong name. **Rename it instead:**

```
hasAudio  ─►  audioReady    // the canonical, playable attachment exists
```

`audioReady` says what the flag has always actually meant — the merged attachment is present, so it can
be played and the relay can transcribe it. Consumers branch on it exactly as before.

`audioBytes` then widens to mean **durable bytes on disk for this item**, summing chunk attachments
while recording and the canonical attachment afterwards. So a UI can show capture progressing rather
than reporting nothing.

**"Not yet" and "dropped" are then already distinguishable with no third field**, which is why this
shape is simpler than the one it replaces:

| State                       | `status`            | `audioReady` | `audioBytes`   |
| --------------------------- | ------------------- | ------------ | -------------- |
| Capturing                   | `recording`         | `false`      | growing        |
| Ready                       | `queued`+           | `true`       | canonical size |
| Dropped after transcription | past `transcribing` | `false`      | `0`            |

Both keys stay **projected, never stored** (`DERIVED_OUTBOX_ITEM_KEYS`), so this is a public API rename
with **no schema migration** — the storage schema never mentioned them. It is a breaking change for
consumers and the changeset must say so.

## 7. Schema migration — needed, but only because of `capture`

Revision 1 asserted v2 was required because "persisted fields change". Review showed that did not follow
from anything it described: `status` is stored as a bounded string with **no enum**, so a new value needs
no migration; `capturedAt` changes meaning, not shape; `durationMs: 0` is already legal; and `lastError`
already exists for the error marker.

**The fix in §3.2 is what makes v2 genuinely necessary.** Moving the fencing token onto the outbox
document adds a real persisted field:

```
capture: { owner: string; leaseAt: string }   // optional; present only while recording
```

So: `outboxRxSchema` goes to **version 2** with a migration strategy. The strategy is mechanical — no v1
document can have been recording, so v1 documents pass through with `capture` absent.

`audioReady` and `audioBytes` (§6.2) need **no** migration, confirmed in review: both are in
`DERIVED_OUTBOX_ITEM_KEYS`, projected and never stored, and the storage schema deliberately never
mentioned them.

## 8. Startup discovery

Recovery cannot search only the lock document. A failed lock release, or a crash between §4's steps,
leaves document state that needs cleanup independently of whether the lock still points at it. Startup
therefore scans for **two** conditions:

- **`recording` rows whose `capture.leaseAt` is stale** → full recovery per §3.3 and §4.
- **`queued` rows that still hold chunk attachments** → interrupted after step 2; run step 3's deletion
  idempotently. No merge, no status change.

Both run **in the leader tab only** (§3.3), before `relay.start()`, so a recovered item is `queued` with
its canonical attachment in place before the relay could select it. Recovery then calls `syncNow()`,
because the relay drains only on `syncNow()`, startup, or a connectivity edge — it has no timer and does
not subscribe to outbox changes, so without the explicit call a recovered recording sits until something
unrelated wakes it.

Note the relay's existing concurrency guard is **per-instance, not cross-tab**; leader-gating recovery is
what keeps two tabs from recovering at once, and the §3.2 fence is what makes being wrong about that safe
rather than corrupting.

## 9. Consumer-visible API changes, declared

`OutboxStatus` and `OutboxItem` are public types. Adding `recording` grows a union consumers may switch
on exhaustively — a compile-time break — and the projection gains a field. `Recorder.start()` becomes
async. These are the right trades against the relay transcribing a non-existent attachment, but they
are **breaking changes and the changeset must say so**, not be described as additive.

## 10. Testing

**Seven that must be able to fail**, each easy to write so it does not:

- **Two tabs starting simultaneously: exactly one wins.** Contend on the lock document concurrently; a
  sequential test proves nothing about the race. Include the **first-ever** case, where the document does
  not yet exist and both callers race `insertLocal`.
- **A suspended owner that wakes after recovery cannot write.** Session A holds the token, another tab
  recovers, then A attempts a chunk write — refused, and A stops. **This is the split-brain case, and a
  staleness test alone passes while it is still broken.**
- **A write issued BEFORE takeover but committing after it is rejected.** The stronger version of the
  above, and the one that would have caught revision 1's mistake: the guard, not the session's own
  bookkeeping, is what stops it. Include the final `dataavailable` that `MediaRecorder` emits on stop.
- **A recovery that outlives the recording lease is not taken over**, because it renews. And a claimant
  that stops renewing **is** eventually taken over. Both halves, or it only proves one.
- **`workSafety` reports `protected` with a distinct reason during healthy recording, and `at-risk` when
  capture health is `behind`.** Revision 1's test asserted recording "does not claim full `protected`",
  which directly contradicted §6.1 — both could not pass. This replaces it.
- **A truncated final chunk recovers via drop-last-and-retry; one that cannot decode at all leaves the
  item recoverable with chunks intact.** And **the chunk-write-failure fallback decode-verifies before
  writing canonical** — the path around the rule.
- **`audioReady` is `false` while `audioBytes` is non-zero mid-recording**, the pair that stops a UI
  reporting dropped bytes; plus `recording` membership asserted directly in each status list, alongside
  the relay behaviour test.

Also: every row of the §4 interruption table against a reopened database, including a `queued` row with
leftover chunks; recovery idempotent under two attempts; merge ordering and decode-verification in real
Chromium; `start()` unwinding cleanly when permission is denied after the lock is acquired, and when the
unwind itself fails; `useRecorder({ enqueue: false })` still working with no durability; and the v1→v2
migration on a database with existing documents.

## 11. Open questions

- **The lease staleness threshold.** Must exceed realistic suspension, but a long threshold delays
  recovery after a genuine crash. Fencing (§3.2) means being wrong is _safe_ rather than corrupting,
  which is what makes a generous default acceptable.
- **MP4 chunk recovery is unverified** (§4.1). It fails honestly rather than silently, but the success
  rate on Safari is unknown and cannot be measured in this harness.
