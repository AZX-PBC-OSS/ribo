import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { corpusWithoutDocuments, removeTemporaries } from "./eval/test-support/corpus.js";

/**
 * @file `--response-cap` on a CLI backend is a usage error refused up front:
 * a CLI cannot cap generated tokens, so the run exits 2 before the preflight,
 * before the corpus load and before any model call.
 *
 * The suite drives the BUILT bin with a stub CLI binary first on the child's
 * PATH whose EVERY spawn is appended to a log: "before the preflight" is
 * proved by the log holding zero spawns — not even the preflight's
 * `--version` probe ran. Without the refusal the run proceeds: the stub
 * answers the probe, every case fails on the unsupported `maxTokens`, and
 * the command exits 0 — a measurement-shaped lie this test exists to deny.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

vi.setConfig({ testTimeout: 30_000 });

/** The stub backend executable: log every spawn, answer `--version`, exit 0. */
const STUB_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const log = process.env.STUB_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) process.stdout.write("stub-cli 0.0.0\\n");
process.exit(0);
`;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The stub's directory and its spawn log. */
let stubDir: string;
let stubLog: string;

beforeAll(() => {
  buildCliOnce();
  stubDir = mkdtempSync(join(tmpdir(), "ribo-cli-cap-stub-"));
  stubLog = join(stubDir, "calls.log");
  for (const name of ["claude", "codex"]) {
    const file = join(stubDir, name);
    writeFileSync(file, STUB_SOURCE);
    chmodSync(file, 0o755);
  }
}, 120_000);

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
  removeTemporaries();
});

/** Drive the built bin with the stub directory first on the child's PATH. */
const runBin = async (args: readonly string[]): Promise<Run> => {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: {
      PATH: `${stubDir}:${process.env["PATH"] ?? ""}`,
      HOME: process.env["HOME"] ?? "",
      STUB_LOG: stubLog,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  return { status, stdout, stderr };
};

test.each([["claude-cli"], ["codex-cli"]] as const)(
  "--response-cap on --backend %s exits 2 before the preflight, naming the flag and the backend",
  async (backend) => {
    rmSync(stubLog, { force: true });
    const corpus = corpusWithoutDocuments();
    const result = await runBin([
      "eval",
      "--corpus",
      corpus,
      "--backend",
      backend,
      "--model",
      "ribo-test",
      "--strategy",
      "single-shot",
      "--response-cap",
      "1024",
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ribo eval");
    expect(result.stderr).toContain("--response-cap");
    expect(result.stderr).toContain(backend);
    // The refusal says the way through: drop the flag.
    expect(result.stderr).toContain("drop --response-cap");
    // The refusal came before the preflight: the spawn seam recorded ZERO
    // spawns — not even the `--version` probe. Must-fail: a refusal wired
    // after the preflight leaves one spawn in the log; no refusal at all
    // leaves the probe plus every case's model calls, and exits 0.
    expect(existsSync(stubLog)).toBe(false);
    // And before the spend guard: no estimate was printed.
    expect(result.stderr).not.toContain("spend estimate");
  },
);

test("the refusal comes before the corpus load too", async () => {
  const missing = join(stubDir, "no-such-corpus");
  const result = await runBin([
    "eval",
    "--corpus",
    missing,
    "--backend",
    "claude-cli",
    "--model",
    "ribo-test",
    "--strategy",
    "single-shot",
    "--response-cap",
    "1024",
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--response-cap");
  // The corpus fault is never reached: the missing corpus is not named.
  expect(result.stderr).not.toContain(missing);
});
