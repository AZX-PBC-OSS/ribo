# Quick Start

This runs a capture through to a first extracted, span-checked field — with no credentials, no
network, and no model. `FakeTranscriber` and `FakeExtractor`, both exported from
`@azx/ribo-core`, stand in for the real engines so the whole pipeline is honest about what it
just did: nothing was actually transcribed or extracted, but every seam ran for real.

```ts
import { z } from "zod";
import {
  baseRecordingSchema,
  enveloped,
  FakeExtractor,
  FakeTranscriber,
  isSpanGrounded,
} from "@azx/ribo-core";

// 1. A capture arrives. No microphone here — a bare `Recording` record stands in for one.
const recording = baseRecordingSchema.parse({
  id: "rec-1",
  capturedAt: new Date().toISOString(),
  mimeType: "audio/webm",
  durationMs: 4_000,
  ctx: {},
});

// 2. Transcribe. `FakeTranscriber` returns canned text instead of running a model.
const transcriber = new FakeTranscriber({
  text: "Jordan Lee from Acme Robotics called about renewing the contract.",
});
const transcript = await transcriber.transcribe(recording, new Blob());

// 3. Declare the values a host writes back. Four leaves — small enough to read at a glance.
const contactSchema = z.object({
  name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  followUpDate: z.string().nullable().optional(),
});

// 4. Derive the extraction schema from it. Every leaf gains { value, confidence, sourceSpan }.
const extractionSchema = enveloped(contactSchema);

// 5. Extract. A real engine would call a model and return this same shape; `FakeExtractor`
//    returns it directly, so this runs with no key and no network. `followUpDate` is an
//    explicit null — the model (fake or real) must say "not stated," never omit the key.
const extractor = new FakeExtractor(
  extractionSchema.parse({
    name: { value: "Jordan Lee", confidence: 1, sourceSpan: "Jordan Lee" },
    company: { value: "Acme Robotics", confidence: 1, sourceSpan: "Acme Robotics" },
    reason: { value: "renewing the contract", confidence: 1, sourceSpan: "renewing the contract" },
    followUpDate: { value: null, confidence: 1, sourceSpan: null },
  }),
);
const { fields } = await extractor.extract(transcript.text);

// 6. Check a field. `isSpanGrounded` confirms the quote is actually in the transcript —
//    the same check a review screen runs before showing a field as trustworthy.
isSpanGrounded(fields.name.sourceSpan, transcript.text); // true
isSpanGrounded(fields.reason.sourceSpan, transcript.text); // true
```

Paste this into a `.ts` file in a project with `zod` and `@azx/ribo-core` installed (see
[Installation](/guide/installation)) and it runs as written.

## Swapping in a real engine

`FakeExtractor` and a real extractor both satisfy the same `Extractor` contract, so nothing above
it — the schema, `enveloped()`, the `isSpanGrounded` check — changes when you swap one in. Only
the construction line does. `@azx/ribo-extractor-openai`'s `singleShotExtractor` builds one
against an OpenAI-compatible chat endpoint:

```ts
import { singleShotExtractor, openAiChat } from "@azx/ribo-extractor-openai";

const extractor = singleShotExtractor({
  target: { name: "contact", extractionSchema, instructions: "Extract the caller's details." },
  chat: openAiChat({ apiKey, baseUrl }),
  model: "gpt-4o-mini",
});
```

`target` is the field knowledge an extractor needs — the same `extractionSchema` from step 4,
plus a name and instructions. A `ToolAdapter` supplies this already, so a real host wires its
adapter straight in rather than building a `target` literal by hand.

## Next

Swapping `FakeTranscriber` for a real engine, wiring both into the durable outbox, and getting a
result to a review screen is [The Core Loop](/guide/core-loop).
