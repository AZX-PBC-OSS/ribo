/**
 * @file The document path: a corpus's document cases run through the eval
 * runner under Node.
 *
 * The runner transcribes each document case's PDF to text — the real
 * `PdfjsTranscriber` over pdf.js's legacy build, resolved from the installed
 * `pdfjs-dist`, with no `Worker` global and no polyfill (spike 0013) — and
 * the text then takes exactly the path a transcript case's text takes. Every
 * run here drives the suite's stub chat: no test reaches a network or spends
 * on a model, and transcription is free and local.
 */
import type { DocumentCapture, Transcriber, Transcript } from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import { transcribeDocumentCases } from "./documents.js";
import { EvalError } from "./error.js";
import { runEval } from "./run.js";
import { stubChat } from "./test-support/stub-chat.js";
import {
  FIXTURE_CORPUS,
  copiedCorpus,
  corpusWithNoTextLayerDocument,
  removeTemporaries,
} from "./test-support/corpus.js";

afterEach(() => {
  removeTemporaries();
});

/** The arm every run here measures. */
const ARM = { strategies: ["single-shot"], model: "ribo-test" } as const;

test("a document case runs through runEval, and the prompt carries the PDF's extracted text", async () => {
  const corpus = loadCorpus(FIXTURE_CORPUS);
  const chat = stubChat();

  const results = await runEval(corpus, chat, ARM);

  const sheet = results.find((entry) => entry.caseId === "service-sheet");
  expect(sheet?.status).toBe("extracted");
  // The PDF's own words reached the model: the fixture's service sheet says
  // "Chain replaced", and some request's messages carry that text.
  // Must-fail: an implementation that skips the document case, or sends an
  // empty transcript for it, has no request containing the string.
  const sent = chat.calls.flatMap((request) => request.messages.map((message) => message.content));
  expect(sent.some((content) => content.includes("Chain replaced"))).toBe(true);
});

test("a mixed corpus — document, transcript and text cases — yields one result per case, in corpus order", async () => {
  const corpus = loadCorpus(FIXTURE_CORPUS);
  const chat = stubChat();

  const results = await runEval(corpus, chat, ARM);

  // The loader's case order: one result per case, none skipped, none doubled.
  expect(results.map((entry) => entry.caseId)).toEqual([
    "service-sheet",
    "spoken-note",
    "written-ticket",
  ]);
  expect(results.every((entry) => entry.status === "extracted")).toBe(true);
});

test("a document case whose PDF has no text layer refuses the whole run, before any model call", async () => {
  const corpus = loadCorpus(corpusWithNoTextLayerDocument());
  const chat = stubChat();

  const failure = await runEval(corpus, chat, ARM).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(EvalError);
  const message = failure instanceof Error ? failure.message : String(failure);
  // The refusal names the case and the reason.
  expect(message).toContain("service-sheet");
  expect(message).toContain("no-text-layer");
  // The whole run refused, not the case skipped: nothing was spent.
  // Must-fail: an implementation that skips the case and runs the rest
  // spends the other cases' calls and fails this assertion.
  expect(chat.calls.length).toBe(0);
});

test("a two-arm run transcribes each document once, not once per arm", async () => {
  const corpus = loadCorpus(copiedCorpus(FIXTURE_CORPUS));
  // The injectable seam: a transcriber that counts its calls.
  let transcribeCalls = 0;
  const counting: Transcriber<DocumentCapture> = {
    engine: "counting-stub",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe: (item): Promise<Transcript> => {
      transcribeCalls += 1;
      return Promise.resolve({
        recordingId: item.id,
        text: "the counted transcription of the document case",
        engine: "counting-stub",
      });
    },
  };

  const documents = await transcribeDocumentCases(corpus, { transcriber: counting });
  expect(transcribeCalls).toBe(1);

  const chat = stubChat();
  const first = await runEval(corpus, chat, ARM, { documents });
  const second = await runEval(corpus, chat, ARM, { documents });

  // Both arms ran every case off the ONE transcription.
  // Must-fail: an implementation that re-transcribes per arm counts two
  // transcription calls here.
  expect(transcribeCalls).toBe(1);
  expect(first.map((entry) => entry.caseId)).toEqual(second.map((entry) => entry.caseId));
  expect(first).toHaveLength(3);
  const sent = chat.calls.flatMap((request) => request.messages.map((message) => message.content));
  expect(sent.some((content) => content.includes("the counted transcription"))).toBe(true);
});

test("a run handed a transcription map that misses a document case refuses, naming the case", async () => {
  const corpus = loadCorpus(FIXTURE_CORPUS);
  const chat = stubChat();

  const failure = await runEval(corpus, chat, ARM, { documents: new Map() }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(EvalError);
  expect(failure instanceof Error ? failure.message : String(failure)).toContain("service-sheet");
  expect(chat.calls.length).toBe(0);
});
