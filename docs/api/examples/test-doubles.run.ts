/**
 * The runnable example behind docs/api/test-doubles.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network — that is the entire point of the
 * doubles this page documents.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_FAKE_TRANSCRIPT_TEXT,
  FakeExtractor,
  FakeTranscriber,
  TranscriberUnavailableError,
  type Recording,
  type Transcript,
} from "@azx/ribo-core";

function recording(id: string): Recording {
  return {
    id,
    capturedAt: new Date().toISOString(),
    kind: "audio",
    durationMs: 96_000,
    mimeType: "audio/webm",
    ctx: {},
  };
}

export async function fakeExtractorReturnsFixedFieldsWithNoModelCalls(): Promise<void> {
  // #region usage
  const extractor = new FakeExtractor({
    name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" },
  });
  const result = await extractor.extract({ text: "Caller is Acme Heating", annotations: {} });
  // #endregion usage

  assert.equal(result.fields.name.value, "Acme Heating");
  // The default usage: a fake makes no model calls. Read from
  // packages/ribo-core/src/extraction/extractor.ts and observed here.
  assert.deepEqual(result.usage, { calls: 0 });
}

export async function fakeExtractorEchoesRawWhenGivenOne(): Promise<void> {
  const raw = { name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" } };
  const extractor = new FakeExtractor(
    { name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" } },
    { raw },
  );

  const result = await extractor.extract({ text: "Caller is Acme Heating", annotations: {} });
  assert.deepEqual(result.raw, raw);
}

// #region defaults
export async function fakeTranscriberDefaultsComeFromTheExportedConstant(): Promise<void> {
  const engine = new FakeTranscriber();
  const transcript: Transcript = await engine.transcribe(
    recording("cap-1"),
    new Blob(["not really audio"], { type: "audio/webm" }),
  );

  // The text default is the exported constant, so a source change that moved it
  // fails here — the page quotes the value next to this region. The engine id
  // and capability are observed directly.
  assert.equal(DEFAULT_FAKE_TRANSCRIPT_TEXT, "fake transcript");
  assert.equal(transcript.text, DEFAULT_FAKE_TRANSCRIPT_TEXT);
  assert.equal(engine.engine, "fake");
  assert.deepEqual(await engine.capability(), { status: "ready" });
}

export async function fakeTranscriberModelsEveryFailureKind(): Promise<void> {
  const attempt = new FakeTranscriber();
  attempt.failWith(new Error("out of memory"));
  await assert.rejects(
    attempt.transcribe(recording("cap-2"), new Blob(["x"], { type: "audio/webm" })),
    /out of memory/,
  );

  const capability = new FakeTranscriber();
  capability.failWithUnavailable("model-unavailable", "weights could not be fetched");
  await assert.rejects(
    capability.transcribe(recording("cap-3"), new Blob(["x"], { type: "audio/webm" })),
    (error: unknown) => {
      assert.ok(error instanceof TranscriberUnavailableError);
      assert.equal(error.reason, "model-unavailable");
      return true;
    },
  );

  const unsuitable = new FakeTranscriber();
  unsuitable.failWithUnsupported("no-text-layer", "no text layer");
  await assert.rejects(
    unsuitable.transcribe(recording("cap-4"), new Blob(["%PDF"], { type: "application/pdf" })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
}
// #endregion defaults
