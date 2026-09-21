import { describe, expect, test } from "vitest";

import { TerminalError, isTransientFailure } from "../storage/backoff.js";
import { TranscriberUnavailableError } from "./transcriber.js";
import { UnsupportedItemError } from "./unsupported-item.js";
import type { Transcript } from "../capture/transcript.js";
import {
  preferEngineOrder,
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

describe("preferEngineOrder", () => {
  // The whole reason this arbiter exists: under a sequential ladder settlement
  // order IS preference order, but a race breaks that identity — a worse engine
  // can settle first, and the first success is then not the best one.
  test("accepts the best-ranked success when a worse one settled first", () => {
    const worse = makeTranscript("b");
    const better = makeTranscript("a");

    // `c` is unranked and still pending, so the engine is not exhausted: the
    // accept must happen mid-run, not wait for exhaustion.
    expectAccept(
      preferEngineOrder(["a", "b"])(
        makeInput([
          { candidate: "b", result: worse },
          { candidate: "a", result: better },
        ]),
      ),
      better,
    );
  });

  test("returns continue while a better-ranked candidate is unsettled", () => {
    const worse = makeTranscript("b");

    expectContinue(preferEngineOrder(["a", "b"])(makeInput([{ candidate: "b", result: worse }])));
  });

  test("accepts once no better-ranked candidate can still arrive", () => {
    const transcript = makeTranscript("b");
    const aFailed = unsupported("a");

    // `a` outranks `b` but has already settled with an error, so nothing ranked
    // above `b` is outstanding (`c` is unranked and ranks below both).
    expectAccept(
      preferEngineOrder(["a", "b"])(
        makeInput([
          { candidate: "a", error: aFailed },
          { candidate: "b", result: transcript },
        ]),
      ),
      transcript,
    );
  });

  test("accepts a top-ranked success immediately — nothing can beat it", () => {
    const transcript = makeTranscript("a");

    expectAccept(
      preferEngineOrder(["a", "b"])(makeInput([{ candidate: "a", result: transcript }])),
      transcript,
    );
  });

  test("a first error before exhaustion does not give up — the race may still succeed", () => {
    const aFailed = unsupported("a");

    expectContinue(preferEngineOrder(["a", "b"])(makeInput([{ candidate: "a", error: aFailed }])));
  });

  test("at exhaustion accepts the best-ranked success", () => {
    const unranked = makeTranscript("c");
    const mid = makeTranscript("b");
    const best = makeTranscript("a");

    expectAccept(
      preferEngineOrder(["a", "b"])(
        makeInput(
          [
            { candidate: "c", result: unranked },
            { candidate: "b", result: mid },
            { candidate: "a", result: best },
          ],
          true,
        ),
      ),
      best,
    );
  });

  test("at exhaustion with no success gives up with the first error", () => {
    const first = unsupported("a");
    const second = unavailable("b");

    // Settlement order, not rank order: `b`'s error settled first.
    expectGiveUp(
      preferEngineOrder(["a", "b"])(
        makeInput(
          [
            { candidate: "b", error: second },
            { candidate: "a", error: first },
          ],
          true,
        ),
      ),
      second,
    );
  });

  // The pin that the ordering is right: `continue` is illegal at exhaustion —
  // the engine rejects it as a caller bug — so every exhaustion input the
  // engine can produce must resolve to accept or give up.
  test("never returns continue at exhaustion", () => {
    const arbiter = preferEngineOrder(["a", "b"]);
    const success = makeTranscript("a");
    const cases: TranscriptionArbiterInput[] = [
      makeInput([{ candidate: "a", result: success }], true),
      makeInput(
        [
          { candidate: "b", result: makeTranscript("b") },
          { candidate: "a", error: unsupported("a") },
        ],
        true,
      ),
      makeInput([{ candidate: "a", error: unsupported("a") }], true),
      makeInput(
        [
          { candidate: "b", error: unavailable("b") },
          { candidate: "a", error: unsupported("a") },
        ],
        true,
      ),
    ];

    for (const input of cases) {
      expect("continue" in arbiter(input)).toBe(false);
    }
  });

  test("an unranked engine sorts after every named one", () => {
    const unranked = makeTranscript("c");
    const named = makeTranscript("b");

    // `c` settled first but is named nowhere, so `b` outranks it even though
    // `b` is the lowest-ranked named engine.
    expectAccept(
      preferEngineOrder(["a", "b"])(
        makeInput(
          [
            { candidate: "c", result: unranked },
            { candidate: "b", result: named },
          ],
          true,
        ),
      ),
      named,
    );

    // And an unranked success must wait for every named engine to settle.
    expectContinue(preferEngineOrder(["a"])(makeInput([{ candidate: "c", result: unranked }])));
  });
});

describe("preferEngineOrder prefers a retryable failure at exhaustion", () => {
  test("gives up with the TRANSIENT error, not whichever settled first", () => {
    // `unsupportedFallsThrough`'s rule 2, which the first implementation of
    // `preferEngineOrder` did not carry — it gave up with `outcomes.find(isErrorOutcome)`,
    // so a race where a terminal failure happened to settle first buried a session that
    // should have been retried. Whether the queue retries would have been decided by
    // which engine was faster, which is not a decision anyone chose.
    //
    // The ranking orders SUCCESSES; it says nothing about which failure is the more
    // useful one to report, so it is not consulted here.
    const terminal = new TerminalError("no text layer");
    const transient = new Error("dropped uplink");
    const arbiter = preferEngineOrder(["pdfjs", "ocr"]);

    const verdict = arbiter({
      outcomes: [
        { candidate: "pdfjs", error: terminal },
        { candidate: "ocr", error: transient },
      ],
      exhausted: true,
    });

    expect(verdict).toEqual({ giveUp: transient });
  });

  test("falls back to the first error when every failure is terminal", () => {
    const first = new TerminalError("no text layer");
    const second = new TerminalError("unsupported format");
    const arbiter = preferEngineOrder(["pdfjs", "ocr"]);

    const verdict = arbiter({
      outcomes: [
        { candidate: "pdfjs", error: first },
        { candidate: "ocr", error: second },
      ],
      exhausted: true,
    });

    expect(verdict).toEqual({ giveUp: first });
  });
});
