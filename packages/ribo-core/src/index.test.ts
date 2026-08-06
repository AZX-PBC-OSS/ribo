import { expect, test } from "vitest";

import * as core from "./index.js";

// The barrel's job is to be a stable, complete list of what consumers may depend on. This test
// pins that list: adding an export means adding it here deliberately, and removing one (a
// breaking change for every consumer) cannot happen by accident during a refactor.
//
// Runtime values only — type-only exports leave nothing to inspect at runtime, and are pinned
// instead by `contracts.test.ts`, which imports them through this same entry point.
test("the barrel exports the package's public runtime surface", () => {
  expect(Object.keys(core).sort()).toEqual([
    "ACTIVE_OUTBOX_STATUSES",
    "AUDIO_ATTACHMENT_ID",
    "DEFAULT_BACKOFF_BASE_MS",
    "DEFAULT_BACKOFF_CAP_MS",
    "DEFAULT_CAPABILITY_TTL_MS",
    "DEFAULT_FAKE_TRANSCRIBER_ENGINE",
    "DEFAULT_FAKE_TRANSCRIPT_TEXT",
    "DEFAULT_MIME_TYPE_PREFERENCES",
    "DEFAULT_OUTBOX_DATABASE_NAME",
    "DEFAULT_PROBE_TIMEOUT_MS",
    "DEFAULT_STABILITY_WINDOW_MS",
    "DERIVED_OUTBOX_ITEM_KEYS",
    "FINISHED_OUTBOX_STATUSES",
    "FakeExtractor",
    "FakeTranscriber",
    "OUTBOX_COLLECTION_NAME",
    "OUTBOX_STATUSES",
    "Outbox",
    "PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS",
    "Recorder",
    "RecorderError",
    "TRANSCRIBER_UNAVAILABLE_REASONS",
    "TerminalQueueError",
    "TranscriberUnavailableError",
    "baseRecordingSchema",
    "buildReviewRequest",
    "createConnectivity",
    "createRelay",
    "extractedSchema",
    "firstCapable",
    "fullJitterDelay",
    "isPermanentlyUnavailable",
    "isSpanGrounded",
    "isTransientFailure",
    "negotiateMimeType",
    "openOutbox",
    "openOutboxDatabase",
    "outboxDocumentSchema",
    "outboxItemSchema",
    "outboxRxSchema",
    "recordingSchema",
    "removeOutboxDatabase",
    "resolveReview",
    "reviewOutcomeSchema",
    "summarizeWork",
    "toExtractStep",
    "transcriptSchema",
    "workSafety",
  ]);
});
