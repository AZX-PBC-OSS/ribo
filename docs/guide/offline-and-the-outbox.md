# Offline & the Outbox

An auditor in a basement has no signal. The recording still has to happen, the transcript still has
to get made, and none of it can wait for a network that might not come back for an hour. `@azx/ribo-core`
answers this with a durable outbox — an RxDB collection every capture lands in the instant it's
made — and a foreground relay that drains it whenever connectivity allows. The outbox is the only
path a capture ever takes, online or not.

The browser-platform mechanics underneath this page — the service worker, storage persistence, the
ORT runtime cache — are [Offline-first](/offline-first/).

## Two state machines, not one

A capture starts life as a **recording** and, once its session is closed, produces work for a
**session** — and those are two different documents with two different state machines, not one
long pipeline. [Sessions](/guide/sessions) covers the structural argument for the split — extraction,
review and write don't know or care whether the text they're operating on came from a microphone or
a scanned invoice, so nothing about them belongs on the recording. This page covers both machines in
full, because the relay has to act on both, and "why is this status excluded" only makes sense once
you can see the whole machine it's excluded from.

### The recording machine

```
recording → queued → transcribing → transcribed
                    ↘ (transient) → failed → (backoff elapses) → retry
                    ↘ (terminal)  → dead
                    ↘ discarded (human decision)
```

`OUTBOX_STATUSES` is exactly these seven: `recording`, `queued`, `transcribing`, `transcribed`,
`failed`, `dead`, `discarded`. The relay's job here is narrow — capture and transcription, nothing
else — and `ACTIVE_OUTBOX_STATUSES` says so directly: `queued`, `transcribing`, `failed`.
`transcribed` is deliberately **not** active. Once a recording is text, the relay is finished with
it — extraction and write happen at the session level, against the joined transcript of every
recording that belongs to it, and the recording itself never moves again except by a human decision.
`discarded` is that decision: the reviewer threw a capture away — a duplicate dictation, a photo of
the wrong invoice — and `joinSessionTranscript` excludes discarded recordings from every future
extraction, without deleting the row itself.

### The session machine

```
open → extracting → awaiting-review → writing → done ⇄ awaiting-review (reopenSessionForReview)
                        ↘ (transient) → failed → (backoff) → retry
                        ↘ (terminal)  → dead   ⇄ awaiting-review (reopenSessionForReview)
```

`SESSION_STATUSES` is `open`, `extracting`, `awaiting-review`, `writing`, `done`, `failed`, `dead`.
`ACTIVE_SESSION_STATUSES` is `extracting`, `writing`, `failed` — and two statuses are excluded on
purpose, for two different reasons. **`open`** is the host's phase: recordings are still being
captured and transcribed, and the relay transcribes them as they arrive but does not touch the
session itself until `closeSession` says the capture set is final. Starting extraction against a
partially-assembled session would be extracting the wrong set. **`awaiting-review`** is parked the
way `transcribed` is on the recording side: it is the review gate, and `submitSessionReview` is the
only way out — nothing about the pipeline advances a parked session on its own. `done` and `dead`
both have a human-driven way back in, through `reopenSessionForReview`, which the recording machine
has no equivalent of: there is no path back from a recording's `dead` or `discarded`.

### Why the split exists

A recording is finished once it is text; everything downstream belongs to the session, which
structurally cannot know what produced its transcript. [Sessions](/guide/sessions) covers the
structural argument in full. Both machines appear here because the relay acts on both.

### `failed` is resting, `dead` is terminal

Both machines share this shape. **`dead` is the only terminal state** in either machine. **`failed`
is a resting state** — the relay picks it back up once
`nextAttemptAt` has passed, which is exactly why `failed` sits in both `ACTIVE_OUTBOX_STATUSES` and
`ACTIVE_SESSION_STATUSES` alongside the in-flight statuses. An item or session becomes `failed` when
the last attempt lost, the error looked transient, and the attempt budget isn't spent; it becomes
`dead` only by exhausting `maxAttempts` or by a failure classified terminal outright.

## Backoff and retry

`isTransientFailure` (`packages/ribo-core/src/queue/backoff.ts`) is the retry classifier: retry 5xx,
429, and network errors; treat 4xx as terminal, except 408 and 429. Its default for an error it
doesn't recognize is `true` — retry it — and that asymmetry is deliberate. A wrongly-retried terminal
failure costs a few pointless requests and lands at `dead` once attempts run out. A wrongly-`dead`
transient failure silently loses a field recording nobody can recreate. A bare `TypeError` from
`fetch` when the uplink drops is the most likely error this queue will ever see, and it has to retry.

`fullJitterDelay` computes the wait: `delay = min(cap, base · 2^attempts) · random()`, persisted into
`nextAttemptAt` rather than held in a timer — the tab may not survive to run that timer, and the
schedule has to be there on the next load regardless. Full jitter rather than a fixed exponential
curve is about decorrelation: several devices that lost the same flaky uplink come back at the same
instant, and a deterministic curve has every one of them retry in lockstep. Drawing uniformly over
the whole window spreads them out instead.

## `createRelay`

```ts
import { createRelay } from "@azx/ribo-core";

const relay = createRelay({
  outbox,
  transcriber,
  sessionExtract,
  sessionWrite,
});

await relay.start(connectivity);
```

The relay drains in two phases, in order: it first tries to transcribe the next pending recording,
and only when there is none does it try to extract or write the next pending session. Recordings go
first because session-level extraction joins transcripts — a recording still `queued` or
`transcribing` would simply be missing from the text a session-level extraction ran against, and
running the session step first would extract against an incomplete set. Both phases process one item
at a time, lowest `seq` (recordings) or `openedAt` (sessions) first, holding a per-item or
per-session Web Lock for the duration — which is how two tabs draining the same outbox stay out of
each other's way without a server to arbitrate.

There is no background drain and no timer. iOS Safari has no Background Sync API, so `syncNow()` runs
on demand — at startup, on a reconnect, or from an explicit "sync now" affordance — not on a schedule
iOS would never fire.

## Connectivity: three states, not a boolean

`navigator.onLine` reports link-layer state, and a captive portal, a wifi AP with no backhaul, or a
tower with no route all report `true` while every request hangs. `createConnectivity` replaces the
boolean with three states — `offline`, `probing`, `online` — and hysteresis: `false` from
`navigator.onLine` is trusted immediately, but `true` only starts a reachability probe, and a single
healthy probe isn't enough to call it `online` either. The model holds `probing` across a stability
window and only asserts `online` once the probe has stayed healthy for the whole window — a few
seconds by default. This hysteresis is deliberately one-directional: going offline stays instant —
you never want to delay recognizing a loss — while only a recovery is held across the stability
window.

The relay does not resync on every `online` reading. It watches for the **edge into `online` from a
prior state that wasn't already `online`** — a transition, not a level — so a connection that is
already `online` doesn't retrigger a drain on every redundant emission, and the first state a
subscriber ever sees (which has no prior to compare against) never itself triggers a sync. This is
what keeps a flapping connection from thrashing the relay: drain, fail, back off, drain again is
exactly the loop a naive "resync whenever the browser says online" would produce, and the stability
window plus the edge-triggered resync are both there to prevent it.

## `workSafety` and `summarizeWork`: the one honest answer

An auditor needs one sentence that answers "is my work safe?" honestly, and `workSafety` is that
sentence's classifier. It's a pure function over three facts — the outbox's summarized state, the
storage persistence grant, and connectivity — and it never overstates safety: `safe` is reserved for
the case where no unsynced work remains on the device at all, because eviction and a lost device
both take a persisted-but-unsynced item along with everything else the browser is holding for you.
Everything short of that is `protected` (persisted, still on-device) or `at-risk` (not persisted, or
a capture whose writes have stalled), and a permanently-`dead` item outranks all of it as
`action-required`, because no amount of waiting fixes it.

`summarizeWork` is the reduction that feeds it: recordings and sessions in, a `WorkOnDevice` count
out — `pending`, `dead`, `synced`, plus `awaitingReview` and `openSessions` as named subsets of
`pending` rather than separate buckets. A `transcribed` recording is counted through its session, not
on its own, and a `discarded` one is counted nowhere — both already left the relay's active set for
the reasons the state machines above give.

## The storage seam: `openOutbox({ storage })`

```ts
import { openOutbox } from "@azx/ribo-core";

const outbox = await openOutbox(); // Dexie (IndexedDB), the browser default
```

`openOutbox` takes an optional RxDB `storage` engine and threads it through to `createRxDatabase`.
Left unset, it defaults to `getRxStorageDexie()` — the free, IndexedDB-backed engine every browser
build uses — lazily constructed, so a caller who injects something else never even touches Dexie.
Tests that need no browser at all inject `getRxStorageMemory()` from `rxdb/plugins/storage-memory`
instead, and get a real `Outbox` with real durability semantics minus the IndexedDB dependency.

This is a deliberate Level 1 seam: `Outbox` stays a concrete class over RxDB, and injecting the
storage engine is the whole of what's exposed. Extracting a formal `Outbox`
interface, with a storage conformance-test kit a second backend would have to satisfy, is deferred
until a genuinely non-RxDB backend is real — writing that interface now would be a contract with
exactly one implementation, which locks in RxDB's shape while pretending the seam is more general
than it is.

## Durable capture

A recording is written to disk as it's made, not merely held in memory until `stop()` — so a crash,
a killed tab, or a dropped-and-relaunched app mid-recording loses at most the last few seconds, not
the whole capture.

```ts
import { openCaptureSession } from "@azx/ribo-core";

const session = await openCaptureSession({ outbox, recording, sourceId, mimeType, sessionId });
mediaRecorder.ondataavailable = (e) => session.ingest(e.data);
mediaRecorder.onstop = () => session.finalize();
```

`openCaptureSession` inserts the row in `recording` status up front and returns a session that
ingests each `MediaRecorder` chunk as its own RxDB attachment, named from an immutable
`capture.sourceId`. `session.health$` reports `"flushing"` (chunks are landing, which is the normal
state of a live recording) or `"stalled"` (a chunk write failed, or nothing has arrived past a
threshold) — and `workSafety` takes that health as an input, so a stalled capture reports `at-risk`
regardless of what the persistence grant says. The stall threshold is a placeholder pending
validation against a real backgrounded device, not a tuned constant.

Cross-tab exclusion during capture and during a relay step both use the Web Locks API
(`packages/ribo-core/src/queue/capture-lock.ts`) — **exclusion only, not write authorization**. A
lock can be released while its holder's execution context survives (the bfcache case), so nothing
here treats "I'm holding the lock" as a durability guarantee on its own; recovery below is what makes
being wrong about that cheap rather than corrupting.

At startup, `recoverInterrupted` looks for rows still in `recording` status — meaning nothing holds
`CAPTURE_LOCK` for them, so no live session is writing to them — and, for each one, tries to merge and
decode its chunks. A successful decode inserts a **new** row, `queued`, carrying the recovered audio
and the original's metadata, then marks the original `dead` naming its successor; a chunk set that
still won't decode after dropping its last (possibly truncated) chunk is left `dead` with its chunks
intact. There is no half-recovered state and no silent repair — an interrupted recording becomes a
visible orphan the relay picks up like any other queued item, or a dead row an operator can look at,
never something the app quietly patches over.

## Next

[Storage & Eviction](/offline-first/storage-eviction) covers the other half of "is my work safe" —
what happens when the browser reclaims the space the outbox lives in, and how that's made visible
rather than silent.
