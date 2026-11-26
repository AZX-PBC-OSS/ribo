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
import { UnsupportedItemError } from "@azx/ribo-core";
import type { DocumentCapture, Transcriber, Transcript } from "@azx/ribo-core";
import { afterEach, expect, test, vi } from "vitest";

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCorpus } from "../corpus/loader.js";
import { loadSchemaInitSamples } from "../schema-init/samples.js";
import { documentTextKey, transcribeDocumentCases } from "./documents.js";
import { OperatorError } from "../operator/error.js";
import { EvalError } from "./error.js";
import { runEval } from "./run.js";
import { stubChat } from "./test-support/stub-chat.js";
import {
  FIXTURE_CORPUS,
  copiedCorpus,
  corpusWithMixedInputsCase,
  corpusWithNoTextLayerDocument,
  editJson,
  removeTemporaries,
} from "./test-support/corpus.js";

afterEach(() => {
  removeTemporaries();
});

/** The arm every run here measures. */
const ARM = { strategies: ["single-shot"], model: "ribo-test" } as const;

/** Add a standalone single-document case to a copied corpus. */
const addDocumentCase = (root: string, id: string): void => {
  cpSync(path.join(root, "service-sheet"), path.join(root, id), { recursive: true });
  editJson(path.join(root, id, "case.json"), (document) => {
    document["id"] = id;
  });
};

interface RecordedDocumentCall {
  readonly capture: DocumentCapture;
  readonly bytes: Blob;
}

/** Record the complete transcriber boundary, optionally rejecting one call. */
const recordingTranscriber = (failure?: { readonly at: number; readonly error: unknown }) => {
  const calls: RecordedDocumentCall[] = [];
  const transcriber: Transcriber<DocumentCapture> = {
    engine: "parity-stub",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe: (capture, bytes): Promise<Transcript> => {
      const index = calls.length;
      calls.push({ capture, bytes });
      // This parity case deliberately rejects with a non-Error; preserving it is the subject.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (index === failure?.at) return Promise.reject(failure.error);
      return Promise.resolve({
        recordingId: capture.id,
        text: `actual transcript for ${capture.id}`,
        engine: "parity-stub",
      });
    },
  };
  return { calls, transcriber };
};

/** Resolve Blob bytes so two transcription paths can be compared exactly. */
const observedCalls = async (calls: readonly RecordedDocumentCall[]) =>
  Promise.all(
    calls.map(async ({ capture, bytes }) => ({
      capture,
      bytes: Buffer.from(await bytes.arrayBuffer()),
    })),
  );

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
  // The one-input document case is combined through core's combiner like any
  // other: its text carries its own marker, and the prompt reads it.
  expect(
    sent.some(
      (content) =>
        content.includes("===== CAPTURE seq:1 kind:document id:input.pdf =====") &&
        content.includes("Chain replaced"),
    ),
  ).toBe(true);
});

const corpusWithMixedCase = corpusWithMixedInputsCase;

test("a two-input case reaches the model as one ordered, marked text", async () => {
  const corpus = loadCorpus(corpusWithMixedCase());
  const chat = stubChat();

  const results = await runEval(corpus, chat, ARM);

  // Extraction actually ran: one result for the case, the stub saw requests.
  const sheet = results.filter((entry) => entry.caseId === "service-sheet");
  expect(sheet).toHaveLength(1);
  expect(sheet[0]?.status).toBe("extracted");
  expect(chat.calls.length).toBeGreaterThan(0);
  // Both inputs' text reaches the prompt, in list order, each under its own
  // marker. Must-fail: an implementation that sends only one input, or drops
  // the markers, has no request carrying this exact text.
  const sent = chat.calls.flatMap((request) => request.messages.map((message) => message.content));
  expect(
    sent.some((content) => {
      const first = content.indexOf("===== CAPTURE seq:1 kind:document id:input.pdf =====");
      const pdf = content.indexOf("Chain replaced");
      const second = content.indexOf("===== CAPTURE seq:2 kind:text id:site-note.txt =====");
      const note = content.indexOf("No additional observations.");
      return (
        first !== -1 &&
        second !== -1 &&
        pdf !== -1 &&
        note !== -1 &&
        first < pdf &&
        pdf < second &&
        second < note
      );
    }),
  ).toBe(true);
});

test("with markCaptures off, the same case's prompt carries both texts and no capture marker", async () => {
  const dir = corpusWithMixedCase();
  editJson(path.join(dir, "manifest.json"), (document) => {
    document["combine"] = { markCaptures: false };
  });
  const corpus = loadCorpus(dir);
  const chat = stubChat();
  // The PDF's own transcription, so the expected one-space join is exact —
  // core's unmarked join of the two parts, nothing else.
  const documents = await transcribeDocumentCases(corpus);
  const pdf = documents.get(documentTextKey("service-sheet", "input.pdf"));
  if (pdf === undefined) throw new Error("the document input did not transcribe");

  const results = await runEval(corpus, chat, ARM, { documents });

  expect(results.some((entry) => entry.caseId === "service-sheet")).toBe(true);
  expect(chat.calls.length).toBeGreaterThan(0);
  // Core's other join: one space between the parts, no markers anywhere.
  const sent = chat.calls.flatMap((request) => request.messages.map((message) => message.content));
  expect(sent.some((content) => content.includes(`${pdf} No additional observations.\n`))).toBe(
    true,
  );
  expect(sent.some((content) => content.includes("===== CAPTURE"))).toBe(false);
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
  // The refusal names the case, the file and the reason.
  expect(message).toContain("service-sheet");
  expect(message).toContain("input.pdf");
  expect(message).toContain("no-text-layer");
  // The whole run refused, not the case skipped: nothing was spent.
  // Must-fail: an implementation that skips the case and runs the rest
  // spends the other cases' calls and fails this assertion.
  expect(chat.calls.length).toBe(0);
});

test("the CLI's default document path prints no pdf.js Warning line, and a genuine failure still surfaces", async () => {
  // The real default path: no transcriber injected, so the CLI's own
  // loadPdfjs wiring runs. The committed fixture's fonts trip pdf.js's
  // `Warning: …` lines at its default verbosity (spike 0013's PDFs print
  // them too); at the CLI's errors-only verbosity none may reach stderr.
  const corpus = loadCorpus(FIXTURE_CORPUS);
  const warnings: string[] = [];
  const warns = vi.spyOn(console, "warn").mockImplementation((...data: unknown[]) => {
    warnings.push(data.map((entry) => String(entry)).join(" "));
  });
  const writes: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    const texts = await transcribeDocumentCases(corpus);
    // The path still transcribes: the fixture's own words came back, under
    // the per-input key.
    expect(texts.get(documentTextKey("service-sheet", "input.pdf"))).toContain("Chain replaced");
  } finally {
    warns.mockRestore();
    stderr.mockRestore();
  }
  // Must-fail: at pdf.js's default verbosity the fixture prints
  // `Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` …`.
  expect(warnings.join("\n")).not.toContain("Warning:");
  expect(writes.join("")).not.toContain("Warning:");

  // A genuine transcription failure still surfaces, naming the case.
  const failure = await transcribeDocumentCases(loadCorpus(corpusWithNoTextLayerDocument())).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(EvalError);
  expect(failure instanceof Error ? failure.message : String(failure)).toContain("service-sheet");
});

test("standalone samples and corpus documents have identical capture, byte, order and text behavior", async () => {
  const dir = copiedCorpus(FIXTURE_CORPUS, (root) => addDocumentCase(root, "second-sheet"));
  const corpus = loadCorpus(dir);
  const sources = corpus.cases
    .filter((entry) => entry.inputs.some((input) => input.kind === "document"))
    .map((entry) => entry.dir);
  const standalone = recordingTranscriber();
  const evaluated = recordingTranscriber();

  const samples = await loadSchemaInitSamples(sources, { transcriber: standalone.transcriber });
  const documents = await transcribeDocumentCases(corpus, { transcriber: evaluated.transcriber });

  expect(await observedCalls(standalone.calls)).toEqual(await observedCalls(evaluated.calls));
  expect(standalone.calls.map((call) => call.capture.id)).toEqual([
    "second-sheet",
    "service-sheet",
  ]);
  expect(standalone.calls).toHaveLength(2);
  expect(evaluated.calls).toHaveLength(2);
  expect(samples.map((sample) => sample.text)).toEqual([...documents.values()]);
  expect(samples.map((sample) => sample.source.capture)).toEqual(
    standalone.calls.map((call) => call.capture),
  );
});

test.each([
  {
    label: "UnsupportedItemError",
    expected: "(no-text-layer)",
    fault: () =>
      new UnsupportedItemError({
        engine: "parity-stub",
        reason: "no-text-layer",
        detail: "the parity fixture has no text",
      }),
  },
  {
    label: "a non-Error fault",
    expected: "non-Error parity sentinel",
    fault: () => "non-Error parity sentinel",
  },
])(
  "standalone and corpus transcription retain $label failure parity",
  async ({ expected, fault }) => {
    const dir = copiedCorpus(FIXTURE_CORPUS, (root) => {
      addDocumentCase(root, "second-sheet");
      addDocumentCase(root, "third-sheet");
    });
    const corpus = loadCorpus(dir);
    const sources = corpus.cases
      .filter((entry) => entry.inputs.some((input) => input.kind === "document"))
      .map((entry) => entry.dir);
    const standalone = recordingTranscriber({ at: 1, error: fault() });
    const evaluated = recordingTranscriber({ at: 1, error: fault() });

    const sampleFailure = await loadSchemaInitSamples(sources, {
      transcriber: standalone.transcriber,
    }).catch((error: unknown) => error);
    const evalFailure = await transcribeDocumentCases(corpus, {
      transcriber: evaluated.transcriber,
    }).catch((error: unknown) => error);

    // Each caller words its own refusal around the same failure detail.
    expect(sampleFailure).toBeInstanceOf(OperatorError);
    expect(evalFailure).toBeInstanceOf(EvalError);
    const sampleMessage =
      sampleFailure instanceof Error ? sampleFailure.message : String(sampleFailure);
    const evalMessage = evalFailure instanceof Error ? evalFailure.message : String(evalFailure);
    const detail = /could not be transcribed.*? — /u.exec(evalMessage)?.[0];
    expect(detail).toBeDefined();
    expect(sampleMessage).toContain(detail!);
    expect(sampleMessage).not.toContain("eval:");
    expect(sampleMessage).toContain(expected);
    expect(sampleMessage).toContain("service-sheet");
    expect(sampleMessage).toContain("input.pdf");
    expect(standalone.calls).toHaveLength(2);
    expect(evaluated.calls).toHaveLength(2);
    expect(await observedCalls(standalone.calls)).toEqual(await observedCalls(evaluated.calls));
  },
);

test("a two-document, two-arm run transcribes each document exactly once", async () => {
  // A second case holding two PDFs: the map is keyed by case id AND file, so
  // neither overwrites the other, and the bin's once-per-run call is what
  // every arm shares.
  const dir = copiedCorpus(FIXTURE_CORPUS, (root) => {
    const pdf = readFileSync(path.join(root, "service-sheet", "input.pdf"));
    mkdirSync(path.join(root, "second-sheet"));
    writeFileSync(path.join(root, "second-sheet", "input.pdf"), pdf);
    writeFileSync(path.join(root, "second-sheet", "annex.pdf"), pdf);
    writeFileSync(
      path.join(root, "second-sheet", "case.json"),
      JSON.stringify(
        {
          id: "second-sheet",
          inputs: [
            {
              file: "input.pdf",
              kind: "document",
              capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 },
            },
            {
              file: "annex.pdf",
              kind: "document",
              capture: { capturedAt: "2026-02-12T08:15:00Z", pageCount: 1 },
            },
          ],
          expected: {},
        },
        null,
        2,
      ),
    );
  });
  const corpus = loadCorpus(dir);

  // The injectable seam: a transcriber that counts its calls and returns
  // distinguishable text for each.
  let transcribeCalls = 0;
  const counting: Transcriber<DocumentCapture> = {
    engine: "counting-stub",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe: (item): Promise<Transcript> => {
      transcribeCalls += 1;
      return Promise.resolve({
        recordingId: item.id,
        text: `the counted transcription ${transcribeCalls}`,
        engine: "counting-stub",
      });
    },
  };

  const documents = await transcribeDocumentCases(corpus, { transcriber: counting });
  // Exactly one call per document input across the corpus: the fixture's one
  // plus the second case's two.
  expect(transcribeCalls).toBe(3);

  const chat = stubChat();
  const first = await runEval(corpus, chat, ARM, { documents });
  const second = await runEval(corpus, chat, ARM, { documents });

  // No arm re-transcribed: still one call per document input. Must-fail: an
  // implementation keyed only by case id would collapse the second case's
  // two PDFs into one text, and one that re-transcribes per arm counts more.
  expect(transcribeCalls).toBe(3);
  expect(first).toHaveLength(4);
  expect(second).toHaveLength(4);
  // Both document inputs' text reaches each arm's prompts, distinguishable —
  // so the second PDF's transcription was not lost to the first's key.
  const sent = chat.calls.flatMap((request) => request.messages.map((message) => message.content));
  expect(documents.size).toBe(3);
  for (const text of documents.values()) {
    expect(sent.some((content) => content.includes(text))).toBe(true);
  }
  expect(chat.calls.length).toBeGreaterThanOrEqual(first.length + second.length);
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

test("a run handed a transcription map that misses a document input refuses, naming the case and the file", async () => {
  const corpus = loadCorpus(FIXTURE_CORPUS);
  const chat = stubChat();

  const failure = await runEval(corpus, chat, ARM, { documents: new Map() }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(EvalError);
  const message = failure instanceof Error ? failure.message : String(failure);
  expect(message).toContain("service-sheet");
  expect(message).toContain("input.pdf");
  expect(chat.calls.length).toBe(0);
});

test("a document input that fails after an earlier one transcribes still refuses the whole run, naming the later file", async () => {
  const dir = corpusWithMixedCase();
  // The later input is the scan: the earlier one transcribes fine.
  writeFileSync(
    path.join(dir, "service-sheet", "annex-scan.pdf"),
    readFileSync(
      fileURLToPath(
        new URL("../../../ribo-transcriber-pdfjs/src/fixtures/no-text-layer.pdf", import.meta.url),
      ),
    ),
  );
  editJson(path.join(dir, "service-sheet", "case.json"), (document) => {
    (document["inputs"] as Record<string, unknown>[]).push({
      file: "annex-scan.pdf",
      kind: "document",
      capture: { capturedAt: "2026-02-12T08:15:00Z", pageCount: 1 },
    });
  });
  const corpus = loadCorpus(dir);
  const chat = stubChat();

  const failure = await runEval(corpus, chat, ARM).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(EvalError);
  const message = failure instanceof Error ? failure.message : String(failure);
  expect(message).toContain("service-sheet");
  expect(message).toContain("annex-scan.pdf");
  expect(message).toContain("no-text-layer");
  // No partial result: the run refused before any model call.
  expect(chat.calls.length).toBe(0);
});

test("a document input whose bytes pdf.js cannot open refuses the run, naming the case and the file", async () => {
  const dir = copiedCorpus(FIXTURE_CORPUS, (root) => {
    writeFileSync(path.join(root, "service-sheet", "input.pdf"), "this is not a PDF\n");
  });
  const corpus = loadCorpus(dir);
  const chat = stubChat();

  const failure = await runEval(corpus, chat, ARM).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(EvalError);
  const message = failure instanceof Error ? failure.message : String(failure);
  expect(message).toContain("service-sheet");
  expect(message).toContain("input.pdf");
  expect(chat.calls.length).toBe(0);
});
