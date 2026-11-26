/**
 * @file Standalone schema-init samples: verbatim text, declared document
 * metadata and the same failure boundary as eval's document path.
 */
import type { DocumentCapture, Transcriber, Transcript } from "@azx/ribo-core";
import { afterEach, expect, test, vi } from "vitest";

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OperatorError } from "./operator/error.js";
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
  expect(samples.map((sample) => sample.kind)).toEqual(["text", "text", "transcript"]);
  expect(samples.map((sample) => sample.text)).toEqual([
    readFileSync(path.join(written, "input.txt"), "utf8"),
    "  direct text\r\n\tsecond line\n",
    readFileSync(path.join(spoken, "input.txt"), "utf8"),
  ]);
  expect(samples.map((sample) => sample.source.file)).toEqual([
    "input.txt",
    "field-notes.txt",
    "input.txt",
  ]);
  expect(samples[1]?.source.path).toBe(direct);
  expect(Buffer.from(samples[1]?.source.bytes ?? []).equals(readFileSync(direct))).toBe(true);
  expect(samples.every((sample) => !("provenance" in sample))).toBe(true);
  expect(samples.every((sample) => !("provenance" in sample.source))).toBe(true);
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
  expect(samples.map((sample) => sample.kind)).toEqual(["document", "document"]);
  expect(samples.map((sample) => sample.text)).toEqual([
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
    expect(samples[index]?.source.capture).toEqual(calls[index]?.capture);
    expect(Buffer.from(samples[index]?.source.bytes ?? []).equals(expected)).toBe(true);
  }
  expect(calls).toHaveLength(2);
  expect(samples.every((sample) => !("provenance" in sample))).toBe(true);
  expect(samples.every((sample) => !("provenance" in sample.source))).toBe(true);
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

test("a direct PDF refuses instead of guessing capture metadata", async () => {
  const dir = copiedCase("service-sheet");
  await expectRefusal([path.join(dir, "input.pdf")], "capture");
});

test("a multi-input case folder refuses rather than merging inputs", async () => {
  const dir = copiedCase("service-sheet");
  writeFileSync(path.join(dir, "note.txt"), "not merged\n");
  editJson(path.join(dir, "case.json"), (document) => {
    (document["inputs"] as Record<string, unknown>[]).push({ file: "note.txt", kind: "text" });
  });
  await expectRefusal([dir], "one input");
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
  expect(samples[0]?.source.capture).toMatchObject({
    capturedAt: "2026-02-11T08:15:00Z",
    pageCount: 1,
  });
});
