import { describe, expect, test } from "vitest";

import { TerminalError, isTransientFailure } from "./storage/backoff.js";
import { TranscriberUnavailableError } from "./transcriber.js";
import { UnsupportedItemError } from "./unsupported-item.js";
import type { Transcript } from "./transcript.js";
import {
  unsupportedFallsThrough,
  type TranscriptionArbiterInput,
  type TranscriptionArbiterVerdict,
} from "./transcription-arbitration.js";

function makeTranscript(engine: string): Transcript {
  return { recordingId: "rec-1", text: "fake transcript", engine };
}

function makeInput(
  outcomes: TranscriptionArbiterInput["outcomes"],
  exhausted = false,
): TranscriptionArbiterInput {
  return { outcomes, exhausted };
}

type Verdict = TranscriptionArbiterVerdict;

function expectContinue(verdict: Verdict): void {
  expect(verdict).toEqual({ continue: true });
}

function expectGiveUp(verdict: Verdict, error: unknown): void {
  expect(verdict).toEqual({ giveUp: error });
  if ("giveUp" in verdict) {
    expect(verdict.giveUp).toBe(error);
  }
}

function expectAccept(verdict: Verdict, transcript: Transcript): void {
  expect(verdict).toEqual({ accept: transcript });
  if ("accept" in verdict) {
    expect(verdict.accept).toBe(transcript);
  }
}

function unsupported(engine: string): UnsupportedItemError {
  return new UnsupportedItemError({ engine, reason: "no-text-layer", detail: "scanned PDF" });
}

function unavailable(engine: string): TranscriberUnavailableError {
  return new TranscriberUnavailableError({ engine, reason: "offline", detail: "no network" });
}

describe("outcome discrimination", () => {
  // An error outcome carrying an explicit `result: undefined` must not read as
  // a success. `result?: never` permits the key, so a `"result" in outcome`
  // test would match — but the guard tests the VALUE, and `undefined` is not a
  // Transcript. Carried over from arbitration.ts.
  test("an error outcome carrying an explicit result: undefined is not a success", () => {
    const boom = new Error("network down");
    const outcome = { candidate: "a", error: boom, result: undefined };

    expectGiveUp(unsupportedFallsThrough(makeInput([outcome], true)), boom);
  });

  // `throw undefined` is legal, so an error outcome may carry no error value.
  test("an error outcome whose error is undefined is still an error", () => {
    const outcome = { candidate: "a", error: undefined };

    expectGiveUp(unsupportedFallsThrough(makeInput([outcome], true)), undefined);
  });
});

describe("unsupportedFallsThrough", () => {
  test("rule 1: first success is accepted", () => {
    const transcript = makeTranscript("ocr");
    expectAccept(
      unsupportedFallsThrough(makeInput([{ candidate: "a", result: transcript }])),
      transcript,
    );
  });

  test("rule 1: a result that appears after an earlier failure is accepted", () => {
    const transcript = makeTranscript("ocr");
    const error = unsupported("pdfjs");

    expectAccept(
      unsupportedFallsThrough(
        makeInput([
          { candidate: "pdfjs", error },
          { candidate: "ocr", result: transcript },
        ]),
      ),
      transcript,
    );
  });

  test("rule 3: UnsupportedItemError continues to the next candidate", () => {
    const error = unsupported("pdfjs");
    expectContinue(unsupportedFallsThrough(makeInput([{ candidate: "pdfjs", error }])));
  });

  test("rule 3: TranscriberUnavailableError continues to the next candidate", () => {
    const error = unavailable("ondevice");
    expectContinue(unsupportedFallsThrough(makeInput([{ candidate: "ondevice", error }])));
  });

  test("rule 4: a plain attempt failure gives up immediately", () => {
    const boom = new Error("out of memory decoding this clip");
    expect(isTransientFailure(boom)).toBe(true);

    expectGiveUp(unsupportedFallsThrough(makeInput([{ candidate: "a", error: boom }])), boom);
  });

  test("rule 4: a TerminalError that is not UnsupportedItemError gives up", () => {
    const terminal = new TerminalError("truncated");
    expect(isTransientFailure(terminal)).toBe(false);

    expectGiveUp(
      unsupportedFallsThrough(makeInput([{ candidate: "a", error: terminal }])),
      terminal,
    );
  });

  // Rule 2 is the deliberate divergence from terminalFallsThrough: at
  // exhaustion, prefer a retryable error over a terminal one. A ladder where
  // pdf.js said no-text-layer (terminal) and OCR then failed on a dropped
  // uplink (retryable) must be retried, not buried in dead.
  test("rule 2: at exhaustion, gives up with the retryable error over a terminal one", () => {
    const terminal = unsupported("pdfjs"); // UnsupportedItemError is terminal
    const retryable = new Error("OCR service 503");
    Object.assign(retryable, { status: 503 });
    expect(isTransientFailure(terminal)).toBe(false);
    expect(isTransientFailure(retryable)).toBe(true);

    // Naive "first error" would give up with `terminal`. The retryable-first
    // preference is what makes this test fail against the naive implementation.
    expectGiveUp(
      unsupportedFallsThrough(
        makeInput(
          [
            { candidate: "pdfjs", error: terminal },
            { candidate: "ocr", error: retryable },
          ],
          true,
        ),
      ),
      retryable,
    );
  });

  test("rule 2: at exhaustion with only terminal errors, gives up with the first error", () => {
    const first = unsupported("pdfjs");
    const second = unsupported("ocr");

    expectGiveUp(
      unsupportedFallsThrough(
        makeInput(
          [
            { candidate: "pdfjs", error: first },
            { candidate: "ocr", error: second },
          ],
          true,
        ),
      ),
      first,
    );
  });

  // The exhaustion check must come before every "keep going" branch. An earlier
  // version of this pattern (on the extractor side) checked a continue-branch
  // before exhaustion and died with a TypeError on the primary case.
  test("exhaustion is checked before the continue branches", () => {
    const error = unsupported("pdfjs");

    // At exhaustion with only an UnsupportedItemError, rule 2 fires (give up),
    // not rule 3 (continue).
    expectGiveUp(unsupportedFallsThrough(makeInput([{ candidate: "pdfjs", error }], true)), error);
  });
});
