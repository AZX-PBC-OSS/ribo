# Ribo — Implementation Proposal: Overview

**Status:** Proposal for review
**Parent design:** [`../superpowers/specs/2026-07-21-ribo-design.md`](../superpowers/specs/2026-07-21-ribo-design.md)

This directory proposes _how_ we build Ribo. It is design-level — approach, interfaces, deploy shape, relative sizing, and open decisions per component — intended to get build sign-off (AZX DRB / Rich) before we generate executable task plans. It is **not** a task-by-task build plan; those come per subsystem once this and the feasibility spike are approved.

## What we're building (recap)

A field auditor speaks their audit findings; the system transcribes → extracts audit fields → review/accept → writes into Snugg Pro. Deliverables:

- **SDK (the reusable product):** `@azx/ribo-core`, `@azx/ribo-ui`, `@azx/ribo-adapter-snuggpro`
- **The field app** _(separate repo; name TBD)_ — a Helix-hosted proof-of-concept host that consumes the SDK — ships/demos without waiting on Snugg Pro's dev team
- **Server STT:** on-device WASM (OSS Whisper) primary; a **managed Azure STT endpoint proxied through Helix** as fallback — **no custom service in v1** (a custom STT service is conditional; see [02](02-server-stt.md))

## Most of this is assembly, not invention

The heavy lifting is open source (or managed); our net-new code is the _composition_, the _adapter model_, the _review UX_, and the _Helix wiring_. Building blocks per component:

| Component                                            | Lean on                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| On-device STT ([03](03-ribo-core.md))                | **`@huggingface/transformers` ^4.2.0** + **`whisper-base.en`** — decided 2026-07-22 by attrition; the other candidates (Moonshine, Vosk, whisper.cpp wrappers) are unshippable in a browser today, see [01](01-feasibility-spike.md) |
| Server STT ([02](02-server-stt.md))                  | **Azure AI Speech** (Fast Transcription) or **Azure OpenAI transcription** — managed, Azure-native, proxied                                                                                                                          |
| Offline data + outbox ([09](09-offline-first.md))    | **RxDB** on the free **Dexie `RxStorage`** — local DB now, backend-agnostic replication later; outbox state machine on top                                                                                                           |
| Model / shell caching ([09](09-offline-first.md))    | **Cache API** + service worker (the WASM model + app shell); `persist()` for iOS                                                                                                                                                     |
| Audio capture / VAD ([03](03-ribo-core.md))          | `MediaRecorder` (web standard) + **@ricky0123/vad**                                                                                                                                                                                  |
| Transcript → structured JSON ([03](03-ribo-core.md)) | official **`openai` SDK** + **`zodResponseFormat`** against Helix's **OpenAI-compatible route** — native structured outputs (no hand-rolled parse/repair)                                                                            |

## Document map

| Doc                                                   | Subsystem                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [01-feasibility-spike](01-feasibility-spike.md)       | On-device WASM spike — **gates everything, do first**                                  |
| [02-server-stt](02-server-stt.md)                     | Server STT (managed Azure) + conditional service                                       |
| [03-ribo-core](03-ribo-core.md)                       | Headless engine                                                                        |
| [04-ribo-ui](04-ribo-ui.md)                           | UI components                                                                          |
| [05-adapter-snuggpro](05-adapter-snuggpro.md)         | Snugg Pro adapter                                                                      |
| [06-field-app-helix](06-field-app-helix.md)           | Helix host app + wiring                                                                |
| [07-testing-and-accuracy](07-testing-and-accuracy.md) | Test strategy + accuracy harness                                                       |
| [08-risks-and-sequencing](08-risks-and-sequencing.md) | Risks, staffing, sequencing                                                            |
| [09-offline-first](09-offline-first.md)               | Offline foundation: RxDB, outbox, iOS rules, API-call story                            |
| [10-build-and-packaging](10-build-and-packaging.md)   | Repo layout, toolchain, package contract, WASM/worker rules, dev loop, maintainability |

## Milestone sequence (proposed)

```
M0  Feasibility spike (on-device WASM)         ─┐  gates transcription default
M1  Server STT wiring (managed Azure proxy)  ──┼─ small now (no custom service to deploy)
M2  ribo-core (engine)             ───────────┤
M3  ribo-ui (components)           ───────────┤
M4  adapter-snuggpro                ───────────┤
M5  field-app + Helix wiring        ───────────┘  integrates M1–M4
─── cross-cutting: accuracy harness fed by REAL recordings collected from day 0
```

Relative sizing per component — **S/M/L/XL**, per the Engineering Feasibility Rubric (deliberately relative, not day/week estimates, so the pieces are graded against each other):

| Milestone                                  | Size                                            |
| ------------------------------------------ | ----------------------------------------------- |
| M0 spike                                   | **S** (up front)                                |
| M1 server STT wiring (managed Azure proxy) | **S** (custom service only if required → **L**) |
| M2 ribo-core                               | **L**                                           |
| M3 ribo-ui                                 | **M**                                           |
| M4 adapter                                 | **S**                                           |
| M5 field-app + wiring                      | **M**                                           |

These overlap; wall-clock depends on staffing. Internal sizing runs ahead of the committed SOW delivery window — so the sequencing doc names explicit descope levers.

## Reading order

Start with the spike ([01](01-feasibility-spike.md)) — its result decides whether on-device is the default or the managed STT path carries more load, which shifts work between [02](02-server-stt.md) and [03](03-ribo-core.md).
