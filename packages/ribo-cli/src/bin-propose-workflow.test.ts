import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { editJson, removeTemporaries } from "./eval/test-support/corpus.js";
import { replyForSchema } from "./eval/test-support/stub-chat.js";
import { EvalRunRecordDocumentSchema } from "./eval/record-schema.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * @file The handoff workflow composed end to end through the BUILT bin:
 * `ribo schema init --corpus` over plain multi-input folders, then the
 * commands init's own stderr names — `corpus text`, `corpus propose`,
 * `corpus review` with a correction and a mark-absent, then `eval` — so the
 * path the docs teach is the path a run can walk. Every model call lands on
 * one loopback stub server (draft, propose and eval alike); there is no real
 * model, no credential and no network beyond the stub.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

interface WireBody {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly response_format: {
    readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown> };
  };
}

/** The content lines both sample folders carry; one file holds the first two, one the rest. */
const SAMPLE_LINES = [
  "Address: 1 Main Street",
  "Year built: 1984",
  "Fuel: gas",
  "Serviced: 2026-03-02",
] as const;

/** The draft the stub author returns: four string leaves, every quote grounded in a sample. */
const draft = {
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
                kind: "string",
                description: "The year built, as the note states it.",
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

/** The leaf paths a request's propose prompt asks for, in prompt order. */
const askedLeavesOf = (body: WireBody): readonly string[] => {
  const content = body.messages[body.messages.length - 1]!.content;
  const start = content.indexOf("Leaves to answer (full dotted paths):");
  const section = content.slice(start);
  return [...section.matchAll(/^- (.+?) \((?:string|number|boolean|enum|literal)/gm)].map(
    (match) => match[1]!,
  );
};

/** The case text a request's prompt carries, between the proposer's delimiters. */
const caseTextOf = (body: WireBody): string => {
  const content = body.messages[body.messages.length - 1]!.content;
  const begin = content.indexOf("--- BEGIN CASE TEXT ---\n") + "--- BEGIN CASE TEXT ---\n".length;
  const end = content.indexOf("\n--- END CASE TEXT ---");
  return content.slice(begin, end);
};

/**
 * The proposer's scripted round: the last asked leaf a proposed absence, one
 * middle leaf a value that is NOT literal in its own quote (the correction
 * target), every other leaf a value equal to a line of the case's own text.
 */
const proposalReply = (body: WireBody): string => {
  const leaves = askedLeavesOf(body);
  const lines = caseTextOf(body)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("====="));
  const items = leaves.map((path, index) => {
    const quote = lines[index % lines.length]!;
    if (index === leaves.length - 1) {
      return { path, value: null, quote: null, absent: true };
    }
    if (index === 1) {
      return { path, value: `${quote} (drafted)`, quote, absent: null };
    }
    return { path, value: quote, quote, absent: null };
  });
  return JSON.stringify({ items, collections: [] });
};

let server: Server;
let baseUrl: string;
let workDir: string;
const received: WireBody[] = [];

function replyFor(body: WireBody): string {
  const name = body.response_format.json_schema.name;
  if (name === "ribo_schema_init") return JSON.stringify(draft);
  if (name === "ribo_corpus_propose") return proposalReply(body);
  return replyForSchema(body.response_format.json_schema.schema, name);
}

beforeAll(async () => {
  buildCliOnce();
  workDir = mkdtempSync(join(tmpdir(), "ribo-propose-workflow-"));
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
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the propose-workflow stub server has no TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
}, 120_000);

afterAll(async () => {
  removeTemporaries();
  rmSync(workDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

afterEach(() => {
  removeTemporaries();
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Drive the built bin; the endpoint and the credential are set explicitly. */
const runBin = async (args: readonly string[]): Promise<Run> => {
  received.length = 0;
  const child = spawn(process.execPath, [BIN, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
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
};

interface CaseDocument {
  readonly expected: Record<
    string,
    {
      status: string;
      value?: unknown;
      review?: string;
      proposal?: { status: string };
    }
  >;
}

test("init's handoff runs propose, review with correction and mark-absent, then eval over every drafted leaf", async () => {
  // Two plain folders, each with two input files: two multi-input samples.
  for (const name of ["field-notes", "garage-notes"]) {
    const dir = join(workDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), `${SAMPLE_LINES[0]}\n${SAMPLE_LINES[1]}\n`);
    writeFileSync(join(dir, "detail.md"), `${SAMPLE_LINES[2]}\n${SAMPLE_LINES[3]}\n`);
  }
  const corpus = join(workDir, "corpus");

  // 1. Init scaffolds the corpus and its stderr names the path this test walks.
  const init = await runBin([
    "schema",
    "init",
    join(workDir, "field-notes"),
    join(workDir, "garage-notes"),
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--corpus",
    corpus,
    "--corpus-name",
    "Propose workflow",
    "--corpus-provenance",
    "synthetic",
  ]);
  expect(init.status).toBe(0);
  expect(init.stderr).toContain("ribo corpus propose");
  expect(init.stderr).toContain("ribo corpus review");
  expect(init.stderr.indexOf("ribo corpus propose")).toBeLessThan(
    init.stderr.indexOf("ribo corpus review"),
  );

  const drafted = JSON.parse(readFileSync(join(corpus, "schema.json"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(drafted).toMatchObject({ type: "object" });
  const caseIds = ["field-notes", "garage-notes"];
  for (const id of caseIds) {
    const caseDocument = JSON.parse(
      readFileSync(join(corpus, id, "case.json"), "utf8"),
    ) as CaseDocument;
    expect(caseDocument.expected).toEqual({});
  }

  // 2. The corpus-text step of the handoff: free, and no model call.
  const text = await runBin(["corpus", "text", corpus]);
  expect(text.status).toBe(0);
  expect(text.stdout).toContain("Address: 1 Main Street");
  expect(received).toHaveLength(0);

  // 3. Propose, on a model this workflow will not score: every case's every
  // leaf gets a pending entry.
  const propose = await runBin([
    "corpus",
    "propose",
    corpus,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(propose.status).toBe(0);
  const proposeReport = JSON.parse(propose.stdout) as {
    cases: { caseId: string; outcome: string; proposed: readonly string[] }[];
  };
  expect(proposeReport.cases).toHaveLength(caseIds.length);
  for (const entry of proposeReport.cases) {
    expect(entry.outcome).toBe("proposed");
  }
  const proposedKeys = proposeReport.cases.flatMap((entry) => entry.proposed);

  // 4. Review each case: a whole-case confirm takes only the literal values,
  // then the reviewer corrects the non-literal one and claims the silence.
  for (const id of caseIds) {
    const casePath = join(corpus, id, "case.json");
    const confirm = await runBin(["corpus", "review", corpus, id, "--confirm", "--json"]);
    expect(confirm.status).toBe(0);
    const confirmReport = JSON.parse(confirm.stdout) as {
      decided: readonly string[];
      leftPending: readonly { path: string; reason: string }[];
    };
    // The non-literal value and the proposed absence stay pending, with the reason.
    const pendingPaths = confirmReport.leftPending.map((entry) => entry.path);
    expect(confirmReport.decided.length).toBe(2);
    expect(pendingPaths).toHaveLength(2);
    for (const entry of confirmReport.leftPending) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    // The correction: an edit to the entry's value in case.json, then confirm.
    const caseDocument = JSON.parse(readFileSync(casePath, "utf8")) as CaseDocument;
    const nonLiteral = pendingPaths.find(
      (path) => caseDocument.expected[path]?.status === "asserted",
    );
    const absence = pendingPaths.find((path) => path !== nonLiteral);
    expect(nonLiteral).toBeDefined();
    expect(absence).toBeDefined();
    editJson(casePath, (document) => {
      const expected = document["expected"] as Record<string, { value?: unknown }>;
      expected[nonLiteral!]!["value"] = SAMPLE_LINES[1];
    });
    const corrected = await runBin([
      "corpus",
      "review",
      corpus,
      id,
      "--confirm",
      "--leaf",
      nonLiteral!,
      "--json",
    ]);
    expect(corrected.status).toBe(0);
    expect(JSON.parse(corrected.stdout)).toMatchObject({ decided: [nonLiteral] });

    // The reviewer's own claim of silence, where the proposer said absent.
    const marked = await runBin([
      "corpus",
      "review",
      corpus,
      id,
      "--mark-absent",
      "--leaf",
      absence!,
      "--json",
    ]);
    expect(marked.status).toBe(0);
    expect(JSON.parse(marked.stdout)).toMatchObject({ decided: [absence] });

    // Nothing is left pending, so no cell can be unscorable for lack of review.
    const sheet = await runBin(["corpus", "review", corpus, id, "--json"]);
    expect(sheet.status).toBe(0);
    const sheetDocument = JSON.parse(sheet.stdout) as {
      cases: { caseId: string; values: unknown[]; absences: unknown[] }[];
    };
    expect(sheetDocument.cases[0]!.values).toEqual([]);
    expect(sheetDocument.cases[0]!.absences).toEqual([]);
  }

  // 5. Eval, on the model the proposer was told not to be: every leaf judged.
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
    "--out",
    runs,
  ]);
  expect(evalRun.status).toBe(0);
  const report = JSON.parse(evalRun.stdout) as {
    arms: readonly { record: string }[];
  };
  expect(report.arms).toHaveLength(1);
  const record = EvalRunRecordDocumentSchema.parse(
    JSON.parse(readFileSync(report.arms[0]!.record, "utf8")) as unknown,
  );

  // Every drafted leaf is judged in at least one case, and no cell anywhere
  // is unscorable for lack of review.
  const leafPaths = [...record.leafPaths].sort();
  expect(leafPaths).toEqual(
    ["heating.fuel", "heating.servicedAt", "home.address", "home.yearBuilt"].sort(),
  );
  for (const leaf of record.leafPaths) {
    const cells = Object.values(record.grid[leaf] ?? {});
    expect(cells.length).toBe(caseIds.length);
    expect(cells.some((cell) => cell.verdict !== "unscorable")).toBe(true);
  }
  for (const cells of Object.values(record.grid)) {
    for (const cell of Object.values(cells)) {
      expect(cell.reason).not.toBe("unreviewed-proposal");
    }
  }

  // The record's origin counts: every judged cell was proposed by the
  // propose run's backend and model; the mark-absent and the accepted
  // entries are accepted-unchanged, the edited one corrected. The scored
  // model is not the proposer, so no cell measures the model's agreement
  // with its own proposal.
  expect(record.expectations).toBeDefined();
  expect(record.expectations!.reviewClasses).toEqual({
    "accepted-unchanged": caseIds.length * 3,
    corrected: caseIds.length,
  });
  expect(record.expectations!.proposers).toEqual([
    { backend: "openai-compatible", model: "gpt-4o", cells: caseIds.length * 4 },
  ]);
  expect(record.expectations!.sameModelAcceptedUnchanged).toBe(0);
  expect(evalRun.stderr).not.toContain("agreement with that model's own proposal");
  expect(proposedKeys).toHaveLength(caseIds.length * 4);

  // 6. The circularity disclosure: the same corpus scored on the proposing
  // model itself says so, and the count moves into the record.
  const sameModelRun = await runBin([
    "eval",
    "--corpus",
    corpus,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--strategy",
    "single-shot",
    "--out",
    join(workDir, "runs-same-model"),
  ]);
  expect(sameModelRun.status).toBe(0);
  expect(sameModelRun.stderr).toContain("agreement with that model's own proposal");
  const sameModelReport = JSON.parse(sameModelRun.stdout) as {
    arms: readonly { record: string }[];
  };
  const sameModelRecord = EvalRunRecordDocumentSchema.parse(
    JSON.parse(readFileSync(sameModelReport.arms[0]!.record, "utf8")) as unknown,
  );
  expect(sameModelRecord.expectations!.sameModelAcceptedUnchanged).toBe(caseIds.length * 3);
});
