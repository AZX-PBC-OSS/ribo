import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSchemaPlan, planFingerprint, SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { SchemaPlan } from "@azx/ribo-core";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { loadCorpus } from "./corpus/loader.js";
import type { LoadedCorpus } from "./corpus/loader.js";
import { EvalRunRecordDocumentSchema } from "./eval/record-schema.js";
import { recordIdentity } from "./eval/record-fingerprint.js";
import { replyForSchema } from "./eval/test-support/stub-chat.js";
import {
  copiedCorpus,
  corpusWithDocumentCase,
  corpusWithoutDocuments,
  editJson,
  FIXTURE_CORPUS,
  removeTemporaries,
} from "./eval/test-support/corpus.js";
import { schemaFingerprint } from "./inspect/fingerprint.js";
import { buildCliOnce } from "./test-support/build-once.js";

/**
 * @file Planned eval through the built command. Plan usage, freshness and
 * construction are proved before a shadow executable's preflight, document
 * transcription, credential/spend work or chat. Successful mixed arms persist
 * the runner's semantic identity. Every transport is a local stub.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");
const COMPARE_FIXTURE = fileURLToPath(
  new URL("./fixtures/records/compare-a.json", import.meta.url),
);
const NO_TEXT_LAYER_PDF = fileURLToPath(
  new URL("../../ribo-transcriber-pdfjs/src/fixtures/no-text-layer.pdf", import.meta.url),
);

vi.setConfig({ testTimeout: 60_000 });

interface WireBody {
  readonly messages: readonly { readonly content: string }[];
  readonly response_format: {
    readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown> };
  };
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ArmReport {
  readonly settings: Record<string, unknown>;
  readonly results: readonly { readonly caseId: string; readonly status: string }[];
  readonly fingerprint: string;
  readonly record: string;
}

interface EvalReport {
  readonly arms: readonly ArmReport[];
}

let server: Server;
let baseUrl: string;
let workDir: string;
let stubDir: string;
let stubLog: string;
const received: WireBody[] = [];

const STUB_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const log = process.env.STUB_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) process.stdout.write("stub-cli 0.0.0\\n");
process.exit(0);
`;

function makePlan(corpus: LoadedCorpus): SchemaPlan {
  return parseSchemaPlan(
    {
      version: SCHEMA_PLAN_CONTRACT_VERSION,
      schemaFingerprint: schemaFingerprint(corpus.schemaDocument),
      fieldPaths: ["frame.material", "frame.serial", "service.date", "service.notes"],
      pieces: [
        {
          name: "Frame",
          description: "The frame's material and serial number stay together.",
          key: "frame",
          paths: ["frame.material", "frame.serial"],
        },
        {
          name: "Service",
          description: "The service date and notes stay together.",
          key: "service",
          paths: ["service.date", "service.notes"],
        },
      ],
      provenance: {
        model: "planning-stub",
        backend: "stub-backend",
        createdAt: "2026-11-13T09:00:00.000Z",
      },
    },
    corpus.schema,
  );
}

function writePlan(name: string, plan: SchemaPlan): string {
  const path = join(workDir, name);
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

beforeAll(async () => {
  buildCliOnce();
  workDir = mkdtempSync(join(tmpdir(), "ribo-eval-planned-work-"));
  stubDir = mkdtempSync(join(tmpdir(), "ribo-eval-planned-stub-"));
  stubLog = join(stubDir, "calls.log");
  for (const name of ["claude", "codex"]) {
    const file = join(stubDir, name);
    writeFileSync(file, STUB_SOURCE);
    chmodSync(file, 0o755);
  }
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
      received.push(body);
      const content = replyForSchema(
        body.response_format.json_schema.schema,
        body.response_format.json_schema.name,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the planned-eval stub server has no TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
}, 120_000);

afterAll(async () => {
  removeTemporaries();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  removeTemporaries();
  rmSync(stubLog, { force: true });
});

async function runBin(args: readonly string[]): Promise<Run> {
  received.length = 0;
  rmSync(stubLog, { force: true });
  const child = spawn(process.execPath, [BIN, ...args], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env["PATH"] ?? ""}`,
      STUB_LOG: stubLog,
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: "test-key",
    },
    cwd: workDir,
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
}

const runEval = (args: readonly string[]): Promise<Run> => runBin(["eval", ...args]);

function baseArgs(corpus: string, backend = "openai-compatible"): string[] {
  return ["--corpus", corpus, "--backend", backend, "--model", "ribo-test"];
}

function expectEarlyRefusal(result: Run, out: string): void {
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("spend estimate");
  expect(received).toHaveLength(0);
  expect(existsSync(stubLog)).toBe(false);
  expect(existsSync(out)).toBe(false);
}

test("planned without --plan and --plan without a planned rung are usage refusals with zero HTTP requests", async () => {
  const corpus = corpusWithoutDocuments();
  const planPath = writePlan("usage-plan.json", makePlan(loadCorpus(corpus)));

  for (const [args, flag] of [
    [["--strategy", "planned"], "--plan"],
    [["--strategy", "single-shot", "--plan", planPath], "planned"],
  ] as const) {
    const out = join(workDir, `usage-${flag.replaceAll("-", "")}-records`);
    const result = await runEval([...baseArgs(corpus), ...args, "--out", out]);
    expectEarlyRefusal(result, out);
    expect(result.stderr).toContain(flag);
  }
});

test("a missing plan artifact refuses before preflight, transcription, spend or records", async () => {
  const corpus = corpusWithDocumentCase();
  const missing = join(workDir, "missing-plan.json");
  const out = join(workDir, "missing-plan-records");
  const result = await runEval([
    ...baseArgs(corpus, "claude-cli"),
    "--strategy",
    "planned",
    "--plan",
    missing,
    "--out",
    out,
  ]);

  expectEarlyRefusal(result, out);
  expect(result.stderr).toContain(missing);
  expect(result.stderr).toContain("could not be read");
});

test("a stale plan names added and removed paths and the update fix before a shadow executable or document transcription", async () => {
  const original = loadCorpus(corpusWithDocumentCase());
  const planPath = writePlan("stale-plan.json", makePlan(original));
  const staleCorpus = corpusWithDocumentCase();
  writeFileSync(join(staleCorpus, "service-sheet", "input.pdf"), readFileSync(NO_TEXT_LAYER_PDF));
  editJson(join(staleCorpus, "schema.json"), (document) => {
    const properties = document["properties"] as Record<string, unknown>;
    const frame = properties["frame"] as Record<string, unknown>;
    const frameProperties = frame["properties"] as Record<string, unknown>;
    frameProperties["finish"] = frameProperties["material"];
    delete frameProperties["material"];
    frame["required"] = ["finish", "serial"];
    const service = properties["service"] as Record<string, unknown>;
    const serviceProperties = service["properties"] as Record<string, unknown>;
    serviceProperties["summary"] = serviceProperties["notes"];
    delete serviceProperties["notes"];
    service["required"] = ["date", "summary"];
  });
  editJson(join(staleCorpus, "service-sheet", "case.json"), (document) => {
    const expected = document["expected"] as Record<string, unknown>;
    expected["service.summary"] = expected["service.notes"];
    delete expected["service.notes"];
  });
  const out = join(workDir, "stale-plan-records");

  const result = await runEval([
    ...baseArgs(staleCorpus, "claude-cli"),
    "--strategy",
    "planned",
    "--plan",
    planPath,
    "--out",
    out,
  ]);

  expectEarlyRefusal(result, out);
  expect(result.stderr).toContain("added [frame.finish, service.summary]");
  expect(result.stderr).toContain("removed [frame.material, service.notes]");
  expect(result.stderr).toContain(
    `schema.json --update ${planPath} --backend <backend> --model planning-stub`,
  );
  // The PDF has no text layer: reaching transcription would replace this refusal.
  expect(result.stderr).not.toContain("no-text-layer");
});

test("an unbuildable plan under the run caps refuses with the construction reason before preflight or chat", async () => {
  const corpus = corpusWithDocumentCase();
  const planPath = writePlan("unbuildable-plan.json", makePlan(loadCorpus(corpus)));
  const out = join(workDir, "unbuildable-plan-records");
  const result = await runEval([
    ...baseArgs(corpus, "claude-cli"),
    "--strategy",
    "planned",
    "--plan",
    planPath,
    "--max-serialized-chars-per-group",
    "1",
    "--out",
    out,
  ]);

  expectEarlyRefusal(result, out);
  expect(result.stderr).toContain("planned call layout could not be constructed");
  expect(result.stderr).toContain("maxSerializedCharsPerGroup");
});

test("fingerprint-only drift emits one note and the run persists core's plan identity", async () => {
  const corpus = corpusWithoutDocuments();
  const drift = { ...makePlan(loadCorpus(corpus)), schemaFingerprint: "0".repeat(64) };
  const planPath = writePlan("drift-plan.json", drift);
  const out = join(workDir, "drift-plan-records");
  const result = await runEval([
    ...baseArgs(corpus),
    "--strategy",
    "planned",
    "--plan",
    planPath,
    "--out",
    out,
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr.match(/schema fingerprint drift/gu)).toHaveLength(1);
  expect(received.length).toBeGreaterThan(0);
  const report = JSON.parse(result.stdout) as EvalReport;
  const arm = report.arms[0]!;
  const expectedIdentity = await planFingerprint(drift);
  expect(arm.settings["planFingerprint"]).toBe(expectedIdentity);
  const persisted = EvalRunRecordDocumentSchema.parse(
    JSON.parse(readFileSync(arm.record, "utf8")) as unknown,
  );
  expect(persisted.contractVersion).toBe(1);
  expect(persisted.settings.planFingerprint).toBe(expectedIdentity);
  expect(persisted.fingerprint).toBe(arm.fingerprint);
});

test("mixed arms share the transcribed document text and persist runner-derived identity on the planned arm only", async () => {
  const corpus = copiedCorpus(FIXTURE_CORPUS);
  const loaded = loadCorpus(corpus);
  const plan = makePlan(loaded);
  const planPath = writePlan("mixed-plan.json", plan);
  const out = join(workDir, "mixed-plan-records");
  const result = await runEval([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--strategy",
    "planned",
    "--plan",
    planPath,
    "--out",
    out,
  ]);

  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as EvalReport;
  expect(report.arms).toHaveLength(2);
  const [ordinary, planned] = report.arms;
  expect(ordinary).toBeDefined();
  expect(planned).toBeDefined();
  expect(ordinary!.settings).not.toHaveProperty("planFingerprint");
  expect(planned!.settings["planFingerprint"]).toBe(await planFingerprint(plan));
  expect(planned!.fingerprint).toBe(ordinary!.fingerprint);
  expect(ordinary!.results.every((entry) => entry.status === "extracted")).toBe(true);
  expect(planned!.results.every((entry) => entry.status === "extracted")).toBe(true);

  const documentRequests = received.filter((request) =>
    request.messages.some((message) => message.content.includes("Chain replaced")),
  );
  expect(documentRequests.length).toBeGreaterThan(0);
  expect(
    documentRequests.some((request) => request.response_format.json_schema.name === "ribo-eval"),
  ).toBe(true);
  expect(
    documentRequests.some((request) =>
      /^ribo-eval-\d+-/u.test(request.response_format.json_schema.name),
    ),
  ).toBe(true);

  const ordinaryRecord = EvalRunRecordDocumentSchema.parse(
    JSON.parse(readFileSync(ordinary!.record, "utf8")) as unknown,
  );
  const plannedRecord = EvalRunRecordDocumentSchema.parse(
    JSON.parse(readFileSync(planned!.record, "utf8")) as unknown,
  );
  expect(ordinaryRecord.settings.planFingerprint).toBeUndefined();
  expect(plannedRecord.settings.planFingerprint).toBe(await planFingerprint(plan));
  expect(plannedRecord.fingerprint).toBe(ordinaryRecord.fingerprint);
  expect(recordIdentity(plannedRecord)).not.toBe(recordIdentity(ordinaryRecord));
});

test("an over-ceiling planned estimate refuses before chat and writes no record", async () => {
  const corpus = corpusWithoutDocuments();
  const planPath = writePlan("ceiling-plan.json", makePlan(loadCorpus(corpus)));
  const out = join(workDir, "ceiling-plan-records");
  const result = await runEval([
    ...baseArgs(corpus),
    "--strategy",
    "planned",
    "--plan",
    planPath,
    "--max-spend",
    "0",
    "--out",
    out,
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("above the ceiling");
  expect(received).toHaveLength(0);
  expect(existsSync(out)).toBe(false);
});

test("compare's reader enforces planned identity in both directions at record version 1", async () => {
  const fixture = JSON.parse(readFileSync(COMPARE_FIXTURE, "utf8")) as Record<string, unknown>;
  const settings = fixture["settings"] as Record<string, unknown>;
  const missing = structuredClone(fixture);
  (missing["settings"] as Record<string, unknown>)["strategies"] = ["planned"];
  delete (missing["settings"] as Record<string, unknown>)["planFingerprint"];
  const stray = structuredClone(fixture);
  (stray["settings"] as Record<string, unknown>)["planFingerprint"] = "a".repeat(64);
  expect(settings["strategies"]).toEqual(["single-shot"]);

  for (const [name, document] of [
    ["missing-plan-identity.json", missing],
    ["stray-plan-identity.json", stray],
  ] as const) {
    const path = join(workDir, name);
    writeFileSync(path, JSON.stringify(document));
    const result = await runBin(["compare", path, path]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("planFingerprint");
  }
});
