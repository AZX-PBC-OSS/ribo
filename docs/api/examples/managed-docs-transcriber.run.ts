/**
 * The runnable example behind docs/api/managed-docs-transcriber.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the endpoint is never real, and the
 * transport is an injected `fetch` double.
 */

import assert from "node:assert/strict";
import { type DocumentCapture, TerminalError, UnsupportedItemError } from "@azx/ribo-core";
import { MANAGED_DOCS_ENGINE, ManagedDocsTranscriber } from "@azx/ribo-transcriber-managed-docs";

const ENDPOINT = "https://example.invalid/documentintelligence/documentId:analyze";

function document(id: string): DocumentCapture {
  return {
    id,
    capturedAt: new Date().toISOString(),
    kind: "document",
    pageCount: 2,
    mimeType: "application/pdf",
    ctx: {},
  };
}

/** A `fetch` double answering `status` with `body` as JSON. */
function fetchReturning(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

export async function withoutConfigurationCapabilityReportsNotConfigured(): Promise<void> {
  // #region usage
  const engine = new ManagedDocsTranscriber();
  const capability = await engine.capability();
  // #endregion usage
  assert.equal(capability.status, "unavailable");
  assert.equal(capability.reason, "not-configured");
}

export async function theResponseIsFlattenedWithPageMarkersAndTableRows(): Promise<void> {
  const doFetch = fetchReturning(200, {
    pages: [
      { pageNumber: 1, content: "Blower door test" },
      { pageNumber: 2, tables: [{ rows: [[{ text: "R-19" }, { text: "attic" }]] }] },
    ],
  });
  const engine = new ManagedDocsTranscriber({ endpoint: ENDPOINT, fetchImpl: doFetch });

  const transcript = await engine.transcribe(document("cap-doc"), new Blob(["%PDF-1.7 …"]));

  assert.equal(transcript.recordingId, "cap-doc");
  assert.equal(transcript.engine, MANAGED_DOCS_ENGINE);
  assert.ok(transcript.text.includes("\n===== PAGE 1 =====\nBlower door test\n"));
  // Cells in a table row are joined the way pdf.js's layout joins them, so a
  // downstream prompt cannot tell which engine produced the text.
  assert.ok(transcript.text.includes("R-19 | attic"));
}

export async function aDocumentWithNoTextIsUnsuitableNotFailed(): Promise<void> {
  const engine = new ManagedDocsTranscriber({
    endpoint: ENDPOINT,
    fetchImpl: fetchReturning(200, { pages: [{ content: "   " }] }),
  });

  await assert.rejects(
    engine.transcribe(document("cap-scan"), new Blob(["%PDF-1.7 …"])),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedItemError);
      assert.equal(error.reason, "no-text-layer");
      // Item unsuitability is terminal for the queue but not for the item —
      // a fallback ladder routes the scan to the next engine.
      assert.ok(error instanceof TerminalError);
      return true;
    },
  );
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The engine id is a published constant, read from
  // packages/ribo-transcriber-managed-docs/src/config.ts — it rides into every
  // Transcript.engine this package produces. The page quotes the value in
  // prose next to this region; a source change that moved it fails here.
  assert.equal(MANAGED_DOCS_ENGINE, "managed-docs");
}
// #endregion defaults
