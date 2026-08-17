# Managed transcription — implementation plan

**Authority:** `managed-transcription-design.md`. Read §3 (what already exists), §5 (the three pieces),
§6 (vendor and phrase list) and §7 (what was measured) before starting any task.

**Scope.** The RTF gate, the managed Azure transcriber, and the hedge combinator. Sequential fallback
already works; this makes it reachable and adds an opt-in race.

## Decisions pinned for this tranche

Do not reopen these mid-task. Each was settled in the design or measured on 2026-08-17.

**Fast Transcription, api-version `2025-10-15`.** Not Azure OpenAI transcription. The version is not
incidental — `phraseList` does not exist before it.

**No chunking, no transcode.** A real `MediaRecorder` WebM/Opus blob transcribes as-is (§7). Ten
minutes of dictation fits a 10 MB hop. If a recording ever exceeds the cap the correct behaviour is a
clear terminal failure, not a chunking implementation smuggled into this tranche.

**No `AbortSignal` on `Transcriber.transcribe`.** A fired hedge is paid for even when the primary
wins. Accepted; revisit when `onHedge` telemetry shows the real rate.

**The calibration clip is a committed asset.** A short (~5 s) 16 kHz mono WAV in the on-device
package. Not synthesised at runtime, not downloaded, not the user's first real recording.

**Provisional defaults ship with knobs.** No Surface Go 3 or field-uplink numbers exist and we are not
gathering them first. Pick a documented default, expose the knob, say in the doc comment that it is
provisional and what would refine it.

## Global constraints

Every task inherits these.

- ESM-only; `.js` extensions on relative TypeScript imports; `import type` for type-only imports
  (lint-enforced).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` must pass. Run `./check.sh` before the final
  commit of each task. The suite is green; **any** failure is yours to explain.
- Comments explain **why**, not what. A comment describing behaviour the code no longer has is a
  defect.
- **No new runtime dependencies.** The managed transcriber uses bare global `fetch`, as
  `ribo-extractor-openai` does.
- **The core contract does not change.** Not `Transcriber`, not `TranscriberCapability`, not
  `firstCapable`, not the outbox schema. §5.1 depends on this: `prime()` is not part of the interface,
  which is precisely why the gate needs no contract change. If you find yourself widening
  `TranscriberCapability`, stop — you have taken a wrong turn.
- No secret is ever bundled, logged, or written to a test fixture. Token, base URL and origin are
  injected by the host, exactly as `helixChat` does it.
- Commit in small pieces as you go. A run that leaves everything uncommitted produced nothing, and a
  task in this repo has died with an empty worktree after hitting the model's output cap.
- Each task adds a changeset.

## Task 1 — The RTF verdict: persist it, and let `capability()` report `too-slow`

**Files:** a new module in `packages/ribo-transcriber-ondevice/src/`, its tests, and the `capability()`
branch in `packages/ribo-transcriber-ondevice/src/index.ts:151`.

**Intent.** A small store that records one measured real-time factor per model id and survives a
reload, plus the `capability()` branch that consults it. **No inference in this task** — the RTF value
is written directly by tests. This is the pure half, and it is where the interesting behaviour lives.

Storage is **injected**, following the existing `#cacheStorage` pattern in the same class, so tests
supply a double rather than touching real persistence. The verdict must be durable across instances,
because `too-slow` is in `PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS` and re-measuring on every page
load would defeat the point.

**Ordering matters and is easy to get backwards.** A stored `too-slow` verdict outranks the cache
check: a device known to be too slow must report `unavailable` even with the weights cached, because
the weights being present is exactly the situation the current code mistakes for readiness. Preserve
today's behaviour when there is no stored verdict.

**Interfaces.** Decide and state in your report: the accessor name that exposes the measured RTF for
Task 6's delay policy (it must return `undefined` before calibration, not a sentinel number), the
option name for the threshold, and the storage key shape. Task 2 writes through this module; Task 6
reads the accessor.

**Must-fail tests.**

- A stored RTF above threshold, **with the model cached**, yields `unavailable` / `too-slow`, and the
  `detail` carries the measured value. This is the behaviour that does not exist today at any
  threshold.
- A stored RTF below threshold and the model cached yields `ready`.
- No stored verdict and the model cached yields `ready` — today's behaviour is unchanged for devices
  that never calibrate.
- `isPermanentlyUnavailable()` returns true for the verdict this produces. If it does not, `firstCapable`
  will re-probe a permanent fact on every drain.
- A verdict written by one instance is read by a fresh one, and a verdict stored under a different
  model id is **not** read — a model swap must re-measure rather than inherit.

## Task 2 — Measure the real-time factor during `prime()`

**Files:** the calibration clip asset and a calibration module in
`packages/ribo-transcriber-ondevice/src/`, the `prime()` path in `index.ts`, and a browser test
(`*.browser.test.ts` — it needs a real worker).

**Intent.** After `prime()` has constructed the pipeline and before it resolves, run one inference
over the committed clip, divide elapsed wall clock by the clip's known duration, and write the verdict
through Task 1's store. The pipeline is already warm at that point, so this measures inference rather
than model load — measuring the load instead would produce an RTF that says more about the disk than
the device.

Keep `prime()`'s existing contract: explicit, user-initiated, never called on a timer or a queue
drain. If `onProgress` gains a calibration phase, it is additive.

**A calibration failure must not fail `prime()`.** A device that primed successfully but could not be
timed should end with no verdict — which Task 1 already treats as "unknown, therefore `ready`" — not
with a broken prime. Swallow, do not propagate.

**Interfaces.** Consumes Task 1's store. Produces nothing new for later tasks beyond a populated
verdict.

**Must-fail tests.**

- After `prime()` resolves, the accessor returns a number, and `capability()` reflects it.
- A deliberately slow worker double produces an RTF above threshold, and `capability()` then reports
  `too-slow` — the end-to-end path Task 1 could only test halfway.
- A worker that throws during calibration still leaves `prime()` resolved, with no verdict stored.
- The measurement divides by the clip's real duration: a clip of known length timed against a
  controlled clock yields the arithmetically correct RTF. A test that only asserts "some number
  appeared" would pass with the units inverted.

## Task 3 — The managed transcriber package: scaffold, config, capability

**Files:** a new `packages/ribo-transcriber-managed/` — `package.json`, `tsconfig.json`,
`tsdown.config.ts`, `README.md`, `src/index.ts`, `src/config.ts` — plus tests and a changeset. Mirror
`packages/ribo-extractor-openai/` exactly; it is the closest existing leaf package.

**Intent.** The package exists, builds, passes the package gates, and reports capability correctly.
**No transcription in this task** — that is Task 4. Splitting here means the packaging work (which is
fiddly and has its own gates) is reviewed separately from the request logic.

Engine id is `managed-azure-speech`, stable and short: it is persisted into every `Transcript.engine`
it produces.

Everything is injected — bearer token, gateway base URL, `Origin`, the Azure resource host, and
`fetch`. Connectivity is injected too, as a predicate: do **not** reach for `navigator.onLine`
directly and do not duplicate core's three-state connectivity model.

Capability maps onto reasons that already exist: no token yields `not-configured`, a connectivity
predicate reporting down yields `offline`, otherwise `ready`. Neither failure is permanent, and that
matters — both are situations, not facts about the hardware.

**Interfaces.** Produces the options interface and the class name Task 4 extends and Task 7 constructs.
State both in your report.

**Done also means:** `pnpm build:packages`, `pnpm check:resolve` and `pnpm check:pkg` pass with the new
package present. These gates exist because a package can typecheck and still be unconsumable.

**Must-fail tests.**

- No token yields `not-configured`, and `isPermanentlyUnavailable()` is **false** for it — a missing
  key must not permanently demote the engine, because the host may supply one later.
- A connectivity predicate reporting down yields `offline`; reporting up with a token yields `ready`.
- The engine id is exactly the documented string. Assert the literal — it is persisted data, and a
  rename is a migration.

## Task 4 — Transcribe through the fetch-proxy

**Files:** `packages/ribo-transcriber-managed/src/` — the transcribe path and its tests.

**Intent.** POST the recording's audio blob as `multipart/form-data` to the Fast Transcription
endpoint through the gateway, and map the response onto a `Transcript`.

The request shape is settled and verified (§7): the target is
`<resource-host>/speechtotext/transcriptions:transcribe?api-version=2025-10-15`, prefixed onto
`<baseUrl>/_api/fetch/`. Two form parts: `audio` carrying the blob, and `definition` carrying JSON.
The transcript text is `combinedPhrases[0].text`. Send the blob **as recorded** — no transcode, no
re-containering.

**Failure classification is the point of this task, and getting it wrong is the bug the contract
exists to prevent** (`transcriber.ts`, and rule 5 of `firstCapable`):

- A 5xx, a timeout, a network error, a malformed body — **attempt** failures. Throw plainly. The
  queue's backoff owns them. These must **not** be `TranscriberUnavailableError`, or one bad clip
  permanently demotes the engine.
- A 401 or 403 — the credential is missing or wrong, which is a **capability** failure the host can
  fix. Throw `TranscriberUnavailableError` with `not-configured`.
- A payload the gateway refuses as too large — terminal, not retryable. Retrying an oversized body
  forever is worse than failing it. Use the queue's existing terminal vocabulary rather than inventing
  a second classifier.

**Interfaces.** Consumes Task 3's options and class. Produces a `Transcript` whose `recordingId`
matches the input `Recording` and whose `engine` is the package's engine id.

**Must-fail tests.** Drive these with an injected `fetch` double; **no test may make a network call.**

- A recorded fixture response yields a `Transcript` with the expected text, the input's `recordingId`,
  and the package's engine id.
- A 503 throws, and the thrown value is **not** a `TranscriberUnavailableError`. State the reason in a
  comment — this test is guarding a specific documented bug, and a future reader will otherwise
  "simplify" it.
- A 401 throws `TranscriberUnavailableError` with reason `not-configured`.
- An oversized payload fails terminally rather than as a retryable attempt failure.
- The request URL contains the `/_api/fetch/` prefix, the resource host, and
  `api-version=2025-10-15`. A silently wrong api-version would lose `phraseList` with no error.
- The bearer token appears in the request headers and **nowhere in any thrown error message or log
  line**.

## Task 5 — The phrase list

**Files:** `packages/ribo-transcriber-managed/src/` — the `definition` builder and its tests.

**Intent.** Accept a list of domain terms and send it as `definition.phraseList.phrases`. This is
load-bearing, not a refinement: measured on 2026-08-17, the same audio returned "our 19" without a
phrase list and "R-19" with one (§6). R-values are exactly what the extractor reads.

**The vocabulary belongs to the host, not to this package.** The on-device engine already takes domain
terms through `TranscribeHints` (`ribo-transcriber-ondevice/src/config.ts`) and turns them into a
jargon prefix. Do **not** move that type into `ribo-core` and do not hardcode a home-energy word list
in a tool-agnostic package. Take a compatible option here so one host-held list can feed both engines
by two mechanisms.

**Interfaces.** Produces the option name Task 7 passes the vocabulary through.

**Must-fail tests.**

- Supplied terms appear at `definition.phraseList.phrases` in the request body — assert the exact
  nesting, since a plausible-looking wrong key is silently ignored by the service.
- No terms supplied omits `phraseList` entirely rather than sending an empty object or empty array.
- `locales` is still present when a phrase list is supplied — a builder that replaces the definition
  instead of extending it would pass a naive phrase-list test while breaking language selection.

## Task 6 — The hedge combinator

**Files:** a new module in `packages/ribo-core/src/`, its tests, and the package's `index.ts` exports.

**Intent.** Race a preferred engine against a fallback on a latency budget, as a sibling of
`firstCapable` — **not** a flag inside it. `firstCapable` stays strictly sequential and rule 5 stays
untouched.

It takes a primary, a hedge, a delay policy, an optional `onHedge` callback and an injectable timer,
and returns a `CompositeTranscriber` so it is interchangeable with `firstCapable` and keeps
`capabilities()` and `invalidate()` working. The primary may itself be a `firstCapable`.

**The delay helper's clamp is the substantive part.** `delay = clamp(predicted × factor, floor,
budget)`. The naive formula — fire after the primary's own predicted duration — is wrong because it
scales the deadline by the device's slowness: on a three-minute dictation an RTF of 0.5 hedges at
135 s but an RTF of 2.5 hedges at 675 s, so the slower the device the later the help. `budgetMs`
expresses what the auditor will tolerate; the prediction only pulls the hedge earlier. Read §5.3 and
§7.1 before writing it.

RTF reaches the policy through Task 1's accessor, supplied by the host. **`ribo-core` must not learn
what an RTF is** — it takes a function returning milliseconds.

**Composition safety is explicitly out of scope.** A configuration that races an engine against itself
is possible and is [its own
ticket](https://app.asana.com/1/1208495702765136/project/1216763563065333/task/1217558466172554). Do
not add a guard here.

**Interfaces.** Consumes Task 1's accessor via the host. Produces the exported combinator, its options
type, the delay helper, and the `onHedge` event shape — Task 7 uses all four.

**Must-fail tests.** Drive the clock and the timer through injected doubles; no test may sleep.

- Primary resolves before the timer: primary's transcript is returned, and **the hedge transcriber is
  never invoked at all**. Assert the call count is zero, not merely that the primary won — this is the
  privacy-relevant assertion in the whole tranche.
- Timer fires and the hedge wins: the hedge's transcript is returned and `onHedge` reports both engines.
- Timer fires but the primary still resolves first: the primary's transcript is returned.
- Both already resolved: the primary wins.
- The primary throwing `TranscriberUnavailableError` hands over to the hedge immediately, without
  waiting for the delay.
- The primary throwing an ordinary error after the hedge succeeded returns the hedge's transcript.
- Both throwing propagates the **primary's** error.
- A primary that is not `ready` delegates straight to the hedge with no race.
- The clamp: a prediction far above `budgetMs` still fires at `budgetMs`, and one far below still
  respects `floorMs`. Assert both bounds — a clamp with one side missing passes a midrange test.
- A discarded loser that rejects does not surface as an unhandled rejection.

## Task 7 — Compose the real roster in the playground

**Files:** `playground/src/QueuePanel.tsx:243` and whatever wiring the composition needs.

**Intent.** The playground's batch path still runs a `FakeTranscriber` — its own comment calls it "the
pre-Phase-3 button". Replace it with the real composition, which is also the first time the on-device
engine reaches the **batch** path in this repo rather than only the live one.

Wire `firstCapable([onDevice, managed])` as the default, and expose the hedged composition as an
opt-in the playground can toggle, so both paths are exercised by hand. The host holds the domain
vocabulary and passes it to both engines (Task 5).

Managed configuration comes from the environment, as the existing Helix dev-gateway wiring does. **No
token in source.**

**Must-fail tests.** A browser test that a recording queued with no on-device model available reaches
the managed engine and produces a transcript, with `fetch` doubled. Do not call the real service from
a test.

## Task 8 — Retire the "deliberately out of scope" entries

**Files:** `docs/roadmap/index.md`, `docs/implementation/02-server-stt.md`,
`docs/roadmap/phases/phase-3-ondevice-transcription.md`, and a new phase record if the tranche's
outcome warrants one.

**Intent.** Three documents currently assert that the managed path is designed but unbuilt, and one
asserts chunking is required. After Task 7 they are wrong, and a stale roadmap is how work gets done
twice.

- `index.md` §"What is deliberately out of scope" — remove the managed STT fallback bullet.
- `02-server-stt.md` — record the vendor decision, the measured latency, and the chunking correction,
  pointing at the design doc rather than restating it.
- `phase-3` — its deferral note for the managed fallback is now discharged.

Leave the iOS on-device deferral alone. It is still true.

**Must-fail check.** `pnpm docs:build` passes — it runs the dead-link check, and these edits move
links.

## Non-goals

Stated so nobody re-litigates them mid-tranche:

- Live transcription on the managed path. No gateway WebSocket exists (§4).
- Confidence-based arbitration. Positional tie-break only, and §7.1 makes it nearly unreachable anyway.
- Cancelling a losing hedge.
- Chunking, transcoding, or a custom STT service.
- Composition-safety guards.
- Changing `audioBitsPerSecond`. Real, measured, and [ticketed
  separately](https://app.asana.com/1/1208495702765136/project/1216763563065333/task/1217574481057363) —
  it touches the shared capture path and needs its own accuracy check.
- Field-uplink and Surface Go 3 measurement campaigns. Provisional defaults plus telemetry instead.
