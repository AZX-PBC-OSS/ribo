/**
 * @file Rebuild a page's visual reading order from pdf.js's per-item geometry.
 *
 * **The problem this solves.** `getTextContent()` returns items in
 * **content-stream order** — the order the PDF's drawing operators happen to
 * run — which is not visual order and is frequently not even close. Measured on
 * a real two-page contractor invoice, concatenating `item.str` put `Subtotal`
 * and its value `$70,903.33` about a thousand characters apart: the generator
 * emits the whole label column, then the whole value column. An extractor asked
 * to pair a label with its amount cannot do it from that.
 *
 * Every text item carries a `transform` matrix and a `width`, so the geometry
 * needed to fix this is already in hand — the previous implementation simply
 * discarded it. This module is the "stream" strategy in the table-extraction
 * literature: cluster items into rows by baseline proximity, order each row
 * left to right, and mark wide horizontal gaps as column boundaries.
 *
 * **Deliberately not "lattice".** This invoice does carry a real ruled grid
 * (80 horizontal and 78 vertical rules per page, reachable via
 * `page.getOperatorList()`), and intersecting those rules would give
 * deterministic cells rather than clustered guesses. That is a bigger piece of
 * work whose main beneficiary is a document a managed parsing API would handle
 * better anyway — so it is deliberately not built here. If it ever is, this
 * file is what it replaces.
 *
 * Pure on purpose: no pdf.js import, so the behaviour gets fast node tests
 * rather than a Chromium launch.
 */

/**
 * One text item with the geometry pdf.js already provides.
 *
 * @category Transcription
 */
export interface PositionedTextItem {
  readonly str: string;
  /** Device-space x of the item's origin — `transform[4]`. */
  readonly x: number;
  /** Device-space y of the baseline — `transform[5]`. PDF y grows **upward**. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What separates two cells that were far apart on the page.
 *
 * Visible rather than a tab, because the joined transcript is shown to a human
 * in review as well as read by a model, and a tab is invisible in both. It also
 * keeps "these were separate columns" recoverable downstream — which matters
 * because a row can pair genuinely unrelated content (see
 * {@link DEFAULT_COLUMN_GAP_PT}).
 * @category Transcription
 */
export const COLUMN_SEPARATOR = " | ";

/**
 * How far two baselines may differ and still count as one row, in points.
 *
 * **Provisional.** 3pt clears sub-pixel baseline jitter within a line while
 * staying well under single-line leading for the 8–12pt text these documents
 * use. What would refine it: a corpus of real submissions measuring the
 * distribution of within-row baseline spread against between-row leading. A
 * value that is too large merges adjacent table rows; too small splits a row
 * whose cells use different font sizes.
 * @category Transcription
 */
export const DEFAULT_ROW_TOLERANCE_PT = 3;

/**
 * How wide a horizontal gap must be to read as a column boundary, in points.
 *
 * **Provisional.** 12pt is roughly two space-widths at 10pt type — comfortably
 * above inter-word spacing, comfortably below the gaps between real columns
 * (measured at 90pt+ between the totals labels and their values on the sample
 * invoice). What would refine it: the same corpus, measuring the gap
 * distribution and looking for the trough between the word-spacing mode and the
 * column-spacing mode.
 *
 * **This threshold is doing something subtler than it looks.** Rebuilding rows
 * fixes label/value pairing, but it also glues together content that merely
 * shares a baseline: on the sample invoice a legal disclaimer at x=44 sits on
 * the same line as the totals box at x=396. Joining those with a plain space
 * invents an adjacency the document does not have. Emitting a separator instead
 * keeps the distinction visible to whatever reads the text next.
 * @category Transcription
 */
export const DEFAULT_COLUMN_GAP_PT = 12;

/**
 * How wide a gap must be to read as a word space rather than kerning, in points.
 *
 * Below this, items are concatenated with nothing between them: pdf.js splits
 * words at kerning pairs, so inserting a space here would corrupt them
 * ("Invo" + "ice" must not become "Invo ice").
 * @category Transcription
 */
export const DEFAULT_WORD_GAP_PT = 0.8;

/** @category Transcription */
export interface PageLayoutOptions {
  readonly rowTolerancePt?: number;
  readonly columnGapPt?: number;
  readonly wordGapPt?: number;
}

/**
 * Rebuild one page's text in visual reading order.
 *
 * @category Transcription
 */
export function layoutPageText(
  items: readonly PositionedTextItem[],
  options: PageLayoutOptions = {},
): string {
  const rowTolerance = options.rowTolerancePt ?? DEFAULT_ROW_TOLERANCE_PT;
  const columnGap = options.columnGapPt ?? DEFAULT_COLUMN_GAP_PT;
  const wordGap = options.wordGapPt ?? DEFAULT_WORD_GAP_PT;

  // A standalone whitespace item is not a cell. Keeping one would open a
  // spurious column and split a row that is really continuous.
  const real = items.filter((it) => it.str.trim() !== "");
  if (real.length === 0) return "";

  const rows: { y: number; cells: PositionedTextItem[] }[] = [];
  for (const it of real) {
    const row = rows.find((r) => Math.abs(r.y - it.y) < rowTolerance);
    if (row) row.cells.push(it);
    else rows.push({ y: it.y, cells: [it] });
  }

  // PDF y grows upward, so descending y is top-of-page first.
  rows.sort((a, b) => b.y - a.y);

  return rows
    .map(({ cells }) => {
      cells.sort((a, b) => a.x - b.x);
      return cells.reduce((line, cell, i) => {
        if (i === 0) return cell.str;
        const previous = cells[i - 1]!;
        const gap = cell.x - (previous.x + previous.width);
        if (gap >= columnGap) return line + COLUMN_SEPARATOR + cell.str;
        if (gap >= wordGap) return line + " " + cell.str;
        return line + cell.str;
      }, "");
    })
    .join("\n");
}
