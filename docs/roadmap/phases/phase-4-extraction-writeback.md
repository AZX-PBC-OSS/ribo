# Phase 4 — Extraction + Write-back Implementation Plan

The plan for extraction and write-back — the pluggable `Extractor<F>` seam, the single-shot managed-LLM extractor, field-level review, and the write-back scaffold that waited on Helix egress signing (A1). Phase 4 is complete; A1 has since been confirmed by measurement (2026-09-21 — see [13](../../implementation/13-helix-platform-asks.md)'s update note), so the write's egress is no longer a platform wait.

**Goal:** replace the two remaining stubs — extraction and write-back — with the real thing. Speak into the field app, get a real on-device transcript (Phase 3), extract structured Snugg Pro fields **with provenance**, review them, and write the accepted ones back to Snugg Pro. Ends with: a queued recording drains all the way to `done` with real data in Snugg Pro.

**Architecture:** a **pluggable `Extractor<F>`** in `ribo-core` — a plain typed builder that collapses to the relay's existing injected `ExtractStep`. `ribo-adapter-snuggpro` owns the field knowledge (the spike-proven `schema` + `instructions` + `examples`, surfaced as a `ToolAdapter`) and ships a **single-shot managed-LLM extractor** as the built default. Two other strategies — plan-then-execute, and a managed "does-it-all" endpoint — are documented and share the same seam, not built. Write-back is the adapter's `write(fields, ctx)` behind the relay's `WriteStep`.

**Tech stack:** the Helix OpenAI-compatible proxy (A2, confirmed) for the single-shot call; `zod` for the trust boundary; the existing outbox/relay state machine.

## Split: extraction now, write-back once A1 landed

Extraction is **unblocked** and de-risked twice over — the spike proved the schema+prompt survives real Snugg Pro data across two models (`docs/spikes/0001-extraction-snuggpro/`), and Task 4 proved it survives real transcription noise (`docs/implementation/14-transcription-measurement.md`). Build it now.

**Write-back needed A1** — egress **HMAC-SHA256** request signing, from `docs/implementation/13-helix-platform-asks.md` (Snugg Pro uses AWS-style signed requests, not a static key). **Update (2026-09-21): A1 is confirmed** — the Helix gateway signs each request server-side, verified against Snugg Pro staging ([13](../../implementation/13-helix-platform-asks.md)'s update note has what was measured) — so write-back is no longer waiting on the platform. The seam-first plan stands: the adapter's `write` stays behind the `WriteStep`/`ToolAdapter.write` seam, so landing the real call is a wiring change, not a redesign. Do **not** sign in client code, and do not fake a signature to green a demo — an unsigned write that "works" against a mock teaches the wrong thing.

## Global Constraints

Everything in [`AGENTS.md`](../../../AGENTS.md) applies, plus:

- **`ribo-core` stays headless and LLM-agnostic.** Core defines the `Extractor<F>` seam and `toExtractStep`; it does **not** import an LLM SDK or `fetch` a provider. The transport (`ChatClient`) is injected, exactly as the transcriber and connectivity probe are. No provider name appears in core.
- **Every model/endpoint output crosses a trust boundary.** Parse with the adapter's `schema` before it becomes field data — a bespoke "does-it-all" service is validated locally too. A fabricated value in a customer report is the failure this whole design exists to prevent.
- **The spike is the regression gate.** `docs/spikes/0001-extraction-snuggpro/score.mjs` and its corpus are how the built extractor is judged — the four hazards (silent fuel drop, health-matrix silence, R-value-vs-band, enum paraphrase), 100% verbatim spans, low hallucination. A change that regresses them is a regression, full stop.
- **`confidence` stays uncalibrated.** The spike showed a 0.9-confidence hallucination; do not build review-card accept/reject thresholds on it until a measurement says it separates right from wrong.
- Dependencies catalog-pinned exact, in the right manifest.

## Decided

- **Single-shot is the built default.** It is what the spike measured at ~0.5–1% hallucination. Plan-then-execute and the managed endpoint are real alternatives on the same seam, documented in Task 5, not built now.
- **`Extractor<F>` is a plain builder, not a capability contract.** The choice between strategies is _configuration_, not runtime device variance, so it does not need the transcriber's `capability()` + `firstCapable` roster. Elevate to a `CapableExtractor` (a `capability()` returning `ready | unavailable(reason)` + `firstCapableExtractor([...])`) **only when selection becomes runtime-conditional** — e.g. "use the managed endpoint if reachable, else single-shot and queue offline." That trigger is named here so the elevation is a deliberate event, not drift.
- **Provider swap (OpenAI ↔ Azure OpenAI) needs no interface change** — the host injects a different `ChatClient`; Helix's compatible proxy covers both.
- **Extraction is a network-bound queued step, and that is fine offline.** The outbox decouples it: capture + transcribe offline, the item rests in `extracting`, the relay runs extraction when connectivity returns. No offline extractor is needed for the offline story.

---

### Task 1: The `Extractor<F>` seam in `ribo-core`

**Files:** `packages/ribo-core/src/extractor.ts` + tests

- Define `Extractor<F>` (`extract(transcript: string): Promise<ExtractionResult<F>>`), `ExtractionResult<F>` (`{ fields: F; raw?: unknown; usage: { calls: number } }`), and `ExtractionTarget<F>` (`Pick<ToolAdapter<F, unknown>, "name" | "schema" | "instructions" | "examples">`).
- `toExtractStep<F>(extractor): ExtractStep` — adapt any `Extractor` to the relay's injected step (`{ transcript } => extractor.extract(transcript.text).fields`). Keeps `RelayOptions.extract` unchanged.
- `FakeExtractor` — returns fixed fields (parallel to `FakeTranscriber`), so the relay and playground can be driven with no network. Prove it substitutes into `createRelay` with no relay changes.
- Headless (no `fetch`, no LLM import here — the seam only). Tests are node unit tests.

### Task 2: The Snugg Pro adapter target

**Files:** `packages/ribo-adapter-snuggpro/src/*`

- Surface the spike-proven artifacts as a `ToolAdapter<F, C>`: `schema` from `docs/spikes/0001-extraction-snuggpro/schema.ts` (the real field model — split fuel axis, depth bands + spoken-R-value holding pen, the 11-test health matrix, no AFUE slot), `instructions` from `prompt.md`'s normalization intent, `examples` optional. `F = z.infer<typeof schema>`.
- `C` is the real write context (whatever identifies the Snugg Pro destination — a job/assessment id + client), never `unknown` (see `adapter.ts`'s note and `@ts-expect-error` test).
- Keep the deterministic normalization pass (`normalization.md`) as code the extractor runs **after** the model — the model never converts R-value→band or does unit math.

### Task 3: The single-shot managed extractor (the built default)

**Files:** `packages/ribo-adapter-snuggpro/src/extractors/single-shot.ts` + tests

- `singleShotExtractor({ target, chat, model })` implementing `Extractor<F>`: one OpenAI-compatible call, `response_format: { type: "json_schema", json_schema: { schema, strict: true } }` (Helix keeps `response_format` + the allowlist — A2). `z.toJSONSchema(schema, { target: "draft-2020-12" })`; remember `confidence` is a bare `z.number()` (`.min()/.max()` emit keywords strict mode rejects — the spike found this).
- `ChatClient` is a **thin injected transport** interface (`complete(req) => { content }`), so tests use a fake and `ribo-core`/adapter never depend on a provider SDK.
- Parse the response with `target.schema` — trust boundary. On parse failure, fail the step as **transient** (retryable) unless the error is clearly terminal.
- **Gate it against the spike corpus:** run `singleShotExtractor` over `docs/spikes/0001-extraction-snuggpro/transcripts/` through `score.mjs` and assert the four hazards hold and hallucination stays within the measured band. This is the acceptance test for extraction quality, and it must be watched to fail (mutate a field, see the score drop).

### Task 4: Wire into the relay and the playground

**Files:** `playground/src/*`, relay wiring

- Replace the extraction stub: `createRelay({ ..., extract: toExtractStep(singleShotExtractor({...})) })`. The queue already has the `extracting` step and rests it offline — use it.
- Playground review card: show the extracted fields with their `sourceSpan` provenance, so a reviewer can confirm every value was said out loud. Remember the span is verbatim to the (possibly mis-heard) transcript — Task 4's `Lennox`→"Linux" caveat: a valid span proves the model didn't invent the quote, not that the audio was heard right.
- Default the playground to `FakeExtractor` or a configured `ChatClient` so the demo runs without a live key, and say which is active.

### Task 5: Document the alternative strategies (not built)

**Files:** this plan / a short design note

- **Plan-then-execute** (`plannedExtractor`): a cheap pass decides which topical field _groups_ the auditor raised, focused passes extract only those, merge onto an all-null skeleton. Fewer fields per call ⇒ less room to invent on unraised topics. (An alternative using a tool-use loop swaps the plan/extract calls for `set_field(key, value, span)` tool calls.) Note plainly: the SDK does **not** mandate a relevance pass — this is one extractor's private strategy.
- **Managed "does-it-all" endpoint** (`managedEndpointExtractor`): POST the transcript to a bespoke Helix-routed service that owns extraction end to end; the client stays dumb and validates the response against the **same** `schema`. Strategy is entirely server-side and swappable with no client ship.
- Record the `CapableExtractor` elevation trigger (runtime-conditional selection) so a future maintainer knows exactly when the plain builder should grow a capability probe.

### Task 6: Write-back — scaffold behind the seam (A1 confirmed 2026-09-21)

**Files:** `packages/ribo-adapter-snuggpro/src/*`, relay `WriteStep`

- Implement `ToolAdapter.write(fields, ctx)` against the Snugg Pro API shape (`docs/implementation/12-snuggpro-data-model.md`): map the accepted fields to Snugg's write endpoints, and send the relay's stable `Idempotency-Key` (already threaded through `WriteStepInput`) — but **do not rest duplicate protection on it.** Measured 2026-09-21: Snugg Pro ignores the header, and replaying an identical create returns a second record with a new uuid. The header is sent because it is harmless and free if the vendor ever honours it; the real mechanism is the write receipt, so a retry updates the uuid a previous attempt recorded instead of creating again.
- **The egress signing is the gateway's, confirmed.** The request is HMAC-SHA256 signed by the Helix egress layer (A1) — confirmed 2026-09-21 and verified end to end against Snugg Pro staging ([13](../../implementation/13-helix-platform-asks.md)'s update note), so the real call is no longer behind a flag or a platform wait. In this repo `adapter.write()` remains the scaffolded seam; wiring the real call through it is the wiring change this plan predicted. Never sign in client code — the browser and the edge never see the secret — and never fake a signature to green a demo.
- Only accepted (human-reviewed) fields are written — extraction proposes, the reviewer disposes. A `null` the reviewer leaves is not written.

---

## Definition of done

- A queued recording drains `queued → transcribing → extracting → writing → done` with a real extractor in the `extracting` step.
- The single-shot extractor passes the spike-corpus gate: four hazards hold, 100% verbatim spans, hallucination within the measured band — and that gate has been seen to fail on a deliberate regression.
- `Extractor<F>` + `toExtractStep` are the seam; `FakeExtractor` substitutes into the relay with zero relay changes.
- Write-back is implemented behind the `WriteStep`/`ToolAdapter.write` seam, exercised against a signing-shaped fake; the egress signing it awaited (A1) is confirmed (2026-09-21 — [13](../../implementation/13-helix-platform-asks.md)'s update note), so landing the real call is a wiring change, not a platform wait.
- `./check.sh` green.

## Deliberately NOT in Phase 4

The `plannedExtractor` and `managedEndpointExtractor` implementations (documented, not built), the `CapableExtractor` capability contract (no runtime-conditional selection yet), an on-device extractor (a local structured-output model is far heavier than Whisper-base — optionality, not near-term), any LLM SDK inside `ribo-core`, review-card thresholds built on `confidence`, and a live signed write to Snugg Pro — excluded while A1 was open; A1 has since been confirmed (2026-09-21, [13](../../implementation/13-helix-platform-asks.md)'s update note), which leaves it a wiring change rather than a blocked item.
