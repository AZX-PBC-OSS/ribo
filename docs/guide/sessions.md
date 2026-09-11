# Sessions

A heat-pump quote reviewer walks into a job with an invoice PDF from a supplier, an ACCA Manual J
load-calculation report, and their own dictated notes on what they saw on site. All three belong to
one job. None of them, alone, is the thing to extract from — the invoice has the equipment cost, the
Manual J has the sizing, and the dictation has the corrections and exceptions a form never captures.
A **session** is what holds all three together and extracts across them once, and this page is
about why that's a real architectural line and not a naming convenience.

## Extraction lives on the session, not the recording

[Captures & Sources](/guide/captures-and-sources) covers `CaptureItem` and the recording queue that
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

This isn't a stylistic choice about which object owns which field. It's a structural split, enforced
in two places at once:

- **The type system.** `Extractor` takes a transcript's text and returns fields — it has no
  parameter that could carry a `CaptureItem`, so it cannot know or care whether that text came from
  a microphone or a PDF. `isSpanGrounded` checks a `sourceSpan` against transcript text the same
  way regardless of source. The review contract addresses leaf paths against a values schema; it
  has never seen a `Recording` or a `DocumentCapture`, only the joined text that produced the
  fields it's reviewing.
- **The persistence layer.** `OutboxDocument` (the recording) carries capture and transcription
  fields only. `SessionDocument` carries `extracted`, `extractedBy`, `reviewOutcome`, `writeResult`,
  and the write destination `ctx` — every field the pipeline touches from extraction onward moved
  here in schema v6, off the recording entirely.

That's why adding PDF support required **no change** to `Extractor`, `isSpanGrounded`, arbitration,
or the review contract. None of that code was ever coupled to what produced the transcript in the
first place — it was already written against session-level text, and a document capture just became
a second way to produce some.

## `joinSessionTranscript`: many captures, one transcript

A session's transcript isn't stored — it's assembled on demand from every recording that belongs to
it:

```ts
import { joinSessionTranscript } from "@azx/ribo-core";

const { text, recordingIds } = await joinSessionTranscript(outbox, session.id);
```

It returns exactly two things: the joined `text`, and the sorted `recordingIds` that produced it —
the cache key a re-extraction compares against to know whether the recording set actually changed.
Nothing in that return shape says whether any of it came from a microphone. That's the whole point:
the invoice PDF, the Manual J report, and the dictation are three captures of two different kinds,
and `joinSessionTranscript` joins all three into one `text` without ever needing to ask which was
which.

Only `transcribed` recordings are included, in capture order (`seq`-ascending) — a recording still
`queued` or `transcribing` simply isn't there yet, and **`discarded` recordings are excluded
outright**. If the reviewer decides a capture shouldn't count — a duplicate dictation, a photo of
the wrong invoice — discarding it removes its words from every future extraction without deleting
the recording itself.

Pass `{ markCaptures: true }` to get **per-capture attribution markers** woven into the joined text,
one line ahead of each capture's content:

```
===== CAPTURE seq:1 kind:document id:cap-invoice =====
…invoice text…
===== CAPTURE seq:2 kind:document id:cap-manualj =====
…Manual J text…
===== CAPTURE seq:3 kind:audio id:cap-dictation =====
…dictated notes…
```

Each marker carries `seq` (capture order, for a reviewer's "the third one"), `kind` (`audio` or
`document`, no row lookup needed), and `id` (the outbox item id a citation can resolve straight back
to). The marker sits before a capture's text, never inside it, so a `sourceSpan` the model quotes
from within one capture still passes `isSpanGrounded` as a verbatim substring of the joined text.
Off by default — the joined text a non-marked caller sees is unchanged — because emitting markers
unconditionally would change what every existing extractor sees.

## The session lifecycle

```ts
import { openOutbox } from "@azx/ribo-core";

const outbox = await openOutbox({/* … */});

// The auditor arrives on site. Open the session before anything is captured.
const session = await outbox.openSession({ ctx: jobCtx, ref: "job-4471" });

// Recordings and document captures enqueue into it as they're captured —
// the invoice photographed, the Manual J scanned, the dictation recorded.
// The relay transcribes each one; the session itself does not move.

// The auditor is done walking the house.
const closed = await outbox.closeSession(session.id);
// closed.status === "extracting" — the relay picks it up on its next drain.
```

`closeSession` is the host's explicit signal that the capture set is final — the relay transcribes a
session's recordings as they arrive, but **does not act on the session itself until the host closes
it**. `open` is deliberately not an active status for exactly that reason: the relay has no way to
know an auditor is done adding captures except being told, and starting extraction on a
partially-assembled session would be extracting the wrong set.

Once closed, the relay runs session-level extraction against the joined transcript and lands the
session at `awaiting-review` — parked, same as the recording side, until a human looks. The only way
out is a review submission (`submitSessionReview`); nothing about the pipeline advances a parked
session on its own. Review is where the reviewer sees every field from all three captures at once,
each still traceable to whichever capture actually said it. Once a decision is submitted, the
session moves to `writing` and, eventually, `done` — or, if a step fails along the way, to `failed`,
which the relay retries on its own once its backoff elapses. `dead` is the only status with no
automatic way out — reached once retries are exhausted — and even from there (or from `done`) a
human can bring the session back to `awaiting-review` with `reopenSessionForReview` if something
needs correcting later.

Watch sessions live rather than poll them:

```ts
outbox.watchSessions({ status: "awaiting-review" }).subscribe((sessions) => {
  // re-renders whenever a session enters or leaves review — including a write
  // from another tab.
});
```

## The worked example, end to end

The heat-pump quote reviewer's job opens as one session. The supplier invoice and the Manual J
report enqueue as `DocumentCapture` items — `pdfjs` (or `managed-docs` for a scanned page it can't
read) transcribes each into text. The reviewer's own dictation enqueues as a `Recording`, transcribed
by whichever audio engine is configured. All three transcribe independently, on their own schedule,
into the same session. When the reviewer closes the session, `joinSessionTranscript` produces one
transcript spanning all three, extraction runs once against it, and the review screen shows a single
set of fields — equipment cost from the invoice, sizing from the Manual J, the exception the
reviewer dictated — each citation still checkable against whichever capture it came from. Nothing
about the extractor, the span check, or the review contract needed to know that two of the three
inputs were never audio at all.

## Next

[Provenance](/guide/provenance) covers what a session's extracted fields look like once they exist —
the envelope, the span check, and the granularity knob. [Schema at Scale](/guide/schema-at-scale)
covers why a session's extraction has to be partitioned across several calls once the target schema
is a real system of record's.
