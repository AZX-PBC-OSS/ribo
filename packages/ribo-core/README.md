# @azx/ribo-core

The **headless engine** at the center of Ribo. It owns the whole capture-to-review vocabulary — the
capture state machine, the transcription and extraction seams, connectivity, the durable offline outbox
and its relay, work-safety, and the field-by-field review contract — with **no React and no DOM
rendering**. Everything else in the workspace depends inward on this package; it depends on nothing else
in it. (Headless is a layering rule, not a ban on browser APIs: `MediaRecorder`, `IndexedDB`, `fetch`,
`Blob`, `AudioContext` and `Worker` are all fair game here.)

## Installation

```bash
pnpm add @azx/ribo-core
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **Provenance** — `extractedSchema`, `isSpanGrounded`, `Extracted`: the envelope every extracted field
  arrives in, and the checkable span-validity signal that replaces confidence for review flagging.
- **Records** — `Recording`, `Transcript` and their zod schemas.
- **Transcription** — the `Transcriber` contract, its `TranscriberCapability` model, `firstCapable`
  selection, and the `FakeTranscriber` double.
- **Capture** — `Recorder`, `negotiateMimeType`.
- **Connectivity** — `createConnectivity`: the `offline`/`probing`/`online` model.
- **Outbox** — `Outbox`, `openOutbox`, `createRelay`: the durable queue and its foreground relay.
- **Extraction** — the `Extractor` seam, `toExtractStep`, and the `FakeExtractor` double.
- **Review** — `buildReviewRequest`, `resolveReview`, `ReviewPresenter`.
- **Work-safety** — `workSafety`, `summarizeWork`: the one honest "is my work safe?" answer.
- **Write-back** — the `ToolAdapter<F, C>` type (implemented by adapter packages).

## Minimal example

```ts
import { FakeTranscriber, firstCapable } from "@azx/ribo-core";

// The fake is substitutable for any real Transcriber — it drives the pipeline with no model.
const transcriber = new FakeTranscriber();

// firstCapable tries engines in preference order; the first one ready wins.
const composite = firstCapable([transcriber]);
const capability = await composite.capability(); // { status: "ready" }

// `audio` is the Blob the queue holds for a Recording; `transcribe` stamps the result with `engine`.
const transcript = await transcriber.transcribe(recording, audio);
```

See the [API Reference](../../docs/reference/) (generated) for the full surface.
