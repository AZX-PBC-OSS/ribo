# Quick Start

This runs a capture through to a first extracted, span-checked field — with no credentials, no
network, and no model. `FakeTranscriber` and `FakeExtractor`, both exported from
`@azx/ribo-core`, stand in for the real engines: nothing is transcribed or extracted, but every
seam runs for real.

The code below is pulled live from [`examples/no-key-pipeline/`](/examples/), where CI executes it
on every change — it is not a static listing.

<<< @/../examples/no-key-pipeline/no-key-pipeline.run.ts#imports

<<< @/../examples/no-key-pipeline/no-key-pipeline.run.ts#pipeline

Paste the two blocks together into a `.ts` file in a project with `zod` and `@azx/ribo-core`
installed (see [Installation](/guide/installation)) and they run as written.

## Swapping in a real engine

`FakeExtractor` and a real extractor both satisfy the same `Extractor` contract, so nothing above
it — the schema, `enveloped()`, the `isSpanGrounded` check — changes when you swap one in. Only
the construction line does. `@azx/ribo-core`'s `singleShotExtractor` builds one
against an OpenAI-compatible chat endpoint — that construction runs (against a scripted chat, no
key) on the [`singleShotExtractor`](/api/single-shot-extractor) API page, and the chat transports
it dials are covered on the [`ChatClient`](/api/chat-transports) page.

`target` bundles what an extractor needs — the same `extractionSchema` from step 4, plus a name
and instructions. A `ToolAdapter` supplies this already, so a real host wires its
adapter straight in rather than building a `target` literal by hand. Or skip the target
entirely: [From a Schema](/guide/from-a-schema) is the constructor that takes the plain zod
schema you wrote and derives the rest.

**API pages:** the [`CaptureSession`](/api/capture-session) page, for the pieces this quick start
drives through the [fakes](/api/test-doubles).

## Next

Swap `FakeTranscriber` for a real engine, wire both into durable storage, and get a result to
a review screen — [Offline & Storage](/guide/offline-and-storage).
