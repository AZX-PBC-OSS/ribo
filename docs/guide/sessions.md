# Sessions

A heat-pump quote reviewer walks into a job with an invoice PDF from a supplier, an ACCA Manual J
load-calculation report, and their own dictated notes on what they saw on site. All three belong to
one job. None of them, alone, is the thing to extract from — the invoice has the equipment cost, the
Manual J has the sizing, and the dictation has the corrections and exceptions a form never captures.
A **session** holds all three and extracts across them once.

## Extraction lives on the session, not the recording

[Captures & Sources](/guide/captures-and-sources) covers `CapturePayload` and the recording queue that
transcribes it. That queue's own state machine is short and ends early:

```
recording → queued → transcribing → transcribed
```

Once a recording reaches `transcribed`, the relay is finished with it. `transcribed` is deliberately
**not** an active status — nothing about extraction, review, or write happens to a recording at all.
The session's state machine is where that begins:

```
open → extracting → awaiting-review → writing → done
```

The split is structural, enforced in two places at once:

- **The type system.** `Extractor` takes an annotated transcript — one canonical text plus an
  annotations bag — and returns fields; it has no parameter that could carry a `CapturePayload`, so it
  cannot know or care whether that text came from a microphone or a PDF. `isSpanGrounded` checks a
  `sourceSpan` against the transcript's text the same way regardless of source. The review contract
  addresses leaf paths against a values schema; it has never seen a `Recording` or a
  `DocumentCapture`, only the joined transcript that produced the fields it's reviewing.
- **The persistence layer.** `CaptureDocument` (the recording) carries capture and transcription
  fields only. `SessionDocument` carries `extracted`, `extractedBy`, `reviewOutcome`, `writeResult`,
  and the write destination `ctx` — every field the pipeline touches from extraction onward moved
  here in schema v6, off the recording entirely.

That's why adding PDF support required **no change** to `Extractor`, `isSpanGrounded`, arbitration,
or the review contract. That code was written against session-level text; a document capture is a
second way to produce it.

## Many captures, one transcript: the combiner contract

A session's transcript isn't stored — it's assembled on demand from every recording that belongs to
it, in two pieces with one seam between them.

The I/O half is `listSessionTranscriptParts`, which lists the session's `transcribed` recordings in
capture order (`seq`-ascending), excluding `discarded` and `dead`, and builds an
`AnnotatedTranscript` per capture. A recording still `queued` or `transcribing` simply isn't there
yet, and a **`discarded` recording is excluded outright**: if the reviewer decides a capture
shouldn't count — a duplicate dictation, a photo of the wrong invoice — discarding it removes its
words from every future extraction without deleting the recording itself:

```ts
import { listSessionTranscriptParts } from "@azx/ribo-core";

const { parts, recordingIds } = await listSessionTranscriptParts(storage, session.id);
```

Each part carries that capture's text and an annotations bag merging two sources: whatever the
transcriber itself produced (a document engine's page markers, a provider's own structured
response), plus the relay's capture metadata — `capture.seq`, `capture.kind`, `capture.id` — under
a reserved `capture.` prefix, so a transcriber's own `seq` or `id` cannot collide with it. The
`recordingIds` are the sorted capture ids that produced the parts — the cache key a re-extraction
compares against to know whether the recording set actually changed.

The policy half is `TranscriptCombiner` — a **pure** function that takes the parts and returns one
transcript:

```ts
import { createDefaultTranscriptCombiner } from "@azx/ribo-core";

// types: type TranscriptCombiner<In, Out> =
//   (parts: readonly AnnotatedTranscript<In>[]) => AnnotatedTranscript<Out>;
const combiner = createDefaultTranscriptCombiner();
```

Purity is the contract's point: a combiner that takes the `Storage`, or reads anything, reproduces
the defect this seam exists to fix — the old fused implementation could not be tested
without a database and could not be replaced at all. The relay supplies the array; the combiner
decides how the texts join. A caller who wants a different policy writes their own combiner
instead of asking for a second flag on the default, and injects it through
`RelayOptions.combineTranscripts`:

```ts
import { createRelay, createDefaultTranscriptCombiner } from "@azx/ribo-core";

const relay = createRelay({
  // ...
  combineTranscripts: createDefaultTranscriptCombiner({ markCaptures: true }),
});
```

The default combiner joins the texts with a single space — byte-for-byte what this page has always
described. Pass `{ markCaptures: true }` to get **per-capture attribution markers** woven in, one
line ahead of each capture's content:

```
===== CAPTURE seq:1 kind:document id:cap-invoice =====
…invoice text…
===== CAPTURE seq:2 kind:document id:cap-manualj =====
…Manual J text…
===== CAPTURE seq:3 kind:audio id:cap-dictation =====
…dictated notes…
```

Each marker carries `seq` (capture order, for a reviewer's "the third one"), `kind` (`audio` or
`document`, no row lookup needed), and `id` (the capture id a citation can resolve straight back
to), with its values read from the part's `capture.`-namespaced annotations. The marker sits before
a capture's text, never inside it, so a `sourceSpan` the model quotes from within one capture still
passes `isSpanGrounded` as a verbatim substring of the joined text.
Marking is off by default — the joined text a non-marked caller sees is unchanged — because
emitting markers unconditionally would change
what every existing extractor sees.

`joinSessionTranscript` is the convenience that does both — list the parts, hand them to a combiner
(its optional third parameter, defaulting to the unmarked default) — and returns just the joined
`text` plus the `recordingIds` cache key. It is the older, I/O-fused face of the same seam; the
relay itself uses `listSessionTranscriptParts` and a combiner, and a host replacing the policy
injects one through `combineTranscripts` rather than forking the I/O.

One thing annotations deliberately do not do is **survive combination**: the combiner returns one
transcript with its own bag, and the default returns an empty one. Per-part annotations are an input
to combination, not a channel through it — state that has to reach an extractor from a transcriber
belongs in [plugin storage](/guide/plugin-storage), which is keyed by capture and survives both the
combine step and a reload.

## The session lifecycle

```ts
import { openStorage } from "@azx/ribo-core";

const storage = await openStorage({/* … */});

// The auditor arrives on site. Open the session before anything is captured.
const session = await storage.sessions.open({ ctx: jobCtx, ref: "job-4471" });

// Recordings and document captures enqueue into it as they're captured —
// the invoice photographed, the Manual J scanned, the dictation recorded.
// The relay transcribes each one; the session itself does not move.

// The auditor is done walking the house.
const closed = await storage.sessions.close(session.id);
// closed.status === "extracting" — the relay picks it up on its next drain.
```

`storage.sessions.close` is the host's explicit signal that the capture set is final — the relay transcribes a
session's recordings as they arrive, but **does not act on the session itself until the host closes
it**. `open` is not an active status for that reason: the relay has no way to know an auditor is done
adding captures except being told, and starting extraction on a partially-assembled session would be
extracting the wrong set.

Once closed, the relay runs session-level extraction against the joined transcript and lands the
session at `awaiting-review` — parked, same as the recording side, until a human looks. The only way
out is a review submission
([`storage.sessions.submitReview`](/guide/review#the-gate-is-a-session-status-not-a-callback)); nothing about
the pipeline advances a parked session on its own. Review is where the reviewer sees every field from
all three captures at once, each still traceable to whichever capture actually said it. Once a
decision is submitted, the session moves to `writing` and, eventually, `done` — or, if a step fails
along the way, to `failed`, which the relay retries on its own once its backoff elapses. `dead` is
the only status with no automatic way out — reached once retries are exhausted — and even from there
(or from `done`) a human can bring the session back to `awaiting-review` with
[`storage.sessions.reopenForReview`](/guide/review#the-gate-is-a-session-status-not-a-callback) if something
needs correcting later.

Watch sessions live rather than poll them:

```ts
storage.sessions.watch({ status: "awaiting-review" }).subscribe((sessions) => {
  // re-renders whenever a session enters or leaves review — including a write
  // from another tab.
});
```

## The worked example, end to end

The heat-pump quote reviewer's job opens as one session. The supplier invoice and the Manual J
report enqueue as `DocumentCapture` items — `pdfjs` (or `managed-docs` for a scanned page it can't
read) transcribes each into text. The reviewer's own dictation enqueues as a `Recording`,
transcribed by whichever audio engine is configured, and all three transcribe independently, on
their own schedule, into the same session. When the reviewer closes the session, the relay lists
the three transcripts and hands them to its combiner — one transcript spanning all three —
extraction runs once against it, and the review screen shows a single set of fields — equipment
cost from the invoice, sizing from the Manual J, the exception the reviewer dictated — each
citation still checkable against whichever capture it came from.

**API pages:** [`CaptureSession`](/api/capture-session) — the recording lifecycle this page
lectures about, plus `recoverInterrupted`, with the `CaptureSession`/`CaptureHealth` surface.

## Next

[Provenance](/guide/provenance) covers what a session's extracted fields look like once they exist —
the envelope, the span check, and the granularity knob. [Schema at Scale](/guide/schema-at-scale)
covers why a session's extraction has to be partitioned across several calls once the target schema
is a real system of record's, and [Per-Group Composition](/guide/per-group) covers what to do when
one of those groups needs different treatment from the rest.
