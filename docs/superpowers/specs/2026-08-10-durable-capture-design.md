# Durable capture — audio survives a crash mid-recording

**Status:** Design. Piece 1 of 2. Not yet planned or implemented.
**Date:** 2026-08-10

> **Why this document exists.** It was split out of
> `2026-08-08-live-transcription-design.md` after two review rounds on that
> combined design failed to converge. Every critical finding in both rounds landed in
> **durability and ownership**, none in the live preview itself. This piece is therefore
> specified and shipped first, on its own merits; live preview (piece 2) builds on it.

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
Worst-case loss is bounded at one timeslice.

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

## 3. Ownership: a lock document plus a fencing token

Two mechanisms, because they solve two different problems. Either alone is insufficient.

### 3.1 Atomic acquisition — a singleton lock document

"Look for a live recording, then create one" is a check-then-insert across **different primary keys**,
so two tabs starting simultaneously both see nothing and both insert. RxDB's conflict handling cannot
help: conflicts are per-document, and these are different documents.

Acquisition therefore goes through **one document with a fixed, well-known key**, via RxDB's
`local-documents` plugin (present in the installed RxDB; needs registering alongside `attachments` and
`migration-schema`):

```
local document "capture-lock" = { itemId, owner, leaseAt }
```

Because every tab contends on the _same_ key, `incrementalModify` gives genuine compare-and-set: one
tab wins, the other observes the winner and refuses to start with a clear reason. **Only one tab may
record at a time.**

The lock lives here and **not on the outbox item** — revision 2 of the combined design put the
heartbeat inside `preview`, which was wrong twice over: shallow patches mean a heartbeat carrying a
stale nested object can erase a sibling field, and it made "no preview when live is unavailable"
internally false, since locking would still require the field. **Ownership is a lifecycle concern, not
preview content**, and piece 2 must not move it back.

### 3.2 Fencing — check the token on every write

A lease alone cannot be safe, because **wall-clock staleness cannot distinguish "tab died" from "phone
backgrounded and suspended timers."** A suspended tab is still alive and still holds the
`MediaRecorder`; it will wake and keep appending chunks to an item another tab already recovered and
queued. `incrementalModify` serializes document writers but cannot revoke a live `MediaRecorder`.

So the lease decides only when another tab **may** take over, and safety comes from a **fencing
token**: each recording session mints a random `owner`, and **every** chunk write, heartbeat, stop and
finalisation re-checks it inside the guarded modify. A session whose token no longer matches — or whose
item is no longer `recording` — **stops capture immediately** and surfaces that its recording was taken
over. Ownership is enforced at the point of mutation, where a suspended clock cannot fool it.

This is what makes the design safe under suspension rather than merely unlikely to break.

### 3.3 Recovery is claimed, not merely guarded

Recovery spans attachment reads, merge, decode, canonical write, and cleanup. **None of that can run
inside `incrementalModify`**, which takes a synchronous document modifier — so "recovery runs inside an
incrementalModify" (revision 2's claim) is not implementable. Two recoverers could otherwise both start
from the same chunks, one deleting while the other reads.

Recovery therefore has three phases:

1. **Claim.** A guarded modify on the lock document that re-checks staleness and writes a fresh
   `owner`. Losing the race means another tab owns recovery; stop.
2. **Work.** Merge, decode-verify, write canonical, finalise — all under the claimed token, re-checked
   before each mutation per §3.2.
3. **Release.** Delete chunks, clear the lock.

**Belt and braces:** register RxDB's `leader-election` plugin and run recovery **only in the leader
tab**. `database.ts:108` already says multi-instance mode _"is what gives us leader election later"_ —
this is later. Leader election alone is not sufficient (leadership can transfer mid-recovery), which is
why the claim in phase 1 still fences.

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

### 4.1 Recovery verifies by decoding — this is what makes it container-honest

`MediaRecorder`'s container is **negotiated, not assumed**: `recorder.ts` deliberately supports
`audio/webm;codecs=opus`, `audio/mp4;codecs=opus` and `audio/mp4` so Safari works. Concatenated WebM
chunks form a valid file because chunk 0 carries the header and the rest are clusters — **that argument
does not hold for MP4**, which can depend on final container metadata written at finalisation.

So recovery never _assumes_ a merge worked:

1. Merge the chunks.
2. **Decode-verify** with `decodeAudioData`.
3. On failure, retry with the last chunk dropped (a crash can leave a partial final cluster).
4. On repeated failure, leave the item in `recording` with an `unrecoverable-audio` marker and the
   chunks intact. Surface it. **Never write a canonical attachment that does not decode**, and never
   silently discard the bytes.

Decode-verification is what makes correctness independent of container: the difference between WebM and
MP4 becomes a difference in _success rate_, not in whether we can tell. **This is stated as an explicit
limitation: MP4 chunk recovery is unverified.** The test harness is Playwright Chromium, so a passing
test proves WebM only. Claiming otherwise would be exactly the kind of untested assertion this project
has been bitten by.

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

### 5.1 `Recorder.start()` becomes async and ordered

`start()` returns `void` today and mints nothing. It must now produce the id and `capturedAt` up front,
and the ordering is observable API, not an implementation detail:

1. Acquire the lock (§3.1) — **refuse early** if another tab is recording, before touching the mic.
2. Request microphone permission.
3. Negotiate the MIME type from the live `MediaRecorder`.
4. Insert the outbox row in `recording` with the negotiated type and `capturedAt`.
5. Start `MediaRecorder` with the timeslice.

**Failure at any step unwinds the ones before it** — a released lock and no orphan row. Permission
denial after acquiring the lock must release it, or one refusal locks recording out until the lease
expires.

## 6. Reporting contracts that change

### 6.1 `workSafety` stays `protected` during normal recording

An earlier draft downgraded `protected` for the whole duration of a recording, on the grounds that the
tail between `dataavailable` events is not yet on disk. **That is the wrong trade.**

The risk that the last moment of a recording may not be saved is well understood by anyone who has used
a recording app, and it is not what this report is about — `workSafety` answers _"is the work I have
already done safe?"_, and a bounded 5-second tail is not that work. Worse, a warning that fires on
**every single recording** is not a signal; it is noise that teaches the user to ignore the one time it
matters. `protected` therefore keeps its meaning and its value during healthy recording.

**What does warrant a downgrade is persistence actually falling behind** — a real, detectable condition
rather than a permanent property of recording:

- a chunk write has **failed**, or
- outstanding chunk writes in the persistence chain **exceed a documented threshold**, meaning far more
  than one timeslice is at risk.

Either condition reports `at-risk`. This is strictly more useful than the constant downgrade: it stays
quiet when things are fine and speaks up exactly when the durability guarantee is genuinely degrading.

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

## 7. Schema migration

Persisted fields change, and `outboxRxSchema` is currently **version 1** with the only declared
strategy being the migration to v1. This needs **version 2** and a strategy — reopening an existing
database with an altered same-version schema is not a valid rollout.

Migration is mechanical: no existing document can be in `recording`, so v1 documents pass through
unchanged. _(The project has no users yet, so this carries no back-compatibility burden beyond doing
it correctly.)_

## 8. Consumer-visible API changes, declared

`OutboxStatus` and `OutboxItem` are public types. Adding `recording` grows a union consumers may switch
on exhaustively — a compile-time break — and the projection gains a field. `Recorder.start()` becomes
async. These are the right trades against the relay transcribing a non-existent attachment, but they
are **breaking changes and the changeset must say so**, not be described as additive.

## 9. Testing

Six that **must be able to fail**, each easy to write so it does not:

- **Two tabs starting simultaneously: exactly one wins.** Contend on the lock document concurrently.
  A sequential test proves nothing about the race.
- **A suspended owner that wakes after recovery cannot write.** Simulate: session A holds the token,
  another tab recovers, then A attempts a chunk write. It must be refused and A must stop. **This is
  the split-brain case; a staleness test alone passes while it is still broken.**
- **`workSafety` never reports plain `safe` with a recording in progress** — and does not claim full
  `protected` either.
- **A deliberately truncated final chunk recovers via drop-last-and-retry**, and one that cannot decode
  at all leaves the item recoverable with chunks intact rather than writing a bad canonical attachment.
  A clean tail proves nothing.
- **`recording` membership** in each status list, asserted directly, alongside the relay behaviour test.
- **`hasAudio` is `false` but the accruing-bytes fact is non-zero mid-recording** — the pair that stops
  a UI reporting dropped bytes.

Also: every row of the §4 interruption table against a reopened database; recovery idempotent under two
attempts; merge ordering and decode-verification in real Chromium; `start()` unwinding cleanly when
permission is denied after the lock is acquired; and the v1→v2 migration on a database with existing
documents.

## 10. Open questions

- **The lease staleness threshold.** Must exceed realistic suspension, but a long threshold delays
  recovery after a genuine crash. Fencing (§3.2) means being wrong is _safe_ rather than corrupting,
  which is what makes a generous default acceptable.
- **MP4 chunk recovery is unverified** (§4.1). It fails honestly rather than silently, but the success
  rate on Safari is unknown and cannot be measured in this harness.
