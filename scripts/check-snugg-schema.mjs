#!/usr/bin/env node
/**
 * check.sh's `snugg:inspect` stage: runs the built `ribo` bin against the Snugg
 * adapter's generated JSON Schema document with pinned thresholds, so schema
 * drift that would break a per-group extraction call turns red at edit time
 * instead of in the field — through the same user-facing command a consumer
 * runs, exercising its exit codes and report contract.
 *
 * Usage:
 *   node scripts/check-snugg-schema.mjs --max-depth <n> --max-piece-chars <n> [schema-path] [--bin <path>]
 *
 * Both threshold flags are required. A stage that runs with a cap unapplied has
 * silently un-gated, and a bare bin call cannot carry this requirement (removing
 * a threshold can only ever remove breaches), which is why the stage is a script
 * with demanded arguments. `schema-path` defaults to the adapter's generated
 * artifact and `--bin` to the built bin, both resolved from the repository root
 * (never the caller's working directory), so tests can point the script at
 * fixtures and stub bins.
 *
 * Exit codes:
 *   0  both caps applied, nothing breached — one summary line on stdout naming
 *      both measured-vs-limit pairs and a fingerprint prefix
 *   1  the threshold class: a breach forwarded from the bin (full report still
 *      on stdout), a missing required cap argument, or the report contract
 *      drifting from the shape this script verifies (contractVersion, one
 *      un-breached row per supplied cap)
 *   2  could-not-run: a missing artifact or bin (a build-first message, never a
 *      resolution stack trace), a forwarded bin could-not-run fault, or a usage
 *      error
 *
 * Everything it reads is local build output: deterministic, free and offline.
 * It composes the two packages by path and imports nothing from either, so the
 * CLI package carries no adapter dependency.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCHEMA_PATH = join(
  REPO_ROOT,
  "packages",
  "ribo-adapter-snuggpro",
  "dist",
  "extraction.schema.json",
);
const DEFAULT_BIN_PATH = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

const die = (code, message) => {
  process.stderr.write(`snugg:inspect: ${message}\n`);
  process.exit(code);
};

// Argument parsing — hand-rolled, no flags library: five options, one positional.
const argv = process.argv.slice(2);
let maxDepth;
let maxPieceChars;
let schemaPath = DEFAULT_SCHEMA_PATH;
let binPath = DEFAULT_BIN_PATH;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const takesValue = (flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      die(2, `usage: ${flag} requires a value`);
    }
    i += 1;
    return value;
  };
  if (arg === "--max-depth") {
    maxDepth = takesValue(arg);
  } else if (arg === "--max-piece-chars") {
    maxPieceChars = takesValue(arg);
  } else if (arg === "--bin") {
    binPath = resolve(takesValue(arg));
  } else if (arg.startsWith("--")) {
    die(2, `usage: unknown option ${arg}`);
  } else if (schemaPath !== DEFAULT_SCHEMA_PATH) {
    die(2, "usage: at most one schema path may be given");
  } else {
    schemaPath = resolve(arg);
  }
}

// A dropped threshold must be red with the threshold exit code, not green with
// a cap unapplied — the failure this stage exists to make impossible.
const missing = [
  ...(maxDepth === undefined ? ["--max-depth"] : []),
  ...(maxPieceChars === undefined ? ["--max-piece-chars"] : []),
];
if (missing.length > 0) {
  die(
    1,
    `missing required threshold argument(s): ${missing.join(", ")} — the stage line in ` +
      "check.sh carries the pinned numbers; apply both caps or the gate is un-applied",
  );
}

// Both inputs are products of `build:packages` — fail build-first, naming the
// remedy, never with a module-resolution stack trace.
const missingPath = [binPath, schemaPath].find((p) => !existsSync(p));
if (missingPath !== undefined) {
  die(
    2,
    `${missingPath} does not exist — the bin and the schema artifact are build output; ` +
      "run `pnpm build:packages` first",
  );
}

const binRun = spawnSync(
  process.execPath,
  [
    binPath,
    "schema",
    "inspect",
    schemaPath,
    "--json",
    "--max-depth",
    maxDepth,
    "--max-piece-chars",
    maxPieceChars,
  ],
  { encoding: "utf8", cwd: REPO_ROOT },
);

if (binRun.error !== undefined || binRun.status === null) {
  die(2, `could not run the bin at ${binPath}: ${binRun.error?.message ?? "exited by signal"}`);
}

// The bin ran and failed threshold, or could not run: forward its outputs
// verbatim — the breach diagnostic, or its own could-not-run diagnostic — and
// add no second interpretation of the fault.
if (binRun.status === 1 || binRun.status === 2) {
  if (binRun.stdout !== "") process.stdout.write(binRun.stdout);
  if (binRun.stderr !== "") process.stderr.write(binRun.stderr);
  process.exit(binRun.status);
}
if (binRun.status !== 0) {
  die(2, `the bin exited ${binRun.status}, which is not one of its documented exit codes`);
}

// The bin reported success: verify the pinned report contract before trusting
// the green — a T5 contract bump must turn this stage red, not un-gate it.
let report;
try {
  report = JSON.parse(binRun.stdout);
} catch {
  die(1, "report contract drift: the bin's --json output is not valid JSON");
}
if (report?.contractVersion !== 2) {
  die(
    1,
    `report contract drift: expected "contractVersion": 2, but the bin reported ` +
      `${JSON.stringify(report?.contractVersion)} — re-pin scripts/check-snugg-schema.mjs ` +
      "deliberately against the new contract",
  );
}

const rowFor = (measure) => report.thresholds?.find((row) => row.measure === measure);
const drift = (detail) => die(1, `report contract drift: ${detail}`);
const depthRow = rowFor("depth");
const charsRow = rowFor("pieceChars");
if (depthRow === undefined || depthRow.limit !== Number(maxDepth)) {
  drift(`no depth threshold row at limit ${maxDepth} in the report`);
}
if (charsRow === undefined || charsRow.limit !== Number(maxPieceChars)) {
  drift(`no pieceChars threshold row at limit ${maxPieceChars} in the report`);
}
if (depthRow.breached !== false || charsRow.breached !== false) {
  // Unreachable when the bin exits 0 — a breach is an exit 1. Guarded anyway so
  // a contract change in `breached`'s meaning cannot read as a green here.
  drift("the bin exited 0 but a threshold row reports breached: true");
}

const fingerprint = typeof report.schemaFingerprint === "string" ? report.schemaFingerprint : "";
if (!/^[0-9a-f]{12}/.test(fingerprint)) {
  drift("the report carries no schemaFingerprint to prefix");
}

process.stdout.write(
  `snugg:inspect: depth ${depthRow.measured}/${depthRow.limit}, worst piece ` +
    `${charsRow.measured}/${charsRow.limit} serialized chars, fingerprint ${fingerprint.slice(0, 12)}…\n`,
);
