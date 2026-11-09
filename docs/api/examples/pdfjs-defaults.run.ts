/**
 * The runnable defaults example behind docs/api/pdfjs-transcriber.html.
 *
 * The page's main example is type-checked only (pdf.js lazy-loads a worker),
 * so this small dedicated file carries the R4 tier-1 constant assertions: the
 * runner executes them in the Vitest `unit` project, and a source change that
 * moved a documented default fails the `test` stage.
 */

import assert from "node:assert/strict";
import { DEFAULT_NO_TEXT_LAYER_THRESHOLD, PDFJS_ENGINE } from "@azx/ribo-transcriber-pdfjs";

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The exported defaults, read from packages/ribo-transcriber-pdfjs/src/config.ts.
  // The page quotes these values in prose next to this region; a source change
  // that moved one fails here.
  assert.equal(DEFAULT_NO_TEXT_LAYER_THRESHOLD, 50);
  assert.equal(PDFJS_ENGINE, "pdfjs");
}
// #endregion defaults
