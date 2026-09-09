import { expect, test } from "vitest";

import { isTransientFailure, TerminalQueueError } from "./queue/backoff.js";
import { TranscriberUnavailableError } from "./transcriber.js";
import {
  UNSUPPORTED_ITEM_REASONS,
  UnsupportedItemError,
  type UnsupportedItemReason,
} from "./unsupported-item.js";

const error = new UnsupportedItemError({
  engine: "pdfjs",
  reason: "no-text-layer",
  detail: "the document has no extractable text — a scanned PDF without OCR",
});

test("is terminal to the queue — isTransientFailure is false", () => {
  // Without this, a bare pdf.js transcriber handed a scanned PDF burns eight
  // backed-off attempts before landing in dead.
  expect(isTransientFailure(error)).toBe(false);
});

test("is a TerminalQueueError, and its name is its own, not the supertype's", () => {
  expect(error).toBeInstanceOf(TerminalQueueError);
  expect(error.name).toBe("UnsupportedItemError");
});

test("is not a capability failure, and carries no capability accessor", () => {
  // The one thing this class must never do: offer a capability verdict to
  // replace a cached one. pdf.js stays `ready` — it can read the next document.
  expect(error).not.toBeInstanceOf(TranscriberUnavailableError);
  expect("capability" in error).toBe(false);
});

test("names the engine, the reason and the detail", () => {
  expect(error.engine).toBe("pdfjs");
  expect(error.reason).toBe("no-text-layer");
  expect(error.detail).toBe("the document has no extractable text — a scanned PDF without OCR");
  expect(error.message).toContain("pdfjs");
  expect(error.message).toContain("no-text-layer");
});

test("a TranscriberUnavailableError is still classified transient", () => {
  // The D5 widening is in the file that decides this, so pin the pre-existing
  // property here: a capability failure is retryable because the next attempt
  // may route to a different engine.
  const unavailable = new TranscriberUnavailableError({
    engine: "managed-azure",
    reason: "offline",
    detail: "fetch failed",
  });
  expect(isTransientFailure(unavailable)).toBe(true);
});

test("the reason list is closed — an unlisted reason is a type error", () => {
  // @ts-expect-error "garbled" is not a valid UnsupportedItemReason.
  const _bad: UnsupportedItemReason = "garbled";
  expect(UNSUPPORTED_ITEM_REASONS).toContain("no-text-layer");
  expect(UNSUPPORTED_ITEM_REASONS).toContain("encrypted");
  expect(UNSUPPORTED_ITEM_REASONS).toContain("unsupported-format");
  // Referencing _bad keeps the linter from removing the @ts-expect-error.
  expect(_bad).toBe("garbled");
});
