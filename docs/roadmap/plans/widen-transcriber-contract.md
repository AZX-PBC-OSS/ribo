# Widening the Transcriber contract — Implementation Plan

> **For anyone implementing this, human or agent:** work task-by-task. Task 1 is the contract
> change and everything else depends on it. Tasks 2–5 are independent of each other once it lands.
> Task 6 follows Task 5 — both edit `relay.ts`. If a task's premise turns out to be wrong against the actual
> code, stop and say so rather than improvising around it.

**Goal:** Give `Transcriber.transcribe` an options parameter carrying run context, so a
transcription can be cancelled and so a plugin can be handed its storage handle — closing three
follow-ups that all wait on the same slot.

**Architecture:** `Transcriber.transcribe(item, bytes, options?)` mirrors the shape
`Extractor.extract(transcript, options?)` already has. The options object carries an
`AbortSignal` now; `PluginStorage` joins it in Task 6. Combinators thread it; transports forward
it as far as each can honestly go, which differs per transport and is the substance of Tasks 2–4.

**Tech Stack:** TypeScript 6.0.3, zod 4.4.3, Vitest 4 (node `unit` + real-Chromium `browser`),
tsdown, pnpm 10.34.5 catalog.

**Design context:** `docs/roadmap/design/post-docs-findings.md` (the three open questions this
closes, and P2's original lifecycle decision) and
`docs/roadmap/design/per-group-composition-design.md` §4.4 plus the plan's P2 sequencing note in
`composition-and-type-fixes.md`, which anticipated that the storage handle needs this contract
widened and not just `Extractor`'s.

---

## Global Constraints

- **Node >= 24, pnpm 10.34.5.** Every command from the repo root. `./check.sh` is the definition
  of done: typecheck, lint, format:check, build:packages, resolve, build:app, pkg:gates,
  snugg:drift, skips:tracked, score:mutations, test. Paste its summary line; never assert success
  without it.
- **CI additionally runs** `pnpm docs:build`, `pnpm changeset status --since=origin/main`, and
  `pnpm test:pack-and-consume`. Run the first two yourself; a malformed changeset breaks CI and
  `./check.sh` will not tell you. Changeset frontmatter is a quoted YAML map of package name to
  bump level.
- **Nothing is published yet, and this is the last cheap moment.** `Transcriber` is implemented in
  four packages — `ribo-transcriber-ondevice`, `-managed`, `-managed-docs`, `-pdfjs` — plus
  `FakeTranscriber` plus anything a host has written. After the first release
  this same change costs every consumer a migration. Breaking changes are acceptable; back-compat
  overloads are not wanted.
- **`Extractor.extract`'s `ExtractOptions` is the precedent.** Match its shape, its parameter
  position, and its optionality. Two adjacent contracts with different conventions for the same
  thing is the drift this repo keeps correcting.
- **A signal that is accepted and not forwarded is worse than no signal**, because it looks like
  cancellation and is not. Every task that claims to forward one must assert on what the transport
  observed, not on the promise rejecting. `packages/ribo-core/src/fallback-extractor.test.ts` has
  a propagation test in this shape and `FakeExtractor.callOptions` is the recording pattern.
- **Every guard you add must be proven to discriminate.** Break the thing it guards, observe the
  failure, restore, and report the observed output.
- **A green Vitest run is not evidence a type-level change is complete.** esbuild strips types
  without checking them, so a red `tsc` does not turn Vitest red. Run `pnpm typecheck`.
- **ESM-only**, `import type` for type-only imports, zod at trust boundaries. `ribo-core` and
  `ribo-adapter-snuggpro` are headless: no `react`, no `document`, no `window`.
- **Do not confuse two different `transcribe`s.** `packages/ribo-transcriber-ondevice/src/worker.ts`
  declares `transcribe: (samples: Float32Array) => …` on an internal session type. That is not the
  `Transcriber` contract and is out of scope everywhere in this plan.

---

## Task 1: Add `TranscribeOptions` to the `Transcriber` contract

**Files:** `packages/ribo-core/src/transcriber.ts` (the contract), `fake-transcriber.ts`,
`first-capable.ts`, `fallback-transcriber.ts`, `hedged.ts`, `restrict-to-kind.ts`,
`packages/ribo-core/src/index.ts`, and the four implementations' signatures in
`ribo-transcriber-ondevice/src/index.ts`, `-managed/src/index.ts`, `-managed-docs/src/index.ts`,
`-pdfjs/src/index.ts`.

**What to do:** Declare `TranscribeOptions` with an optional `signal`, and add it as an optional
third parameter to `Transcriber.transcribe`. Export the type from the core barrel. Update every
implementation's signature to accept it, and every combinator to thread it through.

`FakeTranscriber` must **record** the options it receives, the way `FakeExtractor.callOptions`
does. A combinator that accepts options and forwards none typechecks and is invisible without
that — which is exactly how the extractor combinators shipped broken and were caught only by a
review.

Do not forward the signal to any transport in this task. This is the seam and the threading only.

**Interfaces produced:** `TranscribeOptions` with `signal?: AbortSignal`;
`Transcriber<S>.transcribe: (item: S, bytes: Blob, options?: TranscribeOptions) => Promise<Transcript>`;
`FakeTranscriber.callOptions` returning the per-call options in order.

**Tests that must fail first:** For each of the four combinators — `firstCapable`,
`fallbackTranscriber`, `hedged`, `restrictToKind` — assert the signal the caller passed is the
signal the selected transcriber received, by identity, using `FakeTranscriber`'s recorder. Break
one forward, watch that combinator's test fail, restore, report the output.

`hedged` needs its own thought: it races two transcribers, so both receive the caller's signal,
and the loser's cancellation is a separate concern from the caller's. State what you implemented.

## Task 2: Forward the signal in the two fetch-based transcribers

**Files:** `packages/ribo-transcriber-managed/src/transcribe.ts` and
`packages/ribo-transcriber-managed-docs/src/transcribe.ts` — the fetch lives there, not in the
`index.ts` that holds `fetchImpl`. Both `index.ts` files thread the option through.

**What to do:** Both hold an injected `fetchImpl` (defaulting to `fetch`). Pass the signal in the
request init so an abort cancels the in-flight HTTP request. These are the two transports where
cancellation is unambiguous.

**An abort must not burn the retry budget, and today it would.** `AbortError` is classified as a
transient failure (`packages/ribo-core/src/transcriber.test.ts:101-108` pins this), so a cancelled
transcription currently looks to the queue exactly like a flaky network and gets retried. Decide
how a deliberate cancellation is distinguished from a transport failure and implement it — this is
the part of Task 2 with real consequences, not the signal forwarding.

**Tests that must fail first:** A fake `fetchImpl` that records the `signal` it was handed;
assert it is the caller's, by identity. Then a test that aborts mid-flight and asserts the fetch
was aborted — not merely that the promise rejected.

## Task 3: Decide what an abort means for the on-device transcriber

**Files:** `packages/ribo-transcriber-ondevice/src/index.ts` and its worker protocol.

**Problem:** This transport has no natural cancellation. The only lever is `worker.terminate()`,
which destroys a worker holding a primed model — the thing `prime()` exists to avoid paying for
twice. So "forward the signal" is not obviously right here.

**Two facts that narrow the choice, both verified:**

- **The chunk loop runs inside the worker** (`worker.ts:577-584`), so "check between chunks" is
  not a main-thread `if` — it needs new worker-protocol messages, which is a materially larger
  change than it sounds.
- **The worker channel is shared with live transcription.** Batch replies are matched by
  `requestId` and live replies by `sessionId` precisely so they do not crosstalk on one channel
  (`index.ts:414-418`). So `terminate()` on a batch abort would also kill an in-flight **live
  session** — a user's dictation preview dying because a queued file was cancelled. Any answer
  involving `terminate()` must say what happens to a live session, or rule it out on that basis.

**What to do:** Decide, and justify, between: terminating on abort and accepting both the re-prime
cost and the live-session consequence; checking the signal between chunks via the worker protocol;
or declining to honour the signal and documenting that. Any of
the three is defensible; leaving the parameter accepted and silently ignored is not.

Whatever you choose, the behaviour must be stated in the transcriber's doc comment where a host
will read it, because a host that believes it can cancel and cannot has a worse problem than one
that knows it cannot.

**Tests that must fail first:** Whatever you chose, assert it. If the answer is "checks between
chunks", the test is a multi-chunk transcription aborted after the first chunk asserting the
second never ran. If the answer is "declines", the test asserts the transcription completes and
the doc comment says so.

## Task 4: The pdfjs transcriber

**Files:** `packages/ribo-transcriber-pdfjs/src/index.ts`.

**What to do:** pdf.js **does** offer cancellation — `loadingTask.destroy()` — and the local shim
in `packages/ribo-transcriber-pdfjs/src/config.ts:26` simply does not expose it. So this is not an
investigation: extend the shim's type to surface `destroy`, and wire the signal to it. Page
iteration may additionally allow a between-pages check for work already loaded.

The same rule as Task 3 applies: accepted-and-ignored is the one unacceptable outcome.

**Tests that must fail first:** As Task 3 — assert whatever behaviour you chose, and if the
answer is a between-pages check, prove the later page never ran.

## Task 5: Wire the relay's transcribe timeout to the signal

**Files:** `packages/ribo-core/src/queue/relay.ts` — `#transcribe`, around its `withTimeout` call.

**Problem:** `#transcribe` wraps `transcriber.transcribe(...)` in `withTimeout` with no way to
cancel, so a timed-out transcription rejects while its request runs to completion. This is the
same gap Task 19 of the previous plan closed for `#sessionExtract`, which grew an `onTimeout` hook
that aborts a per-attempt controller before rejecting. Follow that implementation — it is the
pattern, and it is three commits old.

**Tests that must fail first:** A relay test where transcription exceeds the step timeout and the
transcriber's recorded signal is observed aborted. Assert on what the transcriber saw, not that
the relay moved on.

## Task 6: Deliver the plugin storage handle

**Files:** `packages/ribo-core/src/transcriber.ts`, `packages/ribo-core/src/queue/relay.ts`,
`packages/ribo-core/src/queue/outbox.ts`, and whichever extractor construction sites Task 6's
decision touches.

**Problem:** `post-docs-findings.md` P2 records plugin-scoped storage as built and swept but
**undeliverable**: the only accessor is `Outbox.pluginStorage(captureId, pluginId)`, so a plugin
reaches its own storage only if the application hands it the whole `Outbox` — the option P2's
design explicitly rejected, because it makes `Outbox`'s API a plugin-facing contract by accident.

**The decision this plan makes, rather than leaving to code.** An earlier draft said "add it to
both options bags and let the relay supply it". That is wrong on the extract side and the reason
is worth stating, because it shapes the answer:

- A **transcriber** is chosen at call time — `firstCapable` picks among candidates per item — so
  the relay genuinely is the caller and can supply a handle scoped to that capture and that
  plugin. `TranscribeOptions` is the right slot.
- An **extractor** is not. The relay calls an opaque injected `sessionExtract` step
  (`relay.ts:507-509`), and `Extractor<F>` carries **no identity at all** — `engine` appears on
  the _result_, after the call (`extractor.ts:43-44`). The relay cannot name the plugin it is
  invoking, so it cannot scope a handle for it without a new contract field.

So: **the transcriber side gets the handle through `TranscribeOptions`; the extractor side gets it
at construction**, the way it already receives `chat`, `model` and `target`. A host building an
extractor knows which plugin it is building, which is exactly the identity the contract lacks.
This also avoids adding an id to `Extractor` purely to serve storage.

**The residual, which this task must resolve and document:** a transcriber's handle is scoped to
one capture; an extractor runs over a session joined from several. So an extractor that wants what
its sibling transcriber stored needs to read across the session's captures, not one. Decide what
the construction-time handle is scoped to — a session, a plugin across all captures, or something
the host passes per run — and state plainly what a plugin author can and cannot rely on. Check how
the per-capture sweep in `plugin-storage.test.ts` interacts with whatever you choose: storage
swept when a capture is dropped must not leave a session-scoped reader holding a stale view.

**Tests that must fail first:** A transcriber writes a value through the handle it was given, and
an extractor in the same session reads it back — with the outbox **closed and reopened between
them**, because the two halves of a plugin may run in different tabs, minutes apart, which is why
this is storage and not a field. An in-memory pass would satisfy a weaker test and miss the point.

Also assert two plugins cannot read each other's keys through the handles they are supplied, and
that a capture's sweep removes what a transcriber wrote for it.

## Sequencing

Task 1 first and alone; everything else depends on it. Tasks 2, 3, 4 and 5 are independent of one
another — verified disjoint in their files. **Task 6 follows Task 5**, not merely Task 1: both
edit `relay.ts`, and Task 5's `onTimeout` wiring is in the same method Task 6 threads a handle
through. Task 6 is the largest — it may reasonably be deferred to its
own change if the first five take longer than expected, but the contract slot it needs is Task 1's
deliverable either way.
