# Important Defaults

Ribo makes a lot of decisions for you so the [Quick Start](/guide/quick-start) fits on one screen.
Most of those decisions are invisible right up until one of them is wrong for your case, and then
the symptom looks like a bug rather than a default. This page exists so you recognize the symptom
and know which knob to turn.

The two entries that matter most are not about anything failing. They are about the relay
**declining to act on purpose**, which from the outside looks identical to the relay being stuck.

## The review gate parks a session, and only a submission moves it

A session that finishes extraction lands at `awaiting-review`. That status is deliberately absent
from `ACTIVE_SESSION_STATUSES`, so the relay drains past it on every run instead of retrying it —
there is nothing to retry; a human has not looked yet.

**Why:** the relay processes a strictly ordered queue. If it blocked on a person instead of moving
past a parked session, every recording behind it would stall too, and a reload mid-wait would lose
the wait entirely. Persisting the parked state, rather than awaiting a promise, is what lets review
survive the tab closing.

**The only way out is [`storage.sessions.submitReview`](/guide/review).** Nothing else advances a
parked session — not a retry, not a reload, not time passing. If a session's status needs to move
back to `awaiting-review` from `done` or `dead` (the auditor wants to correct something already
written, or already given up on), [`storage.sessions.reopenForReview`](/guide/review) is the way back
in.

**The symptom if you don't know this:** you watch storage, a session reaches `awaiting-review`,
and then nothing happens — no error, no retry, no write. It looks exactly like the pipeline hung.
It didn't; it is waiting for `storage.sessions.submitReview`, and every other extracted session behind it in
the queue kept moving.

## `open` and `transcribed` are inactive for the same reason: someone else owns the next step

Two more statuses the relay will not touch, and for the identical underlying reason as the review
gate — a boundary where the next move belongs to something other than the relay's own retry loop.

**A session sitting at `open`** is still being assembled: recordings are being captured and
transcribed into it. The relay transcribes each of those recordings, but it does not start
extraction on the session itself until the host closes it. The recording set is intentional, not
inferred — the relay has no way to know you're done adding captures except being told.

**A recording that reaches `transcribed`** is finished from the relay's perspective. The relay's
job for a recording ends there — everything downstream (extraction, review, write) belongs to the
session the recording is part of. Once a recording is `transcribed`, the session owns what happens
to its words next.

**The symptom:** an open session with fully transcribed recordings inside it never starts
extracting, and a `transcribed` recording never appears to do anything else on its own. Both are
correct. Close the session to hand extraction to the relay; the session is where you watch after
that.

## `failed` is where the relay parks something to retry, not where it gives up

`failed` shows up on both the recording side (`ACTIVE_CAPTURE_STATUSES`) and the session side
(`ACTIVE_SESSION_STATUSES`) — deliberately, because it's a resting state, not a failure state. An
item in `failed` has a `nextAttemptAt` in the future, and the relay picks it back up the moment that
passes. Retrying is the default behavior, not something you opt into.

**`dead` is the terminal one.** An item only reaches `dead` after exhausting its retry attempts (or
after a failure classified as unrecoverable — a 4xx that isn't a rate limit, for instance). `dead`
has no automatic way out; a session can be rescued with `storage.sessions.reopenForReview`, but nothing
retries a `dead` item on its own.

**The symptom:** an item you expected to have failed hard is still sitting there quietly, with no
error surfaced yet. That's the backoff window: check `nextAttemptAt` before assuming something is
wrong. Conversely, don't build retry logic of your own on top of `failed`; the relay already owns
it, using the backoff defaults below.

## Retry backoff is capped much lower than a server queue would use

Retries use full jitter — `delay = min(cap, base · 2^attempts) · random()` — with both `base` and
`cap` as named, overridable constants (`DEFAULT_BACKOFF_BASE_MS`, `DEFAULT_BACKOFF_CAP_MS`) in
`@azx/ribo-core`'s `queue/backoff.ts`. The cap is a few minutes, not the hours a server-side queue
would reach for.

**Why:** on iOS the relay only runs while its tab is in the foreground. A long backoff window mostly
means "never retried this session" rather than "retried patiently" — there's no background process
to wait it out. Full jitter (not a fixed exponential curve) is deliberate too: several devices that
lost the same flaky connection should not all retry in lockstep the instant it returns.

**The symptom:** if you expect server-style backoff measured in hours, an item retrying every few
minutes on a foreground tab looks like it's hammering something. It's tuned for a device that has to
be actively open to retry at all, not for a background worker.

## Provenance defaults to one citation per leaf

`enveloped()` derives the extraction schema with every leaf at `"leaf"` granularity unless you say
otherwise — one `sourceSpan` per field. A group absent from the `provenance` map you pass stays at
`"leaf"`, which is what keeps the option additive rather than something every existing schema has to
opt into.

**Why leaf is the default:** it's the finest-grained citation there is, and it's what every field
had before per-group granularity existed at all — nothing changes for a schema that doesn't ask for
anything different.

**The symptom if it's wrong for you:** a wide, repetitive group — a table of test readings, say —
comes back with a citation on every cell, which is both a token cost and, measured on a real report,
a fabrication risk: per-cell citations on one such table came back **37% fabricated**, where per-row
citations on a separate report's table came back entirely correct, 14 of 14 (see
[Provenance: Measured](/deep-dives/provenance-measurement) for the numbers). If you're seeing a lot
of citations nobody reviews and some that don't hold up, declare
that group's granularity as `"row"` — or `"none"` if it shouldn't carry provenance at all. The
`ProvenanceGranularity` type and `enveloped()`'s `provenance` option are documented in the
[API Reference](/reference/).

## Storage defaults to Dexie (IndexedDB), and is swappable

`openStorage()` persists to `getRxStorageDexie()` unless you pass a different `RxStorage` in
`OpenStorageOptions.storage`. Existing callers see no change.

**Why:** Dexie-over-IndexedDB is what a browser field app actually has available, durably, with no
server. The storage engine is the one seam a host needs in order to relocate storage — an
in-memory store for fast tests, a future React Native/SQLite engine — without touching `Storage`'s
durability logic at all.

**The symptom:** tests that don't inject a storage engine hit real IndexedDB, which is slower than
it needs to be and, in some runners, unavailable. Pass an in-memory `RxStorage` in a test
environment rather than discovering this from a hang.

## Transcriber and extractor fallback pick the first ready candidate, in the order you list them

`firstCapable` tries each transcriber you give it, in the order given, and uses the first one whose
`capability()` reports `ready` — no scoring, no health windows, no hysteresis. A capability answer
is cached for `DEFAULT_CAPABILITY_TTL_MS` before it's re-probed, because probing (a WebGPU adapter
request, a model-file stat) is not free, but availability can change mid-drain.

**Why order-first-ready, not "best" engine:** fallback exists to rescue the online path when the
preferred engine can't run — it is deliberately not a policy engine that ranks candidates.

**The symptom:** if you expect the composite to pick the "best" available engine by some quality
measure, it won't — it picks the first one in your list that's ready right now. Put your preferred
engine first; put the one you want as a last resort, last. If availability changes fast — an
uplink returns, a model finishes downloading — call `invalidate()`; don't shorten the TTL.

`hedged` composes differently: it starts your preferred engine and only starts a fallback if the
preferred one hasn't finished within a delay computed from `DEFAULT_HEDGE_FACTOR` (a multiple of a
host-supplied predicted duration), floored at `DEFAULT_HEDGE_FLOOR_MS` so a hedge never fires before
the primary has had a chance to start, and capped at `DEFAULT_HEDGE_BUDGET_MS` regardless of what the
prediction says. If you don't supply a predicted duration, the floor and budget still bound the
wait — the prediction only ever pulls the hedge earlier, never later.

## The two extraction arbiters make an opposite call about what to do with a failure

An extraction strategy (a fallback ladder, a race) needs an arbiter to decide what to do after each
candidate settles, and there is no default arbiter applied for you — you choose one. `@azx/ribo-core`
exports two, and picking the wrong one for your deployment is a silent behavior change, not an
error:

- **`terminalFallsThrough`** — the conservative choice. Accepts the first success; on a terminal
  error (the request itself is structurally broken) it falls through to try the next strategy; on a
  transient error (the transport is down) it gives up immediately rather than burning a second
  strategy against the same dead transport.
- **`acceptAnySuccess`** — the degraded-experience choice. Accepts the first success, continues past
  _any_ failure including a transient one, and only gives up once every candidate has been tried.

**Why two, not one default:** naming them separately forces the choice: you pick degraded behavior
on purpose, or you don't get it.

**The symptom:** with `acceptAnySuccess`, a strategy that should have given up and let the relay
retry later instead burns every remaining candidate against a transport that was never coming back.
With `terminalFallsThrough`, a deployment that actually wants best-effort extraction under
degraded conditions sees a session give up sooner than expected, when the intent was "try
everything before failing." These are opposite failure modes; check which one you passed.

Transcription has its own single default, `unsupportedFallsThrough`: accept the first success,
continue past `UnsupportedItemError` and `TranscriberUnavailableError` (both just mean "not this
engine"), and at exhaustion prefer a retryable error over a terminal one. It answers a narrower
question than the extraction pair, and the two are not interchangeable: they classify different
errors.

## The schema partition has a per-call ceiling, tunable but not unlimited

`@azx/ribo-core` partitions a large schema into groups so each call's response schema
stays under `MAX_NULLABLE_UNIONS_PER_CALL` nullable unions — the shape strict structured-output
mode is measured to reject past. It's counted in unions, not leaves, because a leaf's cost in unions
depends on its provenance granularity: an enveloped leaf costs two, a plain (`"row"` or `"none"`)
leaf costs one.

**Why a default rather than no limit:** every call has to fit inside whatever the target model
actually accepts, and that ceiling is where partitioning stops being optional.

**The symptom:** a group with a lot of `"leaf"`-granularity fields hits the ceiling in about half
the leaf count you'd expect, because each one costs two unions, not one — see
[Schema at Scale: Measured](/deep-dives/schema-scale) for how that plays out against a real schema, and the
[API Reference](/reference/) for `MAX_NULLABLE_UNIONS_PER_CALL` and `splitExtractionSchema` itself.

## Connectivity needs a stable signal, not just an event

The connectivity model that decides whether the relay should attempt network work waits
`DEFAULT_PROBE_TIMEOUT_MS` for a single reachability probe before giving up and calling it offline,
and requires `DEFAULT_STABILITY_WINDOW_MS` of continued health before it asserts `online` again.

**Why the asymmetry:** declaring offline is instant and cheap to get wrong in the safe direction.
Declaring online too eagerly is not — a two-second "we're back" blip that turns out to be a flapping
signal drains the queue straight into another round of failures. The model is patient about
declaring success and impatient about declaring failure, on purpose.

**The symptom:** a network that flickers for a second or two doesn't trigger a drain attempt at all,
even though `navigator.onLine` (or your own bind) fired. That's the stability window working as
intended, not a missed event.

## Next

These are the defaults later guides assume you already know. [Typesafety](/guide/typesafety) covers
the schema side — how a values schema, its derived extraction schema, and review's per-leaf schemas
keep from drifting apart.
