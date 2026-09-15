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
  kind: "audio",
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
    // A `Request` has no meaningful string form, so take the URL off whichever
    // member of the union arrived rather than coercing the whole object.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Pull the `definition` form part out of a recorded request body and parse it.
 * The Fast Transcription request sends `definition` as a stringified-JSON form
 * part alongside the `audio` blob (design §7), so the phrase-list assertions
 * inspect the body the package actually built, not a builder return value.
 */
function parseDefinition(calls: Array<{ url: string; init: RequestInit }>): unknown {
  const form = calls[0]!.init.body as FormData;
  const raw = form.get("definition");
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string);
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

  // --- Task 5 — the phrase list --------------------------------------------------
  //
  // The vocabulary belongs to the host, not this package (plan Task 5). These
  // tests assert the request body the package builds, because a plausible-looking
  // wrong key is silently ignored by the service — no error, just worse
  // transcription (design §6, measured 2026-08-17: "our 19" → "R-19").

  test("supplied vocabulary appears at definition.phraseList.phrases in the request body — exact nesting", async () => {
    // The exact nesting is load-bearing: `phraseList.phrases` is the only key
    // the service reads. `phrase_list`, `phraseHints` or a bare array would be
    // silently ignored, so assert the nesting on the body, not just "phrases
    // exist".
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedTranscriber({
      endpoint: ENDPOINT,
      fetchImpl,
      vocabulary: ["R-19", "CFM50", "blower door"],
    });

    await t.transcribe(RECORDING, AUDIO);

    const definition = parseDefinition(calls) as {
      phraseList?: { phrases?: unknown };
    };
    expect(definition.phraseList).toEqual({ phrases: ["R-19", "CFM50", "blower door"] });
  });

  test("no vocabulary supplied omits phraseList entirely from the request body", async () => {
    // An empty phrase list is no phrase list. Sending `phraseList: { phrases: [] }`
    // would be a meaningless part the service did not ask for; assert the key is
    // absent, not merely empty.
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });

    await t.transcribe(RECORDING, AUDIO);

    const definition = parseDefinition(calls) as { phraseList?: unknown };
    expect(definition.phraseList).toBeUndefined();
    expect("phraseList" in definition).toBe(false);
  });

  test("locales is still present in the request body when a phrase list is supplied", async () => {
    // A builder that *replaces* the definition instead of extending it would
    // pass a naive phrase-list test while silently breaking language selection.
    // `locales` must survive alongside `phraseList`.
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedTranscriber({
      endpoint: ENDPOINT,
      fetchImpl,
      vocabulary: ["R-19"],
    });

    await t.transcribe(RECORDING, AUDIO);

    const definition = parseDefinition(calls) as {
      locales?: unknown;
      phraseList?: unknown;
    };
    expect(definition.locales).toEqual(["en-US"]);
    expect(definition.phraseList).toBeDefined();
  });
});

// --- Cancellation — Task 2 of the widen-transcriber-contract plan -----------------
//
// Two properties must hold, and neither may be asserted on "the promise
// rejected": the transport must OBSERVE the caller's signal (by identity, and
// by actually being torn down by it), and a cancellation must be classified
// terminal so the queue does not burn its retry budget re-running work the
// caller withdrew.

describe("ManagedTranscriber — cancellation", () => {
  test("the caller's signal reaches the fetch init — by identity", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });
    const controller = new AbortController();

    await t.transcribe(RECORDING, AUDIO, { signal: controller.signal });

    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  test("aborting mid-flight aborts the in-flight request — the transport observed the abort, and the rejection is terminal", async () => {
    // A fetch double with REAL abort semantics: it rejects only when the signal
    // it was handed fires. If the implementation stops forwarding the signal,
    // this promise never settles and the test times out — a hung test IS the
    // observation that the transport never saw the abort. An implementation that
    // forwards the signal but not the classification fails the assertions below.
    let observed: AbortSignal | undefined;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        observed?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    }) as typeof fetch;
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });
    const controller = new AbortController();

    const pending = t.transcribe(RECORDING, AUDIO, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);

    // The transport observed the abort, not merely a rejection.
    expect(observed?.aborted).toBe(true);
    // ...and the classification: terminal, so the queue does not retry a
    // cancelled transcription the way it retries a flaky network.
    expect(error).toBeInstanceOf(TerminalQueueError);
    expect(isTransientFailure(error)).toBe(false);
  });

  test("an already-aborted signal cancels before the request is sent", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return Response.json(OK_BODY);
    }) as typeof fetch;
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });
    const controller = new AbortController();
    controller.abort();

    const error = await t
      .transcribe(RECORDING, AUDIO, { signal: controller.signal })
      .catch((e: unknown) => e);

    // The caller withdrew before the call — nothing may reach the network.
    expect(calls).toBe(0);
    expect(error).toBeInstanceOf(TerminalQueueError);
  });

  test("a genuine network failure stays retryable — the cancellation path must not swallow it", async () => {
    const fetchImpl = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const t = new ManagedTranscriber({ endpoint: ENDPOINT, fetchImpl });

    const error = await t
      .transcribe(RECORDING, AUDIO, { signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(TerminalQueueError);
    expect(isTransientFailure(error)).toBe(true);
  });
});
