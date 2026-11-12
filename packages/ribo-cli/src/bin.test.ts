import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { SchemaInspectReportSchema } from "./index.js";

/**
 * @file The `ribo schema inspect` command surface, pinned against the built
 * bin as a subprocess (design §1/§4/§5/§8, Decision D2): the human rendering
 * is the default, `--json` emits the versioned contract, threshold breaches
 * exit 1 with the report still on stdout, every could-not-run fault exits 2
 * with an actionable diagnostic, and output discipline holds — stdout for
 * results, stderr for diagnostics, no colour when piped, never a prompt.
 *
 * The suite is self-sufficient: the `beforeAll` hook rebuilds `dist/bin.js`
 * (raising the hook timeout for a cold CI), so `pnpm vitest run
 * packages/ribo-cli` passes on a clean checkout and the suite tests the
 * artifact T6 runs — never a stale one. A build failure fails the file
 * loudly; skipping is never an outcome.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");
const CLI_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, "packages", "ribo-cli", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const CORE_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, "packages", "ribo-core", "package.json"), "utf8")) as {
    version: string;
  }
).version;

let dir: string;

beforeAll(() => {
  execFileSync("pnpm", ["--filter", "@azx/ribo-cli", "build"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  dir = mkdtempSync(join(tmpdir(), "ribo-cli-bin-"));

  const grouped = {
    type: "object",
    description: "Home overview",
    properties: {
      home: {
        type: "object",
        description: "Home",
        properties: {
          address: { type: "string", description: "Street address" },
          yearBuilt: { type: "number", description: "Year built", nullable: true },
        },
        required: ["address", "yearBuilt"],
      },
      notes: { type: "string", description: "Freeform notes", nullable: true },
    },
    required: ["home", "notes"],
  };
  const deep = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: {
              c: {
                type: "object",
                properties: { d: { type: "string", nullable: true } },
                required: ["d"],
              },
            },
            required: ["c"],
          },
        },
        required: ["b"],
      },
    },
    required: ["a"],
  };
  // Nine enveloped leaves in one group (18 nullable unions) partition under
  // the default union cap of 16 — per-group pieces named `home-<part>`.
  const manyNullable = {
    type: "object",
    properties: {
      home: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`leaf${i}`, { type: "string", nullable: true }]),
        ),
        required: Array.from({ length: 9 }, (_, i) => `leaf${i}`),
      },
    },
    required: ["home"],
  };
  const draftForm = {
    type: "object",
    properties: { atRoot: { anyOf: [{ type: "string" }, { type: "null" }] } },
    required: ["atRoot"],
  };
  const ifThen = {
    type: "object",
    properties: { ok: { type: "string" } },
    required: ["ok"],
    if: { properties: { ok: { const: "yes" } } },
    then: { properties: { extra: { type: "string" } } },
  };
  const deriveRefusal = {
    type: "object",
    properties: { home: { type: "object" } },
    required: ["home"],
  };

  writeFileSync(join(dir, "grouped.json"), JSON.stringify(grouped));
  writeFileSync(join(dir, "deep.json"), JSON.stringify(deep));
  writeFileSync(join(dir, "many-nullable.json"), JSON.stringify(manyNullable));
  writeFileSync(join(dir, "draft-form.json"), JSON.stringify(draftForm));
  writeFileSync(join(dir, "if-then.json"), JSON.stringify(ifThen));
  writeFileSync(join(dir, "derive-refusal.json"), JSON.stringify(deriveRefusal));
  writeFileSync(join(dir, "whitespace.json"), "  \n \n");
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

const run = (args: string[], options: { input?: string; ignoreStdin?: boolean } = {}): Run => {
  const outcome = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: "utf8",
    ...(options.input !== undefined
      ? { input: options.input }
      : options.ignoreStdin === true
        ? { stdio: ["ignore", "pipe", "pipe"] }
        : {}),
  });
  return { status: outcome.status, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
};

const envWithoutNoColor = (): NodeJS.ProcessEnv => {
  const { NO_COLOR: _omitted, ...rest } = process.env;
  return rest;
};

// --- Rendering selection and the --json contract (criteria 1, 2) -----------------

test("the human rendering is the default: exit 0, same headline numbers as the report", () => {
  const jsonRun = run(["schema", "inspect", "--json", "grouped.json"]);
  expect(jsonRun.status).toBe(0);
  const report = SchemaInspectReportSchema.parse(JSON.parse(jsonRun.stdout));

  const humanRun = run(["schema", "inspect", "grouped.json"]);
  expect(humanRun.status).toBe(0);
  expect(humanRun.stdout).not.toBe("");
  // The headline numbers appear in the human output: leaf count, whole depth,
  // worst-piece chars.
  expect(humanRun.stdout).toContain(`${report.leafCount}`);
  expect(humanRun.stdout).toContain(`${report.whole!.depth}`);
  expect(humanRun.stdout).toContain(`${report.worstPiece!.serializedChars}`);
});

test("--json parses against the exported contract, names both versions and the fingerprint", () => {
  const jsonRun = run(["schema", "inspect", "--json", "grouped.json"]);
  expect(jsonRun.status).toBe(0);
  const report = SchemaInspectReportSchema.parse(JSON.parse(jsonRun.stdout));
  expect(report.contractVersion).toBe(3);
  expect(report.cliVersion).toBe(CLI_VERSION);
  expect(report.coreVersion).toBe(CORE_VERSION);
  expect(report.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test("--json stdout is byte-identical with and without NO_COLOR", () => {
  const withNoColor = spawnSync(
    process.execPath,
    [BIN, "schema", "inspect", "--json", "grouped.json"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  const withoutNoColor = spawnSync(
    process.execPath,
    [BIN, "schema", "inspect", "--json", "grouped.json"],
    { cwd: dir, encoding: "utf8", env: envWithoutNoColor() },
  );
  expect(withNoColor.status).toBe(0);
  expect(withoutNoColor.status).toBe(0);
  expect(withNoColor.stdout).toBe(withoutNoColor.stdout);
});

// --- Thresholds (criteria 3, 4, 5) -------------------------------------------------

test("a depth breach exits 1, keeps the full report on stdout, and names the breach on stderr", () => {
  const breach = run(["schema", "inspect", "--json", "--max-depth", "3", "deep.json"]);
  expect(breach.status).toBe(1);
  const report = SchemaInspectReportSchema.parse(JSON.parse(breach.stdout));
  const row = report.thresholds!.find((entry) => entry.measure === "depth")!;
  expect(row.limit).toBe(3);
  expect(row.breached).toBe(true);
  expect(row.measured).toBe(report.whole!.depth);
  expect(breach.stderr).toContain("depth");
  expect(breach.stderr).toContain("3");
  expect(breach.stderr).toContain(`${row.measured}`);
});

test("a pieceChars breach exits 1 and names the piece label in both renderings", () => {
  const breach = run([
    "schema",
    "inspect",
    "--json",
    "--max-piece-chars",
    "1",
    "many-nullable.json",
  ]);
  expect(breach.status).toBe(1);
  const report = SchemaInspectReportSchema.parse(JSON.parse(breach.stdout));
  const row = report.thresholds!.find((entry) => entry.measure === "pieceChars")!;
  expect(row.breached).toBe(true);
  expect(row.measured).toBe(report.worstPiece!.serializedChars);
  expect(row.piece).toBe(
    report.worstPiece!.part === undefined
      ? report.worstPiece!.key
      : `${report.worstPiece!.key}-${report.worstPiece!.part}`,
  );
  expect(row.piece).not.toBe("");
  // Named on stderr and in the human rendering alike (design §11).
  expect(breach.stderr).toContain("pieceChars");
  expect(breach.stderr).toContain(`${row.piece}`);
  const humanBreach = run(["schema", "inspect", "--max-piece-chars", "1", "many-nullable.json"]);
  expect(humanBreach.status).toBe(1);
  expect(humanBreach.stdout).toContain(`${row.piece}`);
});

test("thresholds supplied and not breached exit 0 with breached-false rows", () => {
  const ok = run([
    "schema",
    "inspect",
    "--json",
    "--max-depth",
    "50",
    "--max-piece-chars",
    "100000",
    "grouped.json",
  ]);
  expect(ok.status).toBe(0);
  const report = SchemaInspectReportSchema.parse(JSON.parse(ok.stdout));
  expect(report.thresholds).toHaveLength(2);
  for (const row of report.thresholds!) expect(row.breached).toBe(false);
});

test("a refusal is a finding, not a failure: the report rides, the exit is 0", () => {
  const ok = run([
    "schema",
    "inspect",
    "--json",
    "--max-depth",
    "50",
    "--max-piece-chars",
    "100000",
    "derive-refusal.json",
  ]);
  expect(ok.status).toBe(0);
  const report = SchemaInspectReportSchema.parse(JSON.parse(ok.stdout));
  expect(report.refusal).toBeDefined();
  // The refusal that empties the derive stage leaves the measured depth
  // unavailable — and an unavailable measure never breaches (criterion 5).
  const depthRow = report.thresholds?.find((entry) => entry.measure === "depth");
  if (depthRow !== undefined) expect(depthRow).toMatchObject({ measured: null, breached: false });
});

// --- Could-not-run faults (criteria 6–10) ------------------------------------------

test("a missing file exits 2 naming the path, stdout empty", () => {
  const missing = join(dir, "nope.schema.json");
  const fault = run(["schema", "inspect", missing]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain(missing);
});

test("invalid JSON on stdin exits 2 saying the input is not valid JSON, with the position", () => {
  const fault = run(["schema", "inspect"], { input: "{not json" });
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("not valid JSON");
  expect(fault.stderr).toMatch(/position \d+/);
});

test("a draft-2020-12-form document is refused loudly: the form, the one-liner, the docs page", () => {
  const fault = run(["schema", "inspect", "draft-form.json"]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("draft-2020-12");
  expect(fault.stderr).toContain("anyOf");
  expect(fault.stderr).toContain('"nullable": true');
  expect(fault.stderr).toContain('z.toJSONSchema(schema, { target: "openapi-3.0" })');
  expect(fault.stderr).toContain("docs/guide/from-a-schema.md");
});

test("an unconvertible document names the construct, the z.fromJSONSchema limit, and the remedy", () => {
  const fault = run(["schema", "inspect", "if-then.json"]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  // The construct, in zod's own complaint vocabulary (kept a substring, not a
  // sentence — R3).
  expect(fault.stderr).toContain("if/then");
  expect(fault.stderr).toContain("z.fromJSONSchema");
  expect(fault.stderr).toContain("docs/guide/from-a-schema.md");
});

test("empty stdin exits 2 naming the empty source — never an empty report", () => {
  const fault = run(["schema", "inspect"], { input: "" });
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("was empty");
  const whitespace = run(["schema", "inspect", "whitespace.json"]);
  expect(whitespace.status).toBe(2);
  expect(whitespace.stdout).toBe("");
  expect(whitespace.stderr).toContain("was empty");
});

// --- Usage errors, prompts and help (criteria 11, 12, 14) ----------------------------

test("an unknown flag is a usage error: exit 2, stdout empty", () => {
  const fault = run(["schema", "inspect", "--bogus-flag", "grouped.json"]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("--bogus-flag");
});

test("a surplus positional argument is a usage error: exit 2, stdout empty", () => {
  const fault = run(["schema", "inspect", "grouped.json", "deep.json"]);
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("too many arguments");
});

test.each(["abc", "-1", "2.5"])(
  "--max-depth %s is a usage error naming the flag and the value",
  (value) => {
    const fault = run(["schema", "inspect", "--max-depth", value, "grouped.json"]);
    expect(fault.status).toBe(2);
    expect(fault.stdout).toBe("");
    expect(fault.stderr).toContain("--max-depth");
    expect(fault.stderr).toContain(value);
  },
);

test("no path and stdin at end-of-file exits 2 with the empty-input message — no hang, no prompt", () => {
  const fault = run(["schema", "inspect"], { ignoreStdin: true });
  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("was empty");
});

// --- Colour and pipe discipline (criterion 15) ----------------------------------------

test("piped human output and piped diagnostics carry no escape bytes, with and without NO_COLOR", () => {
  const plain = run(["schema", "inspect", "grouped.json"]);
  expect(plain.status).toBe(0);
  expect(plain.stdout).not.toContain("\x1b");
  const withNoColor = spawnSync(process.execPath, [BIN, "schema", "inspect", "grouped.json"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  expect(withNoColor.status).toBe(0);
  expect(withNoColor.stdout).not.toContain("\x1b");
  const fault = run(["schema", "inspect", join(dir, "nope.schema.json")]);
  expect(fault.status).toBe(2);
  expect(fault.stderr).not.toContain("\x1b");
});

// --- --help (criterion 14) --------------------------------------------------------------

test("ribo schema inspect --help teaches the surface: usage, flags, examples, exit codes", () => {
  const help = run(["schema", "inspect", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("[path]");
  expect(help.stdout).toContain("--json");
  expect(help.stdout).toContain("--max-depth");
  expect(help.stdout).toContain("--max-piece-chars");
  expect(help.stdout).toContain("Examples:");
  expect(help.stdout).toContain("ribo schema inspect ./snugg.schema.json");
  expect(help.stdout).toContain("| ribo schema inspect --json");
  expect(help.stdout).toContain("Exit codes:");
  expect(help.stdout).toContain("0 ");
  expect(help.stdout).toContain("1 ");
  expect(help.stdout).toContain("2 ");
});

test("ribo --help and ribo schema --help still work", () => {
  expect(run(["--help"]).status).toBe(0);
  expect(run(["schema", "--help"]).status).toBe(0);
});
