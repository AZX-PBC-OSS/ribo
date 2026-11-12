import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { SCHEMA_NESTING_DEPTH_CAP, SCHEMA_SERIALIZED_CHAR_CAP } from "@azx/ribo-adapter-snuggpro";

/**
 * @file check.sh's `snugg:inspect` stage — `scripts/check-snugg-schema.mjs` —
 * driven as a subprocess (the `bin.test.ts` idiom), plus the sync points that
 * make a stage real here: the `run_stage` line's pinned counts, the PASS
 * summary and the CI job name.
 *
 * The count pin reads `check.sh` with an ANCHORED match on the
 * `run_stage "snugg:inspect"` line, so a commented-out, renamed or wrapped
 * stage line is a miss and fails red — the safe direction. The depth pin is
 * `SCHEMA_NESTING_DEPTH_CAP + 2`: the command measures the DERIVED extraction
 * schema (`describeExtraction` derives before measuring) and reports 14 on the
 * artifact built from today's schema, while the adapter's cap of
 * `SCHEMA_NESTING_DEPTH_CAP` (= 12) binds the plain split pieces via a
 * different measure (`serializedNestingDepth`, pinned at exactly 12 by the
 * adapter's `per-group-cap.test.ts`). Passing 12 would redden `./check.sh` on
 * the current tree; `+ 2` is the measured gap, recorded here so a bump of the
 * adapter cap or a change in what the command measures forces a deliberate
 * re-pin rather than passing silently. The character pin is the vendor cap
 * verbatim.
 *
 * The real-artifact rehearsal reads
 * `packages/ribo-adapter-snuggpro/dist/extraction.schema.json` with `node:fs`
 * (the `acceptance/schema-artifact-round-trip.test.ts` idiom): it is build
 * output, absent on a clean checkout — the failure names `pnpm build:packages`.
 * `./check.sh` builds before it tests, so the gated path always has it.
 *
 * Must-fail mutations — each must turn this file red:
 *   1. delete (or comment out) the `run_stage "snugg:inspect"` line in
 *      check.sh — the anchored count pin misses;
 *   2. re-pin the stage's `--max-depth` to anything other than
 *      `SCHEMA_NESTING_DEPTH_CAP + 2`, or `--max-piece-chars` to anything
 *      other than `SCHEMA_SERIALIZED_CHAR_CAP` — the count pin fails;
 *   3. drop `--max-depth` (or `--max-piece-chars`) from the stage line — the
 *      missing-argument tests exercise exactly that invocation;
 *   4. make the script's missing-file branch print a resolution stack trace —
 *      the build-first assertion fails;
 *   5. drop the script's contract verification (contractVersion, one
 *      un-breached row per cap) — the stub-bin tests fail;
 *   6. drop the stage from check.sh's PASS printf, reorder it out of position,
 *      or omit it from the ci.yml job name — the sync pins fail;
 *   7. make the script exit 0 on a threshold breach — the breach tests fail.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "check-snugg-schema.mjs");
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");
const ARTIFACT = join(
  REPO_ROOT,
  "packages",
  "ribo-adapter-snuggpro",
  "dist",
  "extraction.schema.json",
);

let dir: string;

beforeAll(() => {
  buildCliOnce();
  dir = mkdtempSync(join(tmpdir(), "ribo-cli-snugg-gate-"));

  // Twenty nested object levels: the command's derived measure lands far past
  // the pinned depth, so `--max-depth 14` breaches on it.
  let node: object = { type: "string", description: "leaf" };
  for (let i = 0; i < 20; i++) {
    node = {
      type: "object",
      description: `level ${i}`,
      properties: { inner: node },
      required: ["inner"],
    };
  }
  writeFileSync(
    join(dir, "deep.json"),
    JSON.stringify({ type: "object", properties: { deep: node }, required: ["deep"] }),
  );

  // One group of many described leaves: it splits into pieces of a few
  // thousand serialized chars each — far over a small pin, far under the
  // vendor cap, so `--max-piece-chars 1000` breaches on it.
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (let i = 0; i < 700; i++) {
    properties[`leaf${i}`] = {
      type: "string",
      description: `Field number ${i}: describe what was observed for this entry in plain words.`,
    };
    required.push(`leaf${i}`);
  }
  writeFileSync(
    join(dir, "big.json"),
    JSON.stringify({
      type: "object",
      properties: {
        big: { type: "object", description: "Big group", properties, required },
      },
      required: ["big"],
    }),
  );

  writeFileSync(join(dir, "malformed.json"), "{not json\n");
}, 120_000);

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runScript = (args: string[]): Run => {
  const outcome = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: outcome.status, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
};

/** The pinned counts, extracted from check.sh's own stage line. */
const pinnedStageLine = (): { maxDepth: number; maxPieceChars: number; line: string } => {
  const checkSh = readFileSync(join(REPO_ROOT, "check.sh"), "utf8");
  const line = checkSh
    .split("\n")
    .find((candidate) => /^run_stage "snugg:inspect" /.test(candidate));
  expect(line, 'check.sh carries a run_stage "snugg:inspect" line').toBeDefined();
  const match =
    /^run_stage "snugg:inspect" node scripts\/check-snugg-schema\.mjs --max-depth (\d+) --max-piece-chars (\d+)$/.exec(
      line!,
    );
  expect(
    match,
    'the snugg:inspect stage line is exactly `run_stage "snugg:inspect" node scripts/check-snugg-schema.mjs --max-depth <n> --max-piece-chars <n>`',
  ).not.toBeNull();
  return {
    maxDepth: Number(match![1]),
    maxPieceChars: Number(match![2]),
    line: line!,
  };
};

// --- The count pin (criterion 10) ---------------------------------------------------

test("check.sh's stage line pins the caps to the adapter's exported numbers", () => {
  const { maxDepth, maxPieceChars } = pinnedStageLine();
  // The measured basis: the command measures the derived extraction schema,
  // which reports 2 levels deeper than the adapter's piece cap today — see the
  // file header. A bump of the adapter cap or of the command's measure makes
  // this arithmetic wrong on purpose, forcing a deliberate re-pin of both.
  expect(maxDepth).toBe(SCHEMA_NESTING_DEPTH_CAP + 2);
  expect(maxPieceChars).toBe(SCHEMA_SERIALIZED_CHAR_CAP);
});

test("the stage sits between build:packages and resolve, in the PASS printf and the CI job name", () => {
  const checkSh = readFileSync(join(REPO_ROOT, "check.sh"), "utf8");
  const buildLine = checkSh.indexOf('run_stage "build:packages"');
  const resolveComment = checkSh.indexOf("# Replaces the guard that building destroyed.");
  const stageLine = checkSh.indexOf(pinnedStageLine().line);
  expect(stageLine).toBeGreaterThan(buildLine);
  expect(stageLine).toBeLessThan(resolveComment);

  const summary = checkSh.match(/printf 'check\.sh: PASS — ([^']+)'\n/)![1];
  expect(summary).toContain("build:packages, snugg:inspect, resolve");

  const ciYml = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobName = ciYml.split("\n").find((candidate) => candidate.startsWith("    name:"))!;
  expect(jobName).toContain("build:packages, snugg:inspect,");
});

// --- The green path (criterion 4) ---------------------------------------------------

test("green over the real artifact: exit 0 and one summary line naming both measured-vs-limit pairs", () => {
  const { maxDepth, maxPieceChars } = pinnedStageLine();
  const run = runScript([
    "--max-depth",
    String(maxDepth),
    "--max-piece-chars",
    String(maxPieceChars),
    ARTIFACT,
  ]);
  expect(run.status).toBe(0);
  const lines = run.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  // The measured numbers are a positive control: they must equal what the bin
  // itself reports for this artifact, so the summary cannot pass vacuously.
  const binRun = spawnSync(process.execPath, [BIN, "schema", "inspect", ARTIFACT, "--json"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  expect(binRun.status).toBe(0);
  const report = JSON.parse(binRun.stdout) as {
    whole: { depth: number };
    worstPiece: { serializedChars: number };
    schemaFingerprint: string;
  };
  const summary = new RegExp(
    `^snugg:inspect: depth ${report.whole.depth}/${maxDepth}, worst piece ` +
      `${report.worstPiece.serializedChars}/${maxPieceChars} serialized chars, ` +
      `fingerprint ${report.schemaFingerprint.slice(0, 12)}…$`,
  );
  expect(lines[0]).toMatch(summary);
});

// --- The red paths (criteria 5, 6, 7, 8, 9) ------------------------------------------

test("a dropped threshold argument exits 1 naming the dropped flag", () => {
  const withDepth = runScript(["--max-piece-chars", "32768", ARTIFACT]);
  expect(withDepth.status).toBe(1);
  expect(withDepth.stderr).toContain("--max-depth");
  expect(withDepth.stdout).toBe("");

  const withChars = runScript(["--max-depth", "14", ARTIFACT]);
  expect(withChars.status).toBe(1);
  expect(withChars.stderr).toContain("--max-piece-chars");
  expect(withChars.stdout).toBe("");
});

test("a schema deepened past the depth pin exits 1, names the breach, keeps the report on stdout", () => {
  const run = runScript([
    "--max-depth",
    "14",
    "--max-piece-chars",
    "32768",
    join(dir, "deep.json"),
  ]);
  expect(run.status).toBe(1);
  const report = JSON.parse(run.stdout) as {
    thresholds: { measure: string; breached: boolean; measured: number; limit: number }[];
  };
  const row = report.thresholds.find((entry) => entry.measure === "depth")!;
  expect(row.breached).toBe(true);
  expect(row.limit).toBe(14);
  expect(run.stderr).toContain("depth");
  expect(run.stderr).toContain(`${row.measured}`);
  expect(run.stderr).toContain("14");
});

test("a worst piece over the character pin exits 1, names the piece, keeps the report on stdout", () => {
  const run = runScript(["--max-depth", "50", "--max-piece-chars", "1000", join(dir, "big.json")]);
  expect(run.status).toBe(1);
  const report = JSON.parse(run.stdout) as {
    thresholds: {
      measure: string;
      breached: boolean;
      measured: number;
      limit: number;
      piece?: string;
    }[];
  };
  const row = report.thresholds.find((entry) => entry.measure === "pieceChars")!;
  expect(row.breached).toBe(true);
  expect(row.measured).toBeGreaterThan(1000);
  expect(run.stderr).toContain("pieceChars");
  expect(run.stderr).toContain(`${row.measured}`);
  expect(run.stderr).toContain(row.piece!);
});

test("a missing artifact fails build-first: names the path and pnpm build:packages, no stack trace", () => {
  const missing = join(dir, "absent.schema.json");
  const run = runScript(["--max-depth", "14", "--max-piece-chars", "32768", missing]);
  expect(run.status).toBe(2);
  expect(run.stderr).toContain(missing);
  expect(run.stderr).toContain("pnpm build:packages");
  expect(run.stderr).not.toContain("Cannot find module");
  expect(run.stderr).not.toMatch(/^\s+at /m);

  const missingBin = runScript([
    "--max-depth",
    "14",
    "--max-piece-chars",
    "32768",
    ARTIFACT,
    "--bin",
    join(dir, "absent-bin.js"),
  ]);
  expect(missingBin.status).toBe(2);
  expect(missingBin.stderr).toContain("pnpm build:packages");
  expect(missingBin.stderr).not.toContain("Cannot find module");
});

test("a malformed artifact surfaces the bin's own diagnostic and fails could-not-run", () => {
  const run = runScript([
    "--max-depth",
    "14",
    "--max-piece-chars",
    "32768",
    join(dir, "malformed.json"),
  ]);
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("not valid JSON");
});

test("a stub bin emitting a drifted report fails the threshold class, naming the drifted element", () => {
  const stubReport = (body: string): string =>
    [
      "#!/usr/bin/env node",
      "// A fixture bin: emits a doctored --json report and exits 0, to prove the",
      "// stage verifies the report contract instead of trusting any exit 0.",
      "process.stdout.write(" + JSON.stringify(body) + ");",
    ].join("\n");

  const fullReport = (overrides: Record<string, unknown>): string =>
    JSON.stringify({
      contractVersion: 3,
      cliVersion: "0.0.0",
      coreVersion: "0.0.0",
      schemaFingerprint: "a".repeat(64),
      leafCount: 1,
      worstPiece: null,
      guidanceCoverage: { described: 0, total: 0, ratio: 0 },
      reformatFindings: [],
      granularityViolations: [],
      notVisible: [],
      thresholds: [
        { measure: "depth", limit: 14, measured: 14, breached: false },
        { measure: "pieceChars", limit: 32768, measured: 12, breached: false },
      ],
      ...overrides,
    });

  const cases: [string, string][] = [
    ["a stale contractVersion", stubReport(fullReport({ contractVersion: 2 }))],
    [
      "a missing threshold row",
      stubReport(
        fullReport({
          thresholds: [{ measure: "depth", limit: 14, measured: 14, breached: false }],
        }),
      ),
    ],
    [
      "a re-limit'ed threshold row",
      stubReport(
        fullReport({
          thresholds: [
            { measure: "depth", limit: 99, measured: 14, breached: false },
            { measure: "pieceChars", limit: 32768, measured: 12, breached: false },
          ],
        }),
      ),
    ],
    ["a non-JSON report", stubReport("not json at all")],
  ];

  for (const [label, body] of cases) {
    const stub = join(dir, `stub-${label.replace(/\W+/g, "-")}.mjs`);
    writeFileSync(stub, body);
    const run = runScript([
      "--max-depth",
      "14",
      "--max-piece-chars",
      "32768",
      ARTIFACT,
      "--bin",
      stub,
    ]);
    expect(run.status, label).toBe(1);
    expect(run.stderr, label).toContain("report contract drift");
  }
});

// --- The real-artifact rehearsal (criterion 10) ---------------------------------------

test("the stage, run with check.sh's own pinned caps, is green over the built artifact", () => {
  // Build output, not source: absent on a clean checkout, so the failure names
  // the remedy rather than throwing a module-resolution error.
  let artifact: string;
  try {
    artifact = readFileSync(ARTIFACT, "utf8");
  } catch {
    throw new Error(
      `${ARTIFACT} does not exist — it is build output; run \`pnpm build:packages\` first`,
    );
  }
  expect(artifact).not.toBe("");

  const { maxDepth, maxPieceChars } = pinnedStageLine();
  const run = runScript([
    "--max-depth",
    String(maxDepth),
    "--max-piece-chars",
    String(maxPieceChars),
    ARTIFACT,
  ]);
  expect(run.status).toBe(0);

  // Un-breached threshold rows, verified against the bin's own report rather
  // than the summary line alone.
  const binRun = spawnSync(
    process.execPath,
    [
      BIN,
      "schema",
      "inspect",
      ARTIFACT,
      "--json",
      "--max-depth",
      String(maxDepth),
      "--max-piece-chars",
      String(maxPieceChars),
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  expect(binRun.status).toBe(0);
  const report = JSON.parse(binRun.stdout) as {
    thresholds: { measure: string; breached: boolean }[];
  };
  expect(report.thresholds).toHaveLength(2);
  for (const row of report.thresholds) expect(row.breached).toBe(false);
});
