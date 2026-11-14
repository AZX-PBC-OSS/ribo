import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { corpusWithoutDocuments, removeTemporaries } from "./eval/test-support/corpus.js";

/**
 * @file The CLI backends, driven through the BUILT single-file bin.
 *
 * The two CLI backends are the only way this command can measure a model
 * without a credential, and they are the only path in the package that runs
 * `ajv` — a validator that GENERATES CODE AT RUN TIME, which is a known
 * bundling hazard. Neither `publint` nor `attw` nor the pack-and-consume tier
 * ever executes the shipped bin's validator, so this suite is the only
 * automated catch for "the bundled `ajv` cannot compile a validator".
 *
 * The suite never spawns a real `claude` or `codex`: it writes a STUB
 * executable into a temp directory and puts that directory FIRST on the
 * child's `PATH`, so a developer's own installed binary is shadowed and the
 * run is the same everywhere. The stub answers `--version` (the preflight) and
 * emits a schema-conforming reply for an extraction call — reading the schema
 * out of the prompt, which is where the transport puts it.
 *
 * The stub's first extraction reply is deliberately NON-conforming, so the
 * transport's own retry loop runs: that is what proves the bundled validator
 * REJECTS a bad reply as well as accepting a good one. A run that never
 * retried would not prove the validator works at all.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

// The bin is spawned as a subprocess and waits for a stub process to answer
// it, so every run costs a subprocess and a round trip.
vi.setConfig({ testTimeout: 30_000 });

/**
 * The stub backend executable.
 *
 * It is a plain CommonJS script — a stub cannot import the package's own
 * TypeScript helpers — so the schema-driven reply is re-implemented here in a
 * few lines. The shape it generates is the same one the eval suite's stub
 * chat generates: a value conforming to the request's own JSON Schema.
 */
const STUB_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");

const args = process.argv.slice(2);
const log = process.env.STUB_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");

if (args.includes("--version")) {
  process.stdout.write("stub-cli 0.0.0\\n");
  process.exit(Number(process.env.STUB_VERSION_EXIT || "0"));
}

const marker = "JSON SCHEMA:";
const prompt = args.find((a) => a.includes(marker)) || "";
const after = prompt.slice(prompt.indexOf(marker) + marker.length);

function firstObject(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function conform(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  const branches = node.anyOf || node.oneOf;
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      if (branch && branch.type !== "null") return conform(branch);
    }
    return null;
  }
  if (node.type === "array") return node.items ? [conform(node.items)] : [];
  if (node.properties) {
    const out = {};
    for (const key of Object.keys(node.properties)) out[key] = conform(node.properties[key]);
    return out;
  }
  switch (node.type) {
    case "string": return "sample";
    case "number":
    case "integer": return 1;
    case "boolean": return true;
    case "null": return null;
    default: return null;
  }
}

const markerFile = process.env.STUB_MARKER;
if (markerFile && fs.existsSync(markerFile)) {
  fs.unlinkSync(markerFile);
  process.stdout.write("stub banner\\n" + JSON.stringify({ nope: true }) + "\\n");
  process.exit(0);
}

const schema = JSON.parse(firstObject(after));
process.stdout.write("stub banner\\n" + JSON.stringify(conform(schema)) + "\\n");
`;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The report the command emits. */
interface EvalReport {
  readonly name: string;
  readonly backend: string;
  readonly model: string;
  readonly arms: readonly {
    readonly settings: Record<string, unknown>;
    readonly results: readonly {
      readonly caseId: string;
      readonly status: string;
      readonly usage?: { readonly engine?: string };
    }[];
  }[];
}

/** The stub's directory, its log and its marker file. */
let stubDir: string;
let stubLog: string;
let stubMarker: string;

beforeAll(() => {
  buildCliOnce();
  stubDir = mkdtempSync(join(tmpdir(), "ribo-cli-stub-"));
  stubLog = join(stubDir, "calls.log");
  stubMarker = join(stubDir, "fail-next");
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

/**
 * Drive the built bin with the stub directory first on the child's PATH.
 *
 * The child's environment is built explicitly: no credential is inherited,
 * which is what proves the CLI backends need none.
 */
const runBin = async (args: readonly string[], env: Record<string, string>): Promise<Run> => {
  const child = spawn(process.execPath, [BIN, ...args], { env });
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

/** The child's environment: the stub directory first, and nothing else that matters. */
const childEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${stubDir}:${process.env["PATH"] ?? ""}`,
  HOME: process.env["HOME"] ?? "",
  STUB_LOG: stubLog,
  STUB_MARKER: stubMarker,
  ...extra,
});

/** Every argv the stub was called with, in order. */
const stubCalls = (): readonly string[][] =>
  readFileSync(stubLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);

/** An argv element that carries the prompt, whatever the backend's argv shape is. */
const promptOf = (argv: readonly string[]): string =>
  argv.find((element) => element.includes("JSON SCHEMA:")) ?? "";

test.each([
  ["claude-cli", "claude"],
  ["codex-cli", "codex"],
] as const)(
  "--backend %s runs the real transport against a stub binary, with no credential",
  async (backend: string, binary: string) => {
    // Arm the stub to answer the FIRST extraction call with a non-conforming
    // object: the transport's retry loop must then run, which is what proves
    // the bundled validator rejects as well as accepts.
    writeFileSync(stubMarker, "");
    rmSync(stubLog, { force: true });

    const corpus = corpusWithoutDocuments();
    const result = await runBin(
      [
        "eval",
        "--corpus",
        corpus,
        "--backend",
        backend,
        "--model",
        "ribo-test",
        "--strategy",
        "single-shot",
      ],
      childEnv(),
    );

    expect(result.status).toBe(0);
    // The spend guard prints its estimate before the run spends anything.
    expect(result.stderr).toContain("spend estimate");
    expect(result.stderr).not.toContain("\x1b");
    // The subscription backends carry a stated token-equivalent assumption,
    // so the reader can see what the number stands on.
    expect(result.stderr).toContain("assumption:");
    expect(result.stderr).toContain("subscription");

    const report = JSON.parse(result.stdout) as EvalReport;
    expect(report.backend).toBe(binary === "claude" ? "claude-cli" : "codex-cli");
    expect(report.model).toBe("ribo-test");
    expect(report.arms).toHaveLength(1);
    const arm = report.arms[0]!;
    expect(arm.results.length).toBeGreaterThan(0);
    for (const entry of arm.results) {
      // A broken bundle would show up here as a failed case, not as a crash.
      expect(entry.status).toBe("extracted");
      expect(entry.usage?.engine).toBe(report.backend);
    }

    const calls = stubCalls();
    // The preflight ran first, before any model call.
    expect(calls[0]).toEqual(["--version"]);
    // Then the first extraction call, then the retry the non-conforming reply
    // provoked, then the second case's call.
    expect(calls).toHaveLength(4);
    expect(promptOf(calls[1]!)).toContain("JSON SCHEMA:");
    expect(promptOf(calls[2]!)).toContain("did NOT conform");
    // The model flag reaches the binary the backend was asked for.
    const modelFlag = binary === "claude" ? "--model" : "-m";
    const extractionArgv = calls[1]!;
    const flagIndex = extractionArgv.indexOf(modelFlag);
    expect(flagIndex).toBeGreaterThan(-1);
    expect(extractionArgv[flagIndex + 1]).toBe("ribo-test");
  },
);

test("a missing binary refuses up front, with the cause and the fix", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "ribo-cli-empty-"));
  try {
    const corpus = corpusWithoutDocuments();
    const result = await runBin(
      [
        "eval",
        "--corpus",
        corpus,
        "--backend",
        "claude-cli",
        "--model",
        "ribo-test",
        "--strategy",
        "single-shot",
      ],
      { PATH: emptyDir, HOME: process.env["HOME"] ?? "" },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("claude");
    expect(result.stderr).toMatch(/not found on PATH/);
    expect(result.stderr).toContain("(fix:");
    // The refusal is the preflight's, not commander's choices error.
    expect(result.stderr).not.toContain("Allowed choices");
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("the preflight runs before the corpus is read", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "ribo-cli-empty-"));
  try {
    const missingCorpus = join(emptyDir, "no-such-corpus");
    const result = await runBin(
      [
        "eval",
        "--corpus",
        missingCorpus,
        "--backend",
        "claude-cli",
        "--model",
        "ribo-test",
        "--strategy",
        "single-shot",
      ],
      { PATH: emptyDir, HOME: process.env["HOME"] ?? "" },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    // The binary is named, and the corpus is not: the preflight comes first.
    expect(result.stderr).toContain("claude");
    expect(result.stderr).not.toContain(missingCorpus);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("a binary that does not answer --version refuses the same way", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await runBin(
    [
      "eval",
      "--corpus",
      corpus,
      "--backend",
      "claude-cli",
      "--model",
      "ribo-test",
      "--strategy",
      "single-shot",
    ],
    childEnv({ STUB_VERSION_EXIT: "1" }),
  );

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("claude");
  expect(result.stderr).toContain("--version");
  expect(result.stderr).toContain("(fix:");
});
