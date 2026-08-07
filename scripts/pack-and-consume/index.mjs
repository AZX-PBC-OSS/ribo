#!/usr/bin/env node
/**
 * @file R3 — the pack-and-consume test tier.
 *
 * Spec: `docs/implementation/10-build-and-packaging.md` §7 ("Pack-and-consume ... `pnpm pack` →
 * install tarball → build → assert the worker spawns and WASM loads" — "mandatory, not optional
 * ... the highest-value test in the repo") and §8 (listed among the CI gates). Roadmap entry:
 * `docs/roadmap/index.md` R3.
 *
 * ## Why this exists
 *
 * The playground resolves every workspace package through the `@azx/source` export condition and
 * NEVER touches `dist/` (AGENTS.md §5.1). So every failure mode that only exists in a real
 * consumer's build — a worker that will not spawn, a `default` export path that does not exist, a
 * `dependencies` entry that got dropped, an ESM/CJS interop trap — is invisible to every other
 * test in this repo. `./check.sh`'s `build:app` stage builds the playground; it has never once
 * resolved a package through the branch a real consumer's bundler takes.
 *
 * ## What it does
 *
 * 1. Builds the five publishable packages fresh (`pnpm build:packages`), so the tarballs below
 *    reflect the current tree, not a stale `dist/`.
 * 2. Packs each with `pnpm pack --json` — a REAL tarball, the exact bytes `pnpm publish` would
 *    upload.
 * 3. Writes a fresh, minimal app into a temp directory OUTSIDE this repo (see SCRATCH_DIR below)
 *    and installs the five tarballs into it as `file:` dependencies — pnpm extracts a `file:`
 *    pointing at a `.tgz` exactly like it would a registry tarball; this is NOT the `file:`-to-a-
 *    live-directory escape hatch doc 10 §5 warns the field app off (that one hard-links a live,
 *    uncompiled workspace directory and resolves peers from the consumer; this is a real archive).
 * 4. Runs a real production `vite build` of that app, using the app's OWN installed `vite` (not
 *    this repo's), so the module resolution exercised is the app's, unmediated by anything this
 *    workspace sets up.
 * 5. Serves the built `dist/` and drives a real headless Chromium against it, asserting — per doc
 *    10 §7's minimum bar — that `@azx/ribo-transcriber-ondevice`'s published `./worker` entry
 *    spawns and its ONNX Runtime WASM backend actually initializes a session, plus that the other
 *    four packages resolved, bundled and ran correctly from their tarballs too.
 *
 * ## Why this is NOT in `./check.sh`
 *
 * `./check.sh` is the fast, frequent, "am I done?" loop (AGENTS.md §7) — every stage in it runs
 * against files already on disk in this repo. This tier packs five tarballs, does a full `pnpm
 * install` into a directory OUTSIDE the repo, and downloads a small HF Hub test model over the
 * network: tens of seconds of I/O that has nothing to do with most edits, and exactly the "a
 * network fetch masquerading as a check" shape `vitest.manual.config.ts` already rejected for a
 * slower, heavier case (a real Whisper model). But unlike that file — and unlike
 * `gate.manual.ts`, which is blocked on a paid API key and literally cannot run in CI — this tier
 * needs no secret and nothing it fetches is flaky-by-design, so leaving it purely "manual" would
 * make it the gate nobody runs, which doc 10 §7 explicitly says not to do ("mandatory, not
 * optional"). The resolution: a separate `pnpm` script, run as its OWN step in CI after
 * `./check.sh` — replacing the `TODO(R3)` that has sat in `.github/workflows/ci.yml` since before
 * this package existed — so every push is still gated, without taxing the local edit-save-check
 * loop. Run it by hand with:
 *
 *   pnpm test:pack-and-consume
 *
 * ## Cleanup and crash-robustness
 *
 * `SCRATCH_DIR` is a FIXED path (namespaced by a hash of this repo's root, not a random
 * `mkdtemp` name), so a run that died halfway — killed, crashed, `Ctrl-C` — leaves a directory at
 * a name the NEXT run already knows to remove. Every run therefore starts by force-removing
 * `SCRATCH_DIR` unconditionally (before creating anything), and removes it again in a `finally`
 * block that runs on both success and failure. Set `RIBO_PACK_AND_CONSUME_KEEP=1` to skip the
 * final cleanup for debugging.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { preview } from "vite";

import {
  INDEX_HTML,
  MAIN_JS,
  VITE_CONFIG_JS,
  WHISPER_WORKER_JS,
  scratchPackageJson,
} from "./app-template.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Fixed, not random (see file header): namespaced by the repo root so concurrent worktrees of
// this same repo (there are several on this machine) never collide on one scratch directory.
const REPO_HASH = createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 12);
const SCRATCH_DIR = join(os.tmpdir(), `ribo-pack-and-consume-${REPO_HASH}`);
const TARBALL_DIR = join(SCRATCH_DIR, "tarballs");
const APP_DIR = join(SCRATCH_DIR, "app");

const KEEP_SCRATCH = process.env.RIBO_PACK_AND_CONSUME_KEEP === "1";

// The tiny HF Hub test fixture this tier primes instead of a real (175-970 MB fp32) Whisper
// model. Same org (Xenova) transformers.js's own test suite uses for CI: a randomly-initialized
// but real, Whisper-shaped ONNX export (encoder + decoder, ~4 MB total unquantized). Priming it
// exercises the exact production code path — worker spawn, the worker's dynamic
// `import("@huggingface/transformers")`, and ONNX Runtime WASM session creation — without the
// real models' network cost.
const TEST_MODEL_ID = "Xenova/tiny-random-WhisperForConditionalGeneration";

const EXPECTED_PUBLISHED_COUNT = 5;

function log(message) {
  console.log(`[pack-and-consume] ${message}`);
}

function cleanScratch() {
  try {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  } catch (error) {
    // `force: true` only swallows ENOENT; a previous run killed mid-`pnpm install` can leave
    // permission bits `rm` refuses to cross (pnpm's store links are read-only by design). One
    // repair attempt — widen permissions, then retry — before giving up loudly rather than
    // leaving a corrupt directory that fails every future run the same opaque way.
    log(`initial cleanup of ${SCRATCH_DIR} failed (${error.message}); retrying after chmod -R`);
    execFileSync("chmod", ["-R", "u+rwX", SCRATCH_DIR], { stdio: "ignore" });
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
}

/**
 * The publishable packages, discovered the same way `scripts/pkg-gates.mjs` does — from the
 * workspace, not a hard-coded list — so adding a sixth publishable package without updating this
 * file fails loudly (the count guard below) rather than silently shipping ungated.
 */
function discoverPublishablePackages() {
  const packagesDir = join(REPO_ROOT, "packages");
  const found = [];
  for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = join(packagesDir, dirent.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.private) continue;
    found.push({ dir: dirent.name, name: manifest.name });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  if (found.length !== EXPECTED_PUBLISHED_COUNT) {
    throw new Error(
      `discovered ${found.length} publishable packages, expected ${EXPECTED_PUBLISHED_COUNT} ` +
        `(${found.map((p) => p.name).join(", ")}). If you added or removed a publishable ` +
        "package, update EXPECTED_PUBLISHED_COUNT in this file.",
    );
  }
  return found;
}

function buildPackages() {
  log("building all five publishable packages (pnpm build:packages)...");
  execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
}

/** Packs every publishable package with `pnpm pack --json` and returns { name -> tarball path }. */
function packAll(packages) {
  mkdirSync(TARBALL_DIR, { recursive: true });
  const tarballs = {};
  for (const { dir, name } of packages) {
    log(`packing ${name}...`);
    const cwd = join(REPO_ROOT, "packages", dir);
    const output = execFileSync("pnpm", ["pack", "--pack-destination", TARBALL_DIR, "--json"], {
      cwd,
      encoding: "utf8",
    });
    const parsed = JSON.parse(output);
    if (!parsed.filename || !existsSync(parsed.filename)) {
      throw new Error(`pnpm pack for ${name} did not produce a tarball at the reported path`);
    }
    tarballs[name] = parsed.filename;
  }
  return tarballs;
}

function writeScratchApp(tarballs) {
  log(`writing scratch app to ${APP_DIR}...`);
  mkdirSync(join(APP_DIR, "src"), { recursive: true });
  writeFileSync(
    join(APP_DIR, "package.json"),
    `${JSON.stringify(scratchPackageJson(tarballs), null, 2)}\n`,
  );
  writeFileSync(join(APP_DIR, "index.html"), INDEX_HTML);
  writeFileSync(join(APP_DIR, "vite.config.js"), VITE_CONFIG_JS);
  writeFileSync(join(APP_DIR, "src", "main.js"), MAIN_JS);
  writeFileSync(join(APP_DIR, "src", "whisper.worker.js"), WHISPER_WORKER_JS);
}

function installScratchApp() {
  log("pnpm install in the scratch app (real registry + tarball resolution, no workspace)...");
  execFileSync("pnpm", ["install"], { cwd: APP_DIR, stdio: "inherit" });
}

/**
 * Copies the ONNX Runtime WASM/MJS runtime files into the scratch app's `public/ort/`, so `vite
 * build` carries them into `dist/ort/` same-origin — the exact pattern
 * `playground/vite.config.ts`'s `serveOrtRuntime` uses, and the one doc 10 §4 requires (never the
 * transformers.js jsDelivr default). Runs from the SCRATCH APP's own `node_modules`, not this
 * repo's — `onnxruntime-web` is a transitive dependency of the tarball-installed
 * `@huggingface/transformers`, resolved fresh by the scratch app's own `pnpm install` above.
 */
function copyOrtRuntimeFiles() {
  const pnpmDir = join(APP_DIR, "node_modules", ".pnpm");
  const ortEntry = readdirSync(pnpmDir).find((name) => name.startsWith("onnxruntime-web@"));
  if (!ortEntry) {
    throw new Error(
      "onnxruntime-web not found under the scratch app's node_modules/.pnpm — " +
        "@huggingface/transformers should have pulled it in transitively.",
    );
  }
  const ortDist = join(pnpmDir, ortEntry, "node_modules", "onnxruntime-web", "dist");
  const runtimeFiles = readdirSync(ortDist).filter((name) =>
    /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(name),
  );
  if (runtimeFiles.length === 0) {
    throw new Error(`no ort-wasm-simd-threaded*.{wasm,mjs} files found under ${ortDist}`);
  }
  const dest = join(APP_DIR, "public", "ort");
  mkdirSync(dest, { recursive: true });
  for (const file of runtimeFiles) copyFileSync(join(ortDist, file), join(dest, file));
  log(`copied ${runtimeFiles.length} ONNX Runtime files into public/ort/`);
}

function buildScratchApp() {
  log("building the scratch app (its OWN vite, real production build)...");
  execFileSync("pnpm", ["run", "build"], { cwd: APP_DIR, stdio: "inherit" });
}

/**
 * Serves the scratch app's `dist/` and drives a real headless Chromium against it, returning the
 * page's reported result. Uses THIS repo's own `vite` purely as a static file server for already-
 * built output — no module resolution happens at this stage, so reusing it does not blur the line
 * this tier exists to hold (the app was BUILT with its own, independently-installed `vite`).
 */
async function runInBrowser() {
  const server = await preview({
    root: APP_DIR,
    logLevel: "warn",
    preview: { port: 0 },
  });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("vite preview reported no local URL");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(url, { waitUntil: "load" });
    // `globalThis`, not `window`: this arrow function is serialized and run INSIDE the page by
    // Playwright, but it is still parsed as ordinary Node-file source by this repo's ESLint, whose
    // globals for `scripts/**` are Node's — `window` alone would be a real `no-undef` error here
    // even though the code never runs in Node. `globalThis` is valid (and identical) in both.
    await page.waitForFunction(() => globalThis.__RIBO_PACK_CONSUME_RESULT__ !== undefined, {
      timeout: 60_000,
    });
    const result = await page.evaluate(() => globalThis.__RIBO_PACK_CONSUME_RESULT__);
    return { result, consoleErrors, pageErrors };
  } finally {
    await browser.close();
    await server.close();
  }
}

function assertResult({ result, consoleErrors, pageErrors }) {
  if (pageErrors.length > 0) {
    throw new Error(`uncaught page error(s):\n${pageErrors.join("\n")}`);
  }
  if (consoleErrors.length > 0) {
    throw new Error(
      `console error(s) during a real production build:\n${consoleErrors.join("\n")}`,
    );
  }
  if (!result || result.ok !== true) {
    throw new Error(`scratch app reported failure: ${result?.message ?? "(no result at all)"}`);
  }
  const c = result.checks;
  const expectations = [
    ["riboCoreGroundedSpanTrue", c.riboCoreGroundedSpanTrue === true],
    ["riboCoreGroundedSpanFalse", c.riboCoreGroundedSpanFalse === false],
    ["adapterSchemaKeyCount > 0", c.adapterSchemaKeyCount > 0],
    ["extractorHasExtractFn", c.extractorHasExtractFn === true],
    ["uiReactRendered", c.uiReactRendered === true],
    ["workerPrimedWithoutThrowing", c.workerPrimedWithoutThrowing === true],
    ["workerReportedProgress", c.workerReportedProgress === true],
  ];
  const failed = expectations.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`failed check(s): ${failed.join(", ")}\nfull checks: ${JSON.stringify(c)}`);
  }
  log(
    "PASS — 5 tarballs installed via file: (not the workspace), production build succeeded, " +
      `@azx/ribo-transcriber-ondevice's worker spawned and primed ${TEST_MODEL_ID} ` +
      "(ONNX Runtime WASM session created) with real progress events.",
  );
}

async function main() {
  cleanScratch(); // robust to a previous run that died halfway (see file header)
  try {
    const packages = discoverPublishablePackages();
    buildPackages();
    const tarballs = packAll(packages);
    writeScratchApp(tarballs);
    installScratchApp();
    copyOrtRuntimeFiles();
    buildScratchApp();
    const outcome = await runInBrowser();
    assertResult(outcome);
  } finally {
    if (KEEP_SCRATCH) {
      log(`RIBO_PACK_AND_CONSUME_KEEP=1 set — leaving scratch dir at ${SCRATCH_DIR}`);
    } else {
      cleanScratch();
    }
  }
}

main().catch((error) => {
  console.error(`[pack-and-consume] FAIL — ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
