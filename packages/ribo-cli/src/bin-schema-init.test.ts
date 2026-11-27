/**
 * @file The installed schema-init command, driven through its built bin with
 * local HTTP and shadowing CLI stubs only.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { loadCorpus } from "./corpus.js";
import { defaultOperatorDirectoryFileSystem } from "./operator/output.js";
import { DEFAULT_COMPLETION_TOKENS } from "./operator/spend.js";
import { runSchemaInitCommand } from "./schema-init/command.js";
import { buildCliOnce } from "./test-support/build-once.js";

vi.setConfig({ testTimeout: 30_000 });

const proposal = {
  root: {
    kind: "object",
    description: "A drafted home audit.",
    properties: [
      {
        name: "address",
        node: {
          kind: "string",
          description: "The street address.",
          evidence: { source: "field-notes", quote: "Address: 1 Main Street" },
          // The strict wire form lists every member; an absent optional one arrives as null.
          optional: null,
          enum: null,
        },
      },
    ],
  },
};

interface WireBody {
  readonly model: string;
  readonly max_tokens?: number;
  readonly messages: readonly { readonly content: string }[];
}

let server: Server;
let baseUrl: string;
let received: WireBody[] = [];
let directory: string;
let direct: string;
let stubDirectory: string;
let stubLog: string;
let bin: string;

beforeAll(async () => {
  bin = buildCliOnce();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
      received.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: body.model === "invalid-model" ? "not JSON" : JSON.stringify(proposal),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;

  stubDirectory = mkdtempSync(join(tmpdir(), "ribo-schema-init-bin-stubs-"));
  stubLog = join(stubDirectory, "calls.log");
  const source = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  process.stdout.write("stub schema author\\n");
  process.exit(Number(process.env.STUB_VERSION_EXIT || "0"));
}
fs.readFileSync(0, "utf8");
process.stdout.write(${JSON.stringify(JSON.stringify(proposal))});
`;
  for (const binary of ["claude", "codex"]) {
    const path = join(stubDirectory, binary);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
  }
}, 120_000);

afterAll(async () => {
  rmSync(stubDirectory, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ribo-schema-init-command-"));
  direct = join(directory, "field-notes.txt");
  writeFileSync(direct, "Address: 1 Main Street\nYear built: 1984\n");
  received = [];
  rmSync(stubLog, { force: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runBin(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<Run> {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: directory,
    env: options.env ?? {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: "stub-only",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { status, stdout, stderr };
}

const runInit = (args: readonly string[], options?: Parameters<typeof runBin>[1]): Promise<Run> =>
  runBin(["schema", "init", ...args], options);

const requiredFlags = ["--backend", "openai-compatible", "--model", "gpt-4o"] as const;

function transcriptCase(id = "spoken-note"): string {
  const caseDirectory = join(directory, id);
  mkdirSync(caseDirectory);
  writeFileSync(join(caseDirectory, "input.txt"), "The boiler chain was replaced.\n");
  writeFileSync(
    join(caseDirectory, "case.json"),
    JSON.stringify({
      id,
      inputs: [{ file: "input.txt", kind: "transcript" }],
      expected: { "old.input": { status: "asserted", value: "not copied" } },
      defaults: [{ scope: "old", status: "unmentioned" }],
    }),
  );
  return caseDirectory;
}

function documentCase(): string {
  const caseDirectory = join(directory, "broken-document");
  mkdirSync(caseDirectory);
  writeFileSync(join(caseDirectory, "input.pdf"), "not a PDF");
  writeFileSync(
    join(caseDirectory, "case.json"),
    JSON.stringify({
      id: "broken-document",
      inputs: [
        {
          file: "input.pdf",
          kind: "document",
          capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 },
        },
      ],
      expected: {},
    }),
  );
  return caseDirectory;
}

function multiInputCase(): string {
  const caseDirectory = join(directory, "spoken-case");
  mkdirSync(caseDirectory);
  writeFileSync(join(caseDirectory, "input.txt"), "The boiler chain was replaced.\n");
  writeFileSync(join(caseDirectory, "note.txt"), "No additional observations.\n");
  writeFileSync(
    join(caseDirectory, "case.json"),
    JSON.stringify({
      id: "spoken-case",
      inputs: [
        { file: "input.txt", kind: "transcript" },
        { file: "note.txt", kind: "text" },
      ],
      expected: {},
    }),
  );
  return caseDirectory;
}

const corpusFlags = [
  "--corpus-name",
  "Operator named corpus",
  "--corpus-provenance",
  "synthetic",
] as const;

test("stdout carries only the drafted schema and the HTTP response cap reaches the request", async () => {
  const result = await runInit([
    direct,
    ...requiredFlags,
    "--response-cap",
    "64",
    "--max-spend",
    "1000",
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    type: "object",
    properties: { address: { type: "string" } },
  });
  expect(result.stdout).not.toContain("spend estimate");
  expect(result.stderr).toContain("spend estimate");
  expect(result.stderr).toContain("schema inspect");
  expect(result.stderr).toContain("schema plan");
  expect(result.stderr).toContain("corpus text");
  expect(result.stderr).toContain("expectation");
  expect(result.stderr).toContain("eval");
  expect(received).toHaveLength(1);
  expect(received[0]?.max_tokens).toBe(64);
  expect(received[0]?.messages.map((message) => message.content).join("\n")).toContain(
    "Year built: 1984",
  );
});

test("--out creates a new schema file and keeps stdout empty", async () => {
  const out = join(directory, "draft.json");
  const result = await runInit([direct, ...requiredFlags, "--out", out]);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ type: "object" });
  expect(received).toHaveLength(1);
  // With no --response-cap, the request still carries the reply cap the estimate priced.
  expect(received[0]?.max_tokens).toBe(DEFAULT_COMPLETION_TOKENS);
});

test("a destination whose parent directory is missing is refused before any request", async () => {
  const missingOut = await runInit([
    direct,
    ...requiredFlags,
    "--out",
    join(directory, "missing", "draft.json"),
  ]);
  expect(missingOut.status).toBe(2);
  expect(missingOut.stderr).toContain("parent directory");
  const missingCorpus = await runInit([
    direct,
    ...requiredFlags,
    "--corpus",
    join(directory, "missing", "corpus"),
    ...corpusFlags,
  ]);
  expect(missingCorpus.status).toBe(2);
  expect(missingCorpus.stderr).toContain("parent directory");
  expect(received).toHaveLength(0);
  expect(existsSync(join(directory, "missing"))).toBe(false);
});

test("samples whose case folders differ only by letter case are refused before any request", async () => {
  const upper = transcriptCase("Field-Notes");
  const corpus = join(directory, "case-corpus");
  const result = await runInit([
    direct,
    upper,
    ...requiredFlags,
    "--corpus",
    corpus,
    ...corpusFlags,
  ]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("differ only by letter case");
  expect(received).toHaveLength(0);
  expect(existsSync(corpus)).toBe(false);
});

test("a multi-input case folder with --corpus exits 0 and publishes a loadable corpus", async () => {
  const multi = multiInputCase();
  const out = join(directory, "multi-draft.json");
  const corpus = join(directory, "multi-corpus");
  const result = await runInit([
    direct,
    multi,
    ...requiredFlags,
    "--out",
    out,
    "--corpus",
    corpus,
    ...corpusFlags,
  ]);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  // The scaffolded case keeps both declared inputs, in declared order.
  const loaded = loadCorpus(corpus);
  const entry = loaded.cases.find((candidate) => candidate.id === "spoken-case");
  expect(
    entry?.inputs.map((candidate) => ({ file: candidate.file, kind: candidate.kind })),
  ).toEqual([
    { file: "input.txt", kind: "transcript" },
    { file: "note.txt", kind: "text" },
  ]);
  // The prompt saw both inputs' text, in order.
  const prompt = received[0]?.messages.map((message) => message.content).join("\n") ?? "";
  expect(prompt.indexOf("The boiler chain was replaced.")).toBeGreaterThan(-1);
  expect(prompt.indexOf("No additional observations.")).toBeGreaterThan(
    prompt.indexOf("The boiler chain was replaced."),
  );
});

test("a schema file that fails to publish after the corpus removes the corpus too", async () => {
  const out = join(directory, "late.json");
  const corpus = join(directory, "late-corpus");
  const chat = {
    complete: vi.fn(async () => ({ content: JSON.stringify(proposal) })),
  };
  const ignore = { write: () => true } as unknown as NodeJS.WritableStream;
  const pending = runSchemaInitCommand(
    [direct],
    {
      backend: "openai-compatible",
      model: "gpt-4o",
      out,
      corpus,
      corpusName: "Late corpus",
      corpusProvenance: "synthetic",
      yes: true,
    },
    {
      cwd: directory,
      env: {},
      stdout: ignore,
      stderr: ignore,
      confirmation: null,
      prepareBackend: async () => chat,
      outputFs: {
        lstat: async (path) => (await import("node:fs/promises")).lstat(path),
        writeFile: async (path, artifact) =>
          (await import("node:fs/promises")).writeFile(path, artifact, { flag: "wx" }),
        link: () => Promise.reject(Object.assign(new Error("link refused"), { code: "EACCES" })),
        unlink: async (path) => (await import("node:fs/promises")).unlink(path),
      },
      directoryFs: defaultOperatorDirectoryFileSystem,
    },
  );
  await expect(pending).rejects.toThrow("was removed so no partial scaffold remains");
  expect(chat.complete).toHaveBeenCalledTimes(1);
  expect(existsSync(corpus)).toBe(false);
  expect(existsSync(out)).toBe(false);
  expect(readdirSync(directory).filter((name) => name.includes(".ribo-"))).toEqual([]);
});

test("a corpus scaffold has byte-identical schema output, one empty case per sample and all handoffs", async () => {
  const spoken = transcriptCase();
  const out = join(directory, "draft.json");
  const corpus = join(directory, "corpus");
  const result = await runInit([
    direct,
    spoken,
    ...requiredFlags,
    "--out",
    out,
    "--corpus",
    corpus,
    ...corpusFlags,
  ]);

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(readFileSync(join(corpus, "schema.json"))).toEqual(readFileSync(out));
  const loaded = loadCorpus(corpus);
  expect(loaded.manifest).toMatchObject({
    name: "Operator named corpus",
    provenance: "synthetic",
    prompt: { instructions: "" },
  });
  expect(loaded.cases.map((entry) => entry.id)).toEqual(["field-notes", "spoken-note"]);
  expect(loaded.cases.every((entry) => Object.keys(entry.expected).length === 0)).toBe(true);
  expect(loaded.cases.every((entry) => entry.defaults === undefined)).toBe(true);
  expect(loaded.cases[0]?.inputs[0]).toMatchObject({ kind: "text", file: "field-notes.txt" });
  expect(loaded.cases[1]?.inputs[0]).toMatchObject({ kind: "transcript", file: "input.txt" });
  for (const handoff of ["schema inspect", "schema plan", "corpus text", "expectation", "eval"]) {
    expect(result.stderr).toContain(handoff);
  }
});

test("existing --out and --corpus destinations are refused before any request and never overwritten", async () => {
  const out = join(directory, "existing.json");
  writeFileSync(out, "original schema bytes");
  const existingOut = await runInit([direct, ...requiredFlags, "--out", out]);
  expect(existingOut.status).toBe(2);
  expect(existingOut.stdout).toBe("");
  expect(existingOut.stderr).toContain("already exists");
  expect(readFileSync(out, "utf8")).toBe("original schema bytes");
  expect(received).toHaveLength(0);

  const corpus = join(directory, "existing-corpus");
  mkdirSync(corpus);
  writeFileSync(join(corpus, "keep.txt"), "original corpus bytes");
  const existingCorpus = await runInit([
    direct,
    ...requiredFlags,
    "--corpus",
    corpus,
    ...corpusFlags,
  ]);
  expect(existingCorpus.status).toBe(2);
  expect(existingCorpus.stdout).toBe("");
  expect(existingCorpus.stderr).toContain("already exists");
  expect(readFileSync(join(corpus, "keep.txt"), "utf8")).toBe("original corpus bytes");
  expect(received).toHaveLength(0);
  expect(readdirSync(directory).filter((name) => name.includes(".ribo-"))).toEqual([]);
});

test("usage and invalid corpus metadata combinations exit 2 without a destination or request", async () => {
  const out = join(directory, "usage.json");
  const cases = [
    [...requiredFlags],
    [direct, "--backend", "openai-compatible"],
    [direct, "--backend", "unknown", "--model", "gpt-4o"],
    [direct, ...requiredFlags, "--response-cap", "0"],
    [direct, ...requiredFlags, "--timeout", "1.5"],
    [direct, ...requiredFlags, "--max-spend", "-1"],
    [direct, ...requiredFlags, "--corpus", "unused"],
    [direct, ...requiredFlags, "--corpus-name", "unused"],
    [direct, "--backend", "claude-cli", "--model", "stub", "--response-cap", "10"],
    [direct, ...requiredFlags, "--timeout", "1"],
  ];

  for (const args of cases) {
    const result = await runInit([...args, "--out", out]);
    expect(result.status, args.join(" ")).toBe(2);
    expect(result.stdout, args.join(" ")).toBe("");
    expect(existsSync(out), args.join(" ")).toBe(false);
  }
  expect(received).toHaveLength(0);
  expect(existsSync(stubLog)).toBe(false);
});

test("a duplicate declared input file in a case folder refuses before any request", async () => {
  const multi = transcriptCase("duplicate-input");
  const caseFile = JSON.parse(readFileSync(join(multi, "case.json"), "utf8")) as {
    inputs: unknown[];
  };
  caseFile.inputs.push({ file: "input.txt", kind: "transcript" });
  writeFileSync(join(multi, "case.json"), JSON.stringify(caseFile));
  const out = join(directory, "multi.json");

  const result = await runInit([direct, multi, ...requiredFlags, "--out", out]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("twice");
  expect(existsSync(out)).toBe(false);
  expect(received).toHaveLength(0);
});

test("a missing HTTP credential exits 2 before any request and leaves no destination", async () => {
  const out = join(directory, "credential.json");
  const result = await runInit([direct, ...requiredFlags, "--out", out], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      OPENAI_BASE_URL: baseUrl,
    },
  });

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("OPENAI_API_KEY");
  expect(received).toHaveLength(0);
  expect(existsSync(out)).toBe(false);
});

test("a shadowing CLI executable drafts without a credential and honors its timeout flag", async () => {
  const result = await runInit(
    [direct, "--backend", "claude-cli", "--model", "claude-haiku-5-5", "--timeout", "2"],
    {
      env: {
        PATH: `${stubDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "",
        STUB_LOG: stubLog,
      },
    },
  );

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ type: "object" });
  const calls = readFileSync(stubLog, "utf8").trim().split("\n");
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[0]!)).toEqual(["--version"]);
  expect(JSON.parse(calls[1]!)).toContain("claude-haiku-5-5");
});

test("a failing CLI preflight exits 2 without an artifact", async () => {
  const out = join(directory, "preflight.json");
  const result = await runInit(
    [direct, "--backend", "claude-cli", "--model", "stub", "--out", out],
    {
      env: {
        PATH: `${stubDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "",
        STUB_LOG: stubLog,
        STUB_VERSION_EXIT: "1",
      },
    },
  );

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--version");
  expect(existsSync(out)).toBe(false);
  expect(received).toHaveLength(0);
});

test("a transcription failure exits 2 before any model request and leaves no destination", async () => {
  const out = join(directory, "transcription.json");
  const result = await runInit([direct, documentCase(), ...requiredFlags, "--out", out]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/transcrib|PDF/iu);
  expect(existsSync(out)).toBe(false);
  expect(received).toHaveLength(0);
});

test("spend refusal and exhausted invalid model output leave neither schema nor corpus destinations", async () => {
  const spendOut = join(directory, "spend.json");
  const spendCorpus = join(directory, "spend-corpus");
  const refused = await runInit([
    direct,
    ...requiredFlags,
    "--max-spend",
    "0.000001",
    "--out",
    spendOut,
    "--corpus",
    spendCorpus,
    ...corpusFlags,
  ]);
  expect(refused.status).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("above the ceiling");
  expect(existsSync(spendOut)).toBe(false);
  expect(existsSync(spendCorpus)).toBe(false);
  expect(received).toHaveLength(0);

  const invalidOut = join(directory, "invalid.json");
  const invalidCorpus = join(directory, "invalid-corpus");
  const invalid = await runInit([
    direct,
    "--backend",
    "openai-compatible",
    "--model",
    "invalid-model",
    "--out",
    invalidOut,
    "--corpus",
    invalidCorpus,
    ...corpusFlags,
  ]);
  expect(invalid.status).toBe(2);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("exhausted its named repairs");
  expect(received).toHaveLength(3);
  expect(existsSync(invalidOut)).toBe(false);
  expect(existsSync(invalidCorpus)).toBe(false);
});

test("help names the inputs, output and spend flags and only exit codes 0 and 2", async () => {
  const result = await runInit(["--help"]);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("<samples...>");
  expect(result.stdout).toContain("--out <file>");
  expect(result.stdout).toContain("--corpus <dir>");
  expect(result.stdout).toContain("--corpus-name <name>");
  expect(result.stdout).toContain("--corpus-provenance <kind>");
  expect(result.stdout).toContain("--response-cap <n>");
  expect(result.stdout).toContain("--timeout <seconds>");
  expect(result.stdout).toContain("--max-spend <usd>");
  expect(result.stdout).toContain("--captured-at <iso>");
  expect(result.stdout).toContain("intake-form.pdf");
  expect(result.stdout).toMatch(/0\s+the schema was drafted/u);
  expect(result.stdout).toMatch(/2\s+the command could not run/u);
  expect(result.stdout).not.toMatch(/^\s*1\s+/mu);
});

test("an invalid --captured-at exits 2 with ISO guidance before the stub backend is called", async () => {
  const out = join(directory, "captured-at.json");
  const result = await runInit([
    direct,
    ...requiredFlags,
    "--captured-at",
    "not-a-datetime",
    "--out",
    out,
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ISO 8601");
  expect(existsSync(out)).toBe(false);
  expect(received).toHaveLength(0);
  expect(existsSync(stubLog)).toBe(false);
});

test("--captured-at with only text samples exits 2 before the stub backend is called", async () => {
  const out = join(directory, "text-only.json");
  const result = await runInit([
    direct,
    ...requiredFlags,
    "--captured-at",
    "2026-06-01T09:00:00Z",
    "--out",
    out,
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--captured-at");
  expect(existsSync(out)).toBe(false);
  expect(received).toHaveLength(0);
  expect(existsSync(stubLog)).toBe(false);
});

test("a bare PDF with --corpus drafts, scaffolds the measured and stamped capture, and prints one stamp line", async () => {
  const barePdf = join(directory, "intake-form.pdf");
  writeFileSync(
    barePdf,
    readFileSync(
      fileURLToPath(
        new URL("../../ribo-transcriber-pdfjs/src/fixtures/three-page.pdf", import.meta.url),
      ),
    ),
  );
  const out = join(directory, "bare-pdf.json");
  const corpus = join(directory, "bare-pdf-corpus");
  const result = await runInit([
    barePdf,
    direct,
    ...requiredFlags,
    "--out",
    out,
    "--corpus",
    corpus,
    ...corpusFlags,
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ type: "object" });
  // One stderr line names the stamped file, the instant and the flag.
  const stampLine = result.stderr.split("\n").filter((line) => line.includes("capturedAt"));
  expect(stampLine).toHaveLength(1);
  expect(stampLine[0]).toContain("intake-form.pdf");
  expect(stampLine[0]).toMatch(/capturedAt \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u);
  expect(stampLine[0]).toContain("--captured-at");
  // The scaffold carries the measured page count and the stamped instant.
  const caseFile = JSON.parse(await readFile(join(corpus, "intake-form", "case.json"), "utf8")) as {
    inputs: { capture: { capturedAt: string; pageCount: number } }[];
  };
  expect(caseFile.inputs[0]?.capture).toMatchObject({ pageCount: 3 });
  expect(caseFile.inputs[0]?.capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
});
