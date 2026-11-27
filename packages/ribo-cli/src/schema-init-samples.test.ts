/**
 * @file Standalone schema-init samples: verbatim text, declared document
 * metadata and the same failure boundary as eval's document path.
 */
import type { DocumentCapture, Transcriber, Transcript } from "@azx/ribo-core";
import { afterEach, expect, test, vi } from "vitest";

import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OperatorError } from "./operator/error.js";
import { joinCaseInputTexts } from "./eval/case-text.js";
import { loadSchemaInitSamples } from "./schema-init/samples.js";

const FIXTURE_CORPUS = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));
const temporaries: string[] = [];

const temporaryDirectory = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "ribo-schema-init-samples-"));
  temporaries.push(dir);
  return dir;
};

const editJson = (file: string, edit: (document: Record<string, unknown>) => void): void => {
  const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
};

const copiedCase = (sourceId: string, id = sourceId): string => {
  const dir = path.join(temporaryDirectory(), id);
  cpSync(path.join(FIXTURE_CORPUS, sourceId), dir, { recursive: true });
  if (id !== sourceId) {
    editJson(path.join(dir, "case.json"), (document) => {
      document["id"] = id;
    });
  }
  return dir;
};

const directText = (file: string, text: string): string => {
  const source = path.join(temporaryDirectory(), file);
  writeFileSync(source, text);
  return source;
};

const THREE_PAGE_PDF = fileURLToPath(
  new URL("../../ribo-transcriber-pdfjs/src/fixtures/three-page.pdf", import.meta.url),
);

/** A bare PDF source copied from a fixture, with the given file name. */
const barePdf = (file: string, from = path.join(FIXTURE_CORPUS, "service-sheet", "input.pdf")) => {
  const source = path.join(temporaryDirectory(), file);
  writeFileSync(source, readFileSync(from));
  return source;
};

/** A transcriber stub that never touches pdf.js and returns identifiable text. */
const barePdfTranscriber = () => ({
  transcriber: {
    engine: "bare-pdf-stub",
    capability: () => Promise.resolve({ status: "ready" as const }),
    transcribe: (capture: DocumentCapture): Promise<Transcript> =>
      Promise.resolve({
        recordingId: capture.id,
        text: `bare transcript for ${capture.id}`,
        engine: "bare-pdf-stub",
      }),
  } satisfies Transcriber<DocumentCapture>,
});

const unusedTranscriber = () => {
  const transcribe = vi.fn<Transcriber<DocumentCapture>["transcribe"]>();
  const transcriber: Transcriber<DocumentCapture> = {
    engine: "must-not-run",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe,
  };
  return { transcriber, transcribe, createTranscriber: vi.fn(() => transcriber) };
};

const expectRefusal = async (sources: readonly string[], text: string): Promise<void> => {
  const { transcriber, createTranscriber, transcribe } = unusedTranscriber();
  const failure = await loadSchemaInitSamples(sources, {
    transcriber,
    createTranscriber,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(OperatorError);
  expect(failure instanceof Error ? failure.message : String(failure)).toContain(text);
  expect(createTranscriber).not.toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("direct text and single-input text/transcript cases stay verbatim, named and in caller order", async () => {
  const direct = directText("field-notes.txt", "  direct text\r\n\tsecond line\n");
  const written = copiedCase("written-ticket");
  const spoken = copiedCase("spoken-note");
  const { transcriber, createTranscriber, transcribe } = unusedTranscriber();

  const samples = await loadSchemaInitSamples([written, direct, spoken], {
    transcriber,
    createTranscriber,
  });

  expect(samples.map((sample) => sample.name)).toEqual([
    "written-ticket",
    "field-notes",
    "spoken-note",
  ]);
  expect(samples.map((sample) => sample.inputs.map((input) => input.kind))).toEqual([
    ["text"],
    ["text"],
    ["transcript"],
  ]);
  expect(samples.map((sample) => sample.inputs[0]?.text)).toEqual([
    readFileSync(path.join(written, "input.txt"), "utf8"),
    "  direct text\r\n\tsecond line\n",
    readFileSync(path.join(spoken, "input.txt"), "utf8"),
  ]);
  expect(samples.map((sample) => sample.inputs[0]?.file)).toEqual([
    "input.txt",
    "field-notes.txt",
    "input.txt",
  ]);
  expect(samples[1]?.inputs[0]?.path).toBe(direct);
  expect(Buffer.from(samples[1]?.inputs[0]?.bytes ?? []).equals(readFileSync(direct))).toBe(true);
  // The sample text is the one marked join, shared with eval's caseTextOf.
  expect(samples.map((sample) => sample.text)).toEqual(
    samples.map((sample) => joinCaseInputTexts(sample.inputs)),
  );
  expect(samples.every((sample) => !("provenance" in sample))).toBe(true);
  expect(samples.every((sample) => sample.inputs.every((input) => !("provenance" in input)))).toBe(
    true,
  );
  expect(createTranscriber).not.toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
});

test("every document forwards its complete declared capture and exact bytes once, and returns actual transcript text", async () => {
  const second = copiedCase("service-sheet", "second-sheet");
  editJson(path.join(second, "case.json"), (document) => {
    const input = (document["inputs"] as Record<string, unknown>[])[0];
    input!["capture"] = { capturedAt: "2026-03-04T10:11:12Z", pageCount: 7 };
  });
  const first = copiedCase("service-sheet");
  const calls: { readonly capture: DocumentCapture; readonly bytes: Blob }[] = [];
  const transcriber: Transcriber<DocumentCapture> = {
    engine: "recording-stub",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe: (capture, bytes): Promise<Transcript> => {
      calls.push({ capture, bytes });
      return Promise.resolve({
        recordingId: capture.id,
        text: `actual transcript for ${capture.id}`,
        engine: "recording-stub",
      });
    },
  };

  const samples = await loadSchemaInitSamples([second, first], { transcriber });

  expect(samples.map((sample) => sample.name)).toEqual(["second-sheet", "service-sheet"]);
  expect(samples.map((sample) => sample.inputs.map((input) => input.kind))).toEqual([
    ["document"],
    ["document"],
  ]);
  expect(samples.map((sample) => sample.inputs[0]?.text)).toEqual([
    "actual transcript for second-sheet",
    "actual transcript for service-sheet",
  ]);
  expect(calls.map((call) => call.capture)).toEqual([
    {
      id: "second-sheet",
      kind: "document",
      mimeType: "application/pdf",
      ctx: {},
      capturedAt: "2026-03-04T10:11:12Z",
      pageCount: 7,
    },
    {
      id: "service-sheet",
      kind: "document",
      mimeType: "application/pdf",
      ctx: {},
      capturedAt: "2026-02-11T08:15:00Z",
      pageCount: 1,
    },
  ]);
  for (const [index, source] of [second, first].entries()) {
    const expected = readFileSync(path.join(source, "input.pdf"));
    const actual = calls[index]?.bytes;
    expect(actual).toBeInstanceOf(Blob);
    expect(Buffer.from(await actual!.arrayBuffer()).equals(expected)).toBe(true);
    expect(samples[index]?.inputs[0]?.capture).toEqual(calls[index]?.capture);
    expect(Buffer.from(samples[index]?.inputs[0]?.bytes ?? []).equals(expected)).toBe(true);
  }
  expect(calls).toHaveLength(2);
  expect(samples.every((sample) => !("provenance" in sample))).toBe(true);
  expect(samples.every((sample) => sample.inputs.every((input) => !("provenance" in input)))).toBe(
    true,
  );
});

test("an empty sample list refuses before transcriber construction", async () => {
  await expectRefusal([], "at least one sample");
});

test.each(["", " \r\n\t"])("empty direct text refuses before transcription", async (text) => {
  await expectRefusal([directText("empty.txt", text)], "empty");
});

test("an empty case inputs list refuses before transcription", async () => {
  const dir = copiedCase("service-sheet");
  editJson(path.join(dir, "case.json"), (document) => {
    document["inputs"] = [];
  });
  await expectRefusal([dir], "inputs");
});

test.each(["capture", "capturedAt", "pageCount"])(
  "a document case missing %s refuses before transcription",
  async (missing) => {
    const dir = copiedCase("service-sheet");
    editJson(path.join(dir, "case.json"), (document) => {
      const input = (document["inputs"] as Record<string, unknown>[])[0]!;
      if (missing === "capture") {
        delete input["capture"];
      } else {
        delete (input["capture"] as Record<string, unknown>)[missing];
      }
    });
    await expectRefusal([dir], missing);
  },
);

test.each(["../outside.pdf", "nested/input.pdf"])(
  "an unsafe case input name %s refuses before transcription",
  async (file) => {
    const dir = copiedCase("service-sheet");
    editJson(path.join(dir, "case.json"), (document) => {
      (document["inputs"] as Record<string, unknown>[])[0]!["file"] = file;
    });
    await expectRefusal([dir], "path");
  },
);

test("a missing declared case input refuses before transcription", async () => {
  const dir = copiedCase("service-sheet");
  rmSync(path.join(dir, "input.pdf"));
  await expectRefusal([dir], "input.pdf");
});

test("a bare PDF loads as one named document input with exact bytes, measured pages and the injected run instant", async () => {
  const source = barePdf("intake-form.pdf");
  const { transcriber } = barePdfTranscriber();
  const clock = vi.fn(() => new Date("2026-06-01T09:30:00.000Z"));

  const samples = await loadSchemaInitSamples([source], { clock, transcriber });

  expect(samples).toHaveLength(1);
  const sample = samples[0]!;
  expect(sample.name).toBe("intake-form");
  expect(sample.inputs).toHaveLength(1);
  const input = sample.inputs[0]!;
  expect(input.kind).toBe("document");
  expect(input.file).toBe("intake-form.pdf");
  expect(input.path).toBe(source);
  // The capture block is measured and stamped, not read off the file.
  expect(input.capture).toEqual({
    id: "intake-form",
    kind: "document",
    mimeType: "application/pdf",
    ctx: {},
    capturedAt: "2026-06-01T09:30:00.000Z",
    pageCount: 1,
  });
  expect(Buffer.from(input.bytes).equals(readFileSync(source))).toBe(true);
  expect(input.text).toBe("bare transcript for intake-form");
  expect(sample.text).toBe(joinCaseInputTexts(sample.inputs));
  expect(clock).toHaveBeenCalledTimes(1);
});

test("several bare PDFs share one command-clock reading", async () => {
  const first = barePdf("one.pdf");
  const second = barePdf("two.pdf");
  const { transcriber } = barePdfTranscriber();
  const clock = vi.fn(() => new Date("2026-07-01T10:00:00.000Z"));

  const samples = await loadSchemaInitSamples([first, second], { clock, transcriber });

  expect(clock).toHaveBeenCalledTimes(1);
  expect(
    samples.flatMap((sample) => sample.inputs.map((input) => input.capture?.capturedAt)),
  ).toEqual(["2026-07-01T10:00:00.000Z", "2026-07-01T10:00:00.000Z"]);
});

test("the real pdf.js path measures the three-page fixture as three pages", async () => {
  const source = barePdf("three-page.pdf", THREE_PAGE_PDF);
  const clock = vi.fn(() => new Date("2026-08-01T00:00:00.000Z"));

  // No transcriber injected: the real pdf.js path measures and transcribes.
  const samples = await loadSchemaInitSamples([source], { clock });

  expect(samples[0]?.inputs[0]?.capture).toMatchObject({
    id: "three-page",
    capturedAt: "2026-08-01T00:00:00.000Z",
    pageCount: 3,
  });
  expect(samples[0]?.text).toContain("The first page of the progress fixture has a text layer");
});

test("an explicit captured-at overrides the clock for bare PDFs", async () => {
  const source = barePdf("override.pdf");
  const { transcriber } = barePdfTranscriber();
  const clock = vi.fn(() => new Date("2026-06-01T09:30:00.000Z"));

  const samples = await loadSchemaInitSamples([source], {
    capturedAt: "2026-05-01T08:00:00Z",
    clock,
    transcriber,
  });

  expect(samples[0]?.inputs[0]?.capture).toMatchObject({ capturedAt: "2026-05-01T08:00:00Z" });
  expect(clock).not.toHaveBeenCalled();
});

test("changing a bare PDF's mtime changes neither its measured count nor capturedAt", async () => {
  const source = barePdf("stable.pdf");
  const { transcriber } = barePdfTranscriber();
  const clock = vi.fn(() => new Date("2026-06-01T09:30:00.000Z"));
  utimesSync(source, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  const before = await loadSchemaInitSamples([source], { clock, transcriber });
  utimesSync(source, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  const after = await loadSchemaInitSamples([source], { clock, transcriber });

  expect(after[0]?.inputs[0]?.capture).toEqual(before[0]?.inputs[0]?.capture);
  expect(after[0]?.inputs[0]?.capture).toMatchObject({
    pageCount: 1,
    capturedAt: "2026-06-01T09:30:00.000Z",
  });
});

test("a bare PDF whose bytes pdf.js cannot open refuses naming the file, before transcription", async () => {
  const source = directText("broken.pdf", "this is not a PDF\n");
  await expectRefusal([source], "broken.pdf");
});

test("PDF magic bytes without a .pdf extension refuse with a rename fix", async () => {
  const source = directText("scan.txt", "%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n");
  await expectRefusal([source], "rename");
});

test("a document, document, text case loads as one ordered sample through the shared join", async () => {
  const dir = copiedCase("service-sheet");
  cpSync(path.join(dir, "input.pdf"), path.join(dir, "annex.pdf"));
  writeFileSync(path.join(dir, "note.txt"), "not merged\n");
  editJson(path.join(dir, "case.json"), (document) => {
    document["inputs"] = [
      {
        file: "input.pdf",
        kind: "document",
        capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 },
      },
      {
        file: "annex.pdf",
        kind: "document",
        capture: { capturedAt: "2026-02-12T08:15:00Z", pageCount: 2 },
      },
      { file: "note.txt", kind: "text" },
    ];
  });
  const calls: { readonly capture: DocumentCapture; readonly bytes: Blob }[] = [];
  const transcriber: Transcriber<DocumentCapture> = {
    engine: "recording-stub",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe: (capture, bytes): Promise<Transcript> => {
      calls.push({ capture, bytes });
      return Promise.resolve({
        recordingId: capture.id,
        text: `transcription ${calls.length}`,
        engine: "recording-stub",
      });
    },
  };

  const samples = await loadSchemaInitSamples([dir], { transcriber });

  expect(samples).toHaveLength(1);
  const loaded = samples[0]!;
  expect(loaded.name).toBe("service-sheet");
  expect(loaded.inputs.map((input) => input.file)).toEqual(["input.pdf", "annex.pdf", "note.txt"]);
  expect(loaded.inputs.map((input) => input.kind)).toEqual(["document", "document", "text"]);
  // Each document is transcribed exactly once, in sample-then-input order,
  // and keeps its own declared capture.
  expect(calls).toHaveLength(2);
  expect(loaded.inputs[0]?.text).toBe("transcription 1");
  expect(loaded.inputs[1]?.text).toBe("transcription 2");
  expect(loaded.inputs[0]?.capture).toMatchObject({
    capturedAt: "2026-02-11T08:15:00Z",
    pageCount: 1,
  });
  expect(loaded.inputs[1]?.capture).toMatchObject({
    capturedAt: "2026-02-12T08:15:00Z",
    pageCount: 2,
  });
  expect(loaded.inputs[2]?.text).toBe("not merged\n");
  // The sample text is the shared join's output, markers on, declared order.
  expect(loaded.text).toBe(joinCaseInputTexts(loaded.inputs));
  expect(loaded.text).toContain("===== CAPTURE seq:1 kind:document id:input.pdf =====");
  expect(loaded.text).toContain("===== CAPTURE seq:2 kind:document id:annex.pdf =====");
  expect(loaded.text).toContain("===== CAPTURE seq:3 kind:text id:note.txt =====");
  expect(loaded.text.indexOf("transcription 1")).toBeLessThan(
    loaded.text.indexOf("transcription 2"),
  );
  expect(loaded.text.indexOf("transcription 2")).toBeLessThan(loaded.text.indexOf("not merged"));
});

test("a duplicate declared input file refuses before transcription", async () => {
  const dir = copiedCase("service-sheet");
  editJson(path.join(dir, "case.json"), (document) => {
    (document["inputs"] as Record<string, unknown>[]).push({
      file: "input.pdf",
      kind: "document",
      capture: { capturedAt: "2026-02-12T08:15:00Z", pageCount: 1 },
    });
  });
  await expectRefusal([dir], "twice");
});

test("a later document failure returns no partial samples and stops before later transcription, estimates or model calls", async () => {
  const sources = [
    copiedCase("service-sheet", "first-sheet"),
    copiedCase("service-sheet", "second-sheet"),
    copiedCase("service-sheet", "third-sheet"),
  ];
  const calls: string[] = [];
  const transcriber: Transcriber<DocumentCapture> = {
    engine: "failing-stub",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe: (capture): Promise<Transcript> => {
      calls.push(capture.id);
      if (capture.id === "second-sheet") return Promise.reject(new Error("second PDF failed"));
      return Promise.resolve({
        recordingId: capture.id,
        text: `transcript for ${capture.id}`,
        engine: "failing-stub",
      });
    },
  };
  const estimate = vi.fn();
  const model = vi.fn();
  const run = async (): Promise<void> => {
    const samples = await loadSchemaInitSamples(sources, { transcriber });
    estimate(samples);
    model(samples);
  };

  const failure = await run().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(OperatorError);
  const message = failure instanceof Error ? failure.message : String(failure);
  expect(message).toContain("second PDF failed");
  expect(message).toContain('the schema-init case "second-sheet"');
  expect(message).not.toContain("eval:");
  expect(calls).toEqual(["first-sheet", "second-sheet"]);
  expect(estimate).not.toHaveBeenCalled();
  expect(model).not.toHaveBeenCalled();
});

test("the standalone default path transcribes a real local PDF through pdf.js", async () => {
  const samples = await loadSchemaInitSamples([copiedCase("service-sheet")]);

  expect(samples).toHaveLength(1);
  expect(samples[0]?.name).toBe("service-sheet");
  expect(samples[0]?.text).toContain("Chain replaced");
  expect(samples[0]?.inputs[0]?.capture).toMatchObject({
    capturedAt: "2026-02-11T08:15:00Z",
    pageCount: 1,
  });
});
