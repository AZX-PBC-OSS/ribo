import { expect, test } from "vitest";

import { isPdfTextItem, type PdfContentItem, type PdfTransformMatrix } from "./config.js";

const matrix: PdfTransformMatrix = [10, 0, 0, 10, 396, 187];

const textItem: PdfContentItem = {
  str: "Subtotal",
  hasEOL: false,
  transform: matrix,
  width: 40,
  height: 10,
};

test("a text run narrows, and the narrowed type exposes its geometry", () => {
  expect(isPdfTextItem(textItem)).toBe(true);

  if (!isPdfTextItem(textItem)) throw new Error("unreachable");
  // The point of the union: after narrowing these need no `?? 0`.
  const x: number = textItem.transform[4];
  const y: number = textItem.transform[5];
  expect([x, y]).toEqual([396, 187]);
});

test("a marked-content boundary does not narrow", () => {
  // Before the union it mapped to `{ str: "", x: 0, y: 0 }` — a fabricated item
  // at the page origin that survived only because a whitespace filter dropped it.
  expect(isPdfTextItem({ type: "beginMarkedContent", id: "p1" })).toBe(false);
});

test("the guard tests for `str`, not for the absence of `type`", () => {
  // The documented reasoning, pinned. Discriminating on the ABSENCE of `type`
  // would make any future pdf.js item shape default to "this is text" and then
  // read geometry that is not there. Testing for `str` fails closed instead: an
  // unknown shape is simply not a text run.
  const unknownFutureShape = { type: "somethingNew", id: null } as PdfContentItem;
  expect(isPdfTextItem(unknownFutureShape)).toBe(false);

  // And a text run that also carried a `type` would still be text.
  const hybrid = { ...textItem, type: "beginMarkedContentProps" } as PdfContentItem;
  expect(isPdfTextItem(hybrid)).toBe(true);
});

test("the matrix is exactly six numbers", () => {
  // @ts-expect-error five elements is not a transform matrix
  const tooShort: PdfTransformMatrix = [1, 2, 3, 4, 5];
  // @ts-expect-error seven is not either
  const tooLong: PdfTransformMatrix = [1, 2, 3, 4, 5, 6, 7];

  // The directives above ARE the assertion; referencing them keeps the linter
  // from removing what looks like dead code and taking the assertions with it.
  expect([tooShort, tooLong]).toHaveLength(2);
});
