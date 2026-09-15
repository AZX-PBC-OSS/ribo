import {
  fallbackTranscriber,
  UnsupportedItemError,
  unsupportedFallsThrough,
  type DocumentCapture,
  type Transcriber,
} from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { ManagedDocsTranscriber } from "./index.js";

/**
 * Composition test proving `ManagedDocsTranscriber` drops into the existing
 * fallback ladder with no core change:
 * `fallbackTranscriber([managedDocs, pdfjs], unsupportedFallsThrough)` —
 * managed when reachable, pdf.js when the uplink is down or the service refuses
 * the item.
 *
 * A fake `fetch` drives the managed rung; a fake pdf.js stand-in drives the
 * second. No network, no credentials, no live endpoint. The test asserts that
 * an `UnsupportedItemError` from the managed rung routes to the second rung,
 * and that a successful managed response short-circuits the ladder.
 */

const ENDPOINT =
  "https://example.invalid/documentintelligence/documentModels/prebuilt-read:analyze";

const DOC: DocumentCapture = {
  id: "doc-001",
  capturedAt: "2026-09-09T12:00:00.000Z",
  kind: "document",
  mimeType: "application/pdf",
  pageCount: 1,
  ctx: {},
};

const BYTES = new Blob(["fake-pdf-bytes"], { type: "application/pdf" });

/** A fake pdf.js transcriber that returns a canned transcript. */
function fakePdfjs(text: string): Transcriber<DocumentCapture> {
  return {
    engine: "pdfjs",
    capability: async () => ({ status: "ready" }),
    transcribe: async (item) => ({
      recordingId: item.id,
      text,
      engine: "pdfjs",
    }),
  };
}

describe("fallbackTranscriber composition — managed-docs + pdfjs", () => {
  test("a successful managed response short-circuits the ladder (pdfjs is never called)", async () => {
    let pdfjsCalled = false;
    const managed = new ManagedDocsTranscriber({
      endpoint: ENDPOINT,
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            pages: [{ pageNumber: 1, content: "Managed text from the service." }],
          }),
        ),
    });
    const pdfjs: Transcriber<DocumentCapture> = {
      engine: "pdfjs",
      capability: async () => ({ status: "ready" }),
      transcribe: async () => {
        pdfjsCalled = true;
        return { recordingId: "x", text: "should not happen", engine: "pdfjs" };
      },
    };

    const composite = fallbackTranscriber([managed, pdfjs], unsupportedFallsThrough);
    const transcript = await composite.transcribe(DOC, BYTES);

    expect(transcript.engine).toBe("managed-docs");
    expect(transcript.text).toContain("Managed text from the service.");
    expect(pdfjsCalled).toBe(false);
  });

  test("an UnsupportedItemError from managed-docs falls through to pdfjs", async () => {
    // The managed service returns 415 (unsupported format) — the document is
    // an image-only PDF the managed text-extraction model cannot read.
    // UnsupportedItemError is terminal for the queue but not for the item:
    // the ladder routes to pdf.js, which reads it.
    const managed = new ManagedDocsTranscriber({
      endpoint: ENDPOINT,
      fetchImpl: () => Promise.resolve(new Response("Unsupported Media Type", { status: 415 })),
    });
    const pdfjs = fakePdfjs("Pdf.js text extraction result.");

    const composite = fallbackTranscriber([managed, pdfjs], unsupportedFallsThrough);
    const transcript = await composite.transcribe(DOC, BYTES);

    expect(transcript.engine).toBe("pdfjs");
    expect(transcript.text).toBe("Pdf.js text extraction result.");
  });

  test("a no-text-layer error from managed-docs falls through to pdfjs", async () => {
    // The managed service returns 200 but with no extractable text (a scanned
    // PDF). The no-text-layer guard throws UnsupportedItemError, which routes
    // to pdf.js.
    const managed = new ManagedDocsTranscriber({
      endpoint: ENDPOINT,
      fetchImpl: () => Promise.resolve(Response.json({ pages: [{ pageNumber: 1, content: "" }] })),
    });
    const pdfjs = fakePdfjs("Pdf.js OCR result.");

    const composite = fallbackTranscriber([managed, pdfjs], unsupportedFallsThrough);
    const transcript = await composite.transcribe(DOC, BYTES);

    expect(transcript.engine).toBe("pdfjs");
    expect(transcript.text).toBe("Pdf.js OCR result.");
  });

  test("an encrypted error from managed-docs falls through to pdfjs", async () => {
    const managed = new ManagedDocsTranscriber({
      endpoint: ENDPOINT,
      fetchImpl: () =>
        Promise.resolve(
          Response.json(
            { error: { code: "EncryptedDocument", message: "Password required." } },
            { status: 422 },
          ),
        ),
    });
    const pdfjs = fakePdfjs("Pdf.js read the document.");

    const composite = fallbackTranscriber([managed, pdfjs], unsupportedFallsThrough);
    const transcript = await composite.transcribe(DOC, BYTES);

    expect(transcript.engine).toBe("pdfjs");
  });

  test("a 503 from managed-docs does NOT fall through — it is an attempt failure", async () => {
    // A 503 is a transient outage, not item unsuitability. The ladder must not
    // route to pdf.js on a 503: one bad server response must never re-route
    // the item to a different engine (transcriber.ts, D7 rule 4).
    let pdfjsCalled = false;
    const managed = new ManagedDocsTranscriber({
      endpoint: ENDPOINT,
      fetchImpl: () => Promise.resolve(new Response("Service Unavailable", { status: 503 })),
    });
    const pdfjs: Transcriber<DocumentCapture> = {
      engine: "pdfjs",
      capability: async () => ({ status: "ready" }),
      transcribe: async () => {
        pdfjsCalled = true;
        return { recordingId: "x", text: "", engine: "pdfjs" };
      },
    };

    const composite = fallbackTranscriber([managed, pdfjs], unsupportedFallsThrough);
    const error = await composite.transcribe(DOC, BYTES).catch((e: unknown) => e);

    expect(pdfjsCalled).toBe(false);
    expect(error).not.toBeInstanceOf(UnsupportedItemError);
  });

  test("every rung throwing UnsupportedItemError gives up with a terminal error", async () => {
    const managed = new ManagedDocsTranscriber({
      endpoint: ENDPOINT,
      fetchImpl: () => Promise.resolve(new Response("Unsupported", { status: 415 })),
    });
    const pdfjs: Transcriber<DocumentCapture> = {
      engine: "pdfjs",
      capability: async () => ({ status: "ready" }),
      transcribe: async () => {
        throw new UnsupportedItemError({
          engine: "pdfjs",
          reason: "no-text-layer",
          detail: "scanned PDF",
        });
      },
    };

    const composite = fallbackTranscriber([managed, pdfjs], unsupportedFallsThrough);
    const error = await composite.transcribe(DOC, BYTES).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsupportedItemError);
  });
});
