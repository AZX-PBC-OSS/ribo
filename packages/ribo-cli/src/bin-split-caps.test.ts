import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterAll, beforeAll, expect, test } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { describeExtraction } from "@azx/ribo-core";
import { snuggExtractionSchema } from "@azx/ribo-adapter-snuggpro";

/**
 * @file The split-cap flags reach the library. The report's options carry
 * `maxSerializedCharsPerGroup` and `maxNullableUnionsPerGroup`
 * (`SchemaInspectOptions`), and the design says the partition is reported
 * "under a given split config" — but the bin exposes only the threshold flags
 * `--max-depth` and `--max-piece-chars`, so the caps the field app runs
 * (the vendor byte cap, in particular) cannot be given from the command line
 * at all. These tests pin the wiring: the built bin accepts both cap flags,
 * validates them as positive integers (exit 2 otherwise), names them in
 --help, and the numbers it reports under them equal what `describeExtraction`
 * — the same core dry run the real split reads — produces for the same caps
 * over the real Snugg schema.
 *
 * The bin is driven as a subprocess (the `bin.test.ts` idiom) and built once per run in
 * `beforeAll`, so the suite tests the artifact the command runs, never a stale
 * one.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

let dir: string;
let documentPath: string;

beforeAll(() => {
  buildCliOnce();
  dir = mkdtempSync(join(tmpdir(), "ribo-cli-split-caps-"));
  documentPath = join(dir, "snugg.extraction.schema.json");
  writeFileSync(
    documentPath,
    JSON.stringify(z.toJSONSchema(snuggExtractionSchema, { target: "openapi-3.0" })),
  );
}, 120_000);

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runBin = (args: string[]): Run => {
  const outcome = spawnSync(process.execPath, [BIN, "schema", "inspect", ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return { status: outcome.status, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
};

/** The dry run the report must agree with, over the same document and caps. */
const dryRun = (caps: {
  maxSerializedCharsPerGroup?: number;
  maxNullableUnionsPerGroup?: number;
}) =>
  describeExtraction({
    schema: z.fromJSONSchema(
      JSON.parse(
        JSON.stringify(z.toJSONSchema(snuggExtractionSchema, { target: "openapi-3.0" })),
      ) as Parameters<typeof z.fromJSONSchema>[0],
      { defaultTarget: "openapi-3.0" },
    ) as z.ZodObject,
    ...caps,
  });

const capCases: readonly [
  string,
  { maxSerializedCharsPerGroup?: number; maxNullableUnionsPerGroup?: number },
][] = [
  [
    "the field app's byte cap with the union cap raised",
    { maxSerializedCharsPerGroup: 32768, maxNullableUnionsPerGroup: 100000 },
  ],
  ["the byte cap alone", { maxSerializedCharsPerGroup: 32768 }],
];

test.each(capCases)(
  "the bin accepts the split caps (%s) and reports the partition describeExtraction produces",
  (_label, caps) => {
    const args: string[] = ["--json"];
    if (caps.maxSerializedCharsPerGroup !== undefined)
      args.push("--max-serialized-chars-per-group", String(caps.maxSerializedCharsPerGroup));
    if (caps.maxNullableUnionsPerGroup !== undefined)
      args.push("--max-nullable-unions-per-group", String(caps.maxNullableUnionsPerGroup));
    const run = runBin([...args, documentPath]);

    // Today the flags are unknown options: exit 2, no report at all.
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as {
      pieces?: { key: string; part?: number; serializedChars: number }[];
      worstPiece: { key: string; part?: number; serializedChars: number } | null;
    };
    const description = dryRun(caps);

    expect(report.pieces?.length).toBe(description.pieces?.length);
    expect(report.pieces?.length).toBeGreaterThanOrEqual(1);
    const worst = description.pieces?.reduce((a, b) =>
      b.serializedChars > a.serializedChars ? b : a,
    );
    expect(report.worstPiece?.serializedChars).toBe(worst?.serializedChars);
    expect(report.worstPiece?.key).toBe(worst?.key);
  },
);

test.each([
  ["--max-serialized-chars-per-group", "0"],
  ["--max-serialized-chars-per-group", "abc"],
  ["--max-serialized-chars-per-group", "-5"],
  ["--max-nullable-unions-per-group", "0"],
  ["--max-nullable-unions-per-group", "2.5"],
])("%s %s is a usage error: exit 2, a validation message naming the flag", (flag, value) => {
  const run = runBin([flag, value, documentPath]);
  expect(run.status).toBe(2);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain(flag);
  // A usage error on a KNOWN flag, not the unknown-option diagnostic —
  // pinning that the flag exists and the failure is its validation.
  expect(run.stderr).not.toMatch(/unknown option/i);
});

test("the cap flags are named in --help", () => {
  const run = runBin(["--help"]);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("--max-serialized-chars-per-group");
  expect(run.stdout).toContain("--max-nullable-unions-per-group");
});
