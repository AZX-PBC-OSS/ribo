/**
 * @file Ambient declarations for Vite's `?url` asset imports.
 *
 * Only the colocated `*.browser.test.ts` files use these — they import the
 * pdf.js worker and fixture PDFs as served URLs. Vite resolves `?url` to the
 * emitted asset path; `tsc` needs these declarations to type them, since this
 * package does not pull in `vite/client`.
 */
declare module "*.pdf?url" {
  const url: string;
  export default url;
}

declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const url: string;
  export default url;
}
