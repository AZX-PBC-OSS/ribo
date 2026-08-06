# Ribo — Roadmap

Ribo is a reusable **voice-capture SDK** for field data collection: record a dictation, transcribe it
(on-device WASM or a managed STT service), extract structured fields from the transcript, let a human
review and accept them, then write the result back into a host tool through a thin per-tool adapter.
The first target is home-energy audits in Snugg Pro. The SDK lives in this repo; the consuming field
app lives in a separate repo and is not built here.

This directory is the project's roadmap — the design specs and per-phase plans, committed as records
of what was planned and why. It is excluded from the published docs site (via `srcExclude` in
`docs/.vitepress/config.ts`), but tracked in the repo for anyone working on the code.

## What has shipped

**Phases 0–4** built a working capture → transcribe → extract → review pipeline, in this order:

- **Phase 0** — pnpm workspace, three package skeletons, playground, lint/typecheck/test, `AGENTS.md`.
  → [plan](phases/phase-0-foundation.md)
- **Phase 1** — core contracts in `@azx/ribo-core`: the provenance envelope (`extractedSchema`,
  `isSpanGrounded`), `Recording`/`Transcript`, the `Transcriber` contract, `ToolAdapter<F, C>`, and the
  review contract. → [plan](phases/phase-1-contracts.md)
- **Phase 2** — real audio capture (`MediaRecorder`) and the durable RxDB-backed outbox with its
  per-item state machine. → [plan](phases/phase-2-capture-and-queue.md)
- **Phase 2.5** — offline app load: a service worker precaching the shell, storage persistence, and
  eviction handling. → [plan](phases/phase-2.5-offline-app-load.md)
- **Phase 3** — on-device transcription: Whisper via `@huggingface/transformers` in a Web Worker, in a
  new `@azx/ribo-transcriber-ondevice` package. → [plan](phases/phase-3-ondevice-transcription.md)
- **Phase 4** — extraction and review: the pluggable `Extractor<F>` seam, the single-shot managed-LLM
  extractor (`@azx/ribo-extractor-openai`), field-level review, and the write-back scaffold (gated on
  Helix egress signing). → [plan](phases/phase-4-extraction-writeback.md)

**R1 — package build configs** (the most recent work) gave all five publishable packages real tsdown
builds producing `dist/`, plus gates that prove the artifact is valid for a consumer: publint and attw
in-build, a source-condition resolver assertion, and tarball/duplicate-React checks. All five build,
gated by `./check.sh`. → [design](design/r1-package-build-configs-design.md) ·
[plan](phases/r1-package-build-configs.md)

The original design spec (D1–D10 decisions, architecture, data flow, risks) is at
[design/ribo-design.md](design/ribo-design.md). The docs-site plan is at
[phases/docs-site.md](phases/docs-site.md).

## What is next

The post-Phase-4 work is organized as tasks **R1–R5** and **F1**, defined in a Voice-to-Text MVP
design that is not in this repo. R1 is done; the rest proceed in dependency order:

1. **R1.5 — field-shape contracts.** Surfaced while planning R2, and blocking its review hook.
   `ToolAdapter<F, C>`'s one type parameter does two jobs: the extractor needs the provenance-envelope
   shape (JSON Schema, response parse, few-shot examples, normalization) while `write` and `review.ts`
   need plain values. R1.5 declares the values schema and **derives** the extraction schema from it,
   and moves review onto flat dotted leaf paths — necessary because Snugg Pro's nested `healthSafety`
   matrix would otherwise get one envelope for all 11 tests instead of one each.
   → [design](design/r1.5-field-shape-contracts-design.md) ·
   [plan](phases/r1.5-field-shape-contracts.md)
2. **R2 — populate the headless hook layer** (`@azx/ribo-ui-react`). The package builds but is still a
   `PACKAGE_NAME` stub. R2 fills it with six hooks and a provider over the core engine — and closes the
   gap it surfaced: review is a contract in core with no callers, because the relay goes straight from
   `extracting` to `writing`. Phase A makes review a real gate (`awaiting-review`, a persisted outcome,
   pause/resume on `Recorder`); Phase B builds the hooks and migrates the playground onto them.
   **Phase A has shipped. Phase B is blocked on a design revision:** R1.5 moved review to flat dotted
   leaf paths, so R2's design and plan still specify `useReview` against `ReviewFields<F>`,
   `FieldDecision<F[K]>`, `decisionOf<K extends keyof F>` and `ReviewOutcome<F>` — all now impossible,
   and `ReviewedValues` is deleted. That is a design change, not a docs pass; the hook's whole surface
   follows from it. → [design](design/r2-headless-hook-layer-design.md)
3. **R1.6 — Snugg Pro API alignment.** The adapter's field set was reverse-engineered from Snugg Pro's
   public **printed field sheet**; the machine-readable spec later showed that model to be wrong in
   several places. [Doc 15](../implementation/15-snuggpro-api-verified.md) already wrote the delta list
   and changed no code — this is executing it. Concretely: the API exposes writable heating/cooling/
   steady-state efficiency fields and a writable attic R-value that `schema.ts` deliberately omits; the
   health matrix is **13** tests where we ship 11; `heatingEquipmentType` and `coolingEquipmentType` are
   the _same_ spec field on a per-system record, not two; and `combustionVentType` has no write target
   at all. → see also R1.7, which mechanises the parts of this that should not be hand-maintained.
4. **R1.7 — generate the base types (`pnpm snugg:refresh`).** A script that regenerates wire field names
   and leaf types from the spec into a committed `*.generated.ts`, following the `pnpm target:refresh`
   precedent exactly: thin script, real logic in a typechecked and unit-tested module, deliberately not
   run by CI so a vendor change lands in a reviewable diff. **Enum vocabularies are deliberately out of
   the first cut** — see "Open questions" below. The frozen JSON Schema fixture already means a
   regeneration cannot silently change what is sent to the model: it goes red and a human looks.
5. **R3 — pack-and-consume test tier.** The scratch-app matrix from doc 10 §8: pack each tarball,
   install into a fresh app, build, and assert the worker spawns and WASM loads. The source-condition
   playground never touches `dist/`, so every WASM/worker failure mode is production-build-only. This
   is the only test that exercises a real tarball in a real host build.
6. **R4 — publishing.** Move releases to release-please and publish under the public `@azx` scope.
   Includes the `.npmrc` registry config, `publishConfig.access` change, and release-workflow
   activation. Nothing is published today.
7. **R5 — correct the docs the newer decisions falsify.** Doc 10 §3.1's Vite-library-mode mandate and
   doc 04's styled-components design are superseded by the tsdown-for-all and headless-hook-layer
   decisions; R5 rewrites them. Also covers any AGENTS.md statements R1–R4 have made false.
8. **F1 — the field app** (separate repo). The deployed Helix app that composes the published packages.
   Not built here; the `playground/` app is this repo's stand-in for a consumer.

## Open questions and findings pending action

Discovered while building R1.5 and investigating the Snugg Pro API. Recorded here so they are decided
rather than rediscovered.

- **Do we ask the model for Snugg's literal enum strings, or keep readable tokens and map?** Roughly 25
  of our 27 enumerated leaves are snake_case (`well_sealed`, `not_tested`) where the API uses
  human-readable strings (`"6% - Well sealed"`, `"Not Tested"`). One normalization layer covers most of
  it — but some enums also diverge in _membership_, which needs richer enums rather than a string map.
  Asking the model for the literal strings removes a translation layer that can drift; keeping tokens
  may extract better. **Deliberately deferred, not overlooked:** R1.7's first cut generates no enums, and
  the question is measurable against the existing corpus and scorer before it is answered.
- **Entity identity is the sharpest unresolved risk.** Our field set is singular — "the attic", "the
  heating system" — while the API models components as per-instance resources and real houses have
  several of each. Extraction can be perfectly typed and still write the upstairs furnace's value onto
  the basement boiler. Doc 15 §1 has the resource model and the realistic write sequence; nothing
  implements it. This lands at write-back time, which is the most expensive moment to discover it.
- **Custom fields exist and cannot be enumerated at build time.** The API attaches per-account custom
  fields with their own type/bounds/options metadata. The likely shape is a generated static base schema
  plus a runtime-discovered overlay, cached and available offline — not a wholly dynamic adapter.
- **Whole-spec extraction is closed, on hard limits rather than quality.** The combined job-data schema
  is ~1,326 leaves, which after provenance-enveloping is ~5,360 properties against OpenAI's documented
  5,000 cap, and ~1,490 enum values against the 1,000 cap. The `basedata` subset does fit (~1,201
  properties) but is ~9× the current pilot. Recorded so it is not re-proposed.
- **`Outbox.reopenForReview(id)`.** Three places now point a reader at a raw `patch` back to
  `awaiting-review`, which the relay's own tests describe as "exactly the shape a bug in it would take".
  The only documented recovery path is the one we tell people never to take.
- **Cross-tab relay leader election.** Pre-existing, not introduced by R2: `multiInstance: true` with no
  leader means two tabs can process the same item, and `database.ts` explicitly defers it.
- **The API host is wrong in four docs.** `ribo-design.md`, `06-field-app-helix.md`, `09-offline-first.md`
  and `05-adapter-snuggpro.md` name `https://api.snugg.pro`; the spec's `basePath` is
  `https://api.snuggpro.com/`, which doc 12 and the adapter's own tests already have right. Doc 06
  specifies the Helix egress `fetch.origins` allowlist from the wrong one — a domain we do not control.
- **`minimum`/`maximum` may no longer be forbidden.** `provenance.ts` asserts strict structured-output
  mode rejects them, which is why `confidence` is a bare `z.number()`. Current OpenAI documentation
  lists them as supported for non-fine-tuned models. If that is stale, our schema is more constrained
  than it needs to be — worth one engineer's re-check.

## What is deliberately out of scope

So nobody re-litigates it:

- **Snugg Pro write-back and the request-signing it depends on.** Write-back is scaffolded behind the
  `WriteStep`/`ToolAdapter.write` seam but gated OFF pending Helix egress HMAC-SHA256 signing (A1 in
  `docs/implementation/13-helix-platform-asks.md`). Do not fake the signing to green a demo.
- **The managed STT fallback.** Designed (Azure AI Speech Fast Transcription or Azure OpenAI
  transcription, proxied through Helix) but not built. On-device transcription is the primary path;
  the fallback exists for devices that are too slow, not just those that lack the APIs.
- **iOS on-device transcription.** Phase 3 targets evergreen Chromium with WebGPU. iOS/Safari support,
  engine sniffing, and the WASM single-threaded path are deferred.

## Design documents

- [Ribo — Design](design/ribo-design.md) — the original design spec: D1–D10 decisions, architecture,
  data flow, Helix integration, offline-first, risks.
- [R1 — Package Build Configs — Design](design/r1-package-build-configs-design.md) — the R1 design:
  one build tool (tsdown) for all five packages, the generated Baseline syntax floor, and the package-
  contract gates.
- [R1.5 — Field-Shape Contracts — Design](design/r1.5-field-shape-contracts-design.md) — the R1.5
  design: one declared values schema, a derived extraction schema, and leaf-path review.
- [R2 — Headless Hook Layer — Design](design/r2-headless-hook-layer-design.md) — the R2 design: the
  review gate in the outbox state machine, pause/resume, and the six hooks plus provider that make
  `@azx/ribo-ui-react` real.

## Phase records

- [Phase 0 — Foundation](phases/phase-0-foundation.md)
- [Phase 1 — Contracts](phases/phase-1-contracts.md)
- [Phase 2 — Recorder + Queue](phases/phase-2-capture-and-queue.md)
- [Phase 2.5 — Offline App Load](phases/phase-2.5-offline-app-load.md)
- [Phase 3 — On-Device Transcription](phases/phase-3-ondevice-transcription.md)
- [Phase 4 — Extraction + Write-back](phases/phase-4-extraction-writeback.md)
- [R1 — Package Build Configs](phases/r1-package-build-configs.md)
- [R1.5 — Field-Shape Contracts](phases/r1.5-field-shape-contracts.md)
- [R2 — Headless Hook Layer](phases/r2-headless-hook-layer.md)
- [Docs Site + OSS Front Door](phases/docs-site.md)
