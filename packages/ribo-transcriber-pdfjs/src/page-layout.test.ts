import { expect, test } from "vitest";

import {
  COLUMN_SEPARATOR,
  DEFAULT_COLUMN_GAP_PT,
  DEFAULT_ROW_TOLERANCE_PT,
  layoutPageText,
  type PositionedTextItem,
} from "./page-layout.js";

/**
 * The geometry logic is a pure function on purpose: it is the part with real
 * behaviour, and keeping it free of pdf.js means it gets fast node tests
 * instead of a Chromium launch. `pdf-text.browser.test.ts` covers the
 * integration; everything below covers the layout itself.
 *
 * Why this exists: pdf.js emits text in **content-stream order**, not visual
 * order. On a real contractor invoice that put `Subtotal` and its value
 * `$70,903.33` roughly a thousand characters apart in the extracted text —
 * the label column is emitted as a block, then the value column as another
 * block — which is unreadable for an extractor asked to pair them.
 */

const item = (str: string, x: number, y: number, width = str.length * 5): PositionedTextItem => ({
  str,
  x,
  y,
  width,
  height: 10,
});

test("orders items within a row by x, not by the order pdf.js emitted them", () => {
  // The whole defect in one test: the value is emitted BEFORE the label.
  const text = layoutPageText([item("$70,903.33", 526, 187), item("Subtotal", 396, 187)]);

  expect(text.indexOf("Subtotal")).toBeLessThan(text.indexOf("$70,903.33"));
});

test("a wide horizontal gap becomes a column separator", () => {
  const text = layoutPageText([item("Subtotal", 396, 187, 40), item("$70,903.33", 526, 187)]);

  expect(text).toBe(`Subtotal${COLUMN_SEPARATOR}$70,903.33`);
});

test("a narrow gap becomes a single space, not a column break", () => {
  // `Invoice` then `#` a few points later is one phrase, not two columns.
  const text = layoutPageText([item("Invoice", 44, 700, 30), item("#", 76, 700, 4)]);

  expect(text).toBe("Invoice #");
});

test("items that abut concatenate with nothing between them", () => {
  // pdf.js splits words on kerning; re-inserting a space would corrupt them.
  const text = layoutPageText([item("Invo", 44, 700, 20), item("ice", 64, 700, 15)]);

  expect(text).toBe("Invoice");
});

test("rows are emitted top of page first — PDF y grows upward", () => {
  const text = layoutPageText([item("bottom", 44, 100), item("top", 44, 700)]);

  expect(text).toBe("top\nbottom");
});

test("baselines within the row tolerance share a row; beyond it they do not", () => {
  const together = layoutPageText([
    item("a", 44, 187),
    item("b", 400, 187 + DEFAULT_ROW_TOLERANCE_PT - 1),
  ]);
  const apart = layoutPageText([
    item("a", 44, 187),
    item("b", 400, 187 + DEFAULT_ROW_TOLERANCE_PT + 5),
  ]);

  expect(together.split("\n")).toHaveLength(1);
  expect(apart.split("\n")).toHaveLength(2);
});

test("whitespace-only and empty items are dropped rather than becoming columns", () => {
  // pdf.js emits standalone space items; treating one as a cell would open a
  // spurious column and split a row that is really continuous.
  // The coordinates matter: these three sit within word spacing of each other,
  // so dropping the middle one must leave a word gap and not a column break.
  const text = layoutPageText([item("a", 44, 700, 5), item("   ", 50, 700, 4), item("b", 55, 700)]);

  expect(text).toBe("a b");
});

test("an empty page yields an empty string, not a stray separator", () => {
  expect(layoutPageText([])).toBe("");
});

test("the column gap threshold is configurable, and the default is exported", () => {
  const items = [item("Subtotal", 396, 187, 40), item("$70,903.33", 526, 187)];

  // The gap here is 90pt. Raising the threshold above it collapses the columns.
  expect(layoutPageText(items, { columnGapPt: 200 })).toBe("Subtotal $70,903.33");
  expect(DEFAULT_COLUMN_GAP_PT).toBeGreaterThan(0);
});

test("a real side-by-side layout keeps unrelated columns distinguishable", () => {
  // The trap the naive fix walks into: on this invoice a legal disclaimer at
  // x=44 shares a baseline with the totals box at x=396. Gluing them with a
  // plain space invents an adjacency that is not in the document. The column
  // separator is what keeps "these were far apart" recoverable.
  const text = layoutPageText([
    item("California to cause cancer.", 44, 187, 200),
    item("Subtotal", 396, 187, 40),
    item("$70,903.33", 526, 187),
  ]);

  expect(text.split(COLUMN_SEPARATOR)).toHaveLength(3);
});
