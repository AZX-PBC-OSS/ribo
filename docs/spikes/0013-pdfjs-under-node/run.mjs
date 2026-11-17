// Spike 0013: does pdf.js run under Node without a worker shim?
//
// Free, local, offline: no model, no network service, no credential. Every byte
// read is committed in the repo (the fixture PDFs) or installed in the local
// node_modules (pdfjs-dist 6.4.299 and its worker scripts).
//
// The script is self-verifying: it exits non-zero unless every outcome the
// README records reproduces — the environment facts, A1/A4's recorded failures,
// A2/A3's extracted text, and A5's full three-fixture bar. A green exit is only
// meaningful because the assertions are load-bearing.
//
// Attempts, each recorded in the README:
//   env      — what the process actually sees (Worker, Uint8Array.prototype.toHex)
//   A1       — raw getDocument, standard build, workerSrc set to the local worker file
//   A2       — raw getDocument, legacy build, workerSrc set to the local legacy worker file
//   A3       — raw getDocument, legacy build, workerSrc left at pdf.js's own default
//   A4       — the real PdfjsTranscriber, its DEFAULT loader (standard build)
//   A5       — the real PdfjsTranscriber with loadPdfjs injected to the legacy build,
//              run against the full three-fixture bar (the criterion the answer rides on)
//
// The real-transcriber attempts (A4, A5) run in child processes because the
// package memoizes its pdf.js module load per process and its dist/ export
// surface has no cache reset, so the standard and legacy builds cannot share
// one process honestly.
//
//   node run.mjs
//
// Fixtures are referenced in place, not copied (D2): the three committed PDFs
// under packages/ribo-transcriber-pdfjs/src/fixtures/, the same bytes the
// package's browser suite asserts against.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = new URL(".", import.meta.url);
const repoRoot = new URL("../../..", here);
const pkgRoot = new URL("packages/ribo-transcriber-pdfjs/", repoRoot);
const pdfjsRoot = new URL("node_modules/pdfjs-dist/", pkgRoot);
const fixtures = new URL("src/fixtures/", pkgRoot);
const transcriberEntry = new URL("dist/index.js", pkgRoot).href;
const legacyEntry = new URL("legacy/build/pdf.mjs", pdfjsRoot).href;
const standardWorker = fileURLToPath(new URL("build/pdf.worker.min.mjs", pdfjsRoot));
const legacyWorker = fileURLToPath(new URL("legacy/build/pdf.worker.min.mjs", pdfjsRoot));

// The version the README's answer is tied to (R3): a bump invalidates the record.
const RECORDED_PDFJS_VERSION = "6.4.299";

let failed = false;
function expect(cond, label, detail) {
  if (cond) {
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed = true;
    console.log(`FAIL ${label} — ${detail ?? "no detail"}`);
  }
}

function readFixture(name) {
  return new Blob([readFileSync(fileURLToPath(new URL(name, fixtures)))], {
    type: "application/pdf",
  });
}

function capture(pageCount) {
  return {
    id: `spike-${pageCount}`,
    kind: "document",
    capturedAt: "2026-11-13T12:00:00.000Z",
    mimeType: "application/pdf",
    ctx: {},
    pageCount,
  };
}

// The environment the answer is scoped to: no Worker global and no toHex, both
// observed by this very process. Anything else and the check proves nothing.
function expectEnv(where) {
  expect(typeof Worker === "undefined", `${where}: typeof Worker is undefined`, typeof Worker);
  expect(
    typeof new Uint8Array(1).toHex === "undefined",
    `${where}: Uint8Array.prototype.toHex is undefined`,
    typeof new Uint8Array(1).toHex,
  );
}

// The three-fixture bar, exactly the browser suite's expectations: text-layer.pdf
// yields both known strings with PAGE 1 before PAGE 2; three-page.pdf yields three
// page markers; no-text-layer.pdf is rejected by the guard.
async function fullBar(transcriber) {
  const results = [];

  const twoPage = await transcriber.transcribe(capture(2), readFixture("text-layer.pdf"));
  const p1 = twoPage.text.indexOf("===== PAGE 1 =====");
  const p2 = twoPage.text.indexOf("===== PAGE 2 =====");
  results.push({
    fixture: "text-layer.pdf",
    pass:
      twoPage.text.includes("hello world") &&
      twoPage.text.includes("different text") &&
      p1 > -1 &&
      p2 > p1,
    detail: `PAGE 1 at ${p1}, PAGE 2 at ${p2}`,
    text: twoPage.text,
  });

  const threePage = await transcriber.transcribe(capture(3), readFixture("three-page.pdf"));
  const markers = threePage.text.match(/===== PAGE \d+ =====/g) ?? [];
  results.push({
    fixture: "three-page.pdf",
    pass: markers.length === 3,
    detail: markers.join(","),
  });

  try {
    await transcriber.transcribe(capture(1), readFixture("no-text-layer.pdf"));
    results.push({ fixture: "no-text-layer.pdf", pass: false, detail: "no error thrown" });
  } catch (e) {
    results.push({
      fixture: "no-text-layer.pdf",
      pass: e?.name === "UnsupportedItemError" && e?.reason === "no-text-layer",
      detail: `${e?.name} reason=${e?.reason}`,
    });
  }
  return results;
}

// --- child modes: the real transcriber, one loader per process ----------------

async function attemptTranscriber(loader) {
  expectEnv(`child ${loader}`);
  const { PdfjsTranscriber } = await import(transcriberEntry);
  const transcriber =
    loader === "legacy"
      ? new PdfjsTranscriber({
          workerSrc: legacyWorker,
          loadPdfjs: async () => await import(legacyEntry),
        })
      : new PdfjsTranscriber({ workerSrc: standardWorker });
  const bar = await fullBar(transcriber);
  for (const r of bar) {
    console.log(
      `${r.pass ? "PASS" : "FAIL"} ${r.fixture} — ${r.detail}` +
        (r.fixture === "text-layer.pdf" && r.pass ? `\n  text: ${JSON.stringify(r.text)}` : ""),
    );
  }
  if (bar.some((r) => !r.pass)) process.exitCode = 1;
}

// --- parent: env facts, the raw attempts, then the two child attempts --------

// Returns { ok, text, error } for the recorded assertion; never throws.
async function attemptRaw(moduleUrl, workerSrc) {
  try {
    const pdfjs = await import(moduleUrl);
    if (workerSrc !== undefined) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(fileURLToPath(new URL("text-layer.pdf", fixtures)))),
    }).promise;
    const texts = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      texts.push(content.items.map((i) => i.str ?? "").join(""));
    }
    return { ok: true, text: texts.join("\n"), error: null };
  } catch (e) {
    return { ok: false, text: null, error: e };
  }
}

function runChild(mode) {
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL("run.mjs", here)), mode], {
      stdio: "inherit",
    });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

const mode = process.argv[2];
if (mode === "transcriber-default" || mode === "transcriber-legacy") {
  await attemptTranscriber(mode === "transcriber-legacy" ? "legacy" : "default");
  if (failed) process.exitCode = 1;
} else {
  const pdfjsPkg = JSON.parse(readFileSync(new URL("package.json", pdfjsRoot), "utf8"));
  console.log("node:", process.version);
  console.log("pdfjs-dist:", pdfjsPkg.version);
  expectEnv("parent env");
  expect(
    pdfjsPkg.version === RECORDED_PDFJS_VERSION,
    "pdfjs-dist version matches the record",
    pdfjsPkg.version,
  );

  const a1 = await attemptRaw(new URL("build/pdf.mjs", pdfjsRoot).href, standardWorker);
  expect(
    !a1.ok && a1.error?.message.includes("toHex is not a function"),
    "A1 raw standard build fails with the recorded toHex error",
    a1.ok ? "unexpectedly succeeded" : `${a1.error?.name}: ${a1.error?.message}`,
  );

  const a2 = await attemptRaw(legacyEntry, legacyWorker);
  expect(
    a2.ok && a2.text.includes("hello world") && a2.text.includes("different text"),
    "A2 raw legacy build extracts the fixture text",
    a2.ok ? JSON.stringify(a2.text) : `${a2.error?.name}: ${a2.error?.message}`,
  );

  const a3 = await attemptRaw(legacyEntry, undefined);
  expect(
    a3.ok && a3.text === a2.text,
    "A3 raw legacy build, default workerSrc, extracts the same text",
    a3.ok ? JSON.stringify(a3.text) : `${a3.error?.name}: ${a3.error?.message}`,
  );

  const a4 = runChild("transcriber-default");
  expect(
    a4 !== 0,
    "A4 the real PdfjsTranscriber, DEFAULT loader, fails (standard build)",
    `child exit ${a4}`,
  );

  const a5 = runChild("transcriber-legacy");
  expect(
    a5 === 0,
    "A5 the real PdfjsTranscriber, legacy build injected — the full three-fixture bar",
    `child exit ${a5}`,
  );

  if (failed) {
    console.log("RESULT: the recorded answer did not reproduce — see the FAIL lines above");
    process.exitCode = 1;
  } else {
    console.log("RESULT: every recorded outcome reproduced — shim-free, A5 full bar");
  }
}
