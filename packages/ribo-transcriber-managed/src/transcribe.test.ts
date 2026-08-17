import {
  isTransientFailure,
  TerminalQueueError,
  TranscriberUnavailableError,
  type Recording,
} from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { ManagedTranscriber } from "./index.js";
import { MANAGED_AZURE_SPEECH_ENGINE } from "./config.js";

/**
 * Transcribe tests for the managed transcriber — the Task 4 must-fail tests
 * from `docs/roadmap/design/managed-transcription-plan.md`. No network, no
 * credential: `fetch` is injected with a double that returns canned responses.
 * The package has no capacity to authenticate, so there is nothing to double
 * beyond the transport.
 */

const ENDPOINT =
  "https://myresource.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15";

const RECORDING: Recording = {
  id: "rec-001",
  capturedAt: "2026-08-17T12:00:00.000Z",
  durationMs: 9000,
  mimeType: "audio/webm;codecs=opus",
  ctx: {},
};

const AUDIO = new Blob(["fake-audio-bytes"], { type: "audio/webm;codecs=opus" });

/** A trimmed real Fast Transcription response body (design §7, measured 2026-08-17). */
const OK_BODY = {
  durationMilliseconds: 9000,
  combinedPhrases: [{ text: "The attic insulation is R-19 fiberglass batts." }],
  phrases: [
    {
      offsetMilliseconds: 110,
      durationMilliseconds: 4640,
      text: "The attic insulation is R-19 fiberglass batts.",
      words: [{ text: "The", offsetMilliseconds: 110, durationMilliseconds: 120 }],
    },
  ],
};

/** A fetch double that records its call and returns a canned Response. */
function fakeFetch(response: Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("ManagedTranscriber — transcribe", () => {
  test("a recorded fixture response yields a Transcript with the expected text, recordingId, and engine id", async () => {
    const { fetchImpl } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const transcript = await t.transcribe(RECORDING, AUDIO);

    expect(transcript.text).toBe("The attic insulation is R-19 fiberglass batts.");
    expect(transcript.recordingId).toBe("rec-001");
    expect(transcript.engine).toBe(MANAGED_AZURE_SPEECH_ENGINE);
  });

  test("a 503 throws, and the thrown value is not a TranscriberUnavailableError", async () => {
    // A 503 is an attempt failure, not a capability failure. Throwing
    // TranscriberUnavailableError here would let one bad clip permanently
    // demote the engine — the exact bug the Transcriber contract exists to
    // prevent (transcriber.ts, first-capable rule 5). The queue's backoff
    // owns it, so this must throw plainly and isTransientFailure must read
    // it as retryable.
    const { fetchImpl } = fakeFetch(new Response("Service Unavailable", { status: 503 }));
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(RECORDING, AUDIO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TranscriberUnavailableError);
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a 401 throws TranscriberUnavailableError with reason not-configured", async () => {
    const { fetchImpl } = fakeFetch(new Response("Unauthorized", { status: 401 }));
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(RECORDING, AUDIO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscriberUnavailableError);
    if (error instanceof TranscriberUnavailableError) {
      expect(error.reason).toBe("not-configured");
    }
  });

  test("an oversized payload fails terminally rather than as a retryable attempt failure", async () => {
    const { fetchImpl } = fakeFetch(new Response("Too Large", { status: 413 }));
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t.transcribe(RECORDING, AUDIO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TerminalQueueError);
    expect(isTransientFailure(error)).toBe(false);
  });

  test("the request URL is the bare Azure endpoint with api-version=2025-10-15 and no /_api/fetch/ prefix", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });

    await t.transcribe(RECORDING, AUDIO);

    expect(calls).toHaveLength(1);
    // The api-version is load-bearing: a silently wrong version would lose
    // phraseList with no error (design §6). A /_api/fetch/ prefix added here
    // would double up once the host's transport adds its own (design §5.2).
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.url).toContain("api-version=2025-10-15");
    expect(calls[0]!.url).not.toContain("/_api/fetch/");
  });

  test("no credential appears in the request — no Authorization or Ocp-Apim-Subscription-Key header", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });

    await t.transcribe(RECORDING, AUDIO);

    const headers = new Headers(calls[0]!.init.headers);
    // The package has no capacity to authenticate (design §5.2). The
    // credential lives in the transport the host supplies, so the request
    // this package builds must carry no auth header at all.
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("ocp-apim-subscription-key")).toBeNull();
  });
});
