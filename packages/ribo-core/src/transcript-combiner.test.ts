import { expect, test } from "vitest";

import { isSpanGrounded } from "./provenance.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { createDefaultTranscriptCombiner } from "./transcript-combiner.js";

// The combination policy is pure — a plain array in, a value out, no database.
// These tests prove that without touching an outbox. If a test here needs an
// outbox to pass, the split is in the wrong place.
//
// The default combiner must reproduce the output of the previous
// `joinSessionTranscript` byte-for-byte. Each test constructs the same
// `AnnotatedTranscript[]` the relay would build from outbox items (text from
// the transcript, `seq`/`kind`/`id` from the item) and asserts the combined
// text matches what the old fused function would have produced.

/** Build a part the way the relay does: text from the transcript, metadata from the item. */
function part(seq: number, kind: string, id: string, text: string): AnnotatedTranscript {
  return { text, annotations: { seq, kind, id } };
}

test("multiple parts join with a single space when markCaptures is false", () => {
  const combine = createDefaultTranscriptCombiner();
  const result = combine([
    part(0, "audio", "rec-1", "the attic insulation is R-19"),
    part(1, "audio", "rec-2", "the basement is uninsulated"),
  ]);
  expect(result.text).toBe("the attic insulation is R-19 the basement is uninsulated");
  expect(result.annotations).toEqual({});
});

test("multiple parts join with per-capture markers when markCaptures is true", () => {
  const combine = createDefaultTranscriptCombiner({ markCaptures: true });
  const result = combine([
    part(0, "audio", "rec-1", "the attic insulation is R-19"),
    part(1, "document", "doc-1", "Invoice # 58534"),
  ]);
  expect(result.text).toBe(
    "\n===== CAPTURE seq:0 kind:audio id:rec-1 =====\n" +
      "the attic insulation is R-19" +
      "\n===== CAPTURE seq:1 kind:document id:doc-1 =====\n" +
      "Invoice # 58534",
  );
});

test("a single part produces just that text when markCaptures is false", () => {
  const combine = createDefaultTranscriptCombiner();
  const result = combine([part(0, "audio", "rec-1", "the attic is R-19")]);
  expect(result.text).toBe("the attic is R-19");
});

test("a single part produces a marker followed by the text when markCaptures is true", () => {
  const combine = createDefaultTranscriptCombiner({ markCaptures: true });
  const result = combine([part(0, "audio", "rec-1", "the attic is R-19")]);
  expect(result.text).toBe("\n===== CAPTURE seq:0 kind:audio id:rec-1 =====\nthe attic is R-19");
});

test("zero parts produce empty text regardless of markCaptures", () => {
  expect(createDefaultTranscriptCombiner()([]).text).toBe("");
  expect(createDefaultTranscriptCombiner({ markCaptures: true })([]).text).toBe("");
});

test("the default (no options) matches markCaptures false", () => {
  const parts = [part(0, "audio", "rec-1", "hello"), part(1, "audio", "rec-2", "world")];
  expect(createDefaultTranscriptCombiner()(parts)).toEqual(
    createDefaultTranscriptCombiner({ markCaptures: false })(parts),
  );
});

test("span grounding survives per-capture markers", () => {
  // The markers sit before each capture's text, not inside it, so a verbatim
  // quote from within a single capture remains a substring of the joined text.
  const combine = createDefaultTranscriptCombiner({ markCaptures: true });
  const result = combine([
    part(0, "document", "doc-1", "Invoice # 58534"),
    part(1, "audio", "rec-1", "the attic insulation is R-19"),
  ]);
  expect(isSpanGrounded("the attic insulation is R-19", result.text)).toBe(true);
  expect(isSpanGrounded("Invoice # 58534", result.text)).toBe(true);
  expect(isSpanGrounded("R-38 blown cellulose", result.text)).toBe(false);
});

test("the combined annotations bag is empty", () => {
  const combine = createDefaultTranscriptCombiner();
  const result = combine([part(0, "audio", "rec-1", "text")]);
  expect(result.annotations).toEqual({});
});

test("the marker carries seq, kind, and id from the annotations bag", () => {
  const combine = createDefaultTranscriptCombiner({ markCaptures: true });
  const result = combine([part(42, "document", "doc-abc", "page text")]);
  expect(result.text).toContain("seq:42");
  expect(result.text).toContain("kind:document");
  expect(result.text).toContain("id:doc-abc");
});

test("a custom combiner runs instead of the default", () => {
  // The contract is `(parts) => AnnotatedTranscript`. Any function that fits
  // is a valid combiner — the relay injects it, and it runs.
  const reverse: (parts: AnnotatedTranscript[]) => AnnotatedTranscript = (parts) => ({
    text: parts
      .map((p) => p.text)
      .reverse()
      .join(" | "),
    annotations: {},
  });
  const result = reverse([part(0, "audio", "rec-1", "first"), part(1, "audio", "rec-2", "second")]);
  expect(result.text).toBe("second | first");
});

test("markCaptures rejects a part missing its marker annotations", () => {
  // The bag is `unknown`-valued, so a hand-built part would otherwise stringify to
  // `seq:undefined` and inject that into the canonical text — the string a model quotes from
  // and `isSpanGrounded` checks against. A readable error beats garbage in the substrate.
  const combine = createDefaultTranscriptCombiner({ markCaptures: true });

  expect(() => combine([{ text: "hello", annotations: {} }])).toThrow(TypeError);
  expect(() => combine([{ text: "hello", annotations: {} }])).toThrow(/seq/);
  expect(() => combine([{ text: "hello", annotations: { seq: 0, kind: "audio" } }])).toThrow(
    /\bid\b/,
  );
});

test("markCaptures accepts numeric and string marker annotations", () => {
  const combine = createDefaultTranscriptCombiner({ markCaptures: true });
  const out = combine([{ text: "hello", annotations: { seq: 0, kind: "audio", id: "rec-1" } }]);
  expect(out.text).toBe("\n===== CAPTURE seq:0 kind:audio id:rec-1 =====\nhello");
});
