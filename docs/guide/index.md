# Overview

Ribo is a browser-side SDK for getting **structured, checkable data out of unstructured sources** —
a PDF, a dictation, a scanned report, several of them at once — and into a system of record, with a
human in the loop.

It runs entirely in the browser. It keeps working with no network. And every field it produces
carries a quote from the source that Ribo has verified is actually there.

## The pipeline

Six stages. Each one is an interface you can replace.

| Stage          | What happens                                                                | The seam            |
| -------------- | --------------------------------------------------------------------------- | ------------------- |
| **Capture**    | A recording, a PDF, or a document arrives as a `CaptureItem`                | —                   |
| **Transcribe** | The capture becomes citable text                                            | `Transcriber`       |
| **Session**    | One or more captures are joined into a single transcript                    | —                   |
| **Extract**    | The transcript becomes fields, against a target schema too big for one call | `Extractor`         |
| **Review**     | A human accepts or corrects each field, with its source quote in view       | the review contract |
| **Write**      | The accepted values are written to the host system                          | `ToolAdapter`       |

The pipeline splits cleanly in the middle, and the split is the point. **Capture and transcription
know what a microphone is. Everything downstream does not.** A session's transcript is just text
with attribution markers, so extraction, provenance, review and write-back never learned what
produced it — which is why adding PDF support required no change to any of them.

## What makes it different

Three things, in order of how much work they save you.

**The target schema does not fit in one model call.** This is the problem that arrives the moment
you point an extractor at a real system of record rather than a demo. Wrapping every field in a
provenance envelope multiplies the property count, and structured-output APIs have hard ceilings on
properties and enum values. Ribo partitions the schema, runs the calls, fills what the first pass
abstained on, and reassembles one result. See [Comparison](/guide/comparison) for the numbers.

**Provenance is verified, not asserted.** Every extracted leaf arrives as `{ value, confidence,
sourceSpan }`, and `isSpanGrounded` checks the span against the source text. A model that invents a
citation gets caught by string comparison. This is a categorically different guarantee from a
confidence score, which is the model grading its own work.

**Review is a contract, not a screen.** `buildReviewRequest` turns an extraction into a flat list of
leaf paths, each carrying its own schema — so a review UI renders and validates itself from the
schema and imports nothing tool-specific. A session parks at `awaiting-review` and only an explicit
submission moves it forward.

## What it is not

Ribo does not parse documents. It **delegates** that — to pdf.js, to a hosted document-understanding
API, to whatever you plug into the `Transcriber` seam. If your hard problem is reading a rotated,
handwritten, coffee-stained scan, your hard problem is a parser, and Ribo is the wrong layer to be
shopping in. [Comparison](/guide/comparison) is explicit about where the line falls.

## Where to go next

- **[Motivation](/guide/motivation)** — the problem this exists to solve, and why the obvious
  approaches run out.
- **[Comparison](/guide/comparison)** — Ribo against Docling, Mistral Document AI, and calling a
  structured-output API yourself. Including the rows Ribo loses.
- **[Getting Started](/guide/getting-started)** — run the workspace.
- **[API Reference](/reference/)** — the generated per-package surface.
