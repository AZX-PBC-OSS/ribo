import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { EvalRunRecordSchema, readEvalRunRecords } from "./index.js";
import { replyForSchema } from "./eval/test-support/stub-chat.js";

/**
 * @file The README's walkthrough, held honest: `ribo eval` over the committed
 * example corpus, run through the built bin against the stub-chat harness
 * (`bin-eval.test.ts`'s pattern — a local HTTP stub answering every request
 * with a value conforming to the request's own schema, so nothing here
 * spends on a real model), exits 0 and writes a run record under `--out`.
 *
 * The corpus is the one the package ships and the docs walk through, read in
 * place — the run writes nothing into it.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");
const EXAMPLE = join(REPO_ROOT, "packages", "ribo-cli", "examples", "basic-corpus");

// A run costs a subprocess and a stub-server round trip; the margin is for a
// loaded machine, not for slower assertions.
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
  workDir = mkdtempSync(join(tmpdir(), "ribo-example-eval-"));
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
  rmSync(workDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Drive the built bin; the endpoint and the credential are set explicitly. */
const runBin = async (args: readonly string[]): Promise<Run> => {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "test-key" },
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

test("ribo eval over the example corpus exits 0 and writes a run record", async () => {
  const out = join(workDir, "runs");
  const result = await runBin([
    "eval",
    "--corpus",
    EXAMPLE,
    "--backend",
    "openai-compatible",
    "--model",
    "ribo-test",
    "--strategy",
    "single-shot",
    "--out",
    out,
  ]);

  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as {
    name: string;
    arms: readonly {
      results: readonly { caseId: string; status: string }[];
      record: string;
    }[];
  };
  expect(report.name).toBe("energy-visit-notes");
  expect(report.arms).toHaveLength(1);
  const arm = report.arms[0]!;
  expect(arm.results.map((entry) => entry.caseId)).toEqual([
    "follow-up-letter",
    "morning-visit",
    "voicemail",
  ]);
  // The record the report names was written, and it parses as a run record.
  expect(existsSync(arm.record)).toBe(true);
  const records = readEvalRunRecords(out);
  expect(records).toHaveLength(1);
  expect(EvalRunRecordSchema.safeParse(records[0]).success).toBe(true);
});
