# Ribo — Design

**Date:** 2026-07-21 (revised 2026-07-22)
**Author:** AZX
**Status:** Proposal for review
**Client / context:** a home-energy contractor (referred to as "the client"). Deploys onto AZX's Helix platform.
**Implementation detail:** [`docs/implementation/`](../../implementation/00-overview.md) — this doc is the design and the decisions; the implementation docs carry the per-component proposal.

---

## 1. Goal

A field energy auditor running a **residential home-energy audit** speaks their findings out loud; the system transcribes the speech, extracts the relevant audit fields, shows them for a quick **review/accept**, and writes them into the assessment in **Snugg Pro**. This replaces handwritten shorthand that today gets re-keyed at home.

**Business hook:** the audit is being stretched to roughly double its length. Voice capture is how the client turns that added on-site time into value for the customer.

**Success is qualitative, not just time-saved.** Audit visits are appointment-capped, so the benefit case is _richer, more complete field data captured per visit_, not raw hours saved. The central technical bet is **how much of what an auditor says is measure-relevant** and can be extracted reliably.

---

## 2. Decisions

| #   | Decision                                                                                                                                       | Rationale / source                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Reusable core + thin per-tool adapter**                                                                                                      | "reusable code, not a reusable app" — the SDK, not a one-off app, is the product.                                                                                                  |
| D2  | **Extraction lives in the core**; adapters are declarative (schema + instructions + write)                                                     | Keeps per-client cost low; the core holds a _generic_ extractor that never names a Snugg Pro field.                                                                                |
| D3  | **Transcription is a pluggable strategy**: on-device WASM (primary) + managed server STT (fallback)                                            | On-device gives real-time + offline + best privacy at once; the server path covers devices that can't run the model.                                                               |
| D4  | **Server STT = a managed Azure endpoint proxied through Helix. No custom service in v1**; a custom STT service is _conditional_                | "Custom backend only where required." Removes the Azure-deploy-substrate dependency from v1. See [02](../../implementation/02-server-stt.md).                                      |
| D5  | **Ship our own Helix-hosted PoC host app** (the field app) that consumes the SDK                                                               | Unblocks shipping/demo without waiting on Snugg Pro's dev team. The SDK remains the product; this is its first consumer and may grow.                                              |
| D6  | **Target: home-energy audits on Snugg Pro** (residential); Snugg Pro is the pilot's one adapter                                                | This is the program running on Snugg Pro; another program is on a different tool. _Formal work-package ratification still pending — see Risks._                                    |
| D7  | **Batch** (record → transcribe/upload on reconnect); real-time falls out of on-device only. No server streaming                                | "Brief attic/basement gaps, not indefinite offline." Helix's fetch-proxy is request/response only (no WebSocket).                                                                  |
| D8  | **Everything rides Helix's gateway** — no new platform infra                                                                                   | LLM route (extraction), fetch-proxy (audio→STT, write→Snugg Pro), connection secrets.                                                                                              |
| D9  | **Offline foundation = RxDB (free Dexie `RxStorage`) + an outbox we own**                                                                      | A real local DB with headroom for on-device reference data and backend-agnostic replication later, without a sync backend now. See [09](../../implementation/09-offline-first.md). |
| D10 | **Extraction = one schema-constrained call** via Helix's **OpenAI-compatible route** (`response_format` json_schema, model allowlist retained) | Schema-conformant by construction; no hand-rolled parse/repair. The core imposes no extraction _strategy_.                                                                         |

---

## 3. Deliverables

A small pnpm monorepo (mirrors Helix's own layout):

- **`@azx/ribo-core`** — headless engine (no React, no DOM rendering; browser APIs like `MediaRecorder` and `IndexedDB` are expected): `Recorder`, `Queue` (RxDB outbox), `Transcriber` (interface + `OnDeviceTranscriber` / `ManagedTranscriber`), `Extractor`, `Controller`, `ReviewPresenter` interface.
- **`@azx/ribo-ui`** — components implementing `ReviewPresenter`: `CaptureControl`, `StatusIndicator`, `ReviewCard` (schema-driven). React + Vite.
- **`@azx/ribo-adapter-snuggpro`** — declarative adapter: `schema` (zod), `instructions`, `examples`, `write`.
- **The field app** _(separate repo; name TBD)_ — the Helix-hosted PoC host, deployed via the `azx` CLI. First consumer + demo vehicle.
- **Server STT** — a managed Azure STT endpoint (Azure AI Speech Fast Transcription, or Azure OpenAI transcription) reached through the fetch-proxy. **Nothing for us to deploy in v1.**

---

## 4. Architecture

```
Helix  (hosts field-app: own subdomain · SSO · /_api/* gateway)
  └── field-app                     ← THE DEPLOYABLE (helix deploy)
        imports:
          @azx/ribo-core           (record · queue · transcribe · extract · orchestrate)
          @azx/ribo-ui             (CaptureControl · StatusIndicator · ReviewCard)
          @azx/ribo-adapter-snuggpro (schema · instructions · write)
        talks through the gateway:
          /_api/fetch/<azure-stt>             → STT fallback  (on-device WASM is the primary path)
          <OpenAI-compatible LLM route>       → extraction
          /_api/fetch/https://api.snugg.pro/… → write-back (X-Api-Key injected by egress)
```

**Layering (four tiers):** `ribo-core` (headless, never names a Snugg Pro field) → `ribo-ui` (schema-driven rendering) → `ribo-adapter-snuggpro` (the only tool-specific surface) → the field app (the deployable shell).

### 4.1 The reuse seam

```ts
export interface ToolAdapter<F> {
  name: string;
  schema: z.ZodType<F>; // strict: nullable+required + provenance envelope
  instructions: string; // domain guidance for extraction
  examples?: Array<{ text: string; out: Partial<F> }>; // few-shot
  write(fields: F, ctx: unknown): Promise<void>;
}
```

The core runs **one schema-constrained extraction call** (official `openai` SDK + `zodResponseFormat`), then normalizes units/enums deterministically in TypeScript. A new client = a new `ToolAdapter` object; the extractor, review UI, queue and transcription are reused untouched.

**Schema rules that carry the quality:** model "not mentioned" as **nullable + required** (never optional) so the model must explicitly emit `null` rather than inventing a value; wrap every field as `{ value, confidence, sourceSpan }` so provenance is guaranteed and the review card can show the auditor the quote behind each value.

### 4.2 Transcription strategy

```ts
export interface Transcriber {
  transcribe(rec: Recording): Promise<Transcript>;
}
export class OnDeviceTranscriber implements Transcriber {
  /* OSS Whisper via WASM — primary */
}
export class ManagedTranscriber implements Transcriber {
  /* managed Azure STT via fetch-proxy — fallback */
}
```

Selected at runtime by a device-capability probe. Devices are likely **Surface** tablets (Windows + Chromium → strong WebGPU/WASM) plus some phones; the phone/iOS case is what the managed fallback exists for.

---

## 5. Data flow

```
tap record
  → Recorder captures audio (MediaRecorder)
  → Queue persists it (RxDB outbox, audio as attachment — durable across reload/offline)
  → Transcriber: on-device WASM → transcript   (or, on reconnect, managed Azure STT via /_api/fetch)
  → Extractor: one schema-constrained LLM call → validated fields (+confidence, +sourceSpan)
  → ReviewCard: auditor confirms/edits
  → adapter.write(): PATCH https://api.snugg.pro/…  (X-Api-Key injected by egress)
```

---

## 6. Helix integration

The field app holds **no secrets and picks no vendor** — keys are injected server-side.

- **Capabilities:** the OpenAI-compatible LLM route (supports `response_format`, retains the model allowlist + $/day budget); `fetch.origins` for the managed Azure STT endpoint and `https://api.snugg.pro`, both secret-bound.
- **Connection secrets:** `snuggpro` (`X-Api-Key` recipe) and `azure-stt`. Stored write-only, sealed; never returned.
- **Approvals:** two elevated, one-time manifest changes (both secret-bound origins are high-risk).
- **Per-call flow:** the app calls same-origin `/_api/fetch/https://api.snugg.pro/…`; the edge authorizes and mints a 30 s attested instruction; egress resolves the secret and injects the header. **The edge never reads the key; the browser never holds it.**
- **Constraints:** HTTPS-only for secret-backed calls; request headers safelisted (`cookie`/`authorization` dropped); redirects not followed; **10 MB per hop** → chunk audio on the managed-STT path.
- **Deploy:** `helix deploy` (preview), then `helix promote <n>`.

Full mechanism and setup steps: [06](../../implementation/06-field-app-helix.md).

---

## 7. Offline-first

Offline-first core = **capture + (on-device) transcription**; extraction and write are network-bound and queue. Foundation is **RxDB on the free Dexie `RxStorage`**, with an outbox we own (per-item state machine, foreground relay, idempotency keys, jittered backoff, serial ordering). Audio rides as an RxDB attachment and is dropped once transcription is confirmed; the WASM model is cached via the **Cache API**, not RxDB.

**iOS constraints are design requirements:** no background drain (foreground relay + "Sync now"); the 7-day ITP eviction wipes IndexedDB _and_ Cache together, so `persist()` + "Add to Home Screen" + detect-and-re-prime are mandatory.

The outbox is also the **seam that later becomes RxDB replication** against our own backend, at which point the external write can migrate server-side. Full design: [09](../../implementation/09-offline-first.md).

---

## 8. Scope for the pilot

**In:** the three SDK packages; the field app; the managed-STT wiring; a **bounded set of audit fields**; Helix wiring; an **accuracy-validation harness**; a **feasibility spike** for on-device transcription.

**Out:** deep Snugg Pro product integration; the client's separate OCR/photo-to-field work (coordinate, don't build); multi-language (English-only); real-time _server_ streaming; a custom STT service; field-rollout change management (client-owned).

---

## 9. Risks & dependencies

- **Accuracy / measure-relevance bar is unvalidated** — the central technical risk. The original mitigation was a hard line: **start recording real home-energy audits now**, before build, to seed the validation corpus. _No production code against assumptions._ **Updated 2026-07-23 — that line is being consciously traded, not met.** The consent path is deferred (below), so the PoC is built against a **synthetic** corpus (`spikes/extraction-snuggpro/`, plus a proposed TTS-synthesized audio path). Its numbers are **a floor, not a forecast**. This is a deliberate override of a stated rule in exchange for PoC velocity, recorded so it is visibly a decision rather than an oversight. Real-recording validation is **not cancelled — it becomes a gate before field use** rather than before build; it must not be skipped once the PoC demos well. See [07](../../implementation/07-testing-and-accuracy.md) and [08](../../implementation/08-risks-and-sequencing.md).
- **On-device WASM performance on phones/iOS** — gated by the feasibility spike; the managed fallback is already designed, so a negative result costs little. **The platform baseline (2026-07-23) narrows this but does not remove it:** WebGPU and WASM SIMD are now _assumed available_, so the fallback exists on **performance** grounds — a device that has the APIs may still be too slow — not on capability grounds. See [`docs/open-questions.md` §4](../../open-questions.md) and [01](../../implementation/01-feasibility-spike.md).
- **In-home recording consent/privacy** — needs the client's policy path before any field recording. **Deferred 2026-07-23**, not resolved: it is not ours to unblock, so the PoC proceeds without real recordings rather than stalling. Still blocking for any actual field recording. On-device transcription materially de-risks this (audio can stay on device).
- **Target not formally ratified** — proceeding on Snugg Pro (D6); needs work-package sign-off.
- **Schedule / staffing** — internal sizing runs ahead of the committed delivery window; internal review "reviewed, not approved"; lone-wolf risk — architect + 2nd engineer recommended. Descope levers are named in [08](../../implementation/08-risks-and-sequencing.md).
- **Coordination with the client's own photo-to-field prototype** — align before either side over-invests.

_(The Azure-deploy-substrate risk that dominated the earlier draft is removed from v1 by D4.)_

---

## 10. Testing

Core unit tests (queue durability, chunking, transcriber selection); **extraction scored against a fixture corpus** for field accuracy / measure-relevance — the key quality gate, and now purely _semantic_ since structured outputs guarantee shape; adapter contract tests; managed-STT wiring checks. Detail: [07](../../implementation/07-testing-and-accuracy.md).

**For the PoC that corpus is synthetic, not real** (2026-07-23): consent is deferred, so the fixtures are authored transcripts and TTS-synthesized audio. Real-recording validation remains required — as a gate **before field use**. See §9 and [07](../../implementation/07-testing-and-accuracy.md).

---

## 11. Open questions

Tracked in [`docs/open-questions.md`](../../open-questions.md) and per-component in the implementation docs. The load-bearing ones: the bounded audit field set, and the Snugg Pro endpoint shape.

**Closed 2026-07-23:** the target platform baseline (§4 there) — evergreen Chromium on Windows current−2, Safari iOS/iPadOS current−1 major, Chrome on Android current−2, with WebGPU / WASM SIMD / OPFS / IndexedDB / MediaRecorder / Web Workers / `crypto.randomUUID` / top-level await assumed available. It no longer gates the spike, but it settles **capability only** — the spike's performance question stands.
