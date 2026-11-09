/**
 * The runnable example behind docs/api/managed-transcriber.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the endpoint is never real, and the
 * transport is an injected `fetch` double.
 */

import assert from "node:assert/strict";
import { type Recording, TranscriberUnavailableError } from "@azx/ribo-core";
import { MANAGED_AZURE_SPEECH_ENGINE, ManagedTranscriber } from "@azx/ribo-transcriber-managed";

const ENDPOINT = "https://example.invalid/transcribe?api-version=2024-11-15";

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

/** A `fetch` double answering `status` with `body` as JSON. */
function fetchReturning(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

export async function withoutConfigurationCapabilityReportsNotConfigured(): Promise<void> {
  // #region usage
  const engine = new ManagedTranscriber();
  const capability = await engine.capability();
  // #endregion usage
  assert.equal(capability.status, "unavailable");
  assert.equal(capability.reason, "not-configured");
}

export async function connectivityIsAnInjectedPredicate(): Promise<void> {
  const online = new ManagedTranscriber({ endpoint: ENDPOINT });
  // No predicate supplied: the optimistic default reports the network up.
  assert.deepEqual(await online.capability(), { status: "ready" });

  const offline = new ManagedTranscriber({ endpoint: ENDPOINT, isOnline: () => false });
  const capability = await offline.capability();
  assert.equal(capability.status, "unavailable");
  assert.equal(capability.reason, "offline");
}

export async function transcriptionRunsThroughTheInjectedTransport(): Promise<void> {
  let seenDefinition: string | undefined;
  const doFetch: typeof fetch = async (_url, init) => {
    const form = init?.body as FormData;
    seenDefinition = form.get("definition") as string;
    return new Response(
      JSON.stringify({ combinedPhrases: [{ text: "Kitchen leak found under the sink" }] }),
      { status: 200 },
    );
  };
  const engine = new ManagedTranscriber({
    endpoint: ENDPOINT,
    fetchImpl: doFetch,
    vocabulary: ["R-value"],
  });

  const transcript = await engine.transcribe(recording("cap-1"), new Blob(["not really audio"]));

  assert.equal(transcript.recordingId, "cap-1");
  assert.equal(transcript.text, "Kitchen leak found under the sink");
  assert.equal(transcript.engine, MANAGED_AZURE_SPEECH_ENGINE);
  // The host's vocabulary reaches the service as the definition's phrase list.
  const definition = JSON.parse(seenDefinition!) as { phraseList?: { phrases: string[] } };
  assert.deepEqual(definition.phraseList, { phrases: ["R-value"] });
}

export async function a401IsACapabilityFailureNotAnAttemptFailure(): Promise<void> {
  const engine = new ManagedTranscriber({
    endpoint: ENDPOINT,
    fetchImpl: fetchReturning(401, {}),
  });

  await assert.rejects(
    engine.transcribe(recording("cap-1"), new Blob(["not really audio"])),
    (error: unknown) => {
      assert.ok(error instanceof TranscriberUnavailableError);
      assert.equal(error.reason, "not-configured");
      return true;
    },
  );
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The engine id is a published constant, read from
  // packages/ribo-transcriber-managed/src/config.ts — it rides into every
  // Transcript.engine this package produces. The page quotes the value in
  // prose next to this region; a source change that moved it fails here.
  assert.equal(MANAGED_AZURE_SPEECH_ENGINE, "managed-azure-speech");
  // The optimistic connectivity default is not exported, so it is observed:
  // with an endpoint and no predicate, capability reports ready.
  assert.deepEqual(await new ManagedTranscriber({ endpoint: ENDPOINT }).capability(), {
    status: "ready",
  });
}
// #endregion defaults
