import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { replyForSchema } from "./eval/test-support/stub-chat.js";
import { corpusWithReviewClasses, removeTemporaries } from "./eval/test-support/corpus.js";

/**
 * @file The eval command's circularity disclosure (R8): the stdout report
 * carries the record's expectations summary, stderr states plainly when the
 * run measures agreement with the scored model's own proposal, and an
 * unreviewed cell's expected value travels beside its
 * `unreviewed-proposal` reason — never as a plain expected answer.
 *
 * The suite drives the BUILT bin against a local stub HTTP server — no real
 * model, no credential, no network beyond the loopback.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

vi.setConfig({ testTimeout: 30_000 });

/** The wire body the stub server reads: the schema the request asks for. */
interface WireBody {
  readonly response_format: {
    readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown> };
  };
}

let server: Server;
let baseUrl: string;
let workDir: string;

beforeAll(async () => {
  buildCliOnce();
  workDir = mkdtempSync(join(tmpdir(), "ribo-eval-review-report-"));
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
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

/** Drive the built bin with a fresh endpoint and a fresh records directory. */
const run = async (corpus: string, tag: string): Promise<Run> => {
  const child = spawn(
    process.execPath,
    [
      BIN,
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
      join(workDir, tag),
    ],
    {
      env: {
        ...process.env,
        OPENAI_BASE_URL: baseUrl,
        OPENAI_API_KEY: "test-key",
      },
      cwd: workDir,
    },
  );
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

/** The report's per-arm block the suite reads. */
interface ReportArm {
  readonly totals: { readonly judged: number };
  readonly expectations?: {
    readonly reviewClasses: Record<string, number>;
    readonly proposers: readonly {
      readonly backend: string;
      readonly model: string;
      readonly cells: number;
    }[];
    readonly sameModelAcceptedUnchanged: number;
  };
  /** The record file's path, beside the summary. */
  readonly record: string;
}

/** The stdout report, parsed. */
const reportOf = (stdout: string): { readonly arms: readonly ReportArm[] } =>
  JSON.parse(stdout) as { readonly arms: readonly ReportArm[] };

test("a proposal-bearing run discloses same-model agreement on stderr and in the report", async () => {
  const result = await run(corpusWithReviewClasses(), "reviewed");

  expect(result.status, result.stderr + "\nSTDOUT:" + result.stdout.slice(0, 400)).toBe(0);

  // R8's sentence: the run says plainly what the accepted-unchanged cells of
  // its own proposer measure.
  expect(result.stderr).toContain(
    "1 accepted-unchanged cell was proposed by the scored backend openai-compatible and model " +
      "ribo-test — for that cell the run measures agreement with that model's own proposal, " +
      "not accuracy against an independent answer",
  );

  // The stdout report carries the same summary, computed from the scored
  // cells: one judged cell of each explicit class, the default-resolved
  // judged cell counted as hand-written, the pending cell in no count.
  const report = reportOf(result.stdout);
  const arm = report.arms[0];
  if (arm?.expectations === undefined) throw new Error("the report carries no summary");
  expect(arm.expectations.reviewClasses).toEqual({
    "hand-written": 2,
    "accepted-unchanged": 1,
    corrected: 1,
  });
  expect(arm.expectations.proposers).toEqual([
    { backend: "openai-compatible", model: "ribo-test", cells: 2 },
  ]);
  expect(arm.expectations.sameModelAcceptedUnchanged).toBe(1);
  const judged = Object.values(arm.expectations.reviewClasses).reduce(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  expect(judged).toBe(arm.totals.judged);

  // The unreviewed cell's expected value in the persisted record is the
  // PROPOSED value, carried beside its verdict and reason — marked, never a
  // plain expected answer.
  const written = JSON.parse(readFileSync(arm.record, "utf8")) as {
    readonly grid: Record<
      string,
      Record<
        string,
        {
          readonly verdict: string;
          readonly reason?: string;
          readonly expected: unknown;
          readonly review?: unknown;
        }
      >
    >;
  };
  const pending = written.grid["service.notes"]?.["spoken-note"];
  if (pending === undefined) throw new Error("the record carries no pending cell");
  expect(pending).toMatchObject({
    verdict: "unscorable",
    reason: "unreviewed-proposal",
    expected: "brake pad replacement",
  });
});

test("a proposal-free run carries neither the sentence nor the summary", async () => {
  const result = await run(
    corpusWithReviewClasses({ backend: "stub", model: "ribo-test" }),
    "clean",
  );

  // A proposal-bearing corpus with NO same-model cells still runs and still
  // writes the summary — but the sentence names no agreement, and a
  // mismatching proposer never counts.
  expect(result.status, result.stderr + "\nSTDOUT:" + result.stdout.slice(0, 400)).toBe(0);
  expect(result.stderr).not.toContain("agreement with that model's own proposal");
  const arm = reportOf(result.stdout).arms[0];
  expect(arm?.expectations?.sameModelAcceptedUnchanged).toBe(0);
  expect(arm?.expectations?.reviewClasses).toEqual({
    "hand-written": 2,
    "accepted-unchanged": 1,
    corrected: 1,
  });
});
