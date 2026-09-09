# Document transcription — implementation plan

**Goal.** Teach Ribo to transcribe **PDFs**, so a document submission flows through the same
`transcribe → extract → review` pipeline as a voice note. The driving use case is a heat-pump quote
reviewer: an invoice PDF plus an ACCA Manual J report, extracted into structured fields for a human
to check.

**Authority.** This plan is the authority; there is no separate design doc, because the design work
is small and lives in §"Decisions pinned for this tranche" below. Read AGENTS.md §4 (conventions),
§5.2 (never construct a Worker in library code), §6 (how to add a package) and §7 (definition of
done) before starting any task.

**Scope.** The **capture → transcribe** half only. Everything from `extracted` onward already
works for this: the session layer speaks text (`joinSessionTranscript()` returns
`{ text, recordingIds }`) and has no idea audio was involved, so `Extractor`, `Extracted<T>`,
`isSpanGrounded`, `arbitration.ts`, the arbitration engine, `ExtractionTarget` and the review
contract are reusable **untouched**.

---

## Out of scope — do not touch

- `Extractor`, `Extracted`, `isSpanGrounded`, `arbitration.ts`, `ExtractionTarget`, the review
  contract, the write step. All reusable as-is. In particular `arbitration.ts` is **closed**: the
  transcriber side gets a sibling vocabulary in its own module, not a generalisation of the
  extractor engine. See Task 4's Intent for why that is the right call and not laziness.
- The recorder, the worklet, capture-lock, chunk-names, work-safety. Genuinely audio and genuinely
  field-capture.
- Any OCR transcriber. Task 4 makes it *composable*; building it is a separate tranche.
- Any Abode- or HVAC-specific schema, prompt or validator. Those belong in the consuming app, the
  way `ribo-adapter-snuggpro` holds Snugg Pro's knowledge.
- A **page router**. One was tried in the abode spike and silently dropped 10 of 19 unmatched
  pages — including two load tables and the appliance itemisation — to save about $4/month. Send
  the whole document to every call.

---

## Decisions pinned for this tranche

Do not reopen these mid-task. Each is either a repo principle or a fact verified against this tree
on 2026-09-09.

### D1. `Recording` is the audio branch; `CaptureItem` is the union

`Recording` keeps `durationMs` and gains `kind: "audio"`. A new `DocumentCapture` carries
`pageCount` and `kind: "document"`. `CaptureItem` is the union of the two.

**`Recording` is not renamed and does not become the union.** This follows from the target
signature itself — `Transcriber<S extends CaptureItem = Recording>` — whose default argument only
means "exactly what it means today" if `Recording` is still the audio thing. It also keeps every
existing `.durationMs` access on a `Recording`-typed value compiling.

**Do not model a PDF as a `Recording` with `durationMs: 0`.** That lies to every consumer, to the
capture UI and to anything that formats an elapsed time. `z.strictObject` on each branch is what
makes writing that lie impossible rather than merely discouraged.

`pageCount` is `.int().positive()` where `durationMs` is `.int().nonnegative()`. A zero-length
recording is a legitimate capture — someone held the button and said nothing. A zero-page document
is not a document; it is a parse that went wrong upstream.

### D2. No RxDB version bump — verified, with the evidence

The prompt asked for this to be checked rather than assumed. It was, three ways:

1. `outboxRxSchema` declares `recording: { type: "object" }` with **no nested `properties`**, so
   RxDB neither validates nor indexes the interior. Adding a field inside it is invisible to RxDB.
2. `queue/database.ts` registers `RxDBAttachmentsPlugin` and `RxDBMigrationSchemaPlugin` and
   **no dev-mode or schema-validation plugin**, so there is no second validator to satisfy.
3. `queue/schema.test.ts`'s drift guard compares **top-level keys only**
   (`Object.keys(outboxDocumentSchema.shape)` against `Object.keys(outboxRxSchema.properties)`), so
   it neither sees nor objects to a change inside `recording`.

The zod schema is the only description of that interior, and it is parsed on read — which is where
legacy tolerance has to live. **Migrations only ever run on a version bump**, so a v7 here would
rewrite every row in the one collection holding real recordings in order to add a field zod already
supplies on read. Task 1 pins all three facts as tests, because they are the whole reason this was
cheap.

### D3. The prompt's `.default("audio")` mechanism is **not sufficient** — this is a correction

The prompt said: *"give `kind` a `.default("audio")` so existing rows parse unchanged."* Verified
against zod 4.4.3: **`z.discriminatedUnion` ignores a branch's default on the discriminator.** It
selects a branch by reading the *raw* discriminator value before any branch's defaults run, so a
legacy row with no `kind` reaches no branch at all and fails with `"No matching discriminator"`,
never reaching the default that would have supplied one.

So the union wraps the discriminated union in a `z.preprocess` that stamps `kind: "audio"` onto a
row that has **no `kind` key at all**, and leaves a row carrying an unrecognised `kind` alone so it
fails as a bad discriminator rather than being quietly rewritten to `audio`.

Both mechanisms ship, and each has a distinct job: the branch `.default("audio")` serves a direct
`recordingSchema.parse(...)` (which is what `recorder.ts` and roughly two dozen test fixtures do,
and it is why they need no edit), and the preprocess serves every parse that goes through the
union. Task 1 pins the zod behaviour itself, so that if a later zod applies branch defaults during
discrimination the test goes red and the preprocess can go.

**The rejected alternative was a plain `z.union`**, which needs no preprocess and tolerates the
legacy row for free. It loses on error quality: a document missing `pageCount` reports
`"Invalid input"` with **no path**, because a union cannot know which branch the caller meant.
Discriminating first reports `pageCount: expected number, received undefined`. This is a trust
boundary, and "which field is wrong" is the entire value of parsing at one.

### D4. The third failure class is `UnsupportedItemError`, not `ItemUntranscribableError`

The prompt offered `ItemUntranscribableError` and invited a better name. Use `UnsupportedItemError`.

**Why.** "Untranscribable" is a claim about the *item*, and it is a claim that is false: a scanned
PDF is perfectly transcribable — by OCR, which Task 4 exists to make composable. A name that
overstates the verdict invites exactly the wrong handling one layer up ("nothing can read this, give
up") when the correct handling is "this engine cannot, try the next one". "Unsupported" is
inherently relative to a *supporter*, and the supporter is named in the error's own `engine` field.
It also echoes vocabulary the file already uses (`unsupported-platform`, and the
`"unsupported-format"` reason on this very error).

**The confusion risk was weighed and accepted.** `unsupported-platform` is a *capability* reason,
and the whole point of this class is that it is **not** a capability failure — so a reader could
mis-file `UnsupportedItemError` next to it. The suffix nouns are what keep them apart
(`-Platform` versus `-Item`) and the reason vocabulary reinforces it: `no-text-layer`, `encrypted`
and `unsupported-format` are all plainly properties of an item. Say this in the class's doc comment;
do not leave the reader to notice it.

### D5. `UnsupportedItemError` extends `TerminalQueueError`, which needs a one-token widening

The required semantics include **"terminal for this engine+item pair — never retry the same engine
on the same item"**. A relay retry *is* retrying the same engine on the same item, so the error must
be non-retryable at the queue level too: without this, a bare pdf.js transcriber handed a scanned
PDF burns eight backed-off attempts over ~10 minutes before landing in `dead`.

`queue/backoff.ts`'s `isTransientFailure` is the repo's **only** retry classifier
(`transcriber.ts`: *"there is no second retry classifier here, and there must never be one"*), and
the single thing it recognises beyond an HTTP status is `TerminalQueueError`. `TerminalQueueError`'s
own doc comment already names this case — *"a step that has declared the item unprocessable"* — so
subclassing is reuse, not a stretch.

**The obstacle, verified:** `TerminalQueueError` declares `override readonly name =
"TerminalQueueError"`, which TypeScript infers as the *literal* type `"TerminalQueueError"`, so a
subclass overriding it with its own name fails with **TS2416: Type `"UnsupportedItemError"` is not
assignable to type `"TerminalQueueError"`**. Confirmed by compiling a minimal repro under this
repo's TypeScript 6.0.3 and strict settings.

**So:** change that one declaration to carry an explicit `: string` annotation. It is a type
widening with **zero** runtime change and no behaviour change for any existing caller. This is the
one place this tranche touches an existing implementation beyond a parameter rename; call it out in
the final report.

Do **not** instead give the error a fake HTTP `status: 415` to slip past the classifier — a field
that looks like a protocol fact and is not is worse than the problem it solves.

Note the contrast with `TranscriberUnavailableError`, which is deliberately *not* terminal, because
the next attempt re-probes and may route to a different engine. The two errors sit on opposite sides
of that line on purpose, and each doc comment should point at the other.

### D6. What the fallback ladder is, and what it is not

`firstCapable` selects on `capability()`, which is engine-level and therefore **cannot** express
"this engine cannot read *this item*". `fallbackTranscriber` is the per-item sibling: it calls
candidates in order **without consulting `capability()` at all**, and lets a caller-supplied arbiter
decide from the settled outcomes whether to accept, continue, or give up. That is the distinguishing
property; state it in the module header, because a reader who thinks it is "firstCapable with
retries" will wire it wrongly.

- **Candidates are a bare `readonly Transcriber<S>[]`**, as `firstCapable` takes — not a
  `{ engine, transcriber }` wrapper. A `Transcriber` already carries `.engine`, and a wrapper would
  be a second place for the same id to live. Duplicate engine ids are refused at construction, as
  `firstCapable` refuses them.
- **The arbiter is a required argument**, as `fallbackExtractor`'s is, so the policy is chosen by
  name rather than inherited by omission.
- **Nothing is stamped onto the result.** The extractor side stamps `usage.strategy` because an
  `ExtractionResult` has no engine field; `Transcript.engine` is already required and already set by
  the implementation that ran, so "which one did?" is answerable off `Outbox.list()` for free. That
  is non-negotiable #4 satisfied by the existing contract — do not add a second copy of it.
- **The returned transcript is returned as-is**, never re-stamped with the wrapper's own engine id.
  `firstCapable` has a comment saying exactly this; the same rule applies here.
- `capability()` on the composite reports the **best** of its delegates, with `firstCapable`'s
  precedence (`ready` beats `needs-download` beats `unavailable`, first in order within a tier).

### D7. The default arbiter, `unsupportedFallsThrough`

Mirrors `terminalFallsThrough`'s shape and its hard-won ordering. Rules, in this order:

1. First success → **accept** it.
2. **Exhausted** (every candidate settled) → give up with the first *retryable* error if there is
   one, else with the first error. The retryable-first preference matters: a ladder where pdf.js
   said `no-text-layer` (terminal) and OCR then failed on a dropped uplink (retryable) must be
   retried, not buried in `dead` on the strength of the first outcome.
3. First `UnsupportedItemError` **or** `TranscriberUnavailableError` → **continue**. Both mean "not
   this engine"; they differ only in whether the verdict is cached, and `fallbackTranscriber` caches
   nothing. Demotion is `firstCapable`'s job — say so in the doc comment, and say that the two
   compose (a ladder of `firstCapable` composites, or a `firstCapable` roster of ladders).
4. Any other error → **give up** with it. That is an attempt failure, the queue already owns it, and
   letting it route to a different engine is precisely the bug non-negotiable #2 exists to prevent.

**Exhaustion is checked before every "keep going" branch**, and the ordering is load-bearing —
`arbitration.ts` carries a comment about the version of this that got it backwards and died with a
`TypeError` instead of the real error on the primary case it existed for. Do not reorder.

### D8. The pdf.js package

- `@azx/ribo-transcriber-pdfjs`, engine id `"pdfjs"`.
- **`capability()` must not load pdf.js.** The contract says it is called often and expected to be
  cheap. It answers only "can pdf.js run in this environment": no `Worker` constructor →
  `unsupported-platform` (which is permanent, correctly); no configured worker URL →
  `not-configured` (which is not); otherwise `ready`.
- **`transcribe()` lazy-loads pdf.js via a memoized dynamic `import()`.** It is 89 KB gzipped plus
  a 387 KB worker, and neither may load for a consumer that never transcribes a document. The
  worker is already deferred by pdf.js itself — `workerSrc` is only a URL string.
- **The worker URL is injected by the consumer**, exactly as AGENTS.md §5.2 requires for
  `createWorker` and for the same reason. **CSP note that has bitten this platform before:** the
  worker must be served from the app's own origin. `worker-src 'self' blob:` admits neither a CDN
  URL nor the `data:` URI a bundler will inline. `franklin-field-app`'s `worklet-path.ts` documents
  the same trap for its AudioWorklet. Ship the worker as a static asset and let the consuming app
  serve it.
- **Page markers are required output**, in the form `\n===== PAGE n =====\n`, numbered from 1.
  Not so anything can select pages — see "no page router" above. They exist so a value can be
  attributed to the page it came from, which matters when a document contradicts itself: one
  Wrightsoft report specifies equipment on its Manual S pages and again, differently, on page 24.
- **The package exports its text reader, not just the `Transcriber`.** A `DocumentCapture` requires
  `pageCount` at enqueue time, and counting pages needs a PDF parser — so without this a host would
  load a second copy of pdf.js to fill in the field, defeating the memoization. One exported
  function returning both the text and the page count closes that trap. It is the direct analogue of
  the spike's `pdfToText` and adds no new concept.
- **A page-count disagreement between `item.pageCount` and `doc.numPages` is not an error.** The
  bytes are authoritative and the markers follow them; the metadata may have been recorded by a
  different reader. Inventing a failure class for a discrepancy nothing downstream reads would be
  cost with no benefit.
- The reference implementation of the text extraction, already run against 15 real PDFs, is
  `spike/app/app.js` (`pdfToText`) in the **abode** repo at `~/projects/clients/abode`. It is about
  ten lines; the package is that plus the contract wrapper and the guard.

---

## Global constraints

Every task inherits these.

- ESM-only; `.js` extensions on relative TypeScript imports; `import type` for type-only imports
  (all lint-enforced).
- **zod at the boundaries** (AGENTS.md §4). Anything crossing a trust boundary is parsed with a zod
  schema, not cast. A type is `z.infer`'d from its schema and **never hand-declared alongside it**.
- Comments explain **why**, not what. A comment describing behaviour the code no longer has is a
  defect. Keep them terse: do not bake leaf or field counts into prose, because they go stale and
  cause pure-churn merge conflicts — let tests pin counts.
- **No existing package renamed.** Do not rename `Transcriber`, `Transcript`, `transcribe`, or any
  package. Do **not** introduce an alias like `type Transcriber = TextSource<Recording>` — that is
  two names for one thing (`extractor.ts:114`). The word already fits: transcription's older meaning
  is documents, so a PDF transcriber is using it more literally than an audio one.
- **Leave `Transcript` and `transcriptSchema` alone, `recordingId` included.** It is persisted; a
  slightly narrow field name is a much better trade than a migration.
- **No existing implementation changed beyond the parameter rename**, with the single pinned
  exception in D5.
- Tests live beside the source as `*.test.ts` (node) or `*.browser.test.ts` (real Chromium) and are
  discovered by the **root** vitest config; individual packages have no `test` script. Select a
  subset with a path argument (`pnpm vitest run packages/ribo-core`), **not** `--filter`.
- `./check.sh` must be green before the final commit of each task. The suite is green today; **any**
  failure is yours to explain. Paste the summary line rather than asserting success.
- Commit in small pieces as you go. A run that leaves everything uncommitted produced nothing, and a
  task in this repo has died with an empty worktree after hitting the model's output cap.
- Each task adds a changeset (`.changeset/*.md`).

---

## File structure

**Created**

- `packages/ribo-core/src/capture-fields.ts` — the four fields both branches share
  (`id`, `capturedAt`, `mimeType`, `ctx`), as a raw field bag each branch spreads into its own
  `strictObject`. It exists so the two branch declarations cannot drift: a shared field added to one
  and forgotten in the other would be a union whose common shape is narrower than it reads.
- `packages/ribo-core/src/capture-item.ts` (+ test) — the document branch, the union, and the
  legacy-`kind` preprocess.
- `packages/ribo-core/src/unsupported-item.ts` (+ test) — `UnsupportedItemError`.
- `packages/ribo-core/src/transcription-arbitration.ts` (+ test) — the transcriber-side arbiter
  vocabulary and `unsupportedFallsThrough`.
- `packages/ribo-core/src/fallback-transcriber.ts` (+ test) — the ladder.
- `packages/ribo-transcriber-pdfjs/` — the new package (see Task 6 for its file list).

**Modified**

- `packages/ribo-core/src/recording.ts` — gains `kind`, delegates its shared fields.
- `packages/ribo-core/src/transcriber.ts` — `Transcriber` becomes generic; `audio` → `bytes`.
- `packages/ribo-core/src/fake-transcriber.ts` — generic over the item; gains an unsupported-failure
  setter.
- `packages/ribo-core/src/queue/schema.ts` — the outbox `recording` field accepts either kind.
- `packages/ribo-core/src/queue/outbox.ts` — `enqueue` accepts either kind; `commitRecording` and
  `beginRecording` stay audio-only and say so.
- `packages/ribo-core/src/queue/recovery.ts` — audio-only, and says so.
- `packages/ribo-core/src/queue/relay.ts` — its injected transcriber widens to the union.
- `packages/ribo-core/src/queue/backoff.ts` — the D5 one-token widening.
- `packages/ribo-core/src/index.ts` — barrel exports.
- `playground/src/QueuePanel.tsx` — narrow before reading `durationMs`.
- `pnpm-workspace.yaml`, `docs/typedoc.json`, `AGENTS.md` — see Task 6.

---

## Task 1 — `CaptureItem`: the discriminant, the document branch, and the migration evidence

**Files.** Create `capture-fields.ts`, `capture-item.ts`, `capture-item.test.ts`. Modify
`recording.ts`, `recording.test.ts`, `queue/schema.ts` (the `recording` field only),
`queue/schema.test.ts`, `index.ts`.

**Intent.** Land D1, D2 and D3. `recordingSchema` keeps every field it has, gains
`kind: z.literal("audio").default("audio")`, and takes its four shared fields from
`capture-fields.ts`. `documentCaptureSchema` is the same shared fields plus
`kind: z.literal("document")` (no default — there are no legacy document rows to be tolerant of)
and `pageCount`. `captureItemSchema` is the preprocess-wrapped discriminated union.

The outbox document's `recording` field switches to the base (context-unvalidated) union. **The key
stays `recording`** even though it now holds either kind, for the same reason
`Transcript.recordingId` stays: it is persisted on the v6 collection, and a slightly narrow key name
is a far better trade than a migration. The name that would fit — `capture` — is already taken by
the durable-capture identity on the same document. Say all of that in the field's doc comment.

**There is deliberately no `isDocumentCapture()` helper.** The literal discriminant narrows natively
in TypeScript, and a helper would be a second way to ask one question.

**Interfaces produced.** `captureFields(ctx)`; `documentCaptureSchema(ctx)`,
`baseDocumentCaptureSchema`, `DocumentCapture<C>`; `captureItemSchema(ctx)`,
`baseCaptureItemSchema`, `CaptureItem<C>`. All exported from the `ribo-core` barrel. Later tasks
depend on `CaptureItem`, `DocumentCapture` and `Recording` by these exact names.

**Must-fail tests.**

- A document capture parses, and one carrying `durationMs` does **not** — `strictObject` is what
  makes the `durationMs: 0` lie unwritable.
- `pageCount` of `0`, `-1` and `2.5` are all rejected; `durationMs: 0` is still accepted on the
  audio branch. The asymmetry is the point and would otherwise get "tidied" into matching.
- A row with **no `kind` key** parses through the union as audio, and comes back out **with**
  `kind: "audio"` — stamped, not merely tolerated. Passing the absence through would move the
  failure to the first `switch`.
- A bare `z.discriminatedUnion` over the same two branches **rejects** that same row while
  `captureItemSchema` accepts it. This pins the zod behaviour from D3, not our code, and is what
  stops someone deleting the preprocess as redundant.
- A row carrying `kind: "video"` is rejected, and is **not** rewritten to `audio`.
- A document missing `pageCount` produces an issue whose `path` is `["pageCount"]` — the
  error-quality property that ruled out a plain `z.union`.
- An outbox document whose `recording` is a document capture parses; one whose `recording` predates
  the discriminant parses and reports `kind === "audio"`.
- `outboxRxSchema.properties.recording` is exactly `{ type: "object" }` and
  `outboxRxSchema.version` is still `6`. Assert this rather than writing it in prose: it is the
  evidence for D2, and it is what makes a future v7 an explicit decision.

**Fallout to fix in this task.** `pnpm typecheck` after the schema switch reports exactly two
production errors; both are the union reaching audio-only code, and both want an explicit guard
rather than a cast.

- `queue/relay.ts` hands `item.recording` to its injected `Transcriber`. **Leave this error
  standing until Task 2** (it needs the generic) — or land Tasks 1 and 2 as one commit if you prefer
  a green tree at every commit. Say which you did.
- `queue/recovery.ts` re-derives `durationMs` by decoding merged audio chunks, which is meaningless
  for anything else. Guard on `kind`, and on a non-audio item mark the row `dead` with a reason
  naming the kind — mirroring the file's existing `unrecoverable: no capture.sourceId` branch rather
  than inventing a new shape.
- `queue/outbox.ts` needs three separate changes, and the third is the dangerous one.
  `enqueue` must accept and parse a `CaptureItem` (this is how a document gets into the queue at
  all). `beginRecording` stays `Recording` and keeps parsing with `baseRecordingSchema` — it is the
  durable microphone path. `commitRecording` spreads `durationMs` onto `data.recording`, and that
  spread **typechecks against the union** while producing a document row carrying a bogus
  `durationMs` that the strict schema would then reject on the next read: silent persistence
  corruption on a path TypeScript blessed. Add a runtime guard that refuses a non-audio row, and
  test it — the test needs a cast to construct the state, since `beginRecording`'s signature now
  makes it unreachable through the public API. Say in a comment why the cast is there.
- `playground/src/QueuePanel.tsx` reads `item.recording.durationMs` for its elapsed-time line.
  Narrow on `kind`, and render something honest for a document rather than a zero.
- Roughly two dozen test fixtures declare `const recording: Recording = { … }` with no `kind`. They
  need `kind: "audio"` added, because `z.infer` gives the *output* type where `kind` is required.
  This is mechanical; the branch default is what keeps the far larger number of
  `schema.parse({ … })` call sites unchanged.

---

## Task 2 — `Transcriber` becomes generic over its item

**Files.** Modify `transcriber.ts`, `transcriber.test.ts`, `queue/relay.ts` (the injected
transcriber's type only).

**Intent.** `Transcriber<S extends CaptureItem = Recording>`, with `transcribe(item: S, bytes: Blob)`.

The default type argument means bare `Transcriber` keeps meaning **exactly** what it means today, so
`ribo-transcriber-ondevice`, `ribo-transcriber-managed`, `firstCapable`, `hedged` and
`FakeTranscriber` satisfy it **unchanged**. Rename the parameter `audio` → `bytes`: a parameter
name, not an exported symbol, so nothing importing this breaks, and the Blob was always just bytes.

`RelayOptions.transcriber` widens to the union instantiation, because `OutboxItem.recording` is now
the union. Note in a comment that TypeScript compares **method** parameters bivariantly, so an
audio-only `Transcriber` still satisfies the widened field — the type system will not catch a host
that wires an audio engine and then enqueues a PDF, and the honest answer to that is
`UnsupportedItemError` at runtime (Task 3), not a type trick.

**Do not** add `"no-text-layer"` to the *capability* reason vocabulary. The per-item case is Task 3
and is not a capability reason. Only add it there if a genuinely engine-level use turns up, and say
so if it does.

**Interfaces produced.** `Transcriber<S>` with the default argument; `transcribe(item, bytes)`.

**Must-fail tests.** These are type-level properties, so assert them the way
`queue/schema.test.ts` asserts unpatchable fields — with `@ts-expect-error`, where the unused-
directive error *is* the assertion. A runtime test cannot reach any of them.

- A `Transcriber<DocumentCapture>` **cannot** be constructed from a function taking a `Recording`
  (and vice versa) — the constraint is doing work.
- Bare `Transcriber` still accepts a `Recording` and still **rejects** a `DocumentCapture`, so the
  default argument has not silently widened the existing contract.
- Something that satisfies `Transcriber` today (construct it inline, or reuse `FakeTranscriber`)
  still satisfies it with no type arguments written.

---

## Task 3 — `UnsupportedItemError`: the third failure class

**Files.** Create `unsupported-item.ts`, `unsupported-item.test.ts`. Modify `queue/backoff.ts` (the
D5 widening only), `transcriber.ts` (cross-reference in the `transcribe` doc comment), `index.ts`.

**Intent.** Land D4 and D5. Ribo has two failure kinds and a scanned PDF is neither: retrying
pdf.js will never help, so it is not an attempt failure; but pdf.js is working perfectly, so
demoting it is wrong. This is *item unsuitability* — "this engine cannot handle this item, and that
says nothing about the engine".

The class carries `engine`, a closed `reason` of `"no-text-layer" | "encrypted" |
"unsupported-format"`, and a required `detail` — closed because a UI has to branch on it, and
`detail` required because a reason code with no detail is unactionable. Follow
`TranscriberUnavailableError`'s constructor shape (an init object, a composed message, a
`cause` passthrough) so the two read as siblings.

Extend the `transcribe` doc comment in `transcriber.ts` from two failure kinds to three, and make
each of the three error classes' doc comments point at the other two. The distinction is the
contract's whole reason for existing, and it is only as strong as the prose keeping it.

**Interfaces produced.** `UnsupportedItemError`, `UnsupportedItemInit`,
`UNSUPPORTED_ITEM_REASONS`, `UnsupportedItemReason`. Task 4 reads the class; Task 6 throws it.

**Must-fail tests.**

- `isTransientFailure(new UnsupportedItemError(...))` is `false`. This is the D5 property, and
  without it the relay retries a scanned PDF eight times.
- `error instanceof TerminalQueueError` is `true`, and `error.name` is `"UnsupportedItemError"` —
  the second half is what the D5 widening buys, and without the assertion someone will "simplify"
  the annotation back and silently rename every one of these errors to `TerminalQueueError`.
- `error instanceof TranscriberUnavailableError` is `false`, and an `UnsupportedItemError` carries
  **no** `capability` accessor. The one thing this class must never do is offer a capability verdict
  to replace a cached one, because pdf.js stays `ready`.
- A `TranscriberUnavailableError` is still classified transient — the pre-existing property, pinned
  here because the D5 edit is in the file that decides it.
- The `reason` list is closed: an unlisted reason is a type error (`@ts-expect-error`).

---

## Task 4 — `fallbackTranscriber` and the transcription arbiter

**Files.** Create `transcription-arbitration.ts`, `transcription-arbitration.test.ts`,
`fallback-transcriber.ts`, `fallback-transcriber.test.ts`. Modify `fake-transcriber.ts`,
`fake-transcriber.test.ts`, `index.ts`.

**Intent.** Land D6 and D7 — give the transcriber side the composition the extractor side already
has.

**Why this is a sibling vocabulary and not a reuse of the extractor engine.** `arbitration.ts` is
out of scope, and its engine is typed end-to-end in `Extractor<F>` / `ExtractionResult<F>`: its
candidates carry admission probes a transcriber ladder has no use for, and its accept path stamps
`usage[stampKey]`, which a `Transcript` has no equivalent of and does not need (D6). Generalising it
would mean editing the one file the tranche is told not to touch, in order to add two type
parameters that no extractor caller wants. So: **mirror the shape and the vocabulary, in a new
module.** Reuse the *concepts* — outcomes in settlement order, an `exhausted` flag, an
accept/continue/give-up verdict, exhaustion checked first — not the code. Name the parallel types so
the correspondence is obvious to a reader who knows the extractor side.

Carry over two specific lessons that `arbitration.ts` learned the hard way and paid for:

1. **Discriminate the outcome union on the success VALUE, never on key presence.** `result?: never`
   permits an explicit `undefined`, so an error outcome written with the key present read as a
   success and the arbiter accepted a result that did not exist, swallowing the error.
2. **Validate the verdict.** A `continue` returned at exhaustion is a caller bug and must fail
   naming the arbiter, not crash reading a property off nothing.

Do **not** export outcome constructors. The extractor side exports `resultOutcome` / `errorOutcome`
because `compositeExtractor` drives that engine directly; nothing outside this module builds a
transcription outcome, and those two names are already taken in the barrel.

**Make `FakeTranscriber` generic** — `FakeTranscriber<S extends CaptureItem = Recording>` — rather
than adding a second document-shaped fake. Non-negotiable #1 decides this: two fakes for one seam is
two names for one thing. `new FakeTranscriber()` stays identical for every existing caller. Add a
setter for a one-shot and a persistent `UnsupportedItemError`, beside the existing
`failWithUnavailable`, so the fake still simulates **every** failure kind the contract has — which
is the property that makes it a shipped deliverable rather than test scaffolding. Its call-log
fields rename to match the contract (`item`, `bytes`); that is four lines across two test files.

**Interfaces produced.** `TranscriptionOutcome`, `TranscriptionArbiterInput`,
`TranscriptionArbiterVerdict`, `TranscriptionArbiter`, `unsupportedFallsThrough`;
`fallbackTranscriber(transcribers, arbiter, options?)` returning a `Transcriber<S>` whose `engine`
defaults to `"fallback"`. `FakeTranscriber<S>` with the new setter.

**Must-fail tests.** Drive all of these through `FakeTranscriber` instances — that a Fake
substitutes in with zero changes elsewhere is non-negotiable #3, and it is what proves the seam.

- A ladder whose first candidate throws `UnsupportedItemError` calls the second, and returns the
  second's transcript **with the second's own engine id**, not the wrapper's.
- The first candidate's **cached capability is untouched** after it throws `UnsupportedItemError`:
  probe it before and after and assert `ready` both times, and assert the ladder never called
  `capability()` at all. Non-negotiable #2, and the single most important test in this task.
- A ladder whose first candidate throws a plain attempt failure **does not call the second**, and
  rethrows that error unchanged. One bad clip must never re-route.
- Every candidate throwing `UnsupportedItemError` gives up with a **terminal** error, so the item
  goes `dead` on the first pass rather than burning the retry budget.
- A mix of one `UnsupportedItemError` and one retryable failure gives up with the **retryable** one
  (D7 rule 2). Assert via `isTransientFailure`, and get the ladder order wrong deliberately once
  while writing it — the naive "first error" implementation passes every other test in this list.
- A `TranscriberUnavailableError` from the first candidate routes to the second (D7 rule 3).
- The ladder does **not** consult `capability()` before calling a candidate: a candidate reporting
  `unavailable` is still called, and the arbiter decides. This is the property that distinguishes it
  from `firstCapable`, and nothing else asserts it.
- An arbiter returning `continue` at exhaustion fails with a message naming the arbiter.
- An arbiter accepting a transcript no candidate produced fails, rather than returning it.
- An empty candidate list and a duplicate engine id are both refused at construction.
- `FakeTranscriber` with no type argument still compiles against everything that used it before —
  run the existing `first-capable`, `hedged` and `relay` suites as the assertion.

---

## Task 5 — `@azx/ribo-transcriber-pdfjs`: the package skeleton and `capability()`

**Files.** Create `packages/ribo-transcriber-pdfjs/` — `package.json`, `tsconfig.json`,
`tsdown.config.ts`, `README.md`, `src/index.ts`, `src/config.ts` and their colocated tests. Modify
`pnpm-workspace.yaml` (catalog entry), `docs/typedoc.json` (entry point).

**Intent.** The package, its build wiring, and the **cheap** half of the contract. Splitting the
skeleton from the pdf.js work is deliberate: the packaging rules in AGENTS.md §6 have their own
failure modes, and a `publint`/`attw` failure is a different diagnosis from a text-extraction bug.

Copy `packages/ribo-transcriber-managed/` and change the name — it is the closest sibling. Work
through AGENTS.md §6.2's checklist rather than from memory; the items that bite are `@azx/tsconfig`
in `devDependencies` (only referenced from `tsconfig.json`, and this repo has shipped that bug
once), the `typecheck` script (a package without one is **silently absent** from the gate), the
`"vitest": "catalog:"` entry despite there being no `test` script, `"@azx/source"` **first** and
`"types"` before any JS condition in `exports`, and `@azx/ribo-core` as a plain `dependencies`
entry — `ribo-transcriber-managed` and `-ondevice` are both plain-`dependencies` because they hold
no core instance whose identity must stay shared with a consumer, which is the actual criterion, not
"type-only".

Add `pdfjs-dist` to the `catalog:` block in `pnpm-workspace.yaml`. **Do not invent a version
number** — resolve the latest compatible one at install time and pin exactly what you got, with no
caret, and a comment saying what it is for.

`capability()` per D8: no pdf.js load, no document knowledge. Its options — the injected worker URL
above all — live in `config.ts` beside a `PDFJS_ENGINE` constant, following the managed package's
split.

**Interfaces produced.** `PdfjsTranscriber` implementing `Transcriber<DocumentCapture>`,
`PdfjsTranscriberOptions`, `PDFJS_ENGINE` (the string `"pdfjs"`).

**Must-fail tests.**

- `capability()` reports `not-configured` with no worker URL, and `ready` with one. `not-configured`
  must **not** be permanent — a host may supply one later.
- `capability()` does not load pdf.js. Assert it, do not assume it: the contract says this method is
  called often, and a probe that quietly pulls in 89 KB is the failure this test exists for. A
  counter on an injected module loader is the cleanest way to see it.
- `engine` is exactly `"pdfjs"` and is what a produced transcript carries.
- Repeat the workspace-resolution smoke check the other packages carry, so the new package is
  provably importable by name.

**Do not skip `./check.sh` here.** `build:packages` runs publint and attw in-build, `check:resolve`
asserts both directions of the `@azx/source` condition for **every** package (it enumerates
`packages/*` from the filesystem, so the new one is covered with no script edit), and `check:pkg`
asserts no TypeScript source ships in the tarball. Those four gates are the reason this task is
separate.

---

## Task 6 — pdf.js text extraction, page markers, and the `no-text-layer` guard

**Files.** Create `src/pdf-text.ts`, `src/pdf-text.browser.test.ts`, fixture PDFs under
`src/fixtures/`. Modify `src/index.ts` (wire `transcribe`), `README.md`. Modify `AGENTS.md` (§1's
package inventory and §3's architecture table).

**Intent.** The rest of D8. A memoized dynamic `import()` of pdf.js; per-page `getTextContent()`;
each page prefixed with its marker; the whole document returned as one string. Preserve the
reference implementation's handling of `item.hasEOL` — it is what keeps line structure, and the
extraction accuracy measured on 15 real PDFs was measured **with** it.

The text reader is exported in its own right (D8), because a host needs `pageCount` at enqueue time
and must not load a second copy of pdf.js to get it.

The `no-text-layer` guard: strip the page markers and all whitespace, and if what remains is under a
threshold, throw `UnsupportedItemError` with `reason: "no-text-layer"`. **Export the threshold as a
named constant and expose it as an option**, and say in its doc comment that the value is
provisional and what would refine it — a scanned PDF often yields a handful of stray characters from
a header stamp, so zero is the wrong bar and any specific number is a guess until it has met real
scans. This repo has a precedent for shipping provisional defaults with knobs; follow it rather than
hiding a magic number.

Map pdf.js's own exceptions rather than letting them through as attempt failures: a password
exception is `reason: "encrypted"`, an invalid-PDF exception is `"unsupported-format"`. **Anything
else rethrows unchanged** — that is an attempt failure and the queue owns it. Getting this mapping
too greedy is how a transient failure becomes a permanent `dead`.

**This must be a `*.browser.test.ts`.** pdf.js needs a real `Worker` and real structured-clone
behaviour; the root vitest config's `browser` project globs `packages/*/src/**/*.browser.test.{ts,tsx}`,
so the new package is picked up with no config edit. A node test here would mock the very thing
under test.

Two committed fixtures are needed and both can be hand-written as raw PDF bytes — a few hundred
bytes each, no generator dependency: one two-page document with a real text layer and known
strings, and one with **no** text layer at all. Commit them with a comment saying how they were
constructed, because a fixture nobody can regenerate is a fixture nobody can fix.

Finally: AGENTS.md §1 and §3 enumerate the packages, and both say "six publishable packages". That
count is **already stale** — there are seven (`ribo-extractor-ondevice` is not listed either) — so
correct the count and add both missing packages while you are in there. Per the repo's own rule, do
not write a number that a future package will falsify if you can avoid it.

**Interfaces produced.** The exported text reader (returning the marked-up text and the page count),
`PAGE_MARKER`-style constant if the marker is referenced from more than one place, and the
`no-text-layer` threshold constant and option.

**Must-fail tests.**

- A two-page text-layer PDF yields both pages' known strings, and the output contains
  `===== PAGE 1 =====` and `===== PAGE 2 =====` in that order, each on its own line. Assert the
  exact marker form — a downstream prompt is written against it.
- Markers are numbered from **1**, not 0. Trivial and exactly the kind of off-by-one that ships.
- A no-text-layer PDF throws `UnsupportedItemError` with `reason: "no-text-layer"`, and the thrown
  error names the engine.
- That same failure leaves `capability()` reporting `ready`. Non-negotiable #2 again, this time
  against the real engine rather than a fake — one unreadable PDF must never demote pdf.js for
  every future document.
- pdf.js is **not** imported until the first `transcribe()` call, and is imported **once** across
  two calls. The memoization is the whole reason for the dynamic import.
- The whole document reaches the output: assert the total marker count equals the page count, so a
  future page router cannot be added without turning this test red. The abode spike dropped 10 of 19
  pages silently, and this test is what would have caught it.
- A transcript produced through the ladder from Task 4 carries `engine: "pdfjs"`, proving the two
  halves compose.

---

## Self-review — spec coverage

| Prompt step | Task |
| --- | --- |
| 1 — `Recording` gains `kind`; migration verified | 1 (D1, D2, D3) |
| 2 — `Transcriber` generic; `audio` → `bytes` | 2 |
| 3 — third failure class | 3 (D4, D5) |
| 3 — `fallbackTranscriber` + arbiter + Fake | 4 (D6, D7) |
| 4 — `@azx/ribo-transcriber-pdfjs` | 5 (skeleton, cheap `capability()`) and 6 (extraction, markers, guard) |
| Changeset | every task |

**Report back, when the work is done.**

1. Whether Task 1 really avoided an RxDB version bump, with the evidence it pinned.
2. That the third failure class is `UnsupportedItemError` and why (D4), and that it required the D5
   widening of `TerminalQueueError.name` — the one existing implementation this tranche changed
   beyond a parameter rename.
3. The three corrections this plan already carries against the original prompt (D3's zod finding,
   D5's TS2416 finding, and AGENTS.md's stale package count), plus anything else that turns out to
   be wrong about the codebase.
4. The `pageCount`-at-enqueue coupling (D8) and whether the exported text reader actually resolves
   it for a host, or whether it wants a different shape.
