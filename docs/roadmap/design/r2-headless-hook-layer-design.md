# R2 — Headless Hook Layer — Design

**Date:** 2026-08-06
**Author:** AZX
**Status:** Approved for planning
**Task:** **R2** of the Voice-to-Text MVP design, which lives in the separate `franklin-field-app`
repo (file `docs/roadmap/design/2026-07-28-voice-to-text-mvp-design.md` there; not openable from this
repo)
**Authority it implements:** [`03-ribo-core.md`](../../implementation/03-ribo-core.md) and
[`04-ribo-ui.md`](../../implementation/04-ribo-ui.md) — both with recorded corrections (§7)
**Depends on:** R1 (all five packages build)

---

## 1. Goal

`@azx/ribo-ui-react` is a one-line stub: `export const PACKAGE_NAME = "@azx/ribo-ui-react"`. R1 gave
it a real build, so it ships a valid artifact containing nothing. R2 fills it with the headless hook
layer over the core engine.

Populating it surfaced a gap that has to be closed first. Core carries a complete, tested review
vocabulary — `buildReviewRequest`, `resolveReview`, `ReviewPresenter`, `ReviewOutcome`,
`FieldDecision` — and **nothing calls any of it.** The relay goes straight from extraction to writing
(`queue/relay.ts:288`):

```ts
async #extract(item: OutboxItem): Promise<void> {
  const extracted = await this.#options.extract({ item, transcript: item.transcript! });
  await this.#patch(item.id, { extracted, status: "writing", attempts: 0 });
}
```

There is no status an item can wait in for a human, and no persisted field to record what a human
decided — `outboxDocumentSchema` has `transcript`, `extracted` and `writeResult`, one per relay step,
and nothing for review. The product premise is that an auditor reviews every extracted field before
it reaches the host tool, so review is meant to be a **gate**. It is not one.

The gap is currently invisible because write-back is gated off pending the Helix egress signing ask
(A1 in [`13-helix-platform-asks.md`](../../implementation/13-helix-platform-asks.md)), so no item
reaches a real write. The day that gate opens, the pipeline writes unreviewed model output into a
customer's audit.

A hook cannot close that from outside. So R2 is **two sequenced phases in one design**:

- **Phase A** — `@azx/ribo-core`: make review a real gate in the outbox state machine, and add
  pause/resume to `Recorder`.
- **Phase B** — `@azx/ribo-ui-react`: six hooks and a provider over the resulting engine, plus the
  playground migration that gives every hook a consumer inside the CI build.

They stay in one design because Phase B is entirely downstream of Phase A: `useReview`'s submit
target, `useOutboxItems`' query surface and `useWorkSafety`'s counts are all determined by the
statuses Phase A introduces. Splitting the document would mean writing Phase A's reasoning twice and
reviewing Phase B against a spec that cannot explain itself. They ship as separate commits, with
`./check.sh` green at each.

### What R2 is not

- **Not the `Controller` from doc 03.** That table entry ("orchestrates the loop; drives the queue;
  calls the injected `ReviewPresenter`") was never built, and R2 does not build it. A provider
  carrying host-constructed instances plus six hooks covers what it was for. Introducing an
  orchestrator with exactly one consumer would be a contract with one implementation — the same
  reasoning AGENTS.md §5.5 uses to defer the Level-2 `Outbox` interface.
- **Not components.** No markup, no stylesheet, no `styles.css` subpath. The package is a hook layer;
  doc 04's `CaptureControl` / `StatusIndicator` / `ReviewCard` are superseded (§7).
- **Not write-back.** `writing` still terminates at the stub. Unblocking it is the Helix HMAC ask, and
  faking the signing to green a demo remains forbidden.
- **Not the app-shell stores.** The playground's service-worker update prompt, install nudge, eviction
  detection, Whisper model loading and extractor status stay in the playground. They are application
  concerns, not SDK ones.
- **Not a docs rewrite.** R5 owns doc 04 and doc 10 §3.1. R2 corrects only the statements R2 itself
  makes false (§7).

---

## 2. Decisions

### 2.1 Every core concern gets a hook, not just recorder and review

The roadmap's R2 entry says "the recorder and review hooks". R2 covers six concerns instead:
recorder, review, outbox items, work safety, connectivity and storage persistence.

The reason is duplication that already exists. The playground hand-rolled all six —
`recorder-handle.ts`, `outbox-handle.ts` and six `*-store.ts` files feeding `useSyncExternalStore` —
and every host will rebuild the same subscriptions. `summarizeWork` in particular exists so that
"every presenter classifies identically" (`work-safety.ts` header); leaving each host to compose it
with a persistence grant and a connectivity status re-opens exactly the divergence core centralised
to prevent.

The line is drawn at concerns core models. Storage persistence is the one hook with no core
counterpart, and it is scoped thin on purpose (§4.6).

### 2.2 The provider carries instances; the host constructs them

```tsx
<RiboProvider value={{ recorder, outbox, connectivity }}>
```

Instance lifetime stays above React, with the host. The provider is a carrier, not an owner.

This is not a style preference — it is the playground's scar tissue. `outbox-handle.ts` and
`recorder-handle.ts` document what happens otherwise: StrictMode's double mount opens a second RxDB
database over the same IndexedDB name ("database already exists") and a second `Recorder` holding a
second microphone stream, and Vite HMR replaces the module without reloading the page. Both are
solved by a module singleton with `import.meta.hot.data` carry-over, which is a **host** discipline.
A provider that called `openOutbox()` itself would pull an async open into the render tree — the exact
thing `outbox-handle.ts` exists to keep out of it — and would ship that StrictMode hazard inside the
SDK, where a consumer cannot fix it.

All three instances are optional in the context type: a host using only capture must not be forced to
open a database. Each hook resolves its own dependency and throws an actionable error naming what is
missing and how to supply it, so the failure is a clear message at first render rather than an
`undefined` three frames later. Each hook also accepts an explicit instance that bypasses context,
which is what the tests use.

### 2.3 The review gate parks the item; the relay moves on

Review interposes between extraction and writing as a new `awaiting-review` status that is
deliberately **absent** from `ACTIVE_OUTBOX_STATUSES`. That absence _is_ the gate: `nextPending()`
selects `list({ status: ACTIVE_OUTBOX_STATUSES, limit: 1 })` (`queue/outbox.ts:225`), so a parked item
is skipped and the next recording drains straight past it.

The rejected alternative was the one core's existing contract implies: the relay calls
`ReviewPresenter.present(request)` and awaits the promise the UI resolves. Two things kill it.

1. **It stalls the queue.** The relay processes strictly ascending `seq` — "capture order is write
   order" (`queue/index.ts` header). A step blocked on a human means one un-reviewed recording holds
   up every recording behind it. An auditor who records four rooms and reviews the first should not
   thereby block the other three from transcribing.
2. **It is not crash-safe.** A reload mid-await drops the in-flight promise. The item resumes in a
   `reviewing` status with nothing to resolve, and the presenter has to be re-driven from scratch. On
   iOS the tab is the only execution context and it dies often — which is why backoff schedules are
   persisted rather than held in timers, and the same reasoning applies here.

With the parked model, review is decoupled from the relay entirely: the review queue is a query
(`useOutboxItems({ status: "awaiting-review" })`), submitting persists the outcome and flips the item
to `writing`, and the relay picks it up on its next pass. The auditor can close the tab and come back
tomorrow.

**The gate is unconditional** — there is no `requireReview` flag. A host wanting an automatic pipeline
writes a three-line auto-submitter that accepts every field, which keeps "nothing is written that a
human has not seen" a structural property of the state machine rather than a configuration default
someone can flip.

### 2.4 `ReviewPresenter` is deleted

It has no implementations and no callers anywhere in the repo, and after §2.3 its shape —
`present: (request) => Promise<ReviewSubmission>` — actively misdescribes the architecture. The
promise model is precisely the design rejected above. An exported interface that lies about how the
system works is worse than an absent one, and keeping it "just in case" invites a future contributor
to build against it.

`buildReviewRequest`, `resolveReview`, `ReviewRequest`, `ReviewSubmission`, `FieldDecision`,
`FieldDecisions`, `ReviewField`, `ReviewFields`, `ReviewedValues` and `ReviewOutcome` all stay — they
are the vocabulary the hook is built from, and `resolveReview` remains the single place "was this
draft edited?" is decided.

`review.ts`'s file header needs rewriting: it currently explains the contract in terms of a presenter
the relay calls, and states that "`ribo-ui-react` implements `ReviewPresenter` in Phase 5". Both
become false.

### 2.5 A discard is its own terminal status, not `dead`

`discarded` joins `OUTBOX_STATUSES` and `FINISHED_OUTBOX_STATUSES`, and discarding drops the audio.

Not reusing `dead`: `dead` means "failed permanently and will not move without a human", and it drives
the `action-required` / `failed-permanently` branch of `workSafety`. Filing a deliberate human discard
there would nag the auditor about work they intentionally threw away. `resolveReview`'s own doc
comment draws exactly this line — "Discarding is a statement about the recording; rejecting every
field is a statement about the extraction" — and collapsing the two would lose it.

Dropping the audio is the privacy call: an auditor abandoning a dictation should not leave its bytes
on the device. The row itself is retained, because "this recording was captured and deliberately
discarded" is worth being able to see.

An `edited` outcome in which every field was rejected still goes to `writing`, not `discarded` — see
the rule above. Whether an empty field set is writable is the adapter's `schema.parse` to decide, per
`review.ts`: "Narrowing that to a non-null `F` is the adapter's job."

### 2.6 Pause/resume lands in Phase A

`RecorderPhase` is `idle | recording | stopping` today. `MediaRecorder` supports pause and resume
natively; `Recorder` does not expose them. A field auditor being interrupted mid-dictation is an
ordinary event, and a hook cannot synthesise the capability — stopping and restarting produces a
second `Recording` with a new id and separate audio, so one paused dictation would become two queue
items.

It lands in Phase A rather than a later task because it changes the same invariants Phase A is
already handling, and reopening `recorder.ts`'s duration accounting twice is worse than once.

Three details make it more than a phase flag:

1. **Elapsed time must accumulate.** `elapsedMs` is `performance.now() - session.startedAt`
   (`recorder.ts:240`), which keeps counting through a pause — a 30-second dictation paused for two
   minutes would report 2:30, and that wrong number is written to `Recording.durationMs` at stop. The
   session needs `accumulatedMs` plus a `resumedAt`, with `elapsedMs` summing the two.
2. **Level must read zero while paused.** The tick keeps firing and the analyser keeps reading a live
   stream, so a paused recorder would otherwise show input level bouncing while recording nothing —
   reading as broken in exactly the way doc 04 warns about for the unscaled meter.
3. **The microphone stays open, and that is not optional.** `MediaRecorder.resume()` requires the same
   stream, so pause cannot stop the tracks, and the browser's recording indicator stays lit. That is
   consumer-visible behaviour in a tool whose recorder header calls live tracks "a privacy problem,
   not a resource leak", so it is documented where `level` and the teardown rule are documented — not
   left to be discovered.

No new `RecorderErrorCode` is needed: `pause()` while idle reuses `not-recording`, and `resume()`
while recording reuses `already-recording`. `stop()` must accept the `paused` phase, which its current
`phase !== "recording"` guard rejects.

### 2.7 One subscription helper, and it is not `useSyncExternalStore`

The obvious wiring is broken:

```ts
useSyncExternalStore(recorder.subscribe, () => recorder.state); // infinite render loop
```

`recorder.state` builds a fresh object on every call and `elapsedMs` recomputes from
`performance.now()`, so the snapshot is never referentially stable and React re-renders forever. The
playground's store files carry comments about this exact failure ("a fresh object per call is an
infinite loop"), having solved it by caching a snapshot in module scope — which a hook over a
host-owned instance cannot do.

So all four subscription hooks go through one internal helper holding the last **pushed** value:

```ts
const useSubscribed = <T,>(subscribe: (listener: (value: T) => void) => Unsubscribe, initial: () => T): T
```

Both `Recorder.subscribe` and `Connectivity.subscribe` invoke their listener immediately on
subscribe, so the first paint is never blank and no hook needs to poll.

The tradeoff, stated once and accepted: this gives up `useSyncExternalStore`'s tearing protection
under concurrent rendering. For a level meter pushed every 100 ms and a connectivity badge, a torn
frame is not observable. If a future value needs the guarantee, the fix is a snapshot cache inside
this one helper, not a second pattern in each hook.

### 2.8 Hooks are tested in the real-browser tier

Hook tests land as `packages/ribo-ui-react/src/*.browser.test.tsx`, which the browser project's
`include` glob (`packages/*/src/**/*.browser.test.{ts,tsx}`) already matches — `vitest.config.ts`
needs no change. `vitest-browser-react` is added to the catalog as the Vitest-4-native renderer that
pairs with `@vitest/browser`; resolve the version at install and pin what you get, per AGENTS.md §5.4.

Two reasons, and the second is the one that would otherwise cost a day:

1. These hooks wrap `MediaRecorder` and IndexedDB. `vitest.config.ts` already records why jsdom is
   the wrong tier for those: "jsdom has no MediaRecorder, a shimmed IndexedDB and does not faithfully
   simulate workers; mocking through it produces tests that pass while production is broken."
2. **Cross-package imports only resolve in the browser project.** ui-react's tests must import
   `@azx/ribo-core` by package name to construct a `Recorder` or `Outbox`. AGENTS.md §5.1 records that
   the `unit` project cannot do this today — node-environment tests go through Vite's SSR pipeline,
   which reads `ssr.resolve.conditions`, and nothing fails yet only because every existing test
   imports its own module by relative path. The browser project's plain `resolve.conditions` is
   proven, and `workspace-resolution.browser.test.ts` exists specifically to fail if it is removed.
   R2 is the first task to cross a package boundary in a test, and the browser tier is where that
   works.

### 2.9 The write step consumes reviewed values, and refuses an item that has none

Without this, the whole gate is decorative. `nextStep` derives the step from **which outputs are
present, not from status** (`relay.ts:118`) — that is what makes a crash resumable — and `#write`
currently passes `extracted: item.extracted`, the model's raw envelope map. So an auditor who corrects
the R-value would have the correction persisted to `reviewOutcome` and then **ignored at write time**,
with the original model output going to the host tool.

Two changes fix it:

1. **`WriteStepInput.extracted` is replaced by `reviewed: ExtractedFieldMap`** — the flat reviewed
   values, which is what `resolveReview` already produces and what `ToolAdapter.write(fields: F, ctx: C)`
   already wants (it takes plain values, never envelopes). The raw envelopes stay reachable as
   `input.item.extracted` for provenance and diagnostics.

   Replaced rather than added alongside. Two similarly-named fields on the same input would make
   "wrote the un-reviewed map" a one-word typo whose symptom is silent and whose blast radius is a
   customer's audit. One field, named for what it is, cannot be misused.

2. **`#write` throws a `TerminalQueueError` if `item.reviewOutcome` is absent.** Since the gate is
   unconditional (§2.3), reaching a write with no recorded review is a bug in the state machine, and
   the honest response is a terminal failure rather than a write. This makes "nothing is written that a
   human has not seen" enforced at the write boundary as well as by status routing — cheap
   defence-in-depth for the one invariant in the system whose violation is invisible and unrecoverable.

Also worth recording, because it looks like it needs handling and does not: an `edited` outcome in which
every field was rejected reaches `#write` with `reviewed: {}`. That is correct and needs no special
case — the adapter's `schema.parse` is the trust boundary that decides whether an empty field set is
writable (§2.5).

Blast radius is small: every `WriteStep` in the repo today ignores its input. Two playground stubs
(`QueuePanel.tsx:219`, `TranscribePanel.tsx:257`) and the test doubles need their signatures updated,
and `ribo-adapter-snuggpro`'s `write` is itself still a stub.

---

## 3. Phase A — the review gate in core

Six files, and the last one is a silent bug rather than an addition.

### 3.1 `queue/schema.ts`

- **`awaiting-review`** added to `OUTBOX_STATUSES`, positioned between `extracting` and `writing` so
  the list reads as the pipeline. **Not** added to `ACTIVE_OUTBOX_STATUSES` — that omission is the
  gate (§2.3) and deserves a comment saying so, because it looks like an oversight.
- **`discarded`** added to `OUTBOX_STATUSES` and to `FINISHED_OUTBOX_STATUSES`.
- **`reviewOutcome`**, optional, stored **loose** — `fields: z.record(z.string(), z.unknown())`,
  `editedFields: z.array(z.string())`, `rejectedFields: z.array(z.string())`, `reason: z.string().optional()`,
  discriminated on `status`. Loose for the same reason `extracted` is loose: the document schema cannot
  be generic in `F`. The typed `ReviewOutcome<F>` lives at the hook boundary; persistence erases it.
- **`outboxRxSchema.version` 0 → 1**, with the new property mirrored into the RxDB JSON schema.

The three drift guards in `schema.test.ts` pin `outboxDocumentSchema` ↔ `outboxRxSchema` ↔
`outboxItemSchema` field-for-field, so all three move together or the suite fails. Expect those tests
to go red first; that is the guard working.

### 3.2 `queue/database.ts`

Add `migrationStrategies: { 1: (doc) => doc }` to the collection. The new field is optional, so the
migration is identity — but it is written and exercised rather than skipped, so the code path exists
before a non-trivial migration needs it.

Nothing is published and there are no users, so no deployed data is at risk. That is a reason the
migration is cheap, not a reason to omit it.

### 3.3 `queue/relay.ts`

`#extract` patches `status: "awaiting-review"` instead of `"writing"`. The relay never learns what
review is — it simply stops seeing the item. No new step, no new dispatch case, no change to
`STEP_STATUS` or the crash-resumability reasoning.

`#write` changes per §2.9: it passes `reviewed` (the flat values off `item.reviewOutcome`) rather than
`extracted`, and throws a `TerminalQueueError` when `reviewOutcome` is absent.

`STEP_STATUS.write` stays `"writing"`, and that is safe even though `nextStep` is status-blind. An item
parked at `awaiting-review` has `extracted` present, so `nextStep` would return `"write"` and `#step`
would patch it to `writing` and write it — un-reviewed. The **only** thing preventing that is
`awaiting-review`'s absence from `ACTIVE_OUTBOX_STATUSES`, which keeps `nextPending()` from ever
selecting it. That is the entire safety mechanism, it is one omission in one array, and it therefore
gets both an explanatory comment at the omission site and a dedicated test (§6.1). §2.9's write-time
guard is the second line of defence for exactly this reason.

### 3.4 `queue/outbox.ts`

A new method:

```ts
async submitReview(id: string, outcome: ReviewOutcome<Record<string, unknown>>): Promise<OutboxItem>
```

On `Outbox` rather than as a free function because it is a row write: it inherits the existing
`#serialized` discipline and the pre-write `outboxItemSchema.parse` that makes a bad status fail at
the write rather than at the next reload.

- `accepted` / `edited` → persist `reviewOutcome`, set `status: "writing"`, reset `attempts`.
- `discarded` → persist `reviewOutcome`, drop the audio attachment, set `status: "discarded"`.

### 3.5 `recorder.ts`

Per §2.6: a `paused` phase, `pause()` / `resume()`, accumulated-duration accounting, `level` forced to
zero while paused, `stop()` accepting `paused`, and the mic-stays-open behaviour documented alongside
`level`.

### 3.6 `work-safety.ts` — the silent bug

`summarizeWork` classifies purely on status (`work-safety.ts:145`):

```ts
if (status === "dead") dead += 1;
else if (status === "done") synced += 1;
else if (ACTIVE_OUTBOX_STATUSES.includes(status)) pending += 1;
```

A status in **neither** set falls through all three branches and is counted as nothing at all. Adding
`awaiting-review` naively therefore makes an un-reviewed recording invisible to the summary, and
`workSafety` then reports **`safe` / `all-synced`** while the auditor's dictation sits un-reviewed on
the device. That is precisely the lie this module exists to prevent — its header exists so that "every
presenter classifies identically", and it would be classifying identically wrongly.

So:

- **`awaiting-review` counts toward `pending`.** It is unsynced work on a device, and needing a human
  rather than a network does not make it safe.
- **`discarded` counts toward nothing.** Deliberately abandoned work is not outstanding.
- **`WorkOnDevice` gains `awaitingReview: number`**, informational, so a UI can say "3 recordings need
  review" without re-deriving it from a query. The `workSafety` gradient reads `pending`, which now
  includes them.

---

## 4. Phase B — the hook surface

One small file per hook, per AGENTS.md §4. Six hooks, one provider, one internal helper.

### 4.1 `useRecorder(options?)`

Returns `{ phase, elapsedMs, level, scaledLevel, start, stop, pause, resume, toggle, busy, error }`.

- **Both `level` and `scaledLevel`.** `level` is the honest raw RMS; `scaledLevel` applies the
  perceptual curve (`sqrt`). Doc 04 assigns perceptual scaling to the meter component; a headless
  package has no meter, so the hook owns it. Otherwise every consumer independently rediscovers that
  a bar at `level * 100%` barely leaves the left edge and guesses at a different curve — the exact
  outcome doc 04's Phase 5 note exists to prevent. The playground's local `Math.sqrt` moves here.
- **`error` is the `RecorderError`**, not a string, so hosts branch on `.code` — `permission-denied`
  needs different copy from `no-input-device`.
- **`stop()` resolves `{ capture, item }`.** `enqueue` defaults to **true**: a recording that stops
  without reaching disk is lost, so the durable path is the default rather than an opt-in. `item` is
  `undefined` only when `enqueue: false`. If `enqueue` is true and no outbox is in context, the hook
  throws the §2.2 error naming the omission.
- `busy` covers the async gap around `start`/`stop`, which the playground currently tracks by hand.
- `toggle()` is included because a single record/stop button is the universal capture affordance and
  it is phase-dependent; every consumer would write the same six lines.

### 4.2 `useOutboxItems(query?)`

Returns `{ items, loading, error }` over `outbox.watch(query)`.

`loading` is load-bearing, not cosmetic: `ReviewPanel` already distinguishes "reading the outbox…"
from "nothing extracted yet", and conflating them flashes an empty state before the first emission.

The query object is serialised for the effect dependency, so an inline `{ status: "queued" }` does not
tear down and re-establish the subscription on every render — a trap a consumer would hit immediately
and diagnose slowly.

### 4.3 `useReview(item, options?)`

Generic in `F`. Returns `{ ready, fields, decisionOf, accept, edit, reject, untouched, submit, discard, submitting, error }`.

- `ready` is `false` while `item.extracted` or `item.transcript` is absent; both are optional on
  `OutboxItem` and neither exists before the relay has run those steps.
- `fields` is core's `ReviewFields<F>` from `buildReviewRequest`, so `isGrounded` is precomputed and no
  UI re-implements `isSpanGrounded`.
- **The generic boundary is explicit and one-directional.** `item.extracted` is persisted loose
  (`Record<string, unknown>`), so the hook asserts it to `ExtractedFields<F>` on the way in — `F` is
  the caller's claim about what the adapter extracts, and the hook cannot verify it. On the way out,
  `ReviewOutcome<F>` erases back to the loose shape `submitReview` persists. Both crossings happen in
  this one hook, so the assertion is reviewable in a single place rather than scattered across a UI.
  The adapter's `schema.parse` at write time remains the actual trust boundary; this is a typing
  convenience, and the spec is deliberate that it is not a validation.
- **Decisions initialise complete.** `FieldDecisions` is deliberately not `Partial` — "a field with no
  decision is indistinguishable from a field the reviewer never saw, and 'I did not look at it' must
  not silently mean 'accepted'". Every field therefore starts `{ status: "accepted" }`, and
  **`untouched`** reports which fields the human has not actually acted on. A host can require every
  `isGrounded: false` field to be visited before enabling submit. That honours the warning without
  inventing a fourth decision status the core contract does not have.
- `submit()` runs `resolveReview(request, { status: "submitted", decisions })` and passes the outcome
  to `outbox.submitReview`. `discard(reason?)` submits the discarded branch.

### 4.4 `useWorkSafety()`

Returns `{ safety, work }`. Composes the other three concerns: outbox items → `summarizeWork` →
`workSafety(work, persistence, connectivity)`. The single place the gradient is derived on the React
side, so no host re-implements the composition.

### 4.5 `useConnectivity()`

Returns `ConnectivityState`. State only — `start()` / `stop()` bind and unbind an event source, which
is lifecycle and stays the host's, consistent with the provider not owning construction.

### 4.6 `useStoragePersistence()`

Returns `{ persistence, estimate, request }`, where `persistence` is core's `StoragePersistence`
(`"granted" | "denied" | "unsupported" | "unknown"`).

The one hook with no core counterpart: it wraps `navigator.storage.persisted()`, `persist()` and
`estimate()` directly. Scoped thin on purpose — the playground's `storage-store.ts` is 172 lines
including eviction detection, and that logic stays in the playground. If it should be shared it
becomes a headless core model alongside `createConnectivity`, not logic hidden in a hook. Recorded as
an open question (§8).

### 4.7 `RiboProvider`

One `createContext`, one component, per §2.2. `sideEffects: false` and ESM-only already hold; ESM-only
is what protects a context-carrying package from the dual-package hazard
([`10 §3`](../../implementation/10-build-and-packaging.md)), and the duplicate-React check in
`check.sh` plus the catalog's single pinned React version are the other two defences.

---

## 5. Playground migration

`App.tsx` wraps the tree in `RiboProvider`, fed from the **existing** `recorder-handle.ts` and
`outbox-handle.ts` singletons. Those files stay exactly as they are — they are the host lifetime
discipline a carrying provider expects, and their StrictMode and HMR comments remain the best
available documentation of why the provider constructs nothing.

| Panel               | Change                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `RecordPanel`       | → `useRecorder`. Drops its own `subscribe` / `busy` / `error` wiring and its local `Math.sqrt`. Gains pause/resume controls. |
| `ConnectivityPanel` | → `useConnectivity`. `connectivity-store.ts` (143 lines) becomes deletable.                                                  |
| `QueuePanel`        | → `useOutboxItems` + `useConnectivity`.                                                                                      |
| `WorkSafetyPanel`   | → `useWorkSafety`. Drops its `summarizeWork` / `workSafety` composition.                                                     |
| `StoragePanel`      | → `useStoragePersistence` for the grant; keeps its eviction logic locally.                                                   |
| `ReviewPanel`       | Rewritten interactive (below).                                                                                               |

`ReviewPanel` becomes the first real review surface: `useOutboxItems({ status: "awaiting-review" })`
for the queue, `useReview` per item, per-field accept / edit / reject, and submit / discard. Its two
caveat banners survive verbatim — the extractor-mode warning (sample data vs live model) and the
Lennox/"Linux" grounding caveat are hard-won and honest, and a grounded span still proves only that
the model quoted the transcript, never that the audio was heard correctly.

Two write stubs also change signature per §2.9 — `QueuePanel.tsx:219` and `TranscribePanel.tsx:257`
both build a relay with `write: () => Promise.resolve({ writtenBy: … })`. They ignore their input, so
the change is mechanical, but their `WriteStepInput` now carries `reviewed` rather than `extracted`.

Net effect is on the order of 150–250 lines of duplicated subscription code removed, and every hook
gains a consumer inside `pnpm build:app` — the only composition check CI runs.

---

## 6. Testing

### 6.1 Core (Phase A)

| Suite                      | What it gains                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema.test.ts`           | The three-way drift pin extends to `reviewOutcome` and both new statuses. Goes red first, by design.                                                                                                                                             |
| `work-safety.test.ts`      | **The §3.6 regression:** an outbox holding only `awaiting-review` items must report `pending > 0` and must not report `safe`. This test is the reason that section exists.                                                                       |
| `relay.browser.test.ts`    | Extraction parks the item at `awaiting-review`, **and** the relay then drains the next item past it rather than stalling. The second assertion is the point of the parked design.                                                                |
| `outbox.browser.test.ts`   | `submitReview` transitions: accepted/edited → `writing` with the outcome persisted; discarded → `discarded` with the audio dropped.                                                                                                              |
| `relay.browser.test.ts`    | **The §2.9 guard, both halves:** an `edited` outcome reaches the write step as `reviewed` values — the auditor's corrected value, not the model's — and an item forced to `writing` with no `reviewOutcome` fails terminally instead of writing. |
| `recorder.browser.test.ts` | Paused elapsed-time accounting against the real fake-device stream: record, pause, wait, resume, stop, and assert `durationMs` excludes the paused span. Real clock, not a mock.                                                                 |
| migration                  | The collection opens at version 1 and a document written before the bump survives.                                                                                                                                                               |

On the migration test: if driving a genuine v0 → v1 upgrade through RxDB proves fiddly, the honest
fallback is testing the strategy function directly and **saying so in the plan** — not quietly
dropping the case.

### 6.2 Hooks (Phase B)

`packages/ribo-ui-react/src/*.browser.test.tsx`, per §2.8. Coverage:

- Recorder phase transitions including pause/resume; `error.code` surfacing through the injected
  `getUserMedia` seam (denied permission, no device); enqueue-on-stop landing a real `OutboxItem`.
- `useOutboxItems` going loading → items, updating live on enqueue, and honouring a query filter.
- `useReview`'s decision state, `untouched` tracking, and submit persisting through to a status
  change on the real row.
- `useWorkSafety` reporting un-reviewed work as unsafe — the §3.6 bug asserted at the hook level too,
  because that is where a consumer would see it.
- The provider's missing-instance error message.

### 6.3 Definition of done

`./check.sh` green, per AGENTS.md §7 — typecheck → lint → format:check → build:packages → resolve →
build:app → pkg:gates → test, with the summary line pasted rather than success asserted.

---

## 7. Blast radius, and docs this falsifies

- **`extraction-ui.e2e.test.ts` will fail.** It polls for the item reaching `done`
  (`extraction-ui.e2e.test.ts:98`); under the gate it parks at `awaiting-review` and never gets there
  unaided. It must drive the new review UI to completion. `try-it-ui.e2e.test.ts` and
  `transcribe-ui.e2e.test.ts` need the same audit. This is the e2e suite correctly detecting that the
  product flow changed.
- **`TryItPanel` (406 lines) changes meaning.** Its "drain the queue" affordance now stops at review
  rather than running to `done`, so its copy and flow need revisiting.
- **`review.ts`'s header** is rewritten per §2.4: no presenter, no "Phase 5" promise.
- **AGENTS.md §1** — `ribo-ui-react` is no longer a `PACKAGE_NAME` stub, and the pipeline summary
  gains the review gate.
- **AGENTS.md §6.2** currently justifies ui-react's `peerDependencies` on core by saying its hooks
  "will hold core's `Controller` / `ReviewPresenter` instances". Neither type will exist. The
  conclusion is unchanged and the real reason is better: the provider carries `Recorder`, `Outbox` and
  `Connectivity` instances across the package boundary, so object identity must be shared.
- **AGENTS.md §5.1's closing caveat** ("treat 'Vitest resolves to source' as unproven… expect to fix
  this the moment a test crosses a package boundary") should record that R2 crossed the boundary in
  the **browser** project, where it works, and that the `unit` project's `ssr.resolve.conditions` gap
  remains open and unhit.
- **Doc 04** is left to R5 beyond what R2 falsifies directly. Its `CaptureControl` /
  `StatusIndicator` / `ReviewCard` component table and its CSS-Modules-to-`styles.css` dependency
  policy are superseded by the headless-hook decision; its Phase 5 level-meter note is honoured, just
  in a hook rather than a component.

---

## 8. Open questions

1. **Does `useStoragePersistence` belong in ui-react at all?** It wraps `navigator.storage` and needs
   no React. If the playground's eviction detection ought to be shared, the right home is a headless
   core model beside `createConnectivity`, and the hook shrinks to a subscription over it. Deferred
   until a second consumer exists, per the AGENTS.md §5.5 rule about contracts with one
   implementation.
2. **Should `awaitingReview` raise its own `WorkSafety` level?** R2 counts it as `pending` and exposes
   the number. A case exists for an `action-required` variant, since it will never resolve without a
   human — the same property that puts `failed-permanently` there. Not taken now: the auditor
   reviewing is the normal path, not an exception, and phrasing it as action-required would make the
   ordinary flow read as a fault.
3. **The React floor** (`docs/open-questions.md` §3) stays open. R2 uses no hook beyond React 18, so
   the current `^18.3 || ^19` peer range is not narrowed by this work.
