/**
 * @file The bundle-time stand-in for the literal `import("pdfjs-dist")` the
 * bundled `@azx/ribo-transcriber-pdfjs` carries in its default loader.
 *
 * The CLI never lets that default run — `documents.ts` always injects
 * `loadPdfjs`, pointing at the legacy build resolved out of the installed
 * `pdfjs-dist` at run time — so the specifier's target only has to exist,
 * never to work. This module is what the bin's bundler aliases the specifier
 * to (see `tsdown.config.ts`), for two reasons:
 *
 * - bundling the real module would ship ~770 kB of pdf.js the bin never
 *   evaluates, and pdf.js's own source carries an `import("...")` string
 *   (its CDN-wrapper template) that the pack-and-consume tier's specifier
 *   scan refuses; and
 * - leaving the specifier external would put a literal non-`node:*` import
 *   in the shipped bin, which the same tier refuses.
 *
 * Any call reaching this module means that invariant broke: a caller drove
 * the bundled transcriber without injecting `loadPdfjs`.
 */
import type { PdfjsModule } from "@azx/ribo-transcriber-pdfjs";

const never = (): never => {
  throw new Error(
    "ribo: the bundled pdf.js default loader ran — the CLI's document path always injects " +
      "loadPdfjs with the legacy build resolved from the installed pdfjs-dist, so reaching " +
      "this module means that wiring broke",
  );
};

/** The `PdfjsModule` shape, with every entry point refusing. */
const stub: PdfjsModule = {
  getDocument: () => never(),
  GlobalWorkerOptions: { workerSrc: "" },
};

export const getDocument: PdfjsModule["getDocument"] = stub.getDocument;
export const GlobalWorkerOptions: PdfjsModule["GlobalWorkerOptions"] = stub.GlobalWorkerOptions;
