# Extraction

A session's transcript — [Sessions](/guide/sessions) covers how several captures become one — is
text plus context about where it came from, until something turns it into fields a system of record
can accept. An `Extractor<F>` is that something: the one seam that calls a model, and the only thing
that changes when you swap a fake for a real engine, or one real engine for another.

## The `Extractor<F>` seam

```ts
import type { AnnotatedTranscript, Extractor, ExtractionResult } from "@azx/ribo-core";

interface Extractor<F> {
  extract(transcript: AnnotatedTranscript, options?: ExtractOptions): Promise<ExtractionResult<F>>;
}
```

One method, and it never sees a `CapturePayload`, a `Recording`, or a `DocumentCapture` — only the
joined transcript a session assembles. An extractor that took a capture would have to know whether
the words came from a microphone or a scanner, and nothing about turning text into fields cares.
This is the same structural split [Sessions](/guide/sessions) describes, from the other side.

The input is an `AnnotatedTranscript`, not a bare string. Its `text` is the one canonical string
that extracted spans are checked against — what the model quotes from and what `isSpanGrounded`
checks against, exactly as it always has. Around it sits an open `annotations` bag: a document
transcriber's page boundaries or table structure, the relay's per-capture metadata under the
reserved `capture.` prefix — whatever the upstream stages produced. The bag is deliberately left
schema-free until a real transcriber produces real annotations, and it does not affect grounding:
`isSpanGrounded(span, transcript.text)` is the same check it always was.

`ExtractionResult<F>` carries the parsed `fields`; an optional `raw` payload kept for debugging; a
`usage` block (calls made, token counts, and which `engine` and `strategy` produced the result —
covered from the composition side in [Arbitration & Fallback](/guide/arbitration)); and an optional
`statedEmptyGroups`, for a roster-based strategy's explicit "none of these" answers per group.

## Run options: cancellation is part of the contract

The trailing `options` bag currently carries one member, `signal?: AbortSignal` — the same optional
trailing object `Transcriber.transcribe` takes, so the two run-context contracts do not drift. The
relay passes a signal that it aborts when the extraction step's timeout fires, so a hung model
call is cancelled rather than left running behind the rejection; a host driving an extractor by hand
can pass its own. Each transport states what it does with the signal in its own docs — the
fetch-based ones abort the in-flight request, the on-device engine cancels between phases without
killing the model session — and an implementation that cannot honour it must say so plainly rather
than accept it and ignore it. A cancelled extraction rejects rather than returning a partial
result, and **both** extraction routes classify that abort as retryable on purpose — the on-device
engine rejects with `ChatError.aborted` just as the managed one does. The abort is caller-initiated,
and a host that cancels on a deadline may well succeed on a later attempt with a fresh one. (The
transcription side makes the opposite call — see [Captures & Sources](/guide/captures-and-sources).)

## `ExtractionTarget`: the field knowledge an extractor needs

```ts
type ExtractionTarget<V extends Record<string, unknown>, P = NoProvenance> = Pick<
  ToolAdapter<V, unknown, P>,
  "name" | "extractionSchema" | "instructions" | "examples"
>;
```

It is the slice of a `ToolAdapter` extraction actually touches: the enveloped schema to constrain
the model against, plus the instructions and few-shot examples that shape the prompt — `write` and
the connection context are left out, because writing back is a separate concern an extractor never
needs to know about. A `ToolAdapter<V, C, P>`'s full shape satisfies `ExtractionTarget<V, P>`
structurally, so the same adapter object you hand to a write step is the one you hand to an
extractor — no second, extraction-only object to keep in sync.

## `toSessionExtractStep`: wiring an extractor into the relay

```ts
import { toSessionExtractStep } from "@azx/ribo-core";

const sessionExtract = toSessionExtractStep(myExtractor);
```

The name says `Session`, not `Extract`, on purpose: extraction runs once per **session**, against
the joined transcript from every capture that belongs to it, never once per recording — see
[Sessions](/guide/sessions) for why that line sits where it does. `toSessionExtractStep` is the
one-line adapter between an `Extractor<F>`'s `ExtractionResult<F>` and the relay's own
`SessionExtractStep` shape, so wiring a strategy into the queue is a one-line change to
`RelayOptions.sessionExtract`, with no change to the relay itself.

## `FakeExtractor`: driving the pipeline with no model

```ts
import { FakeExtractor, toSessionExtractStep } from "@azx/ribo-core";

const extractor = new FakeExtractor({
  company: { value: "Acme", confidence: 1, sourceSpan: "Acme" },
});
const sessionExtract = toSessionExtractStep(extractor);
```

`FakeExtractor` returns fixed fields instead of calling anything, and records every transcript it
was handed on `.calls` — the extraction-side parallel of `FakeTranscriber`. It is what lets the
relay, the test suite, and the playground drive capture → transcribe → extract → review → write end
to end with no network and no API key; [Quick Start](/guide/quick-start) builds that pipeline from
scratch with it.

## The two real extractors

### `@azx/ribo-extractor-openai`: the managed-LLM strategies

`singleShotExtractor` is the built default: one structured-output chat call per extraction, its
response parsed against the target's `extractionSchema`. It needs a `ChatClient` to actually talk to
a model, and this package ships two. They are different transports, not two endpoints of one.

- **`openAiChat`** is the OpenAI-compatible transport: it POSTs to `${baseUrl}/chat/completions`
  with bearer auth and reads `choices[0].message.content`, the shape any OpenAI-compatible endpoint
  speaks.
- **`helixChat`** serves the Helix platform's own provider-neutral `/_api/llm/chat` route and is not
  OpenAI-compatible. The wire shape is different too — a flat `{ model, content, stopReason, usage }`
  body rather than an OpenAI `choices` array, and a system message becomes a top-level `system` field
  rather than a message in the array.

Both satisfy the same `ChatClient` interface, so `singleShotExtractor` (and every strategy built on
top of it) is written against the interface and never against either transport's wire shape. Which
one a host constructs is a deployment choice, not a code branch.

```ts
import { singleShotExtractor, openAiChat } from "@azx/ribo-extractor-openai";

const extractor = singleShotExtractor({
  target: { name: "contact", extractionSchema, instructions: "Extract the caller's details." },
  chat: openAiChat({ apiKey, baseUrl }),
  model: "gpt-4o-mini",
});
```

A real target schema does not fit through one call, though — `singleShotExtractor` alone is where a
real system of record's field count runs into a structured-output API's own limits.
[Schema at Scale](/guide/schema-at-scale) is the full mechanism for how this package's other
exports — `splitExtractionSchema`, `perGroupExtractor`, `instanceLadder`, `gapFillExtractor` — get a
real schema through in several calls instead of one; this page does not restate it. The package also
ships two wrappers that sit around any base extractor: `schemaRetryExtractor` catches a
`SchemaParseError` and re-asks the model once, telling it in-band what failed validation (see
[Arbitration & Fallback](/guide/arbitration) for why that error is retryable and recognisable), and
`gapFillExtractor` makes one bounded follow-up call over leaves that abstained despite quoting
evidence. Where those wrappers shine per group rather than over the whole schema is
[Per-Group Composition](/guide/per-group).

### `@azx/ribo-extractor-ondevice`: `threePhaseExtractor`

`threePhaseExtractor` runs the same `Extractor<F>` seam over the platform's on-device Language
Model instead of a managed endpoint — no network once the model is available. It makes three
distinct calls per group — presence, span, and classify — not a single-shot call split into three
retries: a single combined call produced a degenerate whitespace-repetition failure mode on this
model class that retrying the same call could never fix. Splitting the ask brought on-device
source-span fidelity to 100% grounded. Like the managed extractors, it reads its schema from
`ExtractionTarget.extractionSchema` and knows nothing about any one host adapter.

## Extraction quality is not currently measured

**There is no current number for how often an extracted value is correct.** The
annotated corpus this repo's acceptance gate would score against
(`spikes/extraction-snuggpro/ground-truth/`) is written in a field vocabulary the Snugg Pro adapter
no longer uses, so `packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts` deliberately refuses
to emit a score against it rather than publish one that no longer means anything. Every citation
figure elsewhere in these docs — the 37%/14-of-14 numbers in [Provenance](/guide/provenance), the
per-group call counts in [Schema at Scale](/guide/schema-at-scale) — is a measurement of _citation
fidelity_: whether a quoted span is really in the source. None of it says whether the value beside
that span is the right one. See [Extraction: Measured](/deep-dives/accuracy) for the last run
recorded before the gate started refusing, kept as a worked example of how the gate scores a
transcript, not as a claim about current accuracy.

## Next

[Arbitration & Fallback](/guide/arbitration) covers composing more than one of the extractors above
into a strategy ladder, a race, or a capability-selected roster.
[Schema at Scale](/guide/schema-at-scale) covers partitioning a real schema across calls,
[Per-Group Composition](/guide/per-group) covers giving one group its own extractor once it is
partitioned, and [Provenance](/guide/provenance) covers the envelope every one of these extractors
fills in.
