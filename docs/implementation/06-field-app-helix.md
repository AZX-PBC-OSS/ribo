# 06 — The Field App (Helix Host + Wiring)

The deployable. A small static frontend that imports the SDK, mounts the UI, and runs on Helix behind SSO. It's the PoC host and the SDK's first consumer — built so we ship/demo without waiting on Snugg Pro's dev team (design decision D5).

## What it is

```
field-app  (React + Vite static bundle, azx deploy)
  imports @azx/ribo-core, @azx/ribo-ui, @azx/ribo-adapter-snuggpro
  mounts CaptureControl + StatusIndicator + ReviewCard
  holds NO secrets, picks NO vendor — Helix injects both keys server-side
```

## Helix capabilities (manifest, portal-side)

- **`llm`** — extraction via Helix's **OpenAI-compatible route**, which supports `response_format` (json_schema) and **retains the model allowlist** + $/day budget. Governed _and_ ecosystem-compatible, so no fetch-proxy bypass to a vendor endpoint is needed.
- **`fetch.origins`** — the managed **Azure STT** endpoint (bound to a secret) and `https://api.snugg.pro` (bound to a secret).
- **connection secrets** — `snuggpro` (`X-Api-Key` recipe) and `azure-stt` (Azure key, `Ocp-Apim-Subscription-Key` recipe). Both injected server-side by egress.

## One-time setup

1. `POST /api/v1/apps/field-app/secrets` — store the Snugg Pro key and the Azure STT key (both write-only, sealed).
2. Bind `https://api.snugg.pro` → `snuggpro` and the Azure STT endpoint → `azure-stt` in the manifest.
3. **Two approvals** (elevated, one-time): both are secret-bound origins (high-risk). Admin approves once.

## Per-call security invariant

The app calls same-origin `/_api/fetch/https://api.snugg.pro/…`; the edge authorizes and mints a 30 s attested instruction; egress resolves the secret and injects `X-Api-Key`. **Edge never reads the key; browser never holds it.** (Full flow in the design spec §6.)

## Deploy & auth

- `azx deploy --promote` ships the bundle to the field app's Helix subdomain.
- SSO/session provided by Helix; `GET /_api/me` for the signed-in auditor.

## Platform asks (Helix team)

> **Consolidated handoff:** the full, prioritized list of every platform ask this project has surfaced — including the egress **request-signing** ask from [12](12-snuggpro-data-model.md) that supersedes the `X-Api-Key` recipe above — now lives in [13 — Helix Platform Asks](13-helix-platform-asks.md). That is the artifact to hand Kyle / Rich; the three below are the subset this doc raised.

Things we need from the platform rather than from our own code. **Only the first is a requirement**; the rest are levers and risks, and they should be presented that way — asking for a header as a blocker when it is not spends credibility we need for the things that are.

1. **OpenAI-compatible LLM route with `response_format`** — confirmed coming, and it retains the model allowlist. This is what makes extraction schema-conformant by construction ([03](03-ribo-core.md)). **Requirement.**
2. **Per-app COOP/COEP headers — a lever, not a blocker (downgraded 2026-07-22).** `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` on our app's subdomain unlock `SharedArrayBuffer` and therefore _threaded_ WASM transcription. A library cannot set these; only the edge serving the page can. Should be **opt-in per app**, since `require-corp` breaks unadorned third-party embeds.

   **Without them nothing breaks.** ONNX Runtime silently degrades to a single thread — no crash, no error (verified by inspection, [10 §4](10-build-and-packaging.md)) — and WebGPU needs no `SharedArrayBuffer` at all. So what the headers actually buy is **iOS performance**, on the one platform now known to be WASM-only ([01](01-feasibility-spike.md)). The penalty they'd remove is **unmeasured** ([open questions §11](../open-questions.md)); assume 2–4×.

   Worth adding when asking: the alternative libraries that **required** these headers unconditionally were **disqualified for it**, precisely because a third-party host may refuse them. We deliberately chose the stack that works without the ask.

3. **CSP must allow `blob:` in `script-src` and `worker-src`.** transformers.js loads its ONNX Runtime worker through a blob URL (the fix for [#1527](https://github.com/huggingface/transformers.js/issues/1527)), so a strict host CSP omitting `blob:` blocks on-device transcription at runtime, in their environment, not ours. Cheap to confirm up front; expensive to discover in the field. See [10 §4.1](10-build-and-packaging.md).

## Size & open items

- **Size:** **M** (wiring, manifest, approvals, deploy, glue).
- **Open:** app visibility model (group-scoped to field staff vs. public + quotas); the `ctx` the app passes to the adapter to target the current assessment; whether the PoC opens standalone or (later) embeds into Snugg Pro via iframe.
