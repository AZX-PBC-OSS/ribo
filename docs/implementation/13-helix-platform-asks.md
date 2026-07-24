# 13 — Helix Platform Asks (Consolidated Handoff)

**Status:** Handoff to the Helix platform team (Kyle / Rich). One place for every "we need X from
the platform" this project has surfaced — each is otherwise buried in the implementation doc that
found it. These asks were **not** brainstormed against a datasheet; they were found by building the
SDK against the real Helix capability model and by researching the real Snugg Pro API. That is why
one of them (egress request signing) invalidates a design we had already written down: the platform
behaves differently from what [05]/[06] assumed, and the field surfaced it.

Each ask below states **what** is needed, **why** (the concrete thing that breaks without it),
**what it blocks**, and **status**. The table is ordered blocks-pilot-first. Nothing here asks the
platform for a header as a blocker when it is only a lever — that distinction is deliberate and is
called out where it applies ([06](06-field-app-helix.md) makes the same point).

## Legend

Status marks follow the repo convention (bold, load-bearing):

- **[confirmed]** — the platform team has told us this exists / is coming, or it is verified
  servable. Track and verify at deploy; not a design risk.
- **[open]** — needs a decision or a build on the platform side, or needs confirming against the
  real system before we commit our code. These are the asks that need action.
- **[deferred]** — real, but not needed for the pilot. Recorded so it is not rediscovered as a
  surprise later.

"Blocks pilot" is narrower than "Status": an ask can be **[confirmed]** and still be a hard pilot
dependency (we just aren't worried it won't land), and an **[open]** ask can be quality-only.

---

## Priority table (blocks-pilot first)

| #   | Ask                                                                                    | Blocks pilot                               | Status                                   | Source                                                                                         |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A1  | **Egress signs each request (HMAC), not a static header**                              | **Yes** — Phase 4 Snugg Pro write-back     | **[open]**                               | [12 §1](12-snuggpro-data-model.md), corrects [05]/[06]                                         |
| A2  | **OpenAI-compatible LLM route with `response_format` (json_schema) + model allowlist** | **Yes** — extraction                       | **[confirmed]** (coming)                 | [06](06-field-app-helix.md), [03](03-ribo-core.md)                                             |
| A3  | **CSP allows `blob:` in `script-src` / `worker-src`**                                  | **Yes** — on-device transcription on Helix | **[open]**                               | [10 §4.1](10-build-and-packaging.md), [06](06-field-app-helix.md)                              |
| A4  | **Service worker servable at root scope**                                              | **Yes** — offline app load                 | **[confirmed]** (verify scope at deploy) | [phase 2.5 plan](../superpowers/plans/2026-07-23-phase-2.5-offline-app-load.md)                |
| A5  | **A gateway health endpoint the app can probe**                                        | Quality — connectivity/queue reliability   | **[open]** (decision)                    | [`connectivity.ts`](../../packages/ribo-core/src/connectivity.ts), [09](09-offline-first.md)   |
| A6  | **Per-app COOP/COEP headers (opt-in)**                                                 | No — iOS perf lever only                   | **[deferred]**                           | [06](06-field-app-helix.md), [10 §4](10-build-and-packaging.md)                                |
| A7  | **Forward trusted `(app, user)` identity to a first-party backend**                    | No — future server-side move               | **[deferred]**                           | [09](09-offline-first.md), [design spec §6/§7](../superpowers/specs/2026-07-21-ribo-design.md) |

---

## A1 — Egress must **sign** each request, not inject a static header **[open]**

> **This is the highest-value ask, and it changes a design we had already written.** It is the only
> ask that reports a platform capability we need that does not exist today as we'd assumed.

**What we need.** The Helix egress layer must compute a **per-request HMAC-SHA256 signature
server-side** — holding the Snugg Pro private key, generating a fresh `X-Date` timestamp and the
derived `Authorization` value **on every call** — so the browser and the edge never see the secret.
This is a new egress **capability**, not a connection-secret config value.

**Why the current recipe is wrong.** [06](06-field-app-helix.md) and [05](05-adapter-snuggpro.md)
describe the Snugg Pro secret as a static `X-Api-Key` "injected server-side by egress." Research
against Snugg Pro's own KB ([12 §1](12-snuggpro-data-model.md)) established that Snugg Pro's real
auth is **AWS-style HMAC-SHA256**:

- Two headers: an `Authorization` credential/signature pair and an `X-Date` (ISO-8601 request
  timestamp). The signature is an HMAC-SHA256 keyed by a private key over per-request material
  including `X-Date` — i.e. a **per-request signed value, not a constant**. (Exact signing-string
  construction is in the team's private integration notes.) **[verified — Snugg Pro]** (scheme).

Two facts make this impossible for the fetch-proxy as designed:

1. **It injects a _constant_ header.** A signed request cannot be a constant — the signature is a
   function of a per-request `X-Date`, so a static `X-Api-Key` recipe produces a value Snugg Pro
   rejects.
2. **It drops `Authorization`.** `Authorization` (and `cookie`) are on the proxy's header drop-list
   ([design spec §6](../superpowers/specs/2026-07-21-ribo-design.md), constraints), and `X-Date` is
   non-safelisted — so the app cannot supply either from the browser even if it wanted to, and it
   must not (that would mean the browser holds the key).

So the signing must happen **inside egress**: it is the only place that can both hold the private
key and set the dropped `Authorization` header on the outbound request. The app keeps calling
same-origin `/_api/fetch/https://api.snuggpro.com/…` exactly as before; egress replaces "inject
constant header" with "sign this request."

**What it blocks.** The **Phase 4 Snugg Pro write-back** — `adapter.write()` in
[05](05-adapter-snuggpro.md). Without it there is no round-trip: extraction can run, the auditor can
review, but the confirmed fields cannot be written back to the assessment. Everything upstream of
the write (capture, transcription, extraction, review) works without it; the write is where the
pilot's value lands.

**Action / open items.**

- Confirm the exact signing string (is it `X-Date` alone, or a canonical request per AWS SigV4?)
  against `https://app.snuggpro.com/apidocs/` with a **real API key** — the Swagger UI is
  login-gated and could not be read unauthenticated ([12 sources](12-snuggpro-data-model.md)).
- Confirm the assessment create/update/PATCH endpoint shape at the same time; the
  `PATCH /assessments/{jobId}` in [05] is still a **placeholder** ([12 §1](12-snuggpro-data-model.md),
  Assessment CRUD row = **[unknown]**).
- **Correction to record in [05]/[06]:** the "inject a constant `X-Api-Key`" design for the
  `snuggpro` connection is superseded by this ask and should not be built.

---

## A2 — OpenAI-compatible LLM route with `response_format` + model allowlist **[confirmed]**

**What we need.** Extraction via Helix's **OpenAI-compatible route** that supports `response_format`
(json_schema) and **retains the model allowlist** (and $/day budget). Governed _and_
ecosystem-compatible, so no fetch-proxy bypass to a vendor endpoint is needed.

**Why.** This is what makes extraction **schema-conformant by construction**. The core runs a
single schema-constrained call — official `openai` SDK + `zodResponseFormat`, the adapter's zod
schema as `response_format` — then normalizes deterministically in TypeScript
([03](03-ribo-core.md), Extraction). Strict structured outputs are also what let the schema enforce
the anti-hallucination rule at the schema level (`null` = "not stated") rather than by prompt-
pleading ([05](05-adapter-snuggpro.md)). A route without native structured outputs would force a
hand-rolled parse-and-repair stage the design deliberately avoids.

**What it blocks.** The entire extraction step — the transcript → structured-fields conversion that
is the product's core bet.

**Status.** **Confirmed coming**, and confirmed to retain the allowlist. Track landing; no design
risk anticipated.

---

## A3 — CSP must allow `blob:` in `script-src` and `worker-src` **[open]**

**What we need.** The host CSP on our app's Helix subdomain must permit `blob:` in `script-src`
**and** `worker-src`.

**Why.** transformers.js loads its ONNX Runtime worker through a **blob URL** — this is the fix for
the old cross-origin `wasmPaths` worker bug ([huggingface/transformers.js #1527](https://github.com/huggingface/transformers.js/issues/1527),
PR #1558, landed before v4.0.0). The fix routes ORT loading around the cross-origin problem via
`blob:`, so a strict host CSP that omits `blob:` **blocks the worker at runtime** — and therefore
blocks on-device transcription. Full detail in [10 §4.1](10-build-and-packaging.md).

**What it blocks.** On-device (offline) transcription **once the field app deploys on Helix**. This
is a host-integration risk, not a bug in our code: it fails in _their_ environment, at runtime, only
when the host serves a strict CSP. Cheap to confirm up front; expensive to discover in the field —
an auditor standing in an attic.

**Action.** Confirm the deployed CSP includes `blob:` in both directives before field use.

---

## A4 — Service worker servable at root scope **[confirmed]**

**What we need.** Helix must serve an **app-owned** service worker, at a scope that covers the app
root (`/`), so the app can precache its shell and cold-start offline.

**Why.** The offline app-load design ([phase 2.5 plan](../superpowers/plans/2026-07-23-phase-2.5-offline-app-load.md))
has the app register a service worker that precaches the shell (HTML/JS/CSS) and serves it
cache-first. The service worker is **the app's, never the SDK's** — a service worker is
origin-global, and `ribo-core` must not register or ship one ([phase 2.5 plan](../superpowers/plans/2026-07-23-phase-2.5-offline-app-load.md),
Global Constraints). Root scope matters because the SW must intercept the navigation request for
`/` itself; a worker served under a sub-path cannot control the app root.

**What it blocks.** Cold-start offline — the app opening with no signal. Without it, capture and
persistence still work offline (Phase 2), but the page cannot boot without a network, which makes
the rest moot.

**Status.** **Confirmed** that service workers can be served from Helix. **Verify the actual scope
in practice when the field app deploys** — confirmed-servable is not confirmed-at-root-scope.

---

## A5 — A gateway health endpoint the app can probe for reachability **[open]**

**What we need.** A lightweight **gateway health endpoint** — the intended shape is a `HEAD`/`204`,
a few bytes, no body — that is **served by the gateway, not from the app's service-worker precache**,
so the app has an honest reachability target.

**Why.** The connectivity model ([`packages/ribo-core/src/connectivity.ts`](../../packages/ribo-core/src/connectivity.ts))
is a **three-state** view (`offline` / `probing` / `online`) precisely because `navigator.onLine`
lies: a captive portal, an AP with no backhaul, or a tower with no route all report `true`. The
nastiest state is **online-but-useless**, where a request hangs instead of failing. The model
resolves that with an injected reachability **probe**. The problem is _what the probe hits_:

- In the playground, the probe hits a **same-origin URL** — and its own source
  ([`connectivity-store.ts`](../../playground/src/connectivity-store.ts)) records the honest caveat:
  once the service worker is active, a same-origin **precached** path (`"/"`) is answered **from
  cache**, so the probe can read `online` while the device is actually offline. A precached URL is
  the one target that _cannot_ measure reachability.
- The field probe therefore needs a target that is **not** served from the SW precache — a real
  round-trip to the gateway — or "online-but-useless" (captive portal) reads as healthy and the
  queue drains into a black hole.

**What it blocks.** Not a hard pilot blocker (a same-origin non-precached target is a fallback), but
it is a **queue-reliability / correctness** ask: without the right probe target the relay drains on
false-positive connectivity, which is exactly the failure the three-state model exists to prevent.

**Status.** **Open decision.** The docs note the field probe target is undecided
([`connectivity-store.ts`](../../playground/src/connectivity-store.ts) NOTE). We need the platform to
name (or provide) the endpoint.

---

## A6 — Per-app COOP/COEP headers (opt-in) **[deferred]**

**What we need (if at all).** `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` on our app's subdomain, **opt-in per app** (because
`require-corp` breaks unadorned third-party embeds). A library cannot set these — only the edge
serving the page can.

**Why it is deferred, not a blocker.** These headers unlock `SharedArrayBuffer` and therefore
**_threaded_ WASM** transcription. But **without them nothing breaks**: ONNX Runtime silently
degrades to a single thread — no crash, no error (**[verified by inspection]**,
[10 §4](10-build-and-packaging.md)) — and WebGPU needs no `SharedArrayBuffer` at all. So the only
thing the headers buy is **iOS performance**, on the one platform now known to be WASM-only
([01](01-feasibility-spike.md)), and **iOS is out of PoC scope**. The penalty they'd remove is
**[unmeasured]** ([open questions §11](../open-questions.md)); assume 2–4×.

Worth saying to the platform team plainly: the alternative transcription libraries that **required**
these headers unconditionally were **disqualified for it**, because a third-party host may refuse
them. We deliberately chose a stack that works without the ask — so we present this as a
**performance lever**, and accepting a hard COOP/COEP dependency now would re-import the risk we
rejected those candidates over ([10 §4](10-build-and-packaging.md)).

**Status.** **Deferred** — record as a perf lever for a future iOS-in-scope phase, not a pilot
requirement. (Downgraded from "requirement" on 2026-07-22.)

---

## A7 — Forward trusted `(app, user)` identity to a first-party backend **[deferred]**

**What we need (future).** When extraction or the Snugg Pro write moves **server-side** — or when
RxDB read-sync against **our own** backend behind the gateway becomes real — that first-party
backend needs the gateway to forward a **trusted, attested `(app, user)` identity** it can rely on
without re-authenticating.

**Why.** The offline design already anticipates this: the outbox is the seam that later becomes RxDB
replication against our own API behind Helix's gateway, "at which point the external write can
migrate server-side" ([design spec §7](../superpowers/specs/2026-07-21-ribo-design.md)), and the
read-sync backend "**trusts the gateway's attested `(app, user)` identity and does not re-auth**"
([09 §](09-offline-first.md)). Today the app gets the signed-in auditor via `GET /_api/me`
([06](06-field-app-helix.md)), and the fetch-proxy authorizes per call and mints a 30 s attested
instruction — but that attestation is scoped to the outbound third-party fetch and is **not cleanly
forwarded as first-party identity to a backend of our own**. When that backend exists, it will need
one.

**What it blocks.** Nothing in the pilot. It is real, and it reappears together with the "same Azure
deploy substrate" dependency the custom-STT-service discussion raised ([02](02-server-stt.md),
[09 §](09-offline-first.md)) — both surface only when we move server-side.

**Status.** **Deferred**, but flagged so it is designed for, not rediscovered.

---

## Notes on scope

- **Accepted platform constraints (not asks).** For completeness, these are platform behaviors we
  **design around** rather than ask to change: the **10 MB/hop** fetch-proxy cap (→ `ribo-core`
  chunks audio on the managed-STT path, [02](02-server-stt.md), [03](03-ribo-core.md)); **no gateway
  WebSocket** (request/response only → the batch model, design decision D7); redirects not followed;
  HTTPS-only for secret-backed calls. They are listed here only so the Helix team is not asked to
  "fix" what we have already absorbed.
- **Setup, not asks.** Secret storage, origin bindings, and the two one-time elevated approvals for
  the secret-bound origins are one-time onboarding steps, covered in
  [06](06-field-app-helix.md) — not standing platform asks.

## Sources

- [05 — Snugg Pro adapter](05-adapter-snuggpro.md) — the now-superseded `X-Api-Key` write recipe.
- [06 — Field app (Helix host)](06-field-app-helix.md) — the original per-app asks list and the
  per-call egress flow.
- [09 — Offline-first](09-offline-first.md) — gateway single-egress model; attested `(app, user)`
  identity for a first-party backend.
- [10 — Build & packaging](10-build-and-packaging.md) — §4 COOP/COEP downgrade, §4.1 `blob:` CSP.
- [12 — Snugg Pro data model & write API](12-snuggpro-data-model.md) — the HMAC-signing finding that
  drives A1.
- [Phase 2.5 plan — offline app load](../superpowers/plans/2026-07-23-phase-2.5-offline-app-load.md) —
  app-owned service worker at root scope.
- [`packages/ribo-core/src/connectivity.ts`](../../packages/ribo-core/src/connectivity.ts) /
  [`playground/src/connectivity-store.ts`](../../playground/src/connectivity-store.ts) — the
  reachability-probe target problem behind A5.
- [Design spec](../superpowers/specs/2026-07-21-ribo-design.md) — §6 Helix integration, §7
  server-side migration seam.
