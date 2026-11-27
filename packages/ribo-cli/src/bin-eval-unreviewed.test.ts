import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { replyForSchema } from "./eval/test-support/stub-chat.js";
import {
  copiedCorpus,
  corpusWithNoTextLayerDocument,
  editJson,
  FIXTURE_CORPUS,
  removeTemporaries,
} from "./eval/test-support/corpus.js";

/**
 * @file Eval's refusal to judge unreviewed proposals (R5): a corpus with no
 * judgeable expectation is refused before transcription, estimate or any
 * model call, and a partly reviewed corpus runs while reporting what its
 * pending proposals contribute to no rate.
 *
 * The suite drives the BUILT bin against a local stub HTTP server — no real
 * model, no credential, no network beyond the loopback — and proves the
 * pre-spend ordering with a document case whose PDF has no text layer: had
 * transcription run, its own refusal would replace the guard's.
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
/** Every request the stub server received, since the last run. */
const received: WireBody[] = [];

beforeAll(async () => {
  buildCliOnce();
  workDir = mkdtempSync(join(tmpdir(), "ribo-eval-unreviewed-"));
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

/** Drive the built bin, resetting the request counter and setting the stub endpoint. */
const run = async (args: readonly string[]): Promise<Run> => {
  received.length = 0;
  const child = spawn(process.execPath, [BIN, "eval", ...args], {
    env: {
      ...process.env,
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
};

/** The flags every run carries: the corpus, the backend and the model. */
const baseArgs = (corpus: string): string[] => [
  "--corpus",
  corpus,
  "--backend",
  "openai-compatible",
  "--model",
  "ribo-test",
  "--strategy",
  "single-shot",
];

/**
 * Turn every expectation entry of every case into a pending proposal, and
 * drop the scoped defaults — a covering default is itself a judged claim,
 * so a corpus keeping one is not all-pending.
 * @param dir - The corpus directory to rewrite in place.
 */
const proposeEverythingPending = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseFile = join(dir, entry.name, "case.json");
    editJson(caseFile, (document) => {
      const inputs = document["inputs"] as readonly { file: string }[];
      const expected = document["expected"] as Record<string, Record<string, unknown>>;
      for (const [path, leaf] of Object.entries(expected)) {
        expected[path] =
          leaf["status"] === "asserted"
            ? {
                ...leaf,
                proposal: {
                  status: "asserted",
                  value: leaf["value"],
                  evidence: {
                    quote:
                      typeof leaf["sourceSpan"] === "string"
                        ? leaf["sourceSpan"]
                        : "the proposed quote",
                    input: inputs[0]!.file,
                  },
                  backend: "stub-backend",
                  model: "stub-model",
                  proposedAt: "2026-11-13T09:00:00.000Z",
                },
                review: "pending",
              }
            : {
                ...leaf,
                proposal: {
                  status: "declared-absent",
                  backend: "stub-backend",
                  model: "stub-model",
                  proposedAt: "2026-11-13T09:00:00.000Z",
                },
                review: "pending",
              };
      }
      delete document["defaults"];
    });
  }
};

test("an all-pending corpus exits 2 before transcription, estimate or any model call", async () => {
  // The no-text-layer PDF is the tripwire: had eval reached transcription,
  // the document path's own refusal would replace the guard's.
  const corpus = corpusWithNoTextLayerDocument();
  proposeEverythingPending(corpus);

  const result = await run(baseArgs(corpus));

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ribo corpus review");
  expect(result.stderr).not.toContain("spend estimate");
  expect(result.stderr).not.toContain("no-text-layer");
  expect(received).toHaveLength(0);
});

test("an expectation-free corpus exits 2 the same way, naming ribo corpus propose", async () => {
  const corpus = corpusWithNoTextLayerDocument();
  for (const entry of readdirSync(corpus, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    editJson(join(corpus, entry.name, "case.json"), (document) => {
      document["expected"] = {};
      delete document["defaults"];
    });
  }

  const result = await run(baseArgs(corpus));

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ribo corpus propose");
  expect(result.stderr).not.toContain("spend estimate");
  expect(result.stderr).not.toContain("no-text-layer");
  expect(received).toHaveLength(0);
});

test("a partly reviewed corpus runs, and its stderr counts what stays unjudged", async () => {
  const corpus = copiedCorpus(FIXTURE_CORPUS, (dir) => {
    rmSync(join(dir, "service-sheet"), { recursive: true, force: true });
    // Every case's entries become pending proposals; the spoken-note case is
    // then restored to its hand-written expectations, so exactly one case
    // stays fully reviewed and the other is all-pending.
    proposeEverythingPending(dir);
    editJson(join(dir, "spoken-note", "case.json"), (document) => {
      document["expected"] = {
        "frame.material": { status: "asserted", value: "steel", sourceSpan: "steel frame" },
        "frame.serial": { status: "asserted", value: "BW-4471", alternatives: ["BW4471"] },
      };
      document["defaults"] = [{ scope: "service", status: "declared-absent" }];
    });
  });

  const result = await run(baseArgs(corpus));

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("spend estimate");
  expect(result.stderr).toContain("ribo corpus review");
  expect(received.length).toBeGreaterThan(0);
});
