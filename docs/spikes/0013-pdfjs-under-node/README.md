# 0013 — Does pdf.js run under Node without a worker shim?

**Status:** Answered · **Date:** 2026-11-16

## The question

The eval CLI is a Node program, and its corpus format supports `document` cases — but the only
document transcriber, `@azx/ribo-transcriber-pdfjs`, reports `unsupported-platform` from
`capability()` wherever no `Worker` constructor exists, and Node has none. The CLI's runner
refuses document-kind cases by name for exactly this reason
(`packages/ribo-cli/src/eval/run.ts:198-207`). Can pdf.js itself — the text-extraction path
beneath that capability gate, which `transcribe()` runs without ever checking `Worker` — run
under Node without a worker shim? The eval design doc's §9
(`docs/roadmap/design/ribo-cli-eval-design.md`) frames the question and what each answer implies.

## The answer

**Yes — pdf.js runs under Node without a worker shim. The route is pdfjs-dist's own legacy
build (`pdfjs-dist/legacy/build/pdf.mjs`), driven through the real `PdfjsTranscriber` via its
existing `loadPdfjs` option — a build choice among pdf.js's own shipped artifacts, with no
`Worker` global defined, no polyfill and no other DOM shim.** The full three-fixture bar the
package's browser suite asserts passed end to end. The claim is scoped to **text extraction** —
the only thing eval needs; rendering was not tested and is not claimed.

The standard build does **not** run: its worker computes document fingerprints with
`Uint8Array.prototype.toHex` (`pdf.worker.mjs:59937`), which Node 24's V8 13.6 does not provide
(`typeof new Uint8Array(1).toHex` is `"undefined"`), so `getDocument` fails with
`UnknownErrorException: a.toHex is not a function`. pdf.js prints
`Warning: Please use the legacy build in Node.js environments` under Node and ships the legacy
build for exactly this — choosing it is configuration, not a shim.

This unblocks — makes decidable, no further — the deferred document-path build follow-up the
design doc names: with the `loadPdfjs` seam, the CLI could construct `PdfjsTranscriber` with the
legacy build and no `workerSrc` shim at all. The durable record of that decision's framing is
§9 of the design doc, which now carries the dated outcome.

## The check

Free and local: no model spend, no network service, no credential — extraction plays no part.
Every byte the check read is committed in the repo (the three fixture PDFs) or installed in the
local `node_modules` (`pdfjs-dist@6.4.299` and its worker scripts) — never a CDN or remote URL.
Nothing live was touched; the check only reads files and runs pdf.js in-process.

Environment: Node v24.18.0, `typeof Worker === "undefined"` observed by the check process
itself, `pdfjs-dist` 6.4.299 (the transcriber package's pinned catalog version). The script is
`run.mjs` in this directory; the invocation was:

```bash
pnpm --filter @azx/ribo-transcriber-pdfjs build   # the script imports the package's dist/
node docs/spikes/0013-pdfjs-under-node/run.mjs
```

The script is self-verifying: it exits non-zero unless every outcome recorded below reproduces —
the environment facts, A1 and A4's recorded failures, A2 and A3's extracted text, and A5's full
three-fixture bar — so a green run is only meaningful because the assertions hold.

Fixtures are the package's own, referenced in place: `text-layer.pdf` (two pages, known
strings), `three-page.pdf` (page 2 deliberately empty), `no-text-layer.pdf` (no `/Contents`).

## What was tried, and each outcome

No attempt defined any global; "shim" here means only a diagnostic polyfill, and none was
needed, so none was tried. No attempt that was run is omitted.

| Attempt | Layer                       | Build · configuration                                                                      | Fixture          | Outcome                                                                                                                                                                            |
| ------- | --------------------------- | ------------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1      | raw `getDocument`           | standard build · `workerSrc` set to the local `build/pdf.worker.min.mjs`                   | `text-layer.pdf` | **Fail** — `UnknownErrorException: a.toHex is not a function`                                                                                                                      |
| A2      | raw `getDocument`           | legacy build · `workerSrc` set to the local `legacy/build/pdf.worker.min.mjs`              | `text-layer.pdf` | **Pass** — 2 pages; page 1 "The first page says hello world to the reader here", page 2 "The second page contains different text content"                                          |
| A3      | raw `getDocument`           | legacy build · `workerSrc` left at pdf.js's own default (`"./pdf.worker.mjs"`)             | `text-layer.pdf` | **Pass** — identical text to A2; the fake worker needs no injected URL at all                                                                                                      |
| A4      | the real `PdfjsTranscriber` | its default loader (standard build) · `workerSrc` set to the local standard worker file    | `text-layer.pdf` | **Fail** — child process crashed with an uncaught `UnknownErrorException` ("a.toHex is not a function", details "TypeError: a.toHex is not a function") out of the transcribe path |
| A5      | the real `PdfjsTranscriber` | `loadPdfjs` injected to the legacy build · `workerSrc` set to the local legacy worker file | all three        | **Pass — the full bar** (below)                                                                                                                                                    |

For context, `new PdfjsTranscriber({ workerSrc: "x" }).capability()` under Node answered
`{"status":"unavailable","reason":"unsupported-platform"}` — the gate this spike's answer decides
whether to keep. `transcribe()` never consults it; the gate is the only Worker-shaped obstacle.

**A5, the full bar:** `text-layer.pdf` yielded text containing "hello world" and
"different text", with `===== PAGE 1 =====` before `===== PAGE 2 =====` (full extracted text:
`"\n===== PAGE 1 =====\nThe first page says hello world to the reader here\n\n===== PAGE 2 =====\nThe second page contains different text content\n"`); `three-page.pdf` yielded three page
markers, page 2's emptiness intact; `no-text-layer.pdf` was rejected by the guard with
`UnsupportedItemError`, reason `"no-text-layer"`. Same expectations, same fixtures, as
`pdf-text.browser.test.ts` asserts in Chromium — met here with no `Worker` global present.

Notes recorded along the way: pdf.js logs `Indexing all PDF objects` per document (the fixtures
use `startxref 0`, forcing its recovery scan) and `Ensure that the standardFontDataUrl API
parameter is provided` on the legacy build — both cosmetic warnings; text extraction is
unaffected because the fixtures' Helvetica is a base-14 font and the text comes from the content
streams. The managed-docs transcriber (`@azx/ribo-transcriber-managed-docs`) is the other route
to document text, but it is a paid, credentialed network service and so outside this spike's
free-and-local bar.

## What a shim would have had to provide

Nothing, on this route. For completeness: had the standard build been the only option, a shim
would have had to provide `Uint8Array.prototype.toHex` (the one missing piece the failure names)
in addition to the `Worker` constructor `capability()` demands — both were characterized from
failures, not solved with polyfills.
