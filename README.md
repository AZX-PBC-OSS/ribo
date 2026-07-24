# Ribo

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-10.34.5-f69220.svg)](package.json)

A reusable **voice-capture SDK for field data collection**: record a dictation, transcribe it
on-device (or via a managed STT service), extract structured fields from the transcript, let a human
review and accept them with provenance, and write the result back into a host tool through a thin
per-tool adapter.

First target: **home-energy audits in Snugg Pro**, deployed on the Helix platform.

## What works today

The pipeline runs end to end through **review**:

**capture → on-device transcribe → extract → review (with provenance)** → _write-back_

- **Capture** — `Recorder` negotiates a container and records from the microphone, emitting a
  `Recording` plus its bytes.
- **Transcribe** — on-device Whisper (`@azx/ribo-transcriber-ondevice`) implements the `Transcriber`
  contract and runs real inference in a Web Worker; `firstCapable` selects the first ready engine.
  Measured on clean authored audio, `whisper-base.en` runs at ~6× real time with 8.0 % WER
  ([the numbers](docs/implementation/14-transcription-measurement.md)).
- **Extract** — an `Extractor` turns the transcript into structured fields. The built default is the
  single-shot managed-LLM extractor in `@azx/ribo-extractor-openai`, targeting the SnuggPro adapter; a
  `FakeExtractor` drives the pipeline with no model. Every field arrives in a provenance envelope with a checkable, span-grounded
  source quote.
- **Review** — a field-by-field review contract (`buildReviewRequest` / `resolveReview`) lets a human
  accept or correct each value, with the source span surfaced so a reviewer sees where it came from.
- **Write-back is scaffolded, not wired.** The `ToolAdapter` seam and `snuggProAdapter` exist, but the
  live Snugg Pro write is **gated on a platform ask** (see
  [Helix platform asks](docs/implementation/13-helix-platform-asks.md)).

Work never depends on a live network: a recording enters a durable RxDB **outbox** at capture and a
foreground relay drives it forward when connectivity allows. The app shell and the on-device model are
cached so a returning auditor boots and records fully offline. **iOS on-device transcription is out of
scope** for now (the managed STT path covers it).

## Quick start

Requires **Node >= 24** and **pnpm 10.34.5** (pinned via `packageManager`; `corepack enable` honors it).

```bash
pnpm install                  # bootstrap the workspace
./check.sh                    # the one "am I done?" signal: typecheck, lint, format, build, test
pnpm --filter playground dev  # dev server on http://localhost:5173
```

The `playground/` app composes all packages from TypeScript source, so editing a package's
`src/index.ts` hot-updates the page with no build step.

## Architecture at a glance

Four tiers. Dependencies only ever point **inward toward `ribo-core`**; a second host tool is a new
adapter package and nothing else.

| Package                          | What it is                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@azx/ribo-core`                 | The headless engine: capture, transcription contracts + selection, connectivity, the durable outbox + relay, the extraction and review seams, work-safety. No React, no DOM rendering.     |
| `@azx/ribo-transcriber-ondevice` | On-device Whisper implementing `Transcriber`. A separate package because `@huggingface/transformers` pulls heavy native deps no non-transcribing consumer should inherit.                  |
| `@azx/ribo-adapter-snuggpro`     | The **only** tool-specific surface: the Snugg Pro field schema, the extractor instructions/examples, the deterministic normalization pass, and the write-back seam.                        |
| `@azx/ribo-extractor-openai`     | Tool-agnostic extractor plasmid: single-shot managed-LLM extraction (`singleShotExtractor`) over an OpenAI-compatible chat transport (`openAiChat`). Works against any `ExtractionTarget`. |
| `@azx/ribo-ui-react`             | React components over the engine (recorder, review UI). **Still a stub** — no components yet.                                                                                              |

The extension points are three interfaces: **`Transcriber`** (how audio becomes text),
**`Extractor`** (how text becomes fields), and **`ToolAdapter`** (where tool-specific knowledge and
write-back live). The consuming field app lives in a **separate repo**; `playground/` is this repo's
stand-in for a consumer.

## Documentation

- **Docs site** — narrative guide, capability seams, offline-first, deep dives, and a generated API
  reference. Run it locally with `pnpm docs:dev`, or build the static site with `pnpm docs:build`
  (`pnpm docs:api` regenerates the API reference from each package's public barrel). The base path is
  configurable for a subpath deploy: `DOCS_BASE=/ribo/ pnpm docs:build`.
- **[AGENTS.md](AGENTS.md)** — commands, the architecture map, and the non-obvious mechanisms that must
  not be "simplified". Read it before changing code.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, the "am I done?" signal, and the conventions that bite.

## License

[MIT](LICENSE) © 2026 AZX-PBC.
