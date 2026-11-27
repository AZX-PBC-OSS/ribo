import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSchemaPlan, planFingerprint, SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { SchemaPlan, SchemaPlanPiece } from "@azx/ribo-core";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { loadCorpus } from "./corpus.js";
import type { LoadedCorpus } from "./corpus.js";
import { replyForSchema } from "./eval/test-support/stub-chat.js";
import {
  copiedCorpus,
  editJson,
  FIXTURE_CORPUS,
  removeTemporaries,
} from "./eval/test-support/corpus.js";
import { SchemaInspectReportSchema } from "./index.js";
import type { SchemaInspectReport } from "./index.js";
import { schemaFingerprint } from "./inspect/fingerprint.js";
import { convertDocument } from "./inspect/convert.js";
import { EvalRunRecordDocumentSchema } from "./eval/record-schema.js";
import { buildCliOnce } from "./test-support/build-once.js";

// The whole-flow test alone spawns the built bin a dozen times; under a full parallel run that
// outlasts the default timeout.
vi.setConfig({ testTimeout: 60_000 });

/**
 * @file The authoring workflow composed end to end through the BUILT bin, plus the reference
 * pages' agreement with the behavior those runs observe. One local HTTP stub serves every
 * backend dialect (draft, plan, update, extraction); shadow `claude`/`codex` executables log
 * their spawns; the threshold matrix runs against the committed example corpus. No live model,
 * no credential, no network beyond the loopback stub.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");
const DOCS_DIR = join(REPO_ROOT, "docs", "cli");
const EXAMPLE_CORPUS = join(REPO_ROOT, "packages", "ribo-cli", "examples", "basic-corpus");
const NO_TEXT_LAYER_PDF = fileURLToPath(
  new URL("../../ribo-transcriber-pdfjs/src/fixtures/no-text-layer.pdf", import.meta.url),
);

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface WireBody {
  readonly model: string;
  readonly response_format: {
    readonly json_schema: {
      readonly name: string;
      readonly schema: {
        readonly properties?: {
          readonly pieces?: {
            readonly items: {
              readonly properties: {
                readonly paths: { readonly items: { readonly enum?: readonly string[] } };
              };
            };
          };
        };
      };
    };
  };
}

// The draft the stub author returns: two groups over four leaves, every quote grounded in the
// one sample the workflow feeds the command.
const proposal = {
  root: {
    kind: "object",
    description: "A drafted home and heating survey.",
    properties: [
      {
        name: "home",
        node: {
          kind: "object",
          description: "The surveyed home.",
          properties: [
            {
              name: "address",
              node: {
                kind: "string",
                description: "The street address.",
                evidence: { source: "field-notes", quote: "Address: 1 Main Street" },
              },
            },
            {
              name: "yearBuilt",
              node: {
                kind: "number",
                description: "The year the home was built.",
                evidence: { source: "field-notes", quote: "Year built: 1984" },
              },
            },
          ],
        },
      },
      {
        name: "heating",
        node: {
          kind: "object",
          description: "The heating system.",
          properties: [
            {
              name: "fuel",
              node: {
                kind: "string",
                description: "The fuel the system burns.",
                evidence: { source: "field-notes", quote: "Fuel: gas" },
                enum: [{ value: "gas", evidence: { source: "field-notes", quote: "Fuel: gas" } }],
              },
            },
            {
              name: "servicedAt",
              node: {
                kind: "string",
                description: "When the system was last serviced.",
                optional: true,
                evidence: { source: "field-notes", quote: "Serviced: 2026-03-02" },
              },
            },
          ],
        },
      },
    ],
  },
};

const planPieces: readonly SchemaPlanPiece[] = [
  {
    name: "Home",
    description: "The home's address and construction year stay together.",
    key: "home",
    paths: ["home.address", "home.yearBuilt"],
  },
  {
    name: "Heating",
    description: "The heating fuel and service date describe one system.",
    key: "heating",
    paths: ["heating.fuel", "heating.servicedAt"],
  },
];

function replyFor(body: WireBody): string {
  const name = body.response_format.json_schema.name;
  if (name === "ribo_schema_init") return JSON.stringify(proposal);
  if (name === "ribo_schema_plan") return JSON.stringify({ pieces: planPieces });
  if (name === "ribo_schema_plan_update") {
    // The update request's closed vocabulary carries ONLY the added leaves, and a piece that
    // receives one repeats its surviving metadata verbatim; kept assignments are never returned.
    const added =
      body.response_format.json_schema.schema.properties?.pieces?.items.properties.paths.items
        .enum ?? [];
    return JSON.stringify({
      pieces: added.map((path) => {
        const surviving =
          planPieces.find((piece) => path.startsWith(`${piece.key}.`)) ?? planPieces[0]!;
        return {
          name: surviving.name,
          description: surviving.description,
          key: surviving.key,
          paths: [path],
        };
      }),
    });
  }
  return replyForSchema(body.response_format.json_schema.schema, name);
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

beforeAll(async () => {
  buildCliOnce();
  workDir = mkdtempSync(join(tmpdir(), "ribo-planned-workflow-"));
  stubDir = mkdtempSync(join(tmpdir(), "ribo-planned-workflow-stubs-"));
  stubLog = join(stubDir, "spawns.log");
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
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: replyFor(body) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the planned-workflow stub server has no TCP port");
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
      OPENAI_API_KEY: "stub-only",
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

const EXAMPLE_LEAVES = [
  "heating.fuel",
  "heating.servicedAt",
  "home.address",
  "home.yearBuilt",
] as const;

function assertSingleJsonDocument(stdout: string): unknown {
  expect((): unknown => JSON.parse(stdout)).not.toThrow();
  // Clean-stdout contract: the artifact alone, no diagnostics mixed in.
  const parsed: unknown = JSON.parse(stdout);
  return parsed;
}

function reportOf(outcome: Run): SchemaInspectReport {
  expect(outcome.status).toBe(0);
  return SchemaInspectReportSchema.parse(JSON.parse(outcome.stdout));
}

function pieceCharsRow(report: SchemaInspectReport) {
  const row = report.thresholds?.find((entry) => entry.measure === "pieceChars");
  if (row === undefined) throw new Error("the report has no pieceChars threshold row");
  return row;
}

test("init draft, corpus scaffold, plan, update, corpus text, planned and unplanned eval, compare", async () => {
  const sample = join(workDir, "field-notes.txt");
  writeFileSync(
    sample,
    "Address: 1 Main Street\nYear built: 1984\nFuel: gas\nServiced: 2026-03-02\n",
  );
  const corpus = join(workDir, "drafted-corpus");

  // 1. The draft: schema on stdout alone, scaffold beside it, empty expectations.
  const init = await runBin([
    "schema",
    "init",
    sample,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--corpus",
    corpus,
    "--corpus-name",
    "Drafted field notes",
    "--corpus-provenance",
    "synthetic",
  ]);
  expect(init.status).toBe(0);
  expect(JSON.parse(init.stdout)).toMatchObject({
    type: "object",
    properties: { home: { type: "object" }, heating: { type: "object" } },
  });
  expect(init.stdout).not.toContain("spend estimate");
  expect(init.stderr).toContain("spend estimate");
  expect(init.stderr).toContain(`ribo corpus text ${corpus}`);
  const scaffoldManifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8")) as {
    name: string;
    provenance: string;
  };
  expect(scaffoldManifest).toMatchObject({ name: "Drafted field notes", provenance: "synthetic" });
  const scaffoldCase = JSON.parse(
    readFileSync(join(corpus, "field-notes", "case.json"), "utf8"),
  ) as { expected: Record<string, unknown> };
  expect(scaffoldCase.expected).toEqual({});
  expect(readdirSync(corpus)).toContain("schema.json");

  // Output safety: a second draft refuses the existing corpus and changes nothing.
  const initAgain = await runBin([
    "schema",
    "init",
    sample,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--corpus",
    corpus,
    "--corpus-name",
    "Drafted field notes",
    "--corpus-provenance",
    "synthetic",
  ]);
  expect(initAgain.status).toBe(2);
  expect(initAgain.stdout).toBe("");
  expect(JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"))).toEqual(scaffoldManifest);

  // 2. Inspect freshness: the scaffold loads and sizes without a model call.
  const inspect = await runBin(["schema", "inspect", "--json", join(corpus, "schema.json")]);
  expect(inspect.status).toBe(0);
  const fresh = SchemaInspectReportSchema.parse(JSON.parse(inspect.stdout));
  expect(fresh.leafCount).toBe(EXAMPLE_LEAVES.length);
  expect(received).toHaveLength(0);

  // 3. Plan to stdout, saved as the reviewed file the rest of the workflow executes.
  const plan = await runBin([
    "schema",
    "plan",
    join(corpus, "schema.json"),
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(plan.status).toBe(0);
  const reviewedPlan = assertSingleJsonDocument(plan.stdout) as SchemaPlan;
  expect(reviewedPlan.version).toBe(SCHEMA_PLAN_CONTRACT_VERSION);
  expect([...reviewedPlan.fieldPaths].sort()).toEqual([...EXAMPLE_LEAVES]);
  expect(reviewedPlan.pieces).toEqual(planPieces);
  expect(plan.stderr).toContain("review");
  const reviewedPath = join(workDir, "reviewed-plan.json");
  writeFileSync(reviewedPath, plan.stdout);
  const reviewedBytes = readFileSync(reviewedPath);

  // 4a. An update over a reordered schema — the schema's bytes changed, its membership did not —
  // needs no model call and returns the same core plan identity.
  // The drafted schema's shape as this workflow reads it: top-level groups, each with its own
  // properties and (where the draft required leaves) a required list.
  const draft = JSON.parse(readFileSync(join(corpus, "schema.json"), "utf8")) as {
    properties: Record<
      string,
      { properties: Record<string, unknown>; required?: readonly string[] }
    >;
  };
  const reordered: typeof draft = {
    ...draft,
    properties: {
      heating: draft.properties["heating"]!,
      home: draft.properties["home"]!,
    },
  };
  const reorderedPath = join(workDir, "reordered-schema.json");
  writeFileSync(reorderedPath, JSON.stringify(reordered));
  const reorderedUpdate = await runBin([
    "schema",
    "plan",
    reorderedPath,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--update",
    reviewedPath,
  ]);
  expect(reorderedUpdate.status).toBe(0);
  const reorderedPlan = assertSingleJsonDocument(reorderedUpdate.stdout) as SchemaPlan;
  expect(await planFingerprint(reorderedPlan)).toBe(await planFingerprint(reviewedPlan));
  // Core's canonical schema fingerprint is itself reorder-stable; the plan's identity is
  // computed from the plan alone, so reordering the schema's keys moves neither.
  expect(reorderedPlan.schemaFingerprint).toBe(reviewedPlan.schemaFingerprint);
  expect(received).toHaveLength(0);
  expect(readFileSync(reviewedPath)).toEqual(reviewedBytes);

  // 4b. An update over an edited schema — one added leaf — spends one update call, keeps the
  // reviewed assignments, and never touches the input file.
  const edited = structuredClone(draft);
  edited.properties["home"]!.properties["nickname"] = {
    type: "string",
    description: "The household's name for the home.",
  };
  edited.properties["home"]!.required = ["address", "yearBuilt", "nickname"];
  const editedPath = join(workDir, "edited-schema.json");
  writeFileSync(editedPath, JSON.stringify(edited));
  const editedUpdate = await runBin([
    "schema",
    "plan",
    editedPath,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--update",
    reviewedPath,
  ]);
  expect(editedUpdate.status).toBe(0);
  const updatedPlan = assertSingleJsonDocument(editedUpdate.stdout) as SchemaPlan;
  expect(updatedPlan.fieldPaths).toContain("home.nickname");
  expect(updatedPlan.pieces.find((piece) => piece.key === "home")?.paths).toContain(
    "home.nickname",
  );
  expect(received).toHaveLength(1);
  expect(received[0]?.response_format.json_schema.name).toBe("ribo_schema_plan_update");
  expect(readFileSync(reviewedPath)).toEqual(reviewedBytes);

  // 5. The corpus-text handoff: the exact case text, before any expectation is written.
  const text = await runBin(["corpus", "text", corpus]);
  expect(text.status).toBe(0);
  expect(text.stdout).toContain("===== CAPTURE seq:1 kind:text id:field-notes.txt =====");
  expect(text.stdout).toContain("Address: 1 Main Street");
  expect(received).toHaveLength(0);

  // 6. Planned and unplanned arms of one run: additive v1 records, runner-derived identity.
  const runs = join(workDir, "runs");
  const evalRun = await runBin([
    "eval",
    "--corpus",
    corpus,
    "--backend",
    "openai-compatible",
    "--model",
    "ribo-test",
    "--strategy",
    "single-shot",
    "--strategy",
    "planned",
    "--plan",
    reviewedPath,
    "--out",
    runs,
  ]);
  expect(evalRun.status).toBe(0);
  const report = JSON.parse(evalRun.stdout) as {
    arms: readonly {
      settings: Record<string, unknown>;
      fingerprint: string;
      record: string;
    }[];
  };
  expect(report.arms).toHaveLength(2);
  const [ordinary, planned] = report.arms;
  expect(ordinary).toBeDefined();
  expect(planned).toBeDefined();
  expect(ordinary!.settings).not.toHaveProperty("planFingerprint");
  expect(planned!.settings["planFingerprint"]).toBe(await planFingerprint(reviewedPlan));
  expect(planned!.fingerprint).toBe(ordinary!.fingerprint);
  const ordinaryRecord = EvalRunRecordDocumentSchema.parse(
    JSON.parse(readFileSync(ordinary!.record, "utf8")) as unknown,
  );
  const plannedRecord = EvalRunRecordDocumentSchema.parse(
    JSON.parse(readFileSync(planned!.record, "utf8")) as unknown,
  );
  expect(ordinaryRecord.contractVersion).toBe(1);
  expect(plannedRecord.contractVersion).toBe(1);
  expect(ordinaryRecord.settings.planFingerprint).toBeUndefined();
  expect(plannedRecord.settings.planFingerprint).toBe(await planFingerprint(reviewedPlan));
  // Exact coverage: the record's leaf grid is the schema's leaf inventory, and the plan's
  // fieldPaths cover it exactly once.
  expect([...ordinaryRecord.leafPaths].sort()).toEqual([...EXAMPLE_LEAVES]);
  expect([...plannedRecord.leafPaths].sort()).toEqual([...EXAMPLE_LEAVES]);
  expect([...reviewedPlan.fieldPaths].sort()).toEqual([...EXAMPLE_LEAVES]);

  // 7. Compare lines the two records up; a difference is a finding, not a failure.
  const comparison = await runBin(["compare", ordinary!.record, planned!.record]);
  expect(comparison.status).toBe(0);
  expect(comparison.stdout).toContain("planFingerprint");
  expect(comparison.stderr).toBe("");
}, 120_000);

test("init and plan refuse an over-ceiling estimate with exit 2, empty stdout and no model call", async () => {
  const sample = join(workDir, "ceiling-sample.txt");
  writeFileSync(sample, "Address: 1 Main Street\n");
  const schema = join(workDir, "ceiling-schema.json");
  writeFileSync(
    schema,
    JSON.stringify({
      type: "object",
      properties: {
        home: {
          type: "object",
          properties: {
            address: { type: "string", description: "The street address." },
          },
          required: ["address"],
        },
      },
      required: ["home"],
    }),
  );

  for (const args of [
    [
      "schema",
      "init",
      sample,
      "--backend",
      "openai-compatible",
      "--model",
      "gpt-4o",
      "--max-spend",
      "0",
    ],
    [
      "schema",
      "plan",
      schema,
      "--backend",
      "openai-compatible",
      "--model",
      "gpt-4o",
      "--max-spend",
      "0",
    ],
  ] as const) {
    const result = await runBin([...args]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("above the ceiling");
    expect(received).toHaveLength(0);
    expect(existsSync(stubLog)).toBe(false);
  }
});

test("both eval --plan usage refusals leave no request, no spawn and no record", async () => {
  const corpus = copiedCorpus(FIXTURE_CORPUS);
  const loaded = loadCorpus(corpus);
  const planPath = join(workDir, "usage-plan.json");
  writeFileSync(planPath, JSON.stringify(workflowPlan(loaded)));
  const out = join(workDir, "usage-records");

  for (const [args, named] of [
    [["--strategy", "planned"], "--plan"],
    [["--strategy", "single-shot", "--plan", planPath], "planned"],
  ] as const) {
    const result = await runBin([
      "eval",
      "--corpus",
      corpus,
      "--backend",
      "openai-compatible",
      "--model",
      "ribo-test",
      ...args,
      "--out",
      out,
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(named);
    expect(result.stderr).not.toContain("spend estimate");
    expect(received).toHaveLength(0);
    expect(existsSync(stubLog)).toBe(false);
    expect(existsSync(out)).toBe(false);
  }
});

test("a stale plan refuses before preflight, transcription, spend or chat, naming the drift and the fix", async () => {
  const corpus = copiedCorpus(FIXTURE_CORPUS, (dir) => {
    // A PDF with no text layer: reaching transcription would replace this refusal with its own.
    writeFileSync(join(dir, "service-sheet", "input.pdf"), readFileSync(NO_TEXT_LAYER_PDF));
  });
  const loaded = loadCorpus(corpus);
  const planPath = join(workDir, "stale-plan.json");
  writeFileSync(planPath, JSON.stringify(workflowPlan(loaded)));
  editJson(join(corpus, "schema.json"), (document) => {
    const properties = document["properties"] as Record<string, unknown>;
    const frame = properties["frame"] as Record<string, unknown>;
    const frameProperties = frame["properties"] as Record<string, unknown>;
    frameProperties["finish"] = frameProperties["material"];
    delete frameProperties["material"];
    frame["required"] = ["finish", "serial"];
  });
  editJson(join(corpus, "spoken-note", "case.json"), (document) => {
    const expected = document["expected"] as Record<string, unknown>;
    expected["frame.finish"] = expected["frame.material"];
    delete expected["frame.material"];
  });
  const out = join(workDir, "stale-records");

  const result = await runBin([
    "eval",
    "--corpus",
    corpus,
    "--backend",
    "claude-cli",
    "--model",
    "claude-haiku-5-5",
    "--strategy",
    "planned",
    "--plan",
    planPath,
    "--out",
    out,
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("added [frame.finish]");
  expect(result.stderr).toContain("removed [frame.material]");
  expect(result.stderr).toContain("--update");
  expect(result.stderr).not.toContain("spend estimate");
  expect(result.stderr).not.toContain("no-text-layer");
  expect(received).toHaveLength(0);
  expect(existsSync(stubLog)).toBe(false);
  expect(existsSync(out)).toBe(false);
});

test("an unbuildable plan exits 2 for inspect and eval alike, with no report, no record and no model call", async () => {
  // Inspect: a plan whose single leaf cannot fit the requested cap, judged with a threshold flag
  // so a threshold finding (exit 1) can never stand in for the construction refusal.
  const unbuildableSchema = {
    type: "object",
    properties: {
      home: {
        type: "object",
        properties: {
          details: {
            type: "object",
            properties: {
              oversized: {
                type: "string",
                nullable: true,
                enum: ["alpha-aaaaaaaaaaaaaaaaaaaaaaaa", "bravo-bbbbbbbbbbbbbbbbbbbbbbbb"],
              },
            },
            required: ["oversized"],
          },
        },
        required: ["details"],
      },
    },
    required: ["home"],
  };
  const unbuildablePlan = parseSchemaPlan(
    {
      version: SCHEMA_PLAN_CONTRACT_VERSION,
      schemaFingerprint: schemaFingerprint(unbuildableSchema),
      fieldPaths: ["home.details.oversized"],
      pieces: [
        {
          name: "Oversized",
          description: "One projected property cannot fit the requested cap.",
          key: "home",
          paths: ["home.details.oversized"],
        },
      ],
      provenance: { model: "stub", backend: "stub", createdAt: "2026-10-01T02:03:04.000Z" },
    },
    convertDocument(unbuildableSchema),
  );
  const schemaPath = join(workDir, "unbuildable.json");
  const planPath = join(workDir, "unbuildable-plan.json");
  writeFileSync(schemaPath, JSON.stringify(unbuildableSchema));
  writeFileSync(planPath, JSON.stringify(unbuildablePlan));

  const inspect = await runBin([
    "schema",
    "inspect",
    "--json",
    "--plan",
    planPath,
    "--max-serialized-chars-per-group",
    "100",
    "--max-piece-chars",
    "1",
    schemaPath,
  ]);
  expect(inspect.status).toBe(2);
  expect(inspect.stdout).toBe("");
  expect(inspect.stderr).toContain("could not construct the planned call layout");
  expect(received).toHaveLength(0);

  // Eval: the same class, over a real corpus, with a record directory that must never appear.
  const corpus = copiedCorpus(FIXTURE_CORPUS);
  const corpusPlanPath = join(workDir, "corpus-plan.json");
  writeFileSync(corpusPlanPath, JSON.stringify(workflowPlan(loadCorpus(corpus))));
  const out = join(workDir, "unbuildable-records");
  const evalRun = await runBin([
    "eval",
    "--corpus",
    corpus,
    "--backend",
    "openai-compatible",
    "--model",
    "ribo-test",
    "--strategy",
    "planned",
    "--plan",
    corpusPlanPath,
    "--max-serialized-chars-per-group",
    "1",
    "--out",
    out,
  ]);
  expect(evalRun.status).toBe(2);
  expect(evalRun.stdout).toBe("");
  expect(evalRun.stderr).toContain("could not be constructed");
  expect(evalRun.stderr).toContain("maxSerializedCharsPerGroup");
  expect(received).toHaveLength(0);
  expect(existsSync(stubLog)).toBe(false);
  expect(existsSync(out)).toBe(false);
});

test("the threshold judges the rule-based worst piece without a plan (exit 1) and the compliant packed calls with one (exit 0)", async () => {
  const schema = join(EXAMPLE_CORPUS, "schema.json");
  const plan = join(EXAMPLE_CORPUS, "plan.json");
  const unsized = await runBin([
    "schema",
    "inspect",
    "--json",
    join(EXAMPLE_CORPUS, "schema.json"),
  ]);
  const ruleMeasured = reportOf(unsized).worstPiece!.serializedChars;
  // A limit between the planned worst call and the rule-based worst piece: informational either
  // way, breached only without a plan.
  const limit = ruleMeasured - 1;

  const noPlan = await runBin([
    "schema",
    "inspect",
    "--json",
    "--max-piece-chars",
    String(limit),
    schema,
  ]);
  expect(noPlan.status).toBe(1);
  const noPlanReport = SchemaInspectReportSchema.parse(JSON.parse(noPlan.stdout));
  expect(noPlan.stdout).not.toBe("");
  expect(pieceCharsRow(noPlanReport)).toMatchObject({
    layout: "rule-based",
    measured: ruleMeasured,
    breached: true,
  });

  const planned = await runBin([
    "schema",
    "inspect",
    "--json",
    "--plan",
    plan,
    "--max-piece-chars",
    String(limit),
    schema,
  ]);
  expect(planned.status).toBe(0);
  const plannedReport = reportOf(planned);
  const plannedRow = pieceCharsRow(plannedReport);
  expect(plannedRow).toMatchObject({ layout: "planned", breached: false });
  expect(plannedRow.measured).toBeLessThan(limit);
  const worstCall = (plannedReport.planned?.packedCalls ?? []).reduce((worst, call) =>
    call.serializedChars > worst.serializedChars ? call : worst,
  );
  expect(plannedRow.measured).toBe(worstCall.serializedChars);
});

test("a breached planned packed call exits 1 with its full report naming the call", async () => {
  const schema = join(EXAMPLE_CORPUS, "schema.json");
  const plan = join(EXAMPLE_CORPUS, "plan.json");
  const sized = reportOf(await runBin(["schema", "inspect", "--json", "--plan", plan, schema]));
  const worstCall = (sized.planned?.packedCalls ?? []).reduce((worst, call) =>
    call.serializedChars > worst.serializedChars ? call : worst,
  );
  const limit = worstCall.serializedChars - 1;

  const breached = await runBin([
    "schema",
    "inspect",
    "--json",
    "--plan",
    plan,
    "--max-piece-chars",
    String(limit),
    schema,
  ]);
  expect(breached.status).toBe(1);
  expect(breached.stdout).not.toBe("");
  const report = SchemaInspectReportSchema.parse(JSON.parse(breached.stdout));
  const row = pieceCharsRow(report);
  expect(row).toMatchObject({
    layout: "planned",
    breached: true,
    measured: worstCall.serializedChars,
  });
  expect(row.piece).toBe(worstCall.semantic);
});

test("the reference pages document the workflow these runs observe", () => {
  const page = (name: string): string => readFileSync(join(DOCS_DIR, name), "utf8");
  const index = page("index.md");
  // The command and exit surface names the authoring commands.
  expect(index).toContain("| `ribo schema init`");
  expect(index).toContain("| `ribo schema plan`");
  // The authoring → review → corpus-text → planned-eval → compare workflow, with no accuracy claim.
  expect(index).toContain("[Planning and authoring](/cli/planning)");
  expect(index).toContain("ribo corpus text");
  expect(index).toContain("--strategy planned");
  expect(index).not.toMatch(/plan[^\n]*improv[^\n]*accuracy/iu);
  expect(index).not.toMatch(/accuracy[^\n]*improv[^\n]*plan/iu);

  const corpus = page("corpus.md");
  // Init's accepted samples and the scaffold contract.
  expect(corpus).toContain("ribo schema init");
  expect(corpus).toContain("empty");
  expect(corpus).toMatch(/never overwrite|all-or-nothing|no partial/iu);
  // The corpus-text-before-expectations handoff.
  expect(corpus).toContain("ribo corpus text");
  expect(corpus.match(/before writing/gu)?.length).toBeGreaterThan(0);

  const scoring = page("scoring.md");
  // Both plan refusals, the stale-then-construction ordering and the no-artifact guarantee.
  expect(scoring).toMatch(/planned without `--plan`/iu);
  expect(scoring).toMatch(/`--plan` without a planned rung/iu);
  expect(scoring).toContain("stale");
  expect(scoring).toMatch(/before preflight|before any/iu);
  expect(scoring).toMatch(/no report|no records|no record/iu);
  // Runner-derived identity, reorder-stable, additive v1 coexistence, compare's settings axis.
  expect(scoring).toContain("settings.planFingerprint");
  expect(scoring).toMatch(/reorder|order-independent/iu);
  expect(scoring).toMatch(/version 1|v1/iu);
  expect(scoring).toMatch(/additive/iu);
  expect(scoring).toContain("settings");

  const spend = page("spend.md");
  // The planned bound: core's dry run over the plan under the run caps, every ladder rung,
  // retry and consensus multipliers, real planned prompts, refusal without a safe bound.
  expect(spend).toMatch(/dry run|dry-run/iu);
  expect(spend).toContain("packed");
  expect(spend).toContain("rung");
  expect(spend).toContain("retry");
  expect(spend).toContain("consensus");
  expect(spend).toMatch(/real|actual/iu);
  expect(spend).toMatch(/no safe bound|underivable|refused before/iu);
  // The authoring-side spend behavior lives on the planning page.
  expect(spend).toContain("[Planning and authoring](/cli/planning)");

  const planning = page("planning.md");
  // Cross-links from the authoring page to the spend and scoring references.
  expect(planning).toContain("](/cli/spend");
  expect(planning).toContain("](/cli/scoring");
});

/** A plan over the fixture corpus, built the way the runner parses one. */
function workflowPlan(corpus: LoadedCorpus): SchemaPlan {
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
      provenance: { model: "stub", backend: "stub", createdAt: "2026-11-13T09:00:00.000Z" },
    },
    corpus.schema,
  );
}
