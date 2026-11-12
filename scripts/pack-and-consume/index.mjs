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
 * 1. Builds every publishable package fresh (`pnpm build:packages`), so the tarballs below
 *    reflect the current tree, not a stale `dist/`.
 * 2. Packs each with `pnpm pack --json` — a REAL tarball, the exact bytes `pnpm publish` would
 *    upload.
 * 3. Writes a fresh, minimal app into a temp directory OUTSIDE this repo (see SCRATCH_DIR below)
 *    and installs those tarballs into it as `file:` dependencies — pnpm extracts a `file:`
 *    pointing at a `.tgz` exactly like it would a registry tarball; this is NOT the `file:`-to-a-
 *    live-directory escape hatch doc 10 §5 warns the field app off (that one hard-links a live,
 *    uncompiled workspace directory and resolves peers from the consumer; this is a real archive).
 * 4. Runs a real production `vite build` of that app, using the app's OWN installed `vite` (not
 *    this repo's), so the module resolution exercised is the app's, unmediated by anything this
 *    workspace sets up.
 * 5. Serves the built `dist/` and drives a real headless Chromium against it, asserting — per doc
 *    10 §7's minimum bar — that `@azx/ribo-transcriber-ondevice`'s published `./worker` entry
 *    spawns and its ONNX Runtime WASM backend actually initializes a session, plus that the other
 *    five packages resolved, bundled and ran correctly from their tarballs too.
 *
 * ## A defect class this tier actually caught, that no static gate here does
 *
 * During review, pointing the published `./worker` entry's `default` at an EXISTING but
 * semantically wrong file (`./dist/index.js` instead of `./dist/worker.js`) sailed straight
 * through `build:packages` (publint's existence check is satisfied — the file is there) and
 * `check:pkg`, then failed this tier cleanly with rolldown's own `[MISSING_EXPORT] "handleMessage"
 * is not exported by ".../dist/index.js"`. That is a sharper example than the "removed
 * dependency" mutation this file's own tests exercise (see the R3 report): it is a defect that
 * looks structurally identical to a correct `exports` block to every tool that only checks
 * existence, and is invisible anywhere else in this repo.
 *
 * ## Why this is NOT in `./check.sh`
 *
 * `./check.sh` is the fast, frequent, "am I done?" loop (AGENTS.md §7) — every stage in it runs
 * against files already on disk in this repo. This tier packs every tarball, does a full `pnpm
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
 *
 * `CHROME_PROFILE_DIR`, by contrast, is deliberately NOT wiped at start or end — see "Network
 * dependency" below for why it persists on purpose.
 *
 * ## Network dependency: pinned, cached, and reported distinguishably
 *
 * The one real network call this tier makes beyond `pnpm install` (registry + this workspace's own
 * `.pnpm` store, which is not this tier's to fix) is priming `TEST_MODEL_ID` from the HF Hub. Two
 * belts, both load-bearing:
 *
 *   1. **`TEST_MODEL_REVISION` pins a commit hash, not the moving `main` branch** (see
 *      `app-template.mjs`'s doc comment on that constant) — an upstream change to the fixture
 *      repo cannot alter what this tier tests on the next unrelated push.
 *   2. **`CHROME_PROFILE_DIR` is a persistent (not ephemeral) Chromium profile**, inside this repo
 *      at `.cache/pack-and-consume/chromium-profile/` (gitignored), reused across runs instead of a
 *      fresh incognito context every time. The model's weights land in that profile's Cache API
 *      storage (`transformers-cache`), so a warm run never touches the network at all.
 *      `.github/workflows/ci.yml` restores/saves this exact directory with `actions/cache`, keyed
 *      on a hash of `app-template.mjs` (which is where the pin lives) — so CI is warm on every run
 *      after the first for a given pin, and only a change to that pin (or the file around it) ever
 *      forces one cold fetch.
 *
 * This does NOT eliminate the network dependency — a first-ever run, a bumped pin, or an evicted
 * CI cache still fetches for real — but it removes the "the model repo changed under us" axis
 * entirely and makes the steady-state path network-free, which is the same reasoning
 * `vitest.manual.config.ts`'s header rejects a much larger, unpinned, uncached version of.
 *
 * `assertResult` below reports a `category` distinguishing three unrelated failure shapes — see
 * `app-template.mjs`'s doc comment on `MAIN_JS` — so a red run names which one before you open
 * this file: a real packaging regression in one of the non-worker packages
 * (`setup-before-worker`), a real regression in the worker entry itself
 * (`worker-spawn-or-import`), or a probable transient Hub issue (`network-fetch-after-spawn`).
 *
 * ## Two known, accepted gaps (not fixed here — recorded so they are decided, not rediscovered)
 *
 * - **Same-worktree concurrent runs race on one `SCRATCH_DIR` and one `CHROME_PROFILE_DIR`.**
 *   `SCRATCH_DIR` is already namespaced by a hash of the repo root (cross-worktree runs never
 *   collide), but two `pnpm test:pack-and-consume` invocations against the SAME worktree at the
 *   same time will step on each other's tarballs/app files, and Chromium will refuse to open a
 *   second persistent context on a profile directory it already holds a `SingletonLock` on. This
 *   tier is not designed for concurrent invocation against one worktree — same as `./check.sh`
 *   itself, which no one runs twice at once for the same reason. Not fixed with a lock file: the
 *   failure mode (a loud, immediate Chromium/pnpm error) is already distinguishable from a real
 *   test failure, which is the bar this repo's other manual/CI-only gates hold to as well.
 * This gap is now CLOSED, and the note is kept because the reasoning is still useful. The roster
 * walk and `EXPECTED_PUBLISHED_COUNT` used to be duplicated here and in `scripts/pkg-gates.mjs`,
 * deliberately, on the grounds that a shared `scripts/lib/` module for one four-line function was
 * its own maintenance surface — with the stated exit condition that a THIRD copy is the signal to
 * extract. `assert-source-condition.mjs` was the third, and the cost landed: adding the eighth
 * package updated two copies, `./check.sh` went green locally, and this tier — which is
 * deliberately outside `./check.sh` — failed in CI on the copy nobody found. All three now import
 * `scripts/lib/publishable-packages.mjs`.
 */
import { execFileSync, spawnSync } from "node:child_process";

import {
  discoverPublishablePackages,
  EXPECTED_PUBLISHED_COUNT,
  unexpectedCountMessage,
} from "../lib/publishable-packages.mjs";
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
  TEST_MODEL_ID,
  TEST_MODEL_REVISION,
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

// Persistent (not cleaned per-run) Chromium profile — see the file header's "Network dependency"
// section. Inside the repo, unlike SCRATCH_DIR: it holds no tarball/module-resolution state, only
// the browser's own Cache API storage, so keeping it here is not in tension with SCRATCH_DIR's
// "outside the workspace" requirement.
const CHROME_PROFILE_DIR = join(REPO_ROOT, ".cache", "pack-and-consume", "chromium-profile");

// The CLI step's fixture and expectations (ADR 0037 / the ribo-cli design doc §7). The fixture is
// fixed, so the leaf count is a known constant, not a re-derivation: `home.address`,
// `home.yearBuilt`, `home.completed`, `notes`. Re-deriving it here would mean bundling the
// inventory walk into this tier — a second implementation of the measure it is checking.
const INSPECT_FIXTURE_PATH = join(
  REPO_ROOT,
  "scripts",
  "pack-and-consume",
  "fixtures",
  "inspect-fixture.schema.json",
);
const INSPECT_FIXTURE_LEAF_COUNT = 4;
const CLI_BIN_NAME = "ribo";

const KEEP_SCRATCH = process.env.RIBO_PACK_AND_CONSUME_KEEP === "1";

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

function buildPackages() {
  log("building all publishable packages (pnpm build:packages)...");
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
 * Strips comments and scans every emitted JS chunk under `dir` for import/export specifiers.
 * Comments must go first: commander's inlined source carries `@typedef { import("./x.js") }
 * JSDoc blocks that name module specifiers without importing them.
 */
function bundledSpecifiers(dir) {
  const specifiers = new Map();
  const files = readdirSync(dir, { recursive: true }).filter((name) => name.endsWith(".js"));
  for (const file of files) {
    const path = join(dir, file);
    const source = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const matches = source.matchAll(
      /(?:import|export)[^;'"]*?from\s*["']([^"'\n]+)["']|import\s*\(\s*["']([^"'\n]+)["']\s*\)|^\s*import\s*["']([^"'\n]+)["']/gm,
    );
    for (const match of matches) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier && !specifier.startsWith("node:")) {
        specifiers.set(`${file}: ${specifier}`, path);
      }
    }
  }
  return [...specifiers.keys()];
}

/** Runs a command capturing exit code and both streams, never throwing on a non-zero exit. */
function runCaptured(command, args, cwd) {
  const outcome = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: outcome.status,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
  };
}

function assertInspectReport(run, label) {
  if (run.status !== 0) {
    throw new Error(
      `cli-bin-run: ${label} exited ${run.status} instead of 0.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
    );
  }
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    throw new Error(
      `cli-bin-run: ${label} stdout is not exactly one JSON document:\n${run.stdout}`,
    );
  }
  const expectedCliVersion = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "ribo-cli", "package.json"), "utf8"),
  ).version;
  const expectedCoreVersion = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "ribo-core", "package.json"), "utf8"),
  ).version;
  const checks = [
    ["contractVersion === 2", report.contractVersion === 2],
    [`cliVersion === ${expectedCliVersion}`, report.cliVersion === expectedCliVersion],
    [`coreVersion === ${expectedCoreVersion}`, report.coreVersion === expectedCoreVersion],
    [
      `leafCount === ${INSPECT_FIXTURE_LEAF_COUNT}`,
      report.leafCount === INSPECT_FIXTURE_LEAF_COUNT,
    ],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(
      `cli-bin-run: ${label} report failed check(s): ${failed.join(", ")}\nfull report: ${run.stdout}`,
    );
  }
}

function assertCouldNotRun(run, label) {
  if (run.status !== 2) {
    throw new Error(
      `cli-bin-run: ${label} exited ${run.status} instead of 2.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
    );
  }
  if (run.stdout !== "") {
    throw new Error(
      `cli-bin-run: ${label} wrote to stdout on a could-not-run fault:\n${run.stdout}`,
    );
  }
  if (run.stderr.trim() === "") {
    throw new Error(`cli-bin-run: ${label} wrote no diagnostic to stderr on a could-not-run fault`);
  }
}

/**
 * The CLI step (ADR 0037): @azx/ribo-cli ships a single-file Node bundle, and no other package in
 * this repo is built that way — so the packed tarball gets its own proof, both static and dynamic.
 * A failure here fails the tier with a `cli-bin-run:` prefixed message naming this step.
 */
function runCliBinStep(tarballs) {
  log("cli-bin-run: extracting the @azx/ribo-cli tarball...");
  const CLI_DIR = join(SCRATCH_DIR, "cli");
  mkdirSync(CLI_DIR, { recursive: true });
  // The tarball's entries are prefixed `package/`, so extracting into CLI_DIR yields
  // CLI_DIR/package/dist — the extracted artifact tree, not a workspace link.
  execFileSync("tar", ["-xzf", tarballs["@azx/ribo-cli"], "-C", CLI_DIR]);

  // Static: every import/export specifier in the emitted chunk(s) must be a node:* builtin —
  // zod, @azx/ribo-core (and its rxjs), commander and picocolors are bundled IN, not referenced.
  const distDir = join(CLI_DIR, "package", "dist");
  const offenders = bundledSpecifiers(distDir);
  if (offenders.length > 0) {
    throw new Error(
      `cli-bin-run: the bundled chunk(s) reference non-builtin module(s) — the single-file bundle \n` +
        `leaked: ${offenders.join(", ")}`,
    );
  }

  // Dynamic: run the bin from a directory containing nothing but the fixture copy, so a runtime
  // read of anything beside itself would fail. Once via the extracted dist file (the artifact),
  // once via the scratch app's installed node_modules/.bin/ribo (install-time bin wiring).
  const isolated = join(CLI_DIR, "run");
  mkdirSync(isolated, { recursive: true });
  const fixtureName = "fixture.schema.json";
  copyFileSync(INSPECT_FIXTURE_PATH, join(isolated, fixtureName));
  const binFile = join(distDir, "bin.js");
  const installedBin = join(APP_DIR, "node_modules", ".bin", CLI_BIN_NAME);

  log("cli-bin-run: running the extracted dist bin against the fixture...");
  assertInspectReport(
    runCaptured(process.execPath, [binFile, "schema", "inspect", fixtureName], isolated),
    "the extracted dist/bin.js",
  );
  log("cli-bin-run: running the installed node_modules/.bin/ribo against the fixture...");
  assertInspectReport(
    runCaptured(installedBin, ["schema", "inspect", fixtureName], isolated),
    "the installed node_modules/.bin/ribo",
  );

  // The could-not-run class, twice: missing file and malformed JSON each exit 2, stdout empty,
  // stderr non-empty (the ribo-cli design doc §4 exit-code table).
  log("cli-bin-run: asserting the could-not-run class (missing file, malformed JSON)...");
  assertCouldNotRun(
    runCaptured(process.execPath, [binFile, "schema", "inspect", "missing.schema.json"], isolated),
    "a missing file",
  );
  writeFileSync(join(isolated, "malformed.json"), "{not json\n");
  assertCouldNotRun(
    runCaptured(process.execPath, [binFile, "schema", "inspect", "malformed.json"], isolated),
    "a malformed-JSON input",
  );
  log(
    "PASS — the packed ribo bin ran self-contained: fixture inspected (leafCount " +
      `${INSPECT_FIXTURE_LEAF_COUNT}), versions reported, could-not-run faults diagnosed on stderr only.`,
  );
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
 * Launches the persistent Chromium profile at `CHROME_PROFILE_DIR`, repairing it once if the
 * profile itself is the problem (e.g. a `SingletonLock` left by a process that was killed rather
 * than closed) — the same "clean up, retry once, then fail loudly" shape `cleanScratch` uses for
 * `SCRATCH_DIR`, applied to the one other piece of state this tier leaves on disk between runs.
 */
async function launchPersistentContext() {
  mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  try {
    return await chromium.launchPersistentContext(CHROME_PROFILE_DIR, { headless: true });
  } catch (error) {
    log(
      `launching Chromium against ${CHROME_PROFILE_DIR} failed (${error.message}); ` +
        "removing the profile and retrying once (this loses the model-fetch cache for this run)",
    );
    rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true });
    mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
    return await chromium.launchPersistentContext(CHROME_PROFILE_DIR, { headless: true });
  }
}

/**
 * Serves the scratch app's `dist/` and drives a real headless Chromium against it, returning the
 * page's reported result. Uses THIS repo's own `vite` purely as a static file server for already-
 * built output — no module resolution happens at this stage, so reusing it does not blur the line
 * this tier exists to hold (the app was BUILT with its own, independently-installed `vite`).
 *
 * The Chromium context is PERSISTENT (`CHROME_PROFILE_DIR`, not a fresh incognito context) so the
 * pinned test model's fetched bytes survive between runs in the browser's own Cache API storage —
 * see the file header's "Network dependency" section.
 */
async function runInBrowser() {
  const server = await preview({
    root: APP_DIR,
    logLevel: "warn",
    preview: { port: 0 },
  });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("vite preview reported no local URL");

  const context = await launchPersistentContext();
  try {
    const page = await context.newPage();
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
    await context.close();
    await server.close();
  }
}

/**
 * When the scratch app itself reports failure, the error message leads with `result.category` (set
 * in `app-template.mjs`'s `MAIN_JS`) so a human reading a red run — in CI, hours later, with no
 * memory of this file — can tell "the Hub is down" from "we broke the published worker entry"
 * without opening the script. See the file header's "Network dependency" section for the three
 * categories.
 */
function describeFailure(result) {
  const message = result?.message ?? "(no result at all — the page never reported)";
  switch (result?.category) {
    case "setup-before-worker":
      return (
        "packaging regression in ribo-core / ribo-adapter-snuggpro / ribo-chat-openai / " +
        `ribo-chat-helix / ribo-ui-react — none of this phase touches the network:\n${message}`
      );
    case "worker-spawn-or-import":
      return (
        "the worker never reported even one progress event before failing — very likely a real " +
        "regression in @azx/ribo-transcriber-ondevice's published ./worker entry (a broken " +
        `export map, a dropped dependency, or a worker that cannot spawn), NOT the network:\n${message}`
      );
    case "network-fetch-after-spawn":
      return (
        `the worker spawned and reported progress (${JSON.stringify(result.progressStagesSeen)}) ` +
        "before failing — likely a transient issue fetching the pinned test model from the HF " +
        `Hub (an outage or rate limit), not a packaging regression. Underlying error:\n${message}`
      );
    default:
      return `unexpected failure (stage: ${result?.stage ?? "unknown"}):\n${message}`;
  }
}

function assertResult({ result, consoleErrors, pageErrors, tarballCount }) {
  if (pageErrors.length > 0) {
    throw new Error(`uncaught page error(s):\n${pageErrors.join("\n")}`);
  }
  if (consoleErrors.length > 0) {
    throw new Error(
      `console error(s) during a real production build:\n${consoleErrors.join("\n")}`,
    );
  }
  if (!result || result.ok !== true) {
    throw new Error(`scratch app reported failure — ${describeFailure(result)}`);
  }
  const c = result.checks;
  const expectations = [
    ["riboCoreGroundedSpanTrue", c.riboCoreGroundedSpanTrue === true],
    ["riboCoreGroundedSpanFalse", c.riboCoreGroundedSpanFalse === false],
    ["adapterSchemaKeyCount > 0", c.adapterSchemaKeyCount > 0],
    ["extractorHasExtractFn", c.extractorHasExtractFn === true],
    ["helixEngineId", c.helixEngineId === true],
    ["helixCapabilityReady", c.helixCapabilityReady === true],
    ["onDeviceEngineId", c.onDeviceEngineId === true],
    ["onDeviceCapabilityShape", c.onDeviceCapabilityShape === true],
    ["onDeviceExtractorHasExtractFn", c.onDeviceExtractorHasExtractFn === true],
    ["managedUnconfigured", c.managedUnconfigured === true],
    ["managedReady", c.managedReady === true],
    ["uiReactRendered", c.uiReactRendered === true],
    ["systemOneAnswers", c.systemOneAnswers === true],
    // The identity check is the one worth gating: a duplicated ribo-core in the packed install
    // gives this package its own TerminalError class, and every arbitration ladder silently
    // stops falling through. A check computed but left out of this list asserts nothing.
    ["systemOneTerminalIdentity", c.systemOneTerminalIdentity === true],
    ["systemOneExtractorEnumMembers", c.systemOneExtractorEnumMembers === true],
    ["workerPrimedWithoutThrowing", c.workerPrimedWithoutThrowing === true],
    ["workerReportedProgress", c.workerReportedProgress === true],
  ];
  const failed = expectations.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`failed check(s): ${failed.join(", ")}\nfull checks: ${JSON.stringify(c)}`);
  }
  log(
    `PASS — ${tarballCount} tarballs installed via file: (not the workspace), production build succeeded, ` +
      `@azx/ribo-transcriber-ondevice's worker spawned and primed ${TEST_MODEL_ID}@${TEST_MODEL_REVISION} ` +
      "(ONNX Runtime WASM session created) with real progress events.",
  );
}

async function main() {
  cleanScratch(); // robust to a previous run that died halfway (see file header)
  try {
    // The roster and its tripwire count are shared (scripts/lib/publishable-packages.mjs).
    // This tier sits outside ./check.sh, so a package registered everywhere else but not here
    // fails only in CI — which is exactly how it failed once.
    const packages = discoverPublishablePackages(REPO_ROOT);
    if (packages.length !== EXPECTED_PUBLISHED_COUNT) {
      throw new Error(unexpectedCountMessage(packages));
    }
    buildPackages();
    const tarballs = packAll(packages);
    writeScratchApp(tarballs);
    installScratchApp();
    runCliBinStep(tarballs); // ADR 0037 — the packed bin is the artifact this tier must prove.
    copyOrtRuntimeFiles();
    buildScratchApp();
    const outcome = await runInBrowser();
    assertResult({ ...outcome, tarballCount: Object.keys(tarballs).length });
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
