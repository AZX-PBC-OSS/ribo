import { expect, test } from "vitest";

import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { isSpanGrounded } from "./provenance.js";

test("a span still grounds against t.text exactly as before", () => {
  const t: AnnotatedTranscript = {
    text: "the attic insulation is R-19",
    annotations: {},
  };
  expect(isSpanGrounded("R-19", t.text)).toBe(true);
  expect(isSpanGrounded("R-50", t.text)).toBe(false);
  expect(isSpanGrounded(null, t.text)).toBe(false);
  expect(isSpanGrounded("", t.text)).toBe(false);
});

test("an annotation rides through a transcript without affecting grounding", () => {
  const t: AnnotatedTranscript = {
    text: "the attic insulation is R-19",
    annotations: { pages: [{ start: 0, end: 10 }], engine: "managed-docs" },
  };
  // Grounding reads text only — annotations are invisible to it.
  expect(isSpanGrounded("R-19", t.text)).toBe(true);
  expect(isSpanGrounded("R-50", t.text)).toBe(false);
});
