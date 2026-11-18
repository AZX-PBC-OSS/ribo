import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { corpusWithoutDocuments, removeTemporaries } from "./eval/test-support/corpus.js";

/**
 * @file `ribo eval --timeout <seconds>`, driven against the BUILT bin: the
 * flag sets the CLI backends' per-call timeout, a non-positive or
 * non-numeric value is a usage refusal naming the flag, and on the
 * openai-compatible backend the flag is refused up front — the mirror of
 * `--response-cap`'s refusal on the CLI backends.
 *
 * The CLI backends are exercised against a STUB binary first on the child's
 * PATH, never a real `claude`/`codex`: the stub answers the preflight's
 * `--version` probe, then sleeps through every extraction call, so the only
 * way a call ends is the transport's own timeout. A run whose cases all
 * failed is a measurement, not a fault — the command still exits 0, and the
 * per-case failure in the stdout report is where the timeout shows.
 *
 * Must-fail: without the flag, commander refuses `--timeout` as an unknown
 * option and every test below exits 2 where it expects 0 — and the sleeping
 * stub proves the value reached the transport, since nothing else could end
 * its calls at one second.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

// The sleeping-stub run costs the preflight plus every case's full attempt
// budget of one-second timeouts; the margin is for a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The stub backend executable: log every spawn, answer `--version`, and for
 * anything else drain stdin (the prompt rides it) and sleep — a call that
 * only the transport's timeout can end.
 */
const STUB_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const log = process.env.STUB_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) {
  process.stdout.write("stub-cli 0.0.0\\n");
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => setTimeout(() => process.exit(0), 120000));
`;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The report the command emits, as this suite reads it. */
interface EvalReport {
  readonly arms: readonly {
    readonly results: readonly { readonly caseId: string; readonly status: string }[];
    readonly totals: { readonly accuracyOverAll: number | null };
  }[];
}

/** The stub's directory and its spawn log. */
let stubDir: string;
let stubLog: string;

beforeAll(() => {
  buildCliOnce();
  stubDir = mkdtempSync(join(tmpdir(), "ribo-cli-timeout-stub-"));
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
const runBin = async (args: readonly string[], env: Record<string, string> = {}): Promise<Run> => {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: {
      PATH: `${stubDir}:${process.env["PATH"] ?? ""}`,
      HOME: process.env["HOME"] ?? "",
      STUB_LOG: stubLog,
      ...env,
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

/** The eval flags every run here shares, minus the ones under test. */
const baseArgs = (corpus: string, backend: string): readonly string[] => [
  "eval",
  "--corpus",
  corpus,
  "--backend",
  backend,
  "--model",
  "ribo-test",
  "--strategy",
  "single-shot",
];

test.each([["claude-cli"], ["codex-cli"]] as const)(
  "--timeout 1 on --backend %s reaches the transport: the sleeping stub's calls die at one second, with the --timeout fix hint",
  async (backend) => {
    rmSync(stubLog, { force: true });
    const corpus = corpusWithoutDocuments();
    const result = await runBin([...baseArgs(corpus, backend), "--timeout", "1"]);

    // Every case failed, and a failed case is a measurement, not a fault.
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as EvalReport;
    expect(report.arms).toHaveLength(1);
    const arm = report.arms[0]!;
    expect(arm.results.length).toBeGreaterThan(0);
    for (const entry of arm.results) {
      expect(entry.status).toBe("failed");
    }
    // The one-second timeout is what ended the calls: the failure says so,
    // and names --timeout as the fix. A default of 120 s could never have
    // produced this message.
    expect(result.stdout).toContain("did not respond within 1s");
    expect(result.stdout).toContain("--timeout");
    // A run where every case failed reads as zero accuracy, never as a high
    // one: judged cells, none of them correct.
    expect(arm.totals.accuracyOverAll).toBe(0);
    // The preflight ran first, then the extraction calls the timeout killed.
    const calls = readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
    expect(JSON.parse(calls[0]!)).toEqual(["--version"]);
    expect(calls.length).toBeGreaterThan(1);
  },
);

test.each([["0"], ["abc"]] as const)(
  "--timeout %s is a usage refusal: exit 2 naming the flag, before anything ran",
  async (value) => {
    rmSync(stubLog, { force: true });
    const corpus = corpusWithoutDocuments();
    const result = await runBin([...baseArgs(corpus, "claude-cli"), "--timeout", value]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ribo eval");
    expect(result.stderr).toContain("--timeout");
    // The VALUE was refused as invalid — not the option as unknown: a flag
    // that silently accepted zero or a word would pass the exit-code check.
    expect(result.stderr).toContain("invalid");
    // Commander refused the value before the action ran: not even the
    // preflight's --version probe reached the binary.
    expect(existsSync(stubLog)).toBe(false);
    expect(result.stderr).not.toContain("spend estimate");
  },
);

test("--timeout on --backend openai-compatible is refused up front, naming the flag and the fix", async () => {
  const corpus = corpusWithoutDocuments();
  // No credential in the child's environment: if the refusal were not
  // up front, the run would fail on the missing credential instead.
  const result = await runBin([...baseArgs(corpus, "openai-compatible"), "--timeout", "5"]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ribo eval");
  expect(result.stderr).toContain("--timeout");
  expect(result.stderr).toContain("openai-compatible");
  // The refusal says the way through: drop the flag.
  expect(result.stderr).toContain("drop --timeout");
  // The refusal came before the credential lookup: the missing
  // OPENAI_API_KEY is never mentioned.
  expect(result.stderr).not.toContain("OPENAI_API_KEY");
  expect(result.stderr).not.toContain("spend estimate");
});
