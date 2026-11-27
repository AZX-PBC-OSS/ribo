import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { replyForSchema } from "./eval/test-support/stub-chat.js";
import {
  FIXTURE_FLAT_CORPUS,
  FIXTURE_SPLIT_CORPUS,
  corpusWithoutDocuments,
  removeTemporaries,
} from "./eval/test-support/corpus.js";

/**
 * @file The spend guard, driven through the BUILT bin: the estimate that
 * precedes every spend, the ceiling that refuses a run the operator did not
 * allow, and the two places a secret comes from.
 *
 * The backend is a local stub HTTP server on an ephemeral port: it answers
 * every request with a value conforming to the request's own JSON Schema and
 * records the request's `Authorization` header, which is how the precedence
 * between the environment and the `.env.local` file is proved. It counts the
 * requests it received, which is how "the refusal spent nothing" is measured.
 *
 * Every run spawns the bin with an explicit environment and, where the secret
 * rules are under test, an explicit working directory — a fresh empty temp
 * directory — so a developer's own `.env.local` can neither leak in nor make a
 * test pass vacuously. Nothing here spends on a real model.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

vi.setConfig({ testTimeout: 30_000 });

/** The wire body the stub server reads. */
interface WireBody {
  readonly response_format: {
    readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown> };
  };
}

/** One request the stub server received, with the credential it carried. */
interface Received {
  readonly authorization: string | undefined;
}

let server: Server;
let baseUrl: string;
/** Every request the stub server received, since the last run. */
const received: Received[] = [];
/** The stderr the child has written so far. */
let stderrSoFar = "";
/** The stderr the child had written by the time its first request was answered. */
let stderrAtFirstRequest = "";

beforeAll(async () => {
  buildCliOnce();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
      received.push({ authorization: request.headers.authorization });
      const first = received.length === 1;
      const answer = (): void => {
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
      };
      if (!first) {
        answer();
        return;
      }
      // The child writes the estimate BEFORE it makes its first request, so
      // the pipe already carries it; this pause gives the parent's own reader
      // the moment it needs to pick it up.
      setTimeout(() => {
        stderrAtFirstRequest = stderrSoFar;
        answer();
      }, 100);
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

/**
 * Drive the built bin.
 *
 * The child's environment is built explicitly, and the working directory is
 * the caller's choice — a fresh temp directory wherever a secret rule is
 * under test.
 */
const runBin = async (
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): Promise<Run> => {
  received.length = 0;
  stderrAtFirstRequest = "";
  stderrSoFar = "";
  const child = spawn(process.execPath, [BIN, ...args], {
    env: options.env ?? { ...process.env, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "test-key" },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
    stderrSoFar = stderr;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  return { status, stdout, stderr };
};

/** Drive `ribo eval` with the given flags. */
const run = (args: readonly string[], options?: Parameters<typeof runBin>[1]): Promise<Run> =>
  runBin(["eval", ...args], options);

/** The flags every run carries: the corpus, the backend and the model. */
const baseArgs = (corpus: string): string[] => [
  "--corpus",
  corpus,
  "--backend",
  "openai-compatible",
  "--model",
  "ribo-test",
];

// --- The estimate (criteria 1, 2) ------------------------------------------------

test("the estimate is printed before any request, and the report still owns stdout", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([...baseArgs(corpus), "--strategy", "single-shot"]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("spend estimate");
  // The estimate is on stderr; stdout is the report alone.
  const report = JSON.parse(result.stdout) as { readonly arms: readonly unknown[] };
  expect(report.arms.length).toBeGreaterThan(0);
  expect(result.stdout).not.toContain("spend estimate");
  expect(received.length).toBeGreaterThan(0);
  // The child writes the estimate before it makes its first request, so the
  // stderr the parent had read by the time the first request was answered
  // already carries it.
  expect(stderrAtFirstRequest).toContain("spend estimate");
});

test("the estimate states its basis: the bound, the multipliers, the case count, the price", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--consensus",
    "3",
    "--max-retries",
    "1",
  ]);

  expect(result.status).toBe(0);
  const stderr = result.stderr;
  // It is an upper bound, and it says so.
  expect(stderr).toContain("upper bound");
  // The call model, the multipliers and their values — the retry multiplier
  // names the flag it came from and the sum it came from.
  expect(stderr).toContain("single-shot");
  expect(stderr).toContain("retries ×2 (1 + --max-retries 1)");
  expect(stderr).toContain("consensus ×3");
  // The case count, the token bound and the price row with its date.
  expect(stderr).toMatch(/calls: at most \d+ over \d+ case\(s\)/);
  expect(stderr).toContain("tokens: at most");
  expect(stderr).toContain("openai-compatible");
  expect(stderr).toMatch(/priced \d{4}-\d{2}-\d{2}/);
  // Every diagnostic names the command.
  expect(stderr).toContain("ribo eval: ");
  // Piped output carries no escape bytes.
  expect(stderr).not.toContain("\x1b");
});

test("the retry multiplier names --max-retries, and zero removes it", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--max-retries",
    "0",
  ]);

  expect(result.status).toBe(0);
  // The arm line names the control, and the multiplier of one is the sum it
  // came from: 1 + 0.
  expect(result.stderr).toContain("retries ×1 (1 + --max-retries 0)");
});

// --- The ceiling (criteria 7, 8) --------------------------------------------------

test("a run over the ceiling is refused before any request", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--max-spend",
    "0.000001",
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("above the ceiling");
  expect(result.stderr).toContain("USD");
  expect(result.stderr).toContain("(fix:");
  // No terminal, so no question was asked — the run refused instead.
  expect(result.stderr).not.toContain("continue?");
  // The refusal costs nothing: the run never reached the model.
  expect(received.length).toBe(0);
});

test("the same run proceeds with --yes, and still prints the estimate", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--max-spend",
    "0.000001",
    "--yes",
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("spend estimate");
  expect(received.length).toBeGreaterThan(0);
});

test("a run under the ceiling proceeds, and asks nothing", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--max-spend",
    "1000",
  ]);

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("spend estimate");
  expect(result.stderr).not.toContain("continue?");
  expect(received.length).toBeGreaterThan(0);
});

test("a bad --max-spend value is a usage error naming the flag", async () => {
  const corpus = corpusWithoutDocuments();
  for (const value of ["-1", "abc", "1e3", "$5"]) {
    const fault = await run([
      ...baseArgs(corpus),
      "--strategy",
      "single-shot",
      "--max-spend",
      value,
    ]);
    expect(fault.status).toBe(2);
    expect(fault.stdout).toBe("");
    expect(fault.stderr).toContain("--max-spend");
    expect(received.length).toBe(0);
  }
});

// --- The run's own caps (criterion 6) -------------------------------------------------

/** The call count the estimate printed. */
const estimatedCalls = (stderr: string): number =>
  Number(/calls: at most ([\d,]+)/.exec(stderr)?.[1]?.replace(/,/g, "") ?? "-1");

test("a tight byte cap set through the flag is estimated under that cap", async () => {
  const uncapped = await run([...baseArgs(FIXTURE_SPLIT_CORPUS), "--strategy", "per-group"]);
  expect(uncapped.status).toBe(0);
  const uncappedRequests = received.length;
  expect(uncappedRequests).toBeGreaterThan(0);

  const capped = await run([
    ...baseArgs(FIXTURE_SPLIT_CORPUS),
    "--strategy",
    "per-group",
    "--max-serialized-chars-per-group",
    "1500",
  ]);
  expect(capped.status).toBe(0);
  const cappedRequests = received.length;

  // The cap split the groups into more pieces, and the run made more calls...
  expect(cappedRequests).toBeGreaterThan(uncappedRequests);
  // ...and the estimate was priced under THAT cap, so it covers the calls the
  // capped run made.
  expect(estimatedCalls(capped.stderr)).toBeGreaterThan(estimatedCalls(uncapped.stderr));
  expect(estimatedCalls(capped.stderr)).toBeGreaterThanOrEqual(cappedRequests);
});

// --- A bound that does not exist (criterion 4) ---------------------------------------

test("a presence-narrowed run over a schema with no groups refuses, naming the bound", async () => {
  const result = await run([
    "--corpus",
    FIXTURE_FLAT_CORPUS,
    "--backend",
    "openai-compatible",
    "--model",
    "ribo-test",
    "--strategy",
    "presence-narrowed",
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("presence-narrowed strategy has no call bound");
  expect(result.stderr).toContain("(fix:");
  expect(received.length).toBe(0);
});

test("a presence-narrowed run whose split cannot fit a piece refuses, naming the bound", async () => {
  const result = await run([
    "--corpus",
    FIXTURE_SPLIT_CORPUS,
    "--backend",
    "openai-compatible",
    "--model",
    "ribo-test",
    "--strategy",
    "presence-narrowed",
    "--max-serialized-chars-per-group",
    "1",
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("presence-narrowed strategy has no call bound");
  expect(result.stderr).toContain("(fix:");
  // The split's own refusal is carried, so the operator sees the cause.
  expect(result.stderr).toContain("splitExtractionSchema");
  expect(received.length).toBe(0);
});

test("--yes does not override a bound that does not exist", async () => {
  const result = await run([
    "--corpus",
    FIXTURE_FLAT_CORPUS,
    "--backend",
    "openai-compatible",
    "--model",
    "ribo-test",
    "--strategy",
    "presence-narrowed",
    "--yes",
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("presence-narrowed strategy has no call bound");
  expect(received.length).toBe(0);
});

// --- The preflight comes first (criterion 9) ------------------------------------------

test("a missing CLI binary refuses at the preflight, and the estimate is never printed", async () => {
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
      { env: { PATH: emptyDir, HOME: process.env["HOME"] ?? "" } },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("claude");
    // The preflight comes FIRST: the guard never priced the run.
    expect(result.stderr).not.toContain("spend estimate");
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

// --- Secrets (criterion 10) ------------------------------------------------------------

/** A fresh empty working directory, so no `.env.local` can leak in. */
const emptyCwd = (): string => mkdtempSync(join(tmpdir(), "ribo-cli-cwd-"));

test("a missing credential refuses, naming the key and both places the CLI looked", async () => {
  const cwd = emptyCwd();
  try {
    const corpus = corpusWithoutDocuments();
    const result = await run([...baseArgs(corpus), "--strategy", "single-shot"], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        OPENAI_BASE_URL: baseUrl,
      },
      cwd,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPENAI_API_KEY");
    // Both places: the environment, and the file it checked by its absolute
    // path.
    expect(result.stderr).toContain("environment");
    expect(result.stderr).toContain(join(cwd, ".env.local"));
    expect(result.stderr).toContain("(fix:");
    expect(received.length).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a credential in the working directory's .env.local is used", async () => {
  const cwd = emptyCwd();
  try {
    writeFileSync(
      join(cwd, ".env.local"),
      "# the operator's own credential\nOPENAI_API_KEY=file-key\n",
    );
    const corpus = corpusWithoutDocuments();
    const result = await run([...baseArgs(corpus), "--strategy", "single-shot"], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        OPENAI_BASE_URL: baseUrl,
      },
      cwd,
    });

    expect(result.status).toBe(0);
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]?.authorization).toBe("Bearer file-key");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the environment wins over the .env.local file", async () => {
  const cwd = emptyCwd();
  try {
    writeFileSync(join(cwd, ".env.local"), "OPENAI_API_KEY=file-key\n");
    const corpus = corpusWithoutDocuments();
    const result = await run([...baseArgs(corpus), "--strategy", "single-shot"], {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        OPENAI_BASE_URL: baseUrl,
        OPENAI_API_KEY: "env-key",
      },
      cwd,
    });

    expect(result.status).toBe(0);
    expect(received.length).toBeGreaterThan(0);
    // The value on the wire is the environment's.
    expect(received[0]?.authorization).toBe("Bearer env-key");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- The help text (criterion 12) -------------------------------------------------------

test("ribo eval --help teaches the ceiling, the override and the .env.local source", async () => {
  const help = await runBin(["eval", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--max-spend");
  expect(help.stdout).toContain("--yes");
  expect(help.stdout).toContain(".env.local");
  expect(help.stdout).toContain("refused spend");
});
