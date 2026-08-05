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

1. **R2 — populate the headless hook layer** (`@azx/ribo-ui-react`). The package builds but is still a
   `PACKAGE_NAME` stub. R2 fills it with the recorder and review hooks over the core engine.
2. **R3 — pack-and-consume test tier.** The scratch-app matrix from doc 10 §8: pack each tarball,
   install into a fresh app, build, and assert the worker spawns and WASM loads. The source-condition
   playground never touches `dist/`, so every WASM/worker failure mode is production-build-only. This
   is the only test that exercises a real tarball in a real host build.
3. **R4 — publishing.** Move releases to release-please and publish under the public `@azx` scope.
   Includes the `.npmrc` registry config, `publishConfig.access` change, and release-workflow
   activation. Nothing is published today.
4. **R5 — correct the docs the newer decisions falsify.** Doc 10 §3.1's Vite-library-mode mandate and
   doc 04's styled-components design are superseded by the tsdown-for-all and headless-hook-layer
   decisions; R5 rewrites them. Also covers any AGENTS.md statements R1–R4 have made false.
5. **F1 — the field app** (separate repo). The deployed Helix app that composes the published packages.
   Not built here; the `playground/` app is this repo's stand-in for a consumer.

### Deployment

Two things in this repo build but are not deployed anywhere. The docs site is startable now; the
playground is not.

- **Docs site.** `pnpm docs:build` produces a static VitePress site and nothing deploys it — the repo
  has no deploy workflow at all. Static output only (no service worker, no LLM, no workers), so it is
  a hosting target plus a CI step and depends on nothing already in flight. It can be anonymously
  readable rather than sign-in gated, since the platform recently gained an operator flag for public
  apps — an open choice, not a decision. The site already excludes the roadmap, the implementation
  notes and the open questions from what it publishes (`srcExclude` in `docs/.vitepress/config.ts`),
  so deploying it does not publish those.
- **Playground, with extraction on the platform LLM route.** The playground registers a
  **service worker** (`VitePWA` in `playground/vite.config.ts`), and the platform bans service workers
  except under a per-app grant, so the deploy needs that grant. It runs **on-device Whisper** through
  an injected `createWorker`, which needs `blob:` allowed in the CSP's `script-src`. Its "Try it"
  extraction panel is served by `playground/vite-extract.ts`, a **Vite server plugin** mounted only on
  the dev and preview servers, so a deployed static build has no backend for it. That resolves without
  new coupling: `openAiChat({ apiKey, baseUrl, fetchImpl })` in `@azx/ribo-extractor-openai` already
  takes the endpoint as a parameter and POSTs to `${baseUrl}/chat/completions`, and the platform now
  exposes an OpenAI-compatible gateway — so the deployed build points the existing extractor at that
  route, configuration not Helix-specific code. `fetchImpl` is the seam for same-origin cookie auth,
  so no API key ships to the browser; the dev-server plugin stays as it is for local work.

The service-worker grant and `blob:` in `script-src` are the same platform capabilities the field app
needs, so the playground deploy waits on them. The docs site waits on nothing.

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

## Phase records

- [Phase 0 — Foundation](phases/phase-0-foundation.md)
- [Phase 1 — Contracts](phases/phase-1-contracts.md)
- [Phase 2 — Recorder + Queue](phases/phase-2-capture-and-queue.md)
- [Phase 2.5 — Offline App Load](phases/phase-2.5-offline-app-load.md)
- [Phase 3 — On-Device Transcription](phases/phase-3-ondevice-transcription.md)
- [Phase 4 — Extraction + Write-back](phases/phase-4-extraction-writeback.md)
- [R1 — Package Build Configs](phases/r1-package-build-configs.md)
- [Docs Site + OSS Front Door](phases/docs-site.md)
