/**
 * @file The transcribe request path for {@link ManagedTranscriber}.
 *
 * POST the recording's audio blob as `multipart/form-data` to the Azure Fast
 * Transcription endpoint through the injected `fetch`, and map the response onto
 * a {@link Transcript}. The request shape is verified against the live endpoint
 * (design §7, measured 2026-08-17): two form parts — `audio` carrying the blob
 * as recorded (no transcode, no re-containering) and `definition` carrying JSON.
 *
 * **The URL is the configured endpoint as-is.** The package does not prefix
 * `/_api/fetch/` — routing is the host transport's job (design §5.2). Baking
 * the gateway into the package would double up once the host's transport adds
 * its own prefix.
 *
 * ## Failure classification — the point of this task
 *
 * Getting this wrong is the bug `Transcriber`'s contract exists to prevent
 * (`transcriber.ts`, `first-capable` rule 5):
 *
 * - **5xx, timeout, network error, malformed body → attempt failure.** Throw
 *   plainly with the HTTP `status` attached so `isTransientFailure` can
 *   classify it (5xx → retryable, 4xx → dead). These must **not** be
 *   {@link TranscriberUnavailableError}, because a single bad clip would then
 *   permanently demote the engine.
 * - **401 / 403 → capability failure.** The credential is missing or wrong and
 *   the host can fix it. Throw {@link TranscriberUnavailableError} with reason
 *   `not-configured` so `firstCapable` demotes the engine and the next attempt
 *   routes elsewhere.
 * - **413 → terminal.** The payload is too large for the transport. Retrying
 *   an oversized body forever is worse than failing it. Throw
 *   {@link TerminalQueueError} — the queue's existing terminal vocabulary, not
 *   a second retry classifier.
 */
import { TerminalQueueError, TranscriberUnavailableError } from "@azx/ribo-core";
import type { Recording, Transcript } from "@azx/ribo-core";

import { buildDefinition } from "./definition.js";

/** The subset of the Fast Transcription response body this module reads. */
interface FastTranscriptionResponse {
  readonly combinedPhrases?: ReadonlyArray<{ readonly text?: unknown }>;
}

/** Inputs for {@link transcribeViaManagedAzure} — supplied by the class. */
export interface TranscribeViaManagedAzureOptions {
  /** The Azure transcribe endpoint URL, already carrying `?api-version=...`. */
  readonly endpoint: string;
  /** The injected `fetch` — the host's transport, credential-attaching or not. */
  readonly doFetch: typeof fetch;
  /** `Transcriber.engine` — stamped onto the resulting `Transcript.engine`. */
  readonly engine: string;
  /**
   * Domain terms sent as `definition.phraseList.phrases` (Task 5). Omitted or
   * empty sends no `phraseList` — see {@link buildDefinition}.
   */
  readonly vocabulary?: readonly string[];
}

/**
 * Send the audio blob to the Fast Transcription endpoint and map the response.
 *
 * The package adds **no credential** to the request — no `Authorization` header,
 * no `Ocp-Apim-Subscription-Key`. Whatever auth the call needs is the
 * transport's responsibility (design §5.2). The `Content-Type` header is set
 * automatically by `FormData` (the browser/Node generates the multipart
 * boundary), so it is not set explicitly either.
 */
export async function transcribeViaManagedAzure(
  recording: Recording,
  audio: Blob,
  options: TranscribeViaManagedAzureOptions,
): Promise<Transcript> {
  const { endpoint, doFetch, engine, vocabulary } = options;

  // Two form parts: the audio blob as recorded, and the definition JSON. The
  // definition carries `locales` always, and `phraseList.phrases` when the host
  // supplied a vocabulary (Task 5, design §6). `buildDefinition` omits
  // `phraseList` entirely when there are no terms — an empty phrase list is no
  // phrase list.
  const form = new FormData();
  form.append("audio", audio);
  form.append("definition", JSON.stringify(buildDefinition(vocabulary)));

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      body: form,
    });
  } catch (cause) {
    // Network error, timeout, DNS failure — attempt failures. Throw plainly
    // (no `status`) so `isTransientFailure` reads it as retryable. These must
    // not be `TranscriberUnavailableError`, or one bad clip permanently
    // demotes the engine (transcriber.ts, first-capable rule 5).
    throw new Error(
      `${engine}: request to ${endpoint} failed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  // 401 / 403 — the credential is missing or wrong. A capability failure the
  // host can fix: throw `TranscriberUnavailableError` with `not-configured` so
  // `firstCapable` demotes the engine and the next attempt re-probes.
  if (response.status === 401 || response.status === 403) {
    throw new TranscriberUnavailableError({
      engine,
      reason: "not-configured",
      detail: `Azure transcribe endpoint returned ${response.status} — the credential is missing or wrong.`,
    });
  }

  // 413 — the payload is too large for the transport. Terminal, not retryable:
  // retrying an oversized body forever is worse than failing it. Use the
  // queue's existing `TerminalQueueError` rather than inventing a second
  // classifier.
  if (response.status === 413) {
    throw new TerminalQueueError(
      `${engine}: the recording (${audio.size} bytes) was rejected as too large (413) ` +
        `by ${endpoint}. A retry would send the same oversized body.`,
    );
  }

  // Any other non-2xx — attempt failure. Attach the `status` so
  // `isTransientFailure` can classify: 5xx → transient (retryable), other 4xx
  // → dead. This is the queue's existing heuristic, not a second classifier.
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(
      new Error(
        `${engine}: ${response.status} ${response.statusText} from ${endpoint}` +
          (detail ? `: ${detail.slice(0, 500)}` : ""),
      ),
      { status: response.status },
    );
  }

  // Parse the response body. A malformed body is an attempt failure — throw
  // plainly (no `status`) so `isTransientFailure` reads it as retryable.
  let body: FastTranscriptionResponse;
  try {
    body = (await response.json()) as FastTranscriptionResponse;
  } catch (cause) {
    throw new Error(`${engine}: response from ${endpoint} was not valid JSON`, {
      cause,
    });
  }

  const text = body.combinedPhrases?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`${engine}: response from ${endpoint} had no combinedPhrases[0].text string`);
  }

  return {
    recordingId: recording.id,
    text,
    engine,
  };
}
