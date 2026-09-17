# Ribo

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-10.34.5-f69220.svg)](package.json)

Ribo fills a schema from documents and speech, in a browser, with a person checking the result.

You give it a zod schema of the fields you need. It takes PDFs, dictation, or several of both at
once, runs them through a model, and returns each field with the quote it came from. It checks that
the quote is actually in the source. A person reviews the fields. An adapter writes them into your
system of record.

It runs client-side and keeps working without a network.

## Why a library

Five things make this a library instead of a script:

1. Real schemas are too large for one model call. Ribo splits the schema, runs the calls, and
   reassembles one result.
2. Models cite text that isn't there. Ribo checks every quote against the source and flags the ones
   that fail.
3. Someone has to approve the output. Review is an API that addresses individual fields, not a
   screen you write later.
4. Field work happens without signal. Captures and jobs persist locally and resume.
5. The output has to reach the right record in a real system, which is a separate problem from
   extracting it.

Ribo does not parse documents. It calls something else for that, and you choose what.

## What works today

The pipeline runs as two persisted state machines, split where the code splits: capture and
transcription belong to a **recording**; extraction, review and write-back belong to a **session**.
The recording half knows what a microphone is; the session half does not.

- **Recording:** `recording → queued → transcribing → transcribed`, with a resting `failed` the
  relay retries after backoff and a terminal `dead`. A recording is finished, from the relay's
  perspective, once it is text.
- **Session:** `open → extracting → awaiting-review → writing → done`, the same `failed`/`dead`
  split. One or more recordings join into a session, and extraction, review and write-back all
  happen there — never on the recording.

Stage by stage:

- **Capture** — `Recorder` negotiates a container and records from the microphone. `CapturePayload` is
  a union of `Recording` and `DocumentCapture`, so a PDF enqueues through the same path as a
  dictation.
- **Transcribe** — four engines implement `Transcriber`: on-device speech (`@azx/ribo-transcriber-ondevice`,
  Moonshine by default), managed speech (`@azx/ribo-transcriber-managed`), pdf.js against a PDF's
  existing text layer (`@azx/ribo-transcriber-pdfjs`), and a hosted document-understanding API
  (`@azx/ribo-transcriber-managed-docs`). `firstCapable`, `fallbackTranscriber` and `hedged` compose
  them. On clean, authored text-to-speech audio, the on-device path's previous default
  (`whisper-base.en`) ran at ~6× real time with 8.0% WER — a floor, not a field forecast. Word-error
  rate against real field speech is not yet measured for either model
  ([the numbers](docs/implementation/14-transcription-measurement.md)).
- **Extract** — a session's joined transcript becomes structured fields through an `Extractor`:
  `@azx/ribo-extractor-openai` ships the managed default (`singleShotExtractor`) plus a per-group
  strategy (`perGroupExtractor`) that partitions a schema too big for one call across concurrent
  calls; `@azx/ribo-extractor-ondevice` runs the same contract against an on-device chat model in
  three phases. Every field arrives in a provenance envelope (`{ value, confidence, sourceSpan }`),
  and `isSpanGrounded` checks the span against the source text. Extraction quality has no current
  measured figure: the annotated corpus that produced earlier numbers is written in a field
  vocabulary the adapter no longer uses, so the acceptance gate refuses to emit a score instead of a
  meaningless one.
- **Review** — `buildReviewRequest` / `resolveReview` turn a session's extraction into a flat list of
  per-leaf review items, each carrying its own schema; a session parks at `awaiting-review` and only
  an explicit `Storage.submitSessionReview` moves it forward.
- **Write-back is scaffolded, not wired.** The `ToolAdapter` contract and `snuggProAdapter` exist,
  but the live Snugg Pro write is **gated on a Helix platform ask** — egress request signing, see
  [Helix platform asks](docs/implementation/13-helix-platform-asks.md).

Work never depends on a live network: a recording enters a durable RxDB **storage** at capture and a
foreground relay drives each state machine forward when connectivity allows. The app shell and any
on-device model weights are cached so a returning user boots and records fully offline. **iOS
on-device transcription is out of scope** for now (the managed STT path covers it).

## Quick start

Requires **Node >= 24** and **pnpm 10.34.5** (pinned via `packageManager`; `corepack enable` honors
it).

```bash
pnpm install                  # bootstrap the workspace
./check.sh                    # the one "am I done?" signal: typecheck, lint, format, build, test
pnpm --filter playground dev  # dev server on http://localhost:5173
```

> **Not yet published to npm.** Every example in this repo imports the real package names
> (`@azx/ribo-core` and friends) the way a real consumer would, but nothing is on npm yet —
> `publishConfig.access` is `restricted` workspace-wide. Releases will move to release-please and
> publish under the public `@azx` scope; until then, consume packages from workspace source the way
> `playground/` does.

The `playground/` app composes all packages from TypeScript source, so editing a package's
`src/index.ts` hot-updates the page with no build step.

## Architecture at a glance

Nine publishable packages. Dependencies point **inward, toward `ribo-core`**; every transcriber,
extractor and adapter package depends on it and never on each other, so adding a second host tool is
a new adapter package and nothing else.

| Package                              | What it is                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@azx/ribo-core`                     | The headless engine: capture, the recording and session state machines (durable storage + relay), transcription and extraction contracts + selection, connectivity, the review contract, work-safety. No React, no DOM rendering.                                               |
| `@azx/ribo-ui-react`                 | Headless React hook layer over the engine — `RiboProvider` plus recorder, review, storage, connectivity and work-safety hooks. No components beyond `RiboProvider`, no markup.                                                                                                  |
| `@azx/ribo-transcriber-ondevice`     | On-device speech transcription implementing `Transcriber` (Moonshine by default, Whisper models still selectable), running inference in a Web Worker. Separate package because `@huggingface/transformers` pulls heavy native deps no non-transcribing consumer should inherit. |
| `@azx/ribo-transcriber-managed`      | Managed speech transcription (Azure AI Speech Fast Transcription) proxied through the host's transport. It never holds a credential — it takes an endpoint and an injected `fetch`.                                                                                             |
| `@azx/ribo-transcriber-pdfjs`        | PDF transcription via pdf.js: extracts a PDF's existing text layer, and refuses a document with no text layer — it cannot OCR.                                                                                                                                                  |
| `@azx/ribo-transcriber-managed-docs` | A hosted document-understanding API behind the host's transport, for scans and layouts pdf.js can't read. Composes with `ribo-transcriber-pdfjs` through `fallbackTranscriber`.                                                                                                 |
| `@azx/ribo-extractor-openai`         | Tool-agnostic managed-LLM extraction: `singleShotExtractor` (the default) and `perGroupExtractor`, which partitions a schema too big for one call across concurrent calls.                                                                                                      |
| `@azx/ribo-extractor-ondevice`       | An on-device extractor over Chrome's built-in language model, running presence, span and classify as three phases against the same `Extractor` contract.                                                                                                                        |
| `@azx/ribo-adapter-snuggpro`         | The **reference adapter and worked example**: Snugg Pro's field schema, the extractor instructions/examples, the deterministic normalization pass, and the write-back contract — the only tool-specific surface in the workspace.                                               |

(`@azx/build-config` and `@azx/tsconfig` are private workspace plumbing — shared build and tsconfig
setup, not part of the pipeline, never published.)

The extension points are **`Transcriber`** (how a capture becomes text), **`Extractor`** (how text
becomes fields), **`ToolAdapter`** (where tool-specific knowledge and write-back live), and the
storage's injectable **`RxStorage`** (where the durable queue persists — `AGENTS.md` §5.5). The
consuming field app lives in a **separate repo**; `playground/` is this repo's stand-in for a
consumer.

## Documentation

- **Docs site** — narrative guide, the comparison against Docling/Mistral/direct structured
  outputs, offline-first, deep dives, and a generated API reference. Run it locally with
  `pnpm docs:dev`, or build the static site with `pnpm docs:build` (`pnpm docs:api` regenerates the
  API reference from each package's public barrel). The base path is configurable for a subpath
  deploy: `DOCS_BASE=/ribo/ pnpm docs:build`.
- **[AGENTS.md](AGENTS.md)** — commands, the architecture map, and the non-obvious mechanisms that must
  not be "simplified". Read it before changing code.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, the "am I done?" signal, and the conventions that bite.

## License

[MIT](LICENSE) © 2026 AZX-PBC.
