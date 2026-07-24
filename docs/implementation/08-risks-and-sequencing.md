# 08 — Risks & Sequencing

## Risk register

| Risk                                                                                           | Impact                             | Mitigation                                                                                                                                                                                                                                  | Owner            |
| ---------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Custom STT service would need an Azure deploy substrate** Helix hasn't stood up (M5 pending) | Schedule — **now avoided in v1**   | Default is proxying a managed Azure STT endpoint (no service to deploy); a custom STT service is built only if required ([02](02-server-stt.md))                                                                                            | AZX              |
| **Managed Azure STT accuracy/latency** for field audio (fallback path)                         | Product (fallback only)            | Evaluate Azure AI Speech vs Azure OpenAI transcription in the spike/harness; phrase-lists for domain terms                                                                                                                                  | AZX              |
| **Accuracy / measure-relevance unvalidated** — **and now accepted through the PoC**            | Product — the core bet             | **Was:** real recordings + harness from day 0, no prod code against assumptions. **Now:** synthetic corpus for the PoC (consent deferred), with real-recording validation as a **gate before field use** ([07](07-testing-and-accuracy.md)) | AZX + the client |
| **On-device WASM perf on phones/iOS**                                                          | Feature scope                      | Spike first ([01](01-feasibility-spike.md)); managed STT fallback already designed — now justified on **performance**, not capability, since the platform baseline guarantees WebGPU/WASM-SIMD; on-device can become a fast-follow          | AZX              |
| **In-home recording consent/privacy**                                                          | Legal — **deferred, not resolved** | **Deferred 2026-07-23.** The client's policy path still required before _any_ real recording; PoC proceeds on a synthetic corpus instead of waiting. On-device keeps audio on device                                                        | the client       |
| **Target not formally ratified** (this program vs another on a different tool)                 | Premise                            | Proceed on Snugg Pro; formal work-package sign-off                                                                                                                                                                                          | the client       |
| **Schedule: internal sizing exceeds the committed delivery window; lone-wolf**                 | Delivery                           | Descope levers (below); review-recommended architect + 2nd engineer                                                                                                                                                                         | AZX              |
| **Snugg Pro API header/shape surprises**                                                       | Small                              | Confirm endpoint + safelist early ([05](05-adapter-snuggpro.md))                                                                                                                                                                            | AZX              |

## Sequencing

```
Day 0 ──────────────────────────────────────────────────────────────►
  M0 spike ▓▓▓                     (S, gates transcription default)
  synthetic corpus + TTS audio ░░░░  (unblocked; feeds accuracy harness — 01/07)
  consent path ····················  (DEFERRED, not ours; unblocks real recordings)
  M1 server STT wiring   ▓▓                (S, managed Azure proxy — no service)
  M2 ribo-core              ▓▓▓▓▓▓▓▓▓       (L)
  M3 ribo-ui                     ▓▓▓▓▓      (M)
  M4 adapter                          ▓▓     (S)
  M5 field-app + wiring                ▓▓▓▓  (M, integrates all)
                                            ┃
                              GATE: real-recording accuracy validation
                              ───────────────────────────────────────
                              before FIELD USE, not before build
```

(Bar length is relative size, not calendar time.)

**The gate is part of the sequence, not a footnote.** Recording collection has moved off the build critical path because the consent path is deferred ([open questions §8](../open-questions.md)) — but it has moved to the **end**, in front of field use, not off the plan. A PoC that demos well on synthetic data has not cleared it. See [07](07-testing-and-accuracy.md) for what clearing it means.

Wall-clock depends on staffing. With one primary engineer the milestones largely serialize — but dropping the custom STT service (M1 from **L** to **S**) pulls the critical path back meaningfully. Descope levers below cover the rest.

## Descope levers (if slipping)

Pull in this order:

1. **On-device → fast-follow.** Ship managed-Azure-STT-primary (batch); add on-device after. Removes the riskiest work from the critical path.
2. **Narrow the field set** further ([05](05-adapter-snuggpro.md)) — fewer audit fields in v1.
3. **Drop the higher-accuracy re-pass** ([02](02-server-stt.md)) — never build a custom STT service for v1.
4. **Standalone field app only** — defer any Snugg-Pro-embed work entirely.

## Staffing note

The AZX DRB "reviewed with guidance" but did **not** approve the build-phase plan; the direction was to add an architect + a second engineer and reduce the single-engineer load. Removing the custom STT service takes the heaviest infra chunk off the plate; the remaining offload candidates are the accuracy harness and the `ribo-ui` component work. This proposal assumes the staffing question is resolved before build starts.
