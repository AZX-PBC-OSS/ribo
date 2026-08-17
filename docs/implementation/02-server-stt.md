# 02 — Server STT Path (Managed, Azure) + Conditional Custom Service

> **Built on 2026-08-17.** `@azx/ribo-transcriber-managed` implements this path; see
> [Managed Transcription — Design](../roadmap/design/managed-transcription-design.md) for what was
> measured against the live endpoint, and note three corrections to this document:
>
> 1. **The vendor question below is closed: Azure AI Speech Fast Transcription**, api-version
>    `2025-10-15`. The deciding factor is not in this document — it is the **phrase list**, which
>    Azure OpenAI transcription does not offer. Measured: the same audio returned "our 19" without one
>    and "R-19" with one, and R-values are exactly what the extractor reads.
> 2. **Client-side chunking was not needed.** This document treats it as a given because of the
>    10 MB/hop cap, but the recorder emits Opus, so a hop carries roughly ten minutes of dictation —
>    longer than a field recording. A `MediaRecorder` WebM/Opus blob is accepted by the endpoint
>    as-recorded, so there is no transcode either.
> 3. **The size estimate held.** "S" was right, though the larger half of the work turned out to be
>    the real-time-factor gate in the on-device package rather than this path: without it
>    `capability()` judged readiness on cached weights alone, so a slow device always reported
>    `ready` and this fallback could never be selected.

> **Design spec D4.** For v1 the server path is a **direct proxy to a managed Azure STT endpoint — no custom service to build or deploy**. A custom STT service is a _conditional_ upgrade, built only where a step requires it. Follows the "custom backend only where required" principle and removes what had been the biggest schedule risk.

## Role

Server-side speech-to-text — the **fallback** for devices that can't run on-device WASM (older/iOS phones), and optionally a higher-accuracy re-pass. On-device (OSS Whisper-WASM) handles the primary path where the spike ([01](01-feasibility-spike.md)) clears the bar.

## Default (v1): proxy a managed Azure STT endpoint — build nothing

The field app calls `/_api/fetch/<azure-stt-endpoint>` with the audio; the Azure key is a Helix **connection secret**, injected server-side by egress. The app holds nothing; **we deploy no service.**

### Azure-native candidates (managed, key-based, easy to stand up)

| Option                                                           | Notes                                                                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Azure AI Speech — Fast Transcription REST** (default)          | Purpose-built STT; short-clip transcription returns synchronously. Provision a Speech resource → endpoint + key. Supports domain phrase-lists and batch if we grow into it. |
| **Azure OpenAI transcription** (`whisper` / `gpt-4o-transcribe`) | Same Azure OpenAI account already used for the LLM proxy; audio → text REST. One-vendor alternative.                                                                        |

Both are "provision resource → key → REST call," so both drop straight into the fetch-proxy + connection-secret pattern with zero custom infra. We only consider Azure-native managed STT (per the deploy constraint) — not Deepgram/AssemblyAI/etc.

## When a custom STT service IS required (conditional)

Build it **only** if we need logic the proxy can't do:

- chunk stitching / reassembly for long recordings,
- orchestration across models (cheap on-device draft + server high-accuracy re-pass),
- normalization across multiple STT vendors behind one interface,
- pre/post-processing (domain-vocabulary biasing, redaction).

If built: **Azure Container App, scale-to-zero**, reached via the fetch-proxy exactly like the managed endpoint. This is the _only_ part that carries the "Helix has no Azure substrate yet" risk — and we now incur it **only if required**, not by default.

## Compliance escape hatch (unchanged)

The vendor sits behind `ribo-core`'s `Transcriber` interface, so Azure AI Speech → Azure OpenAI → self-hosted Whisper is swappable without touching any caller. If the client's SOC/ISO review demands audio never touch a managed service, that swap is where a self-hosted OSS Whisper backend drops in.

## Constraints

- **10 MB/hop** fetch-proxy cap → `ribo-core` chunks audio client-side.
- **HTTPS-only**; egress strips injected creds from responses.
- Batch / request-response (no gateway WebSocket) — consistent with the batch model (D7).

## Size & open items

- **Size (default, managed proxy):** **S** — provision Azure STT, store the connection secret, wire the transcriber + chunking. (Down from ~**L**; the deploy-substrate risk is removed.)
- **Size (only if a custom STT service becomes required):** **+L** incl. deploy.
- **~~Open:~~ Closed 2026-08-17.** AI Speech Fast Transcription, on the phrase list (see the note at the top). No v1 need forced a custom service, and the default assumption of **no** held: chunking, the most likely trigger, turned out unnecessary at the recorder's bitrate.
