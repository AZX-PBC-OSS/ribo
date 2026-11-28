/**
 * @file `ribo corpus review`, driven through the BUILT bin: the versioned
 * `--json` contract, empty stdout on a refusal, the decision writes, and a
 * confirmed corpus then scoring as judged under a stub-backed `ribo eval`.
 *
 * No test spends on a real model: the eval leg runs against the loopback
 * stub server the eval suite uses (a local HTTP stub answering every request
 * with a value conforming to the request's own schema), and the review
 * command itself makes no model call at all. The corpus fixtures are copied
 * from the committed fixture corpus into temp directories.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { readEvalRunRecords } from "./index.js";
import { replyForSchema } from "./eval/test-support/stub-chat.js";
import { editJson, FIXTURE_CORPUS, removeTemporaries } from "./eval/test-support/corpus.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

vi.setConfig({ testTimeout: 60_000 });

/** The wire body the eval stub server reads: the schema the request asks for. */
interface WireBody {
  readonly response_format: {
    readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown> };
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  buildCliOnce();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: replyForSchema(
                  body.response_format.json_schema.schema,
                  body.response_format.json_schema.name,
                ),
              },
              finish_reason: "stop",
            },
          ],
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
    throw new Error("the stub server has no TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
}, 120_000);

afterAll(async () => {
  removeTemporaries();
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
const runBin = async (args: readonly string[], cwd?: string): Promise<Run> => {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: "test-key",
    },
    ...(cwd === undefined ? {} : { cwd }),
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

/** A fresh corpus holding only the transcript case, its proposals pending review. */
const pendingCorpus = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ribo-corpus-review-bin-"));
  cpSync(FIXTURE_CORPUS, dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "spoken-note") {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
    }
  }
  const proposal = (status: "asserted" | "declared-absent", value?: unknown): unknown =>
    status === "asserted"
      ? {
          status,
          value,
          evidence: { quote: "serial number BW-4471", input: "input.txt" },
          backend: "openai-compatible",
          model: "gpt-4o",
          proposedAt: "2026-11-13T09:00:00.000Z",
        }
      : {
          status,
          backend: "openai-compatible",
          model: "gpt-4o",
          proposedAt: "2026-11-13T09:00:00.000Z",
        };
  editJson(join(dir, "spoken-note", "case.json"), (document) => {
    document["expected"] = {
      // Hand-written, so a decision on it is refused.
      "frame.material": { status: "asserted", value: "steel", sourceSpan: "steel frame" },
      // Pending, grounded in the case's own input.
      "frame.serial": {
        status: "asserted",
        value: "BW-4471",
        proposal: proposal("asserted", "BW-4471"),
        review: "pending",
      },
      // A pending proposed absence — the whole-case confirm leaves it.
      "service.date": {
        status: "declared-absent",
        proposal: proposal("declared-absent"),
        review: "pending",
      },
    };
    document["defaults"] = [{ scope: "service", status: "declared-absent" }];
  });
  return dir;
};

test("the --json sheet carries the versioned contract, the values and the absence block", async () => {
  const dir = pendingCorpus();

  const result = await runBin(["corpus", "review", dir, "--json"]);

  expect(result.status).toBe(0);
  const sheet = JSON.parse(result.stdout) as {
    contractVersion: number;
    corpus: string;
    cases: {
      caseId: string;
      values: { path: string; grounded: boolean; literal: boolean }[];
      absences: { path: string }[];
    }[];
  };
  expect(sheet.contractVersion).toBe(1);
  expect(sheet.corpus).toBe("workshop-bicycles");
  expect(sheet.cases).toHaveLength(1);
  expect(sheet.cases[0]!.caseId).toBe("spoken-note");
  expect(sheet.cases[0]!.values.map((row) => row.path)).toEqual(["frame.serial"]);
  expect(sheet.cases[0]!.values[0]).toMatchObject({ grounded: true, literal: true });
  expect(sheet.cases[0]!.absences.map((entry) => entry.path)).toEqual(["service.date"]);
});

test("a refusal exits 2 with empty stdout, under the command's name", async () => {
  const dir = pendingCorpus();

  for (const args of [
    // A decision on a hand-written entry — no pending proposal there.
    ["corpus", "review", dir, "spoken-note", "--confirm", "--leaf", "frame.material"],
    // Two actions at once.
    ["corpus", "review", dir, "spoken-note", "--confirm", "--reject", "--leaf", "frame.serial"],
    // An action without a case id.
    ["corpus", "review", dir, "--confirm"],
    // mark-absent without its leaf.
    ["corpus", "review", dir, "spoken-note", "--mark-absent"],
  ]) {
    const result = await runBin(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ribo corpus review:");
  }
});

test("a confirmed corpus then scores those cells as judged under a stub-backed eval", async () => {
  const dir = pendingCorpus();
  const firstOut = mkdtempSync(join(tmpdir(), "ribo-corpus-review-bin-eval-"));
  const finalOut = mkdtempSync(join(tmpdir(), "ribo-corpus-review-bin-eval-"));

  const confirmed = await runBin([
    "corpus",
    "review",
    dir,
    "spoken-note",
    "--confirm",
    "--leaf",
    "frame.serial",
    "--json",
  ]);
  expect(confirmed.status).toBe(0);
  const report = JSON.parse(confirmed.stdout) as {
    contractVersion: number;
    action: string;
    decided: readonly string[];
    leftPending: unknown[];
  };
  expect(report.contractVersion).toBe(1);
  expect(report.action).toBe("confirm");
  expect(report.decided).toEqual(["frame.serial"]);
  expect(report.leftPending).toEqual([]);

  const caseDocument = JSON.parse(readFileSync(join(dir, "spoken-note", "case.json"), "utf8")) as {
    expected: Record<string, { review?: string }>;
  };
  expect(caseDocument.expected["frame.serial"]).toMatchObject({ review: "confirmed" });
  expect(caseDocument.expected["service.date"]).toMatchObject({ review: "pending" });

  // The confirmed corpus runs, and the still-pending proposed absence is
  // never a measurement: it scores unscorable, and the judged rest goes on.
  const firstRun = await runBin([
    "eval",
    "--corpus",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--strategy",
    "per-group",
    "--max-spend",
    "1.00",
    "--yes",
    "--out",
    firstOut,
  ]);
  expect(firstRun.status).toBe(0);
  const firstRecords = readEvalRunRecords(firstOut);
  expect(firstRecords).toHaveLength(1);
  expect(firstRecords[0]!.totals.unscorable).toBe(1);

  // Confirm the absence too (mark-absent), and the pending cell becomes a
  // judged expectation: nothing unscorable, and the record classifies the
  // judged proposal-bearing cells as accepted-unchanged, proposed by the
  // run's own backend and model.
  const absence = await runBin([
    "corpus",
    "review",
    dir,
    "spoken-note",
    "--mark-absent",
    "--leaf",
    "service.date",
  ]);
  expect(absence.status).toBe(0);

  const finalRun = await runBin([
    "eval",
    "--corpus",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--strategy",
    "per-group",
    "--max-spend",
    "1.00",
    "--yes",
    "--out",
    finalOut,
  ]);
  expect(finalRun.status).toBe(0);
  const records = readEvalRunRecords(finalOut);
  expect(records).toHaveLength(1);
  const record = records[0]!;
  expect(record.totals.judged).toBeGreaterThan(0);
  expect(record.totals.unscorable).toBe(0);
  expect(record.expectations?.reviewClasses).toMatchObject({
    // The default-resolved notes cell counts as hand-written — the
    // documented rule for a judged cell with no review class.
    "hand-written": 2,
    "accepted-unchanged": 2,
  });
  expect(record.expectations?.proposers[0]).toMatchObject({
    backend: "openai-compatible",
    model: "gpt-4o",
    cells: 2,
  });

  rmSync(firstOut, { recursive: true, force: true });
  rmSync(finalOut, { recursive: true, force: true });
});

test("reject through the bin removes the pending entry and leaves the default untouched", async () => {
  const dir = pendingCorpus();

  const result = await runBin([
    "corpus",
    "review",
    dir,
    "spoken-note",
    "--reject",
    "--leaf",
    "frame.serial",
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("rejected");

  const caseDocument = JSON.parse(readFileSync(join(dir, "spoken-note", "case.json"), "utf8")) as {
    expected: Record<string, unknown>;
    defaults: { scope: string; status: string }[];
  };
  expect("frame.serial" in caseDocument.expected).toBe(false);
  expect(caseDocument.defaults).toEqual([{ scope: "service", status: "declared-absent" }]);
});

test("the review command's sheet is free: it writes nothing and reads no credential-bearing option", async () => {
  const dir = pendingCorpus();
  const before = readFileSync(join(dir, "spoken-note", "case.json"), "utf8");

  const result = await runBin(["corpus", "review", dir]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("== spoken-note ==");
  expect(readFileSync(join(dir, "spoken-note", "case.json"), "utf8")).toBe(before);
  // No credential ever rides a flag: the review command declares none.
  const help = await runBin(["corpus", "review", "--help"]);
  expect(help.stdout).not.toMatch(/api[-_]?key|token/iu);
});
