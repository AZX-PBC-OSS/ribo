import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { EvalCompareReportSchema } from "./index.js";

/**
 * @file The `ribo compare` command surface, pinned against the built bin as a
 * subprocess (design §6/§7): the two committed fixture records parse and
 * render, `--json` emits the versioned contract, the corpus gate refuses
 * without the named override flag, and every could-not-run fault — usage
 * error, unreadable record, malformed record, empty intersections — exits 2
 * with an empty stdout and a diagnostic naming the command.
 *
 * The suite is self-sufficient: `beforeAll` builds `dist/bin.js` once per run
 * (shared with the other bin suites), so it tests the artifact the command
 * runs, never a stale one. Nothing here makes a model call: compare reads
 * two files, and the fixtures are committed records the stub chat produced.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");
const FIXTURE_A = fileURLToPath(new URL("./fixtures/records/compare-a.json", import.meta.url));
const FIXTURE_B = fileURLToPath(new URL("./fixtures/records/compare-b.json", import.meta.url));

let dir: string;

beforeAll(() => {
  buildCliOnce();
  dir = mkdtempSync(join(tmpdir(), "ribo-cli-compare-"));
}, 120_000);

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (args: readonly string[]): Run => {
  const outcome = spawnSync(process.execPath, [BIN, "compare", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: outcome.status, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
};

/** A 64-hex fingerprint no real record carries. */
const otherFingerprint = (fingerprint: string): string =>
  fingerprint === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);

/** A copy of a committed fixture, with one edit applied, in the suite's temp dir. */
const fixtureCopy = (
  fixture: string,
  name: string,
  edit: (document: Record<string, unknown>) => void,
): string => {
  const document = JSON.parse(readFileSync(fixture, "utf8")) as Record<string, unknown>;
  edit(document);
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
};

// --- The fixtures render (criteria 2, 3) ---------------------------------------------

test("ribo compare renders the two committed fixtures: identities, axis, exclusions, totals, verdicts", () => {
  const result = run([FIXTURE_A, FIXTURE_B]);

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  // Both identities appear, with their settings — where the strategies live.
  expect(result.stdout).toContain("backend openai-compatible, model ribo-test");
  expect(result.stdout).toContain('"strategies":["single-shot"]');
  expect(result.stdout).toContain('"strategies":["per-group"]');
  // The one axis that differs is named.
  expect(result.stdout).toContain("axes");
  expect(result.stdout).toContain("settings");
  // The intersection size and both sides' exclusion counts appear.
  expect(result.stdout).toContain("leaves compared");
  expect(result.stdout).toContain("0 leaf(s), 0 case(s)");
  // Both sides' totals appear.
  expect(result.stdout).toContain("left totals");
  expect(result.stdout).toContain("right totals");
  // At least one differing cell, with both verdicts and the values behind them.
  expect(result.stdout).toContain("left:  wrong");
  expect(result.stdout).toContain("right: correct");
  // Spawned (non-TTY), the output carries no escape bytes.
  expect(result.stdout).not.toContain("\x1b");
});

test("ribo compare --json emits the versioned contract, and carries no escape bytes", () => {
  const result = run(["--json", FIXTURE_A, FIXTURE_B]);

  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain("\x1b");
  const report = EvalCompareReportSchema.parse(JSON.parse(result.stdout));
  expect(report.contractVersion).toBe(1);
  expect(report.corpusOverride).toBe(false);
  expect(report.axes).toEqual(["settings"]);
  expect(report.leafPaths).toHaveLength(4);
  expect(report.differences.length).toBeGreaterThan(0);
  expect(report.left.corpus.name).toBe("workshop-bicycles");
  expect(report.right.corpus.name).toBe("workshop-bicycles");
  expect(report.left.identity.settings.strategies).toEqual(["single-shot"]);
  expect(report.right.identity.settings.strategies).toEqual(["per-group"]);
  expect(report.left.excludedLeaves).toBe(0);
  expect(report.right.excludedLeaves).toBe(0);
  expect(report.left.excludedCases).toBe(0);
  expect(report.right.excludedCases).toBe(0);
  expect(report.left.totals.cases).toBe(2);
  expect(report.right.totals.cases).toBe(2);
});

// --- --help (criterion 1) --------------------------------------------------------------

test("ribo compare --help teaches the surface: arguments, flags, exit codes", () => {
  const help = run(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("<a>");
  expect(help.stdout).toContain("<b>");
  expect(help.stdout).toContain("--json");
  expect(help.stdout).toContain("--allow-corpus-mismatch");
  expect(help.stdout).toContain("Exit codes:");
  expect(help.stdout).toContain("0  ");
  expect(help.stdout).toContain("2  ");
  expect(help.stdout).toContain("a difference is a finding, not a failure");
});

// --- Usage errors (criterion 4) ----------------------------------------------------------

const usageErrors: readonly (readonly string[])[] = [
  [],
  [FIXTURE_A],
  [FIXTURE_A, FIXTURE_B, FIXTURE_A],
  ["--bogus-flag", FIXTURE_A, FIXTURE_B],
];

test.each(usageErrors.map((args) => ({ args })))(
  "the usage error over $args exits 2 with an empty stdout and a named diagnostic",
  ({ args }) => {
    const fault = run(args);
    expect(fault.status).toBe(2);
    expect(fault.stdout).toBe("");
    expect(fault.stderr).toContain("ribo compare:");
  },
);

// --- Reading the records (criteria 6, 7) ---------------------------------------------------

test("a missing record path exits 2 naming the path and that it could not be read", () => {
  const missing = join(dir, "no-such-record.json");
  const fault = run([missing, FIXTURE_B]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain(missing);
  expect(fault.stderr).toContain("could not be read");
});

test("a record path pointing at a directory exits 2 naming the path", () => {
  const fault = run([dir, FIXTURE_B]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain(dir);
  expect(fault.stderr).toContain("could not be read");
});

test("a non-JSON record file exits 2 naming the path", () => {
  const file = join(dir, "not-json.json");
  writeFileSync(file, "{ not json\n");
  const fault = run([file, FIXTURE_B]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain(file);
  expect(fault.stderr).toContain("could not be read");
});

test("the left record is read first: two unreadable records report the left one", () => {
  const left = join(dir, "left-missing.json");
  const right = join(dir, "right-missing.json");
  const fault = run([left, right]);
  expect(fault.status).toBe(2);
  expect(fault.stderr).toContain(left);
  expect(fault.stderr).not.toContain(right);
});

test("a schema-invalid record exits 2 naming the path and the schema issues", () => {
  // An unknown key (the schema is strict) and a missing one, in one file.
  const broken = fixtureCopy(FIXTURE_A, "schema-broken.json", (document) => {
    document["unknown"] = true;
    delete document["model"];
  });
  const fault = run([broken, FIXTURE_B]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain(broken);
  expect(fault.stderr).toContain("model");
});

// --- The corpus gate (criteria 9, 10, 11) ---------------------------------------------------

test("records from different corpora are refused, and the refusal names the override flag", () => {
  const other = fixtureCopy(FIXTURE_B, "other-corpus.json", (document) => {
    const corpus = document["corpus"] as Record<string, unknown>;
    const fingerprint = corpus["fingerprint"] as string;
    corpus["fingerprint"] = otherFingerprint(fingerprint);
  });
  const fault = run([FIXTURE_A, other]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("corpora");
  expect(fault.stderr).toContain("--allow-corpus-mismatch");
});

test("the same pair under the override compares, and the output records it", () => {
  const other = fixtureCopy(FIXTURE_B, "other-corpus-allowed.json", (document) => {
    const corpus = document["corpus"] as Record<string, unknown>;
    const fingerprint = corpus["fingerprint"] as string;
    corpus["fingerprint"] = otherFingerprint(fingerprint);
  });
  const json = run(["--json", "--allow-corpus-mismatch", FIXTURE_A, other]);
  expect(json.status).toBe(0);
  const report = EvalCompareReportSchema.parse(JSON.parse(json.stdout));
  expect(report.corpusOverride).toBe(true);
  expect(report.left.corpus.fingerprint).not.toBe(report.right.corpus.fingerprint);

  const human = run(["--allow-corpus-mismatch", FIXTURE_A, other]);
  expect(human.status).toBe(0);
  expect(human.stdout).toContain("the corpora differ");
  expect(human.stdout).toContain("--allow-corpus-mismatch");
});

test("the override is recorded as passed even when the corpora match", () => {
  const json = run(["--json", "--allow-corpus-mismatch", FIXTURE_A, FIXTURE_B]);
  expect(json.status).toBe(0);
  const report = EvalCompareReportSchema.parse(JSON.parse(json.stdout));
  expect(report.corpusOverride).toBe(true);
});

test("under the override, records whose case ids are disjoint exit 2", () => {
  const otherCases = fixtureCopy(FIXTURE_B, "other-cases.json", (document) => {
    const grid = document["grid"] as Record<string, Record<string, unknown>>;
    for (const [leaf, row] of Object.entries(grid)) {
      const relabelled = Object.fromEntries(
        Object.entries(row).map(([caseId, cell]) => [`${caseId}-elsewhere`, cell]),
      );
      grid[leaf] = relabelled;
    }
  });
  const fault = run(["--allow-corpus-mismatch", FIXTURE_A, otherCases]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("share no case");
});

// --- The leaf intersection (criteria 17, 18) --------------------------------------------------

test("records with disjoint leaf sets exit 2 saying they share no leaf", () => {
  const empty = fixtureCopy(FIXTURE_B, "no-leaves.json", (document) => {
    document["leafPaths"] = [];
    document["grid"] = {};
  });
  const fault = run([FIXTURE_A, empty]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("share no leaf");
});

test("a partially overlapping leaf set compares on the intersection, with the exclusions counted", () => {
  const narrower = fixtureCopy(FIXTURE_B, "fewer-leaves.json", (document) => {
    document["leafPaths"] = ["frame.material", "frame.serial", "service.date"];
    const grid = document["grid"] as Record<string, Record<string, unknown>>;
    delete grid["service.notes"];
  });
  const json = run(["--json", FIXTURE_A, narrower]);
  expect(json.status).toBe(0);
  const report = EvalCompareReportSchema.parse(JSON.parse(json.stdout));
  expect(report.leafPaths).toEqual(["frame.material", "frame.serial", "service.date"]);
  expect(report.left.excludedLeaves).toBe(1);
  expect(report.right.excludedLeaves).toBe(0);
  for (const difference of report.differences) {
    expect(difference.leafPath).not.toBe("service.notes");
  }
});

// --- Comparing a record with itself (criterion 16's bin-level face) ---------------------------

test("a record compared with itself exits 0 with no axes and no differences", () => {
  const json = run(["--json", FIXTURE_A, FIXTURE_A]);
  expect(json.status).toBe(0);
  const report = EvalCompareReportSchema.parse(JSON.parse(json.stdout));
  expect(report.axes).toEqual([]);
  expect(report.differences).toEqual([]);
});
