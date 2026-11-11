/**
 * The runnable example behind docs/api/transcriber.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the engine is a `FakeTranscriber`.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_FAKE_TRANSCRIPT_TEXT,
  FakeTranscriber,
  isPermanentlyUnavailable,
  type DocumentCapture,
  type AudioCapture,
  TranscriberUnavailableError,
  type Transcriber,
  type TranscriberCapability,
  type Transcript,
} from "@azx/ribo-core";

function recording(id: string): AudioCapture {
  return {
    id,
    capturedAt: new Date().toISOString(),
    kind: "audio",
    durationMs: 96_000,
    mimeType: "audio/webm",
    ctx: {},
  };
}

export async function probeWhatTheEngineCanDoRightNow(): Promise<void> {
  // #region usage
  const engine: Transcriber = new FakeTranscriber({
    engine: "ondevice-whisper",
    text: "Kitchen leak found under the sink",
  });
  const capability = await engine.capability();
  // #endregion usage
  assert.equal(capability.status, "ready");
}

export async function transcribeTiesTheTranscriptBackToItsCapture(): Promise<void> {
  const engine = new FakeTranscriber({ engine: "ondevice-whisper" });
  engine.setResponse("cap-dictation", "Kitchen leak found under the sink");

  const transcript: Transcript = await engine.transcribe(
    recording("cap-dictation"),
    new Blob(["not really audio"], { type: "audio/webm" }),
  );

  assert.equal(transcript.recordingId, "cap-dictation");
  assert.equal(transcript.text, "Kitchen leak found under the sink");
  assert.equal(transcript.engine, "ondevice-whisper");
}

export async function capabilityHasThreeStatesAndPermanentOnesAreNamed(): Promise<void> {
  const needsDownload: TranscriberCapability = {
    status: "needs-download",
    downloadBytes: 165_000_000,
    detail: "whisper-base.en",
  };
  const tooSlow: TranscriberCapability = {
    status: "unavailable",
    reason: "too-slow",
    detail: "measured real-time factor 4",
  };
  const offline: TranscriberCapability = {
    status: "unavailable",
    reason: "offline",
    detail: "no network",
  };

  assert.equal(isPermanentlyUnavailable(needsDownload), false);
  assert.equal(isPermanentlyUnavailable(tooSlow), true);
  assert.equal(isPermanentlyUnavailable(offline), false);
}

export async function aCapabilityFailureThrowsTranscriberUnavailableError(): Promise<void> {
  const engine = new FakeTranscriber();
  engine.failWithUnavailable("model-unavailable", "weights could not be fetched");

  await assert.rejects(
    engine.transcribe(recording("cap-1"), new Blob(["not really audio"], { type: "audio/webm" })),
    (error: unknown) => {
      assert.ok(error instanceof TranscriberUnavailableError);
      assert.equal(error.reason, "model-unavailable");
      assert.deepEqual(error.capability, {
        status: "unavailable",
        reason: "model-unavailable",
        detail: "weights could not be fetched",
      });
      return true;
    },
  );
}

export async function documentEnginesTakeTheSecondTypeParameter(): Promise<void> {
  const documentEngine: Transcriber<DocumentCapture> = new FakeTranscriber<DocumentCapture>({
    engine: "pdfjs",
    text: "Page 1 — home inspection report",
  });
  const documentCapture: DocumentCapture = {
    id: "cap-doc",
    capturedAt: new Date().toISOString(),
    kind: "document",
    pageCount: 4,
    mimeType: "application/pdf",
    ctx: {},
  };

  const transcript = await documentEngine.transcribe(
    documentCapture,
    new Blob(["%PDF-1.7 …"], { type: "application/pdf" }),
  );

  assert.equal(transcript.recordingId, "cap-doc");
  assert.equal(transcript.text, "Page 1 — home inspection report");
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  const engine = new FakeTranscriber();
  const transcript = await engine.transcribe(
    recording("cap-defaults"),
    new Blob(["not really audio"], { type: "audio/webm" }),
  );

  // An options-less transcribe passes no options — TranscribeOptions itself has no defaults.
  assert.deepEqual(engine.callOptions, [undefined]);
  // The fake's defaults, read from packages/ribo-core/src/transcription/fake-transcriber.ts.
  // The text default is the exported constant, so a source change that moved it fails here;
  // the engine id and the `ready` capability are observed directly. The page quotes these
  // values in prose next to this region.
  assert.equal(DEFAULT_FAKE_TRANSCRIPT_TEXT, "fake transcript");
  assert.equal(transcript.text, DEFAULT_FAKE_TRANSCRIPT_TEXT);
  assert.equal(engine.engine, "fake");
  assert.deepEqual(await engine.capability(), { status: "ready" });
}
// #endregion defaults
