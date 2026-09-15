import type { RxStorage } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { afterEach, expect, test } from "vitest";

import type { DocumentCapture } from "../capture-item.js";
import { FakeExtractor, toSessionExtractStep } from "../extractor.js";
import { isSpanGrounded } from "../provenance.js";
import { createDefaultTranscriptCombiner } from "../transcript-combiner.js";
import type { Recording } from "../recording.js";
import { removeOutboxDatabase } from "./database.js";
import { openOutbox, type Outbox } from "./outbox.js";
import { joinSessionTranscript, listSessionTranscriptParts } from "./session-extract.js";

// The premise the whole document-transcription tranche rests on.
//
// Scoping that work to the capture → transcribe half was justified by one
// claim: everything from `extracted` onward already speaks TEXT, so extraction,
// review and write need no change to accept a PDF. `joinSessionTranscript`
// reads only `status`, `seq` and `transcript.text` — it never touches
// `recording.kind`, `durationMs` or the mime type — so the claim holds by
// construction.
//
// "By construction" is exactly the kind of property that stops being true
// without anyone noticing. These tests pin it. They PASS against the code as
// written (they are a fence, not a must-fail), which is why each was verified
// by mutation: filtering `joinSessionTranscript` on `kind === "audio"` turns
// the first two red, and dropping the page markers from the joined text turns
// the third red.

const opened: { outbox: Outbox; name: string; storage: RxStorage<unknown, unknown> }[] = [];

afterEach(async () => {
  for (const { outbox, name, storage } of opened.splice(0)) {
    if (!outbox.closed) await outbox.close();
    await removeOutboxDatabase(name, storage);
  }
});

async function freshOutbox(): Promise<Outbox> {
  const storage = getRxStorageMemory();
  const name = `ribo-session-extract-${crypto.randomUUID()}`;
  const outbox = await openOutbox({ name, storage });
  opened.push({ outbox, name, storage });
  return outbox;
}

const bytes = (): Blob => new Blob([new Uint8Array(8)], { type: "application/pdf" });

const document = (id: string): DocumentCapture => ({
  kind: "document",
  id,
  capturedAt: "2026-09-09T10:00:00.000Z",
  pageCount: 2,
  mimeType: "application/pdf",
  ctx: { jobId: "job-7" },
});

const dictation = (id: string): Recording => ({
  kind: "audio",
  id,
  capturedAt: "2026-09-09T10:05:00.000Z",
  durationMs: 4200,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
});

/** The shape a real pdf.js transcript has: page markers around each page's text. */
const INVOICE_TEXT =
  "\n===== PAGE 1 =====\nInvoice # 58534\nP.O. Number 153787\n" +
  "\n===== PAGE 2 =====\nINSTALLATION Installation / Service Work 1EA 17,087.70\n";

test("a document's transcript reaches session extraction like any other", async () => {
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const item = await outbox.enqueue({
    recording: document("doc-1"),
    audio: bytes(),
    sessionId: session.id,
  });
  await outbox.writeTranscript(
    item.id,
    { recordingId: "doc-1", text: INVOICE_TEXT, engine: "pdfjs" },
    { status: "transcribed" },
  );

  const joined = await joinSessionTranscript(outbox, session.id);

  expect(joined.recordingIds).toEqual([item.id]);
  expect(joined.text).toContain("Invoice # 58534");
});

test("a session mixing a document and a dictation joins both, in capture order", async () => {
  // The session is the unit of extraction, and nothing says its members must be
  // the same medium. A PDF submitted alongside the walkthrough dictation is the
  // driving use case, so the ordering guarantee has to hold across kinds.
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const first = await outbox.enqueue({
    recording: document("doc-1"),
    audio: bytes(),
    sessionId: session.id,
  });
  const second = await outbox.enqueue({
    recording: dictation("rec-1"),
    audio: bytes(),
    sessionId: session.id,
  });

  await outbox.writeTranscript(
    first.id,
    { recordingId: "doc-1", text: INVOICE_TEXT, engine: "pdfjs" },
    { status: "transcribed" },
  );
  await outbox.writeTranscript(
    second.id,
    { recordingId: "rec-1", text: "the attic insulation is R-19", engine: "fake" },
    { status: "transcribed" },
  );

  const joined = await joinSessionTranscript(outbox, session.id);

  expect(joined.text).toContain("Invoice # 58534");
  expect(joined.text).toContain("R-19");
  // Capture order, by `seq` — the document was enqueued first.
  expect(joined.text.indexOf("Invoice # 58534")).toBeLessThan(joined.text.indexOf("R-19"));
});

test("page markers survive into the extractor's input", async () => {
  // The markers exist so a value can be attributed to the page it came from,
  // which matters when a document contradicts itself. That is only true if they
  // are still there by the time the model sees the text — every layer between
  // `transcribe` and `extract` is a chance to normalise them away.
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const item = await outbox.enqueue({
    recording: document("doc-1"),
    audio: bytes(),
    sessionId: session.id,
  });
  await outbox.writeTranscript(
    item.id,
    { recordingId: "doc-1", text: INVOICE_TEXT, engine: "pdfjs" },
    { status: "transcribed" },
  );

  const extractor = new FakeExtractor({ invoiceNumber: "58534" });
  const step = toSessionExtractStep(extractor);
  const joined = await joinSessionTranscript(outbox, session.id);

  await step({
    session,
    transcript: { text: joined.text, annotations: {} },
    recordingIds: joined.recordingIds,
  });

  expect(extractor.calls).toHaveLength(1);
  expect(extractor.calls[0]!.text).toContain("===== PAGE 1 =====");
  expect(extractor.calls[0]!.text).toContain("===== PAGE 2 =====");
});

// ---------------------------------------------------------------------------
// Per-capture attribution markers
// ---------------------------------------------------------------------------
//
// Attribution today is per-session: the joined transcript is one undifferentiated
// string, so a model cannot cite which capture a value came from, and a human
// reviewing a flagged field cannot be shown the source. The page markers inside
// a document's own text are the existing precedent for the fix — a marker in the
// text is what gives the model something to cite.
//
// `joinSessionTranscript(outbox, sessionId, { markCaptures: true })` delimits
// each capture's text with a per-capture marker in the page-marker family
// (`\n===== CAPTURE seq:N kind:K id:I =====\n`). The option defaults to off so
// existing callers see the same text they always have. These tests were verified
// by mutation: dropping the marker prefix turns the first red, unconditionally
// emitting markers turns the second red, and modifying the transcript text
// (uppercasing it) turns the third red — `isSpanGrounded` is verbatim and
// case-sensitive, so the marker must sit beside the text, not alter it.

test("per-capture markers delimit each capture's text when markCaptures is true", async () => {
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const first = await outbox.enqueue({
    recording: document("doc-1"),
    audio: bytes(),
    sessionId: session.id,
  });
  const second = await outbox.enqueue({
    recording: dictation("rec-1"),
    audio: bytes(),
    sessionId: session.id,
  });

  await outbox.writeTranscript(
    first.id,
    { recordingId: "doc-1", text: INVOICE_TEXT, engine: "pdfjs" },
    { status: "transcribed" },
  );
  await outbox.writeTranscript(
    second.id,
    { recordingId: "rec-1", text: "the attic insulation is R-19", engine: "fake" },
    { status: "transcribed" },
  );

  const joined = await joinSessionTranscript(
    outbox,
    session.id,
    createDefaultTranscriptCombiner({ markCaptures: true }),
  );

  // Each capture is preceded by a marker in the page-marker family.
  expect(joined.text).toContain("===== CAPTURE");
  // The marker carries the seq, kind, and outbox item id — what a consumer
  // needs to resolve a citation back to a row via `outbox.get(id)`.
  expect(joined.text).toContain("seq:0");
  expect(joined.text).toContain("kind:document");
  expect(joined.text).toContain(`id:${first.id}`);
  expect(joined.text).toContain("seq:1");
  expect(joined.text).toContain("kind:audio");
  expect(joined.text).toContain(`id:${second.id}`);
  // The capture's own text still follows its marker.
  expect(joined.text).toContain("Invoice # 58534");
  expect(joined.text).toContain("R-19");
  // Capture order is preserved: the document marker precedes the dictation marker.
  expect(joined.text.indexOf("kind:document")).toBeLessThan(joined.text.indexOf("kind:audio"));
});

test("per-capture markers are absent by default", async () => {
  // The option defaults to off so existing callers see the same text they
  // always have — changing what every extractor sees unconditionally is a
  // risk the caller should opt into.
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const item = await outbox.enqueue({
    recording: dictation("rec-1"),
    audio: bytes(),
    sessionId: session.id,
  });
  await outbox.writeTranscript(
    item.id,
    { recordingId: "rec-1", text: "the attic insulation is R-19", engine: "fake" },
    { status: "transcribed" },
  );

  const joined = await joinSessionTranscript(outbox, session.id);

  expect(joined.text).not.toContain("===== CAPTURE");
  expect(joined.text).toBe("the attic insulation is R-19");
});

test("span grounding survives per-capture markers", async () => {
  // `isSpanGrounded` checks extracted spans against this joined text. The
  // markers are added AROUND each capture's text, not inside it, so a
  // verbatim quote from within a single capture remains a substring. This is
  // the non-negotiable constraint: whatever we add must not break grounding
  // for values that were already groundable.
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const first = await outbox.enqueue({
    recording: document("doc-1"),
    audio: bytes(),
    sessionId: session.id,
  });
  const second = await outbox.enqueue({
    recording: dictation("rec-1"),
    audio: bytes(),
    sessionId: session.id,
  });

  await outbox.writeTranscript(
    first.id,
    { recordingId: "doc-1", text: INVOICE_TEXT, engine: "pdfjs" },
    { status: "transcribed" },
  );
  await outbox.writeTranscript(
    second.id,
    { recordingId: "rec-1", text: "the attic insulation is R-19", engine: "fake" },
    { status: "transcribed" },
  );

  const joined = await joinSessionTranscript(
    outbox,
    session.id,
    createDefaultTranscriptCombiner({ markCaptures: true }),
  );

  // A verbatim quote from within the dictation's text is still grounded.
  expect(isSpanGrounded("the attic insulation is R-19", joined.text)).toBe(true);
  // A verbatim quote from within the document's text is still grounded.
  expect(isSpanGrounded("Invoice # 58534", joined.text)).toBe(true);
  // A quote that does not appear is still not grounded.
  expect(isSpanGrounded("R-38 blown cellulose", joined.text)).toBe(false);
});

test("per-capture markers survive into the extractor's input", async () => {
  // The markers exist so a model can attribute a value to the capture it came
  // from. That is only true if they reach the model — every layer between
  // `joinSessionTranscript` and the extractor's call is a chance to strip them.
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const first = await outbox.enqueue({
    recording: document("doc-1"),
    audio: bytes(),
    sessionId: session.id,
  });
  const second = await outbox.enqueue({
    recording: dictation("rec-1"),
    audio: bytes(),
    sessionId: session.id,
  });

  await outbox.writeTranscript(
    first.id,
    { recordingId: "doc-1", text: INVOICE_TEXT, engine: "pdfjs" },
    { status: "transcribed" },
  );
  await outbox.writeTranscript(
    second.id,
    { recordingId: "rec-1", text: "the attic insulation is R-19", engine: "fake" },
    { status: "transcribed" },
  );

  const extractor = new FakeExtractor({ invoiceNumber: "58534" });
  const step = toSessionExtractStep(extractor);
  const joined = await joinSessionTranscript(
    outbox,
    session.id,
    createDefaultTranscriptCombiner({ markCaptures: true }),
  );

  await step({
    session,
    transcript: { text: joined.text, annotations: {} },
    recordingIds: joined.recordingIds,
  });

  expect(extractor.calls).toHaveLength(1);
  expect(extractor.calls[0]!.text).toContain("===== CAPTURE");
  expect(extractor.calls[0]!.text).toContain("kind:document");
  expect(extractor.calls[0]!.text).toContain("kind:audio");
});

// ---------------------------------------------------------------------------
// Collision rule: a transcriber annotation named `seq` coexists with `capture.seq`.
//
// The relay writes `capture.seq`, `capture.kind`, and `capture.id` from outbox
// row metadata. A transcriber might reasonably use `seq` (or `kind` or `id`) as
// its own annotation key. Namespacing under `capture.` is the rule that prevents
// a collision: both keys live in the same bag, and the transcriber's value is
// independent of the relay's.
// ---------------------------------------------------------------------------

test("a transcriber annotation named seq coexists with the relay's capture.seq", async () => {
  const outbox = await freshOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const item = await outbox.enqueue({
    recording: dictation("rec-1"),
    audio: bytes(),
    sessionId: session.id,
  });

  // The transcriber uses `seq` — the exact generic name the plan flags as
  // plausible. It also uses `id` and `kind` for good measure.
  await outbox.writeTranscript(
    item.id,
    {
      recordingId: "rec-1",
      text: "the attic is R-19",
      engine: "fake",
      annotations: { seq: "page-1", id: "doc-abc", kind: "invoice" },
    },
    { status: "transcribed" },
  );

  const { parts } = await listSessionTranscriptParts(outbox, session.id);

  expect(parts).toHaveLength(1);

  // The transcriber's values are at the top level, untouched.
  expect(parts[0]?.annotations["seq"]).toBe("page-1");
  expect(parts[0]?.annotations["id"]).toBe("doc-abc");
  expect(parts[0]?.annotations["kind"]).toBe("invoice");

  // The relay's values are namespaced under `capture.` and coexist.
  expect(parts[0]?.annotations["capture.seq"]).toBe(item.seq);
  expect(parts[0]?.annotations["capture.kind"]).toBe("audio");
  expect(parts[0]?.annotations["capture.id"]).toBe(item.id);
});
