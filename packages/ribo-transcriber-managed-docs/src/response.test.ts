import { describe, expect, test } from "vitest";

import {
  flattenDocumentAnalysisResponse,
  isEncryptedError,
  stripMarkersAndWhitespace,
  type DocumentAnalysisResponse,
} from "./response.js";

/**
 * Response flattening tests. Pure — no network, no fetch, no DOM. These pin the
 * output conventions that must match `@azx/ribo-transcriber-pdfjs`'s
 * `page-layout.ts` and `pdf-text.ts`: `" | "` between cells, newlines between
 * rows, `\n===== PAGE n =====\n` per page.
 */

describe("flattenDocumentAnalysisResponse", () => {
  test("plain text content is emitted with page markers", () => {
    const body: DocumentAnalysisResponse = {
      pages: [
        { pageNumber: 1, content: "Attic insulation: R-19 fiberglass batts." },
        { pageNumber: 2, content: "Basement insulation: R-10 rigid foam." },
      ],
    };

    const text = flattenDocumentAnalysisResponse(body);

    expect(text).toContain("\n===== PAGE 1 =====\n");
    expect(text).toContain("Attic insulation: R-19 fiberglass batts.");
    expect(text).toContain("\n===== PAGE 2 =====\n");
    expect(text).toContain("Basement insulation: R-10 rigid foam.");
  });

  test("tables are flattened with ' | ' between cells and newlines between rows", () => {
    const body: DocumentAnalysisResponse = {
      pages: [
        {
          pageNumber: 1,
          tables: [
            {
              rows: [
                [{ text: "Label" }, { text: "Value" }],
                [{ text: "Subtotal" }, { text: "$70,903.33" }],
              ],
            },
          ],
        },
      ],
    };

    const text = flattenDocumentAnalysisResponse(body);

    expect(text).toContain("Label | Value");
    expect(text).toContain("Subtotal | $70,903.33");
    // Rows are separated by newlines, not the column separator.
    expect(text).toContain("Label | Value\nSubtotal | $70,903.33");
  });

  test("content and tables on the same page are both emitted, content first", () => {
    const body: DocumentAnalysisResponse = {
      pages: [
        {
          pageNumber: 1,
          content: "Invoice Summary",
          tables: [
            {
              rows: [
                [{ text: "Total" }, { text: "$70,903.33" }],
              ],
            },
          ],
        },
      ],
    };

    const text = flattenDocumentAnalysisResponse(body);

    expect(text).toContain("Invoice Summary");
    expect(text).toContain("Total | $70,903.33");
    // Content appears before table.
    expect(text.indexOf("Invoice Summary")).toBeLessThan(text.indexOf("Total | $70,903.33"));
  });

  test("pageNumber falls back to 1-based array index when absent", () => {
    const body: DocumentAnalysisResponse = {
      pages: [{ content: "First" }, { content: "Second" }],
    };

    const text = flattenDocumentAnalysisResponse(body);

    expect(text).toContain("\n===== PAGE 1 =====\n");
    expect(text).toContain("\n===== PAGE 2 =====\n");
  });

  test("empty pages array yields empty string", () => {
    expect(flattenDocumentAnalysisResponse({ pages: [] })).toBe("");
  });

  test("no pages key yields empty string", () => {
    expect(flattenDocumentAnalysisResponse({})).toBe("");
  });

  test("page with no content and no tables yields just the marker", () => {
    const text = flattenDocumentAnalysisResponse({ pages: [{ pageNumber: 1 }] });
    expect(text).toBe("\n===== PAGE 1 =====\n\n");
  });

  test("multiple tables on a page are separated by newlines", () => {
    const body: DocumentAnalysisResponse = {
      pages: [
        {
          pageNumber: 1,
          tables: [
            { rows: [[{ text: "A" }, { text: "B" }]] },
            { rows: [[{ text: "C" }, { text: "D" }]] },
          ],
        },
      ],
    };

    const text = flattenDocumentAnalysisResponse(body);

    expect(text).toContain("A | B");
    expect(text).toContain("C | D");
    expect(text).toContain("A | B\nC | D");
  });

  test("cells with missing text are treated as empty strings", () => {
    const body: DocumentAnalysisResponse = {
      pages: [
        {
          pageNumber: 1,
          tables: [
            { rows: [[{ text: "A" }, {}, { text: "C" }]] },
          ],
        },
      ],
    };

    const text = flattenDocumentAnalysisResponse(body);

    expect(text).toContain("A |  | C");
  });
});

describe("stripMarkersAndWhitespace", () => {
  test("strips page markers and whitespace, leaving only text", () => {
    const text = "\n===== PAGE 1 =====\nHello World\n===== PAGE 2 =====\nFoo Bar\n";
    expect(stripMarkersAndWhitespace(text)).toBe("HelloWorldFooBar");
  });

  test("empty string stays empty", () => {
    expect(stripMarkersAndWhitespace("")).toBe("");
  });

  test("only markers and whitespace yields empty", () => {
    expect(stripMarkersAndWhitespace("\n===== PAGE 1 =====\n  \n")).toBe("");
  });
});

describe("isEncryptedError", () => {
  test("detects 'EncryptedDocument' error code", () => {
    expect(isEncryptedError({ error: { code: "EncryptedDocument" } })).toBe(true);
  });

  test("detects 'PasswordProtected' error code (case-insensitive)", () => {
    expect(isEncryptedError({ error: { code: "passwordprotected" } })).toBe(true);
  });

  test("detects 'encrypted' substring in code", () => {
    expect(isEncryptedError({ error: { code: "DocumentIsEncrypted" } })).toBe(true);
  });

  test("does not match unrelated error codes", () => {
    expect(isEncryptedError({ error: { code: "InvalidDocument" } })).toBe(false);
    expect(isEncryptedError({ error: { code: "TooManyPages" } })).toBe(false);
  });

  test("missing error code is not encrypted", () => {
    expect(isEncryptedError({})).toBe(false);
    expect(isEncryptedError({ error: {} })).toBe(false);
  });
});
