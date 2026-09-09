/**
 * @file Flatten a managed document analysis response into text.
 *
 * The seam returns {@link Transcript}, whose payload is a single `text` string.
 * A managed document understanding API returns structured content — pages with
 * text, tables with rows and cells — so this module flattens that structure into
 * a plain string that preserves row/column adjacency.
 *
 * **The output conventions match `@azx/ribo-transcriber-pdfjs`** so a downstream
 * prompt does not have to know which engine produced the text:
 *
 * - Cells in a table row are joined with `" | "` (the same separator
 *   `page-layout.ts`'s `COLUMN_SEPARATOR` uses).
 * - Rows are separated by newlines (the same join `layoutPageText` uses).
 * - Each page is preceded by `\n===== PAGE n =====\n`, numbered from 1 — the
 *   same marker `pdf-text.ts`'s `PAGE_MARKER` produces.
 *
 * These constants are defined locally rather than imported from the pdfjs
 * package, because workspace packages depend only on `@azx/ribo-core`, never on
 * each other (AGENTS.md §3). They must stay in sync with the pdfjs package's
 * constants; a divergence would make a downstream prompt read two different
 * formats depending on which engine ran, which is exactly the failure this
 * module exists to prevent.
 */

/** Matches `PAGE_MARKER` in `ribo-transcriber-pdfjs/src/pdf-text.ts`. */
const PAGE_MARKER = "\n===== PAGE ";

/** Matches `COLUMN_SEPARATOR` in `ribo-transcriber-pdfjs/src/page-layout.ts`. */
const COLUMN_SEPARATOR = " | ";

/** The subset of a document analysis response body this module reads. */
export interface DocumentAnalysisResponse {
  pages?: ReadonlyArray<DocumentAnalysisPage>;
}

/** One page from the response. */
export interface DocumentAnalysisPage {
  /** 1-based page number. Falls back to array index + 1 if absent. */
  readonly pageNumber?: number;
  /** Plain text content for the page, if the service provides one. */
  readonly content?: string;
  /** Structured tables on the page, if any. */
  readonly tables?: ReadonlyArray<DocumentAnalysisTable>;
}

/** A table in the response. */
export interface DocumentAnalysisTable {
  /** Rows of cells, top to bottom. */
  readonly rows?: ReadonlyArray<ReadonlyArray<DocumentAnalysisCell>>;
}

/** One cell in a table row. */
export interface DocumentAnalysisCell {
  /** The cell's text content. */
  readonly text?: string;
}

/** The subset of an error response body this module reads. */
export interface DocumentAnalysisErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

/**
 * Flatten a document analysis response into a single text string with page
 * markers and table separators matching pdfjs conventions.
 *
 * Pages are emitted in array order, each preceded by its page marker. Within a
 * page, text `content` is emitted first (if present), then each table: rows
 * joined by newlines, cells in a row joined by `" | "`. A trailing newline
 * follows each page's content, matching `pdf-text.ts`'s per-page format.
 */
export function flattenDocumentAnalysisResponse(body: DocumentAnalysisResponse): string {
  const pages = body.pages ?? [];
  return pages
    .map((page, index) => {
      const pageNumber = page.pageNumber ?? index + 1;
      const parts: string[] = [];
      if (page.content) parts.push(page.content);
      if (page.tables) {
        for (const table of page.tables) {
          const rows = table.rows ?? [];
          const tableText = rows
            .map((row) =>
              row.map((cell) => cell?.text ?? "").join(COLUMN_SEPARATOR),
            )
            .join("\n");
          if (tableText) parts.push(tableText);
        }
      }
      return PAGE_MARKER + pageNumber + " =====\n" + parts.join("\n") + "\n";
    })
    .join("");
}

/**
 * Strip page markers and all whitespace from a flattened document text.
 *
 * Used by the no-text-layer guard: if what remains is empty, the document
 * yielded no extractable text. Mirrors `pdf-text.ts`'s stripping logic, adapted
 * to the same page-marker format.
 */
export function stripMarkersAndWhitespace(text: string): string {
  return text.replace(/===== PAGE \d+ =====/g, "").replace(/\s/g, "");
}

/**
 * Check whether an error response body indicates an encrypted or
 * password-protected document.
 *
 * Identification is by error `code` (case-insensitive), not by HTTP status alone:
 * a 422 is ambiguous (it could be a service-side validation issue), so only a
 * clear encrypted/password indicator in the error code maps to
 * `UnsupportedItemError("encrypted")`. This is deliberately conservative —
 * mapping an ambiguous 422 to `encrypted` would let a transient service bug
 * permanently kill an item that pdf.js might read fine.
 */
export function isEncryptedError(body: DocumentAnalysisErrorBody): boolean {
  const code = body.error?.code?.toLowerCase() ?? "";
  return code.includes("encrypt") || code.includes("password");
}
