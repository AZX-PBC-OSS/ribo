import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { describeExtraction } from "@azx/ribo-core";

import { loadCorpus } from "./corpus/loader.js";
import type { LoadedCorpus } from "./corpus/loader.js";
import { describeCalls } from "./inspect/calls.js";
import {
  EvalRunRecordSchema,
  isRecordCurrent,
  readEvalRunRecords,
  runFingerprint,
} from "./index.js";
import type { EvalScoreTotals } from "./index.js";
import { replyForSchema } from "./eval/test-support/stub-chat.js";
import {
  FIXTURE_CORPUS,
  FIXTURE_SPLIT_CORPUS,
  copiedCorpus,
  corpusWithNoTextLayerDocument,
  corpusWithoutDocuments,
  removeTemporaries,
} from "./eval/test-support/corpus.js";

/**
 * @file The `ribo eval` command surface, pinned against the built bin as a
 * subprocess (design §6): the flags build the run's settings object, the
 * corpus enters only through the loader, the report lands on stdout, and the
 * command owns exactly two exit codes — 0 success, 2 could-not-run.
 *
 * The backend is a local stub HTTP server on an ephemeral port: it answers
 * every request with a value conforming to the request's own JSON Schema (the
 * same answer the eval suite's stub chat gives) and COUNTS the requests it
 * received, which is how the consensus count and the split caps are measured.
 * The endpoint and the credential are passed through the environment, always
 * explicitly, so a developer's own environment can neither leak in nor make a
 * test pass vacuously. Nothing here spends on a real model.
 *
 * The bin is spawned ASYNCHRONOUSLY, not with `spawnSync`: the stub server
 * lives in this process, and a blocking spawn would starve the event loop
 * that has to answer the bin's requests — the child would wait for a reply
 * this process could never send.
 *
 * The suite is self-sufficient: `beforeAll` builds `dist/bin.js` once per run
 * (shared with the other bin suites) and raises the hook timeout for a cold
 * CI, so the suite tests the artifact the command runs — never a stale one.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

// Every run in this suite spawns the built bin and waits for a local stub
// server to answer it, so a run costs a subprocess and a round trip. The
// node default of five seconds is tight when the unit project runs its files
// in parallel; the margin is for a loaded machine, not for slower assertions.
vi.setConfig({ testTimeout: 30_000 });

/** The wire body the stub server reads: the schema the request asks for. */
interface WireBody {
  readonly response_format: {
    readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown> };
  };
}

/** One arm's report entry. */
interface ArmReport {
  readonly settings: Record<string, unknown>;
  readonly results: readonly { readonly caseId: string; readonly status: string }[];
  /** The run fingerprint — over the schema and the prompt, never the settings. */
  readonly fingerprint: string;
  /** The arm's scored totals. */
  readonly totals: Record<string, unknown>;
  /** The path of the record the arm's run was written to. */
  readonly record: string;
}

/** The report the command emits. */
interface EvalReport {
  readonly name: string;
  readonly backend: string;
  readonly model: string;
  readonly arms: readonly ArmReport[];
}

let server: Server;
let baseUrl: string;
/**
 * The working directory every run is spawned in.
 *
 * The records a run writes land beside its working directory, so the suite
 * gives every run a fresh one of its own and the repository tree is never
 * written to.
 */
let workDir: string;
/** Every request the stub server received, since the last run. */
const received: WireBody[] = [];

beforeAll(async () => {
  buildCliOnce();
  workDir = mkdtempSync(join(tmpdir(), "ribo-eval-work-"));
  buildCliOnce();
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

/**
 * Drive the built bin.
 *
 * The endpoint and the credential are set explicitly on every run, and the
 * request counter is reset, so each run is measured on its own.
 */
const runBin = async (
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  cwd?: string,
): Promise<Run> => {
  received.length = 0;
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "test-key", ...env },
    cwd: cwd ?? workDir,
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

/** Drive `ribo eval` with the given flags. */
const run = (args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd?: string): Promise<Run> =>
  runBin(["eval", ...args], env, cwd);

/** The flags every run carries: the corpus, the backend and the model. */
const baseArgs = (corpus: string): string[] => [
  "--corpus",
  corpus,
  "--backend",
  "openai-compatible",
  "--model",
  "ribo-test",
];

// --- The happy path (criteria 1, 2) --------------------------------------------------

test("a run over a fixture corpus emits the report and exits 0", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([...baseArgs(corpus), "--strategy", "single-shot"]);

  expect(result.status).toBe(0);
  // The estimate is printed before the run spends anything, so stderr is not
  // empty on a successful run.
  expect(result.stderr).toContain("spend estimate");
  expect(result.stderr).not.toContain("\x1b");
  const report = JSON.parse(result.stdout) as EvalReport;
  expect(report.name).toBe("workshop-bicycles");
  expect(report.backend).toBe("openai-compatible");
  expect(report.model).toBe("ribo-test");
  expect(report.arms).toHaveLength(1);
  const arm = report.arms[0]!;
  expect(arm.results.length).toBeGreaterThan(0);
  for (const entry of arm.results) {
    expect(["extracted", "failed"]).toContain(entry.status);
    expect(entry.caseId).not.toBe("");
  }
  // The run drove the model: a run that reached nothing fails here.
  expect(received.length).toBeGreaterThan(0);
});

test("the report's settings echo exactly the flags, and omit every absent one", async () => {
  const corpus = corpusWithoutDocuments();

  const bare = await run([...baseArgs(corpus), "--strategy", "single-shot"]);
  expect(bare.status).toBe(0);
  const bareArm = (JSON.parse(bare.stdout) as EvalReport).arms[0]!;
  expect(bareArm.settings).toEqual({ strategies: ["single-shot"], model: "ribo-test" });

  const full = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--consensus",
    "3",
    "--consensus-arbiter",
    "majority",
    "--max-retries",
    "2",
    "--response-cap",
    "512",
    "--max-nullable-unions-per-group",
    "4",
    "--max-serialized-chars-per-group",
    "4096",
  ]);
  expect(full.status).toBe(0);
  const fullArm = (JSON.parse(full.stdout) as EvalReport).arms[0]!;
  expect(fullArm.settings).toEqual({
    strategies: ["single-shot"],
    model: "ribo-test",
    consensusCandidates: 3,
    consensusArbiter: "majority",
    maxRetries: 2,
    responseCap: 512,
    splitCaps: { maxNullableUnionsPerGroup: 4, maxSerializedCharsPerGroup: 4096 },
  });
});

// --- Arms and ladders (criteria 3, 4) ------------------------------------------------

test("a repeated --strategy measures one arm per occurrence, in flag order", async () => {
  const corpus = corpusWithoutDocuments();

  const both = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--strategy",
    "per-group",
  ]);
  expect(both.status).toBe(0);
  const report = JSON.parse(both.stdout) as EvalReport;
  expect(report.arms).toHaveLength(2);
  expect(report.arms[0]?.settings["strategies"]).toEqual(["single-shot"]);
  expect(report.arms[1]?.settings["strategies"]).toEqual(["per-group"]);
  const bothCount = received.length;
  expect(bothCount).toBeGreaterThan(0);

  // Each arm measured on its own: the run's count is the sum of the arms'.
  const single = await run([...baseArgs(corpus), "--strategy", "single-shot"]);
  expect(single.status).toBe(0);
  const singleCount = received.length;
  const perGroup = await run([...baseArgs(corpus), "--strategy", "per-group"]);
  expect(perGroup.status).toBe(0);
  const perGroupCount = received.length;

  expect(singleCount).toBeGreaterThan(0);
  expect(perGroupCount).toBeGreaterThan(0);
  expect(bothCount).toBe(singleCount + perGroupCount);
});

test("a comma-separated --strategy is one arm's fallback ladder", async () => {
  const corpus = corpusWithoutDocuments();

  const ladder = await run([...baseArgs(corpus), "--strategy", "single-shot,per-group"]);
  expect(ladder.status).toBe(0);
  const report = JSON.parse(ladder.stdout) as EvalReport;
  expect(report.arms).toHaveLength(1);
  expect(report.arms[0]?.settings["strategies"]).toEqual(["single-shot", "per-group"]);
  const ladderCount = received.length;
  expect(ladderCount).toBeGreaterThan(0);

  // The stub always answers, so the first rung settles and the second never
  // runs: the ladder costs the first rung alone.
  const firstRung = await run([...baseArgs(corpus), "--strategy", "single-shot"]);
  expect(firstRung.status).toBe(0);
  const firstRungCount = received.length;
  expect(firstRungCount).toBeGreaterThan(0);
  expect(ladderCount).toBe(firstRungCount);
});

// --- The run records (criteria 5, 12, 14, 15, 16, 18, 19) ---------------------------

test("--out writes the run record where it pointed", async () => {
  const corpus = corpusWithoutDocuments();
  const out = join(corpus, "runs");
  const result = await run([...baseArgs(corpus), "--strategy", "single-shot", "--out", out]);

  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as EvalReport;
  expect(report.arms).toHaveLength(1);
  const arm = report.arms[0]!;

  // The report names the record the arm's run was written to.
  expect(arm.record).not.toBe("");
  expect(existsSync(arm.record)).toBe(true);
  expect(arm.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  expect(arm.totals["cases"]).toBeGreaterThan(0);

  // The record is there, and it parses through the exported schema.
  const records = readEvalRunRecords(out);
  expect(records).toHaveLength(1);
  expect(EvalRunRecordSchema.safeParse(records[0]).success).toBe(true);
  expect(records[0]?.fingerprint).toBe(arm.fingerprint);

  const help = await runBin(["eval", "--help"]);
  expect(help.stdout).toContain("--out");
});

test("a run with no --out writes its record under ./ribo-eval-runs beside the cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ribo-eval-cwd-"));
  try {
    const corpus = corpusWithoutDocuments();
    const result = await run([...baseArgs(corpus), "--strategy", "single-shot"], {}, cwd);

    expect(result.status).toBe(0);
    const records = readEvalRunRecords(join(cwd, "ribo-eval-runs"));
    expect(records).toHaveLength(1);

    // A freshness read against that directory finds the record current.
    const loaded = loadCorpus(corpus);
    const record = records[0]!;
    expect(
      isRecordCurrent(record, {
        backend: "openai-compatible",
        model: "ribo-test",
        settings: record.settings,
        fingerprint: runFingerprint(loaded.schemaDocument, loaded.manifest.prompt),
      }),
    ).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--out writes there instead of the default location", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ribo-eval-cwd-"));
  try {
    const corpus = corpusWithoutDocuments();
    const out = join(cwd, "chosen");
    const result = await run(
      [...baseArgs(corpus), "--strategy", "single-shot", "--out", out],
      {},
      cwd,
    );

    expect(result.status).toBe(0);
    expect(readEvalRunRecords(out)).toHaveLength(1);
    expect(existsSync(join(cwd, "ribo-eval-runs"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the --consensus flag's difference travels the flag path and stales the pair", async () => {
  const corpus = corpusWithoutDocuments();
  const out = mkdtempSync(join(tmpdir(), "ribo-eval-out-"));
  try {
    const three = await run([
      ...baseArgs(corpus),
      "--strategy",
      "single-shot",
      "--consensus",
      "3",
      "--yes",
      "--out",
      out,
    ]);
    expect(three.status).toBe(0);
    const threeCalls = received.length;
    expect(threeCalls).toBeGreaterThan(0);

    const five = await run([
      ...baseArgs(corpus),
      "--strategy",
      "single-shot",
      "--consensus",
      "5",
      "--yes",
      "--out",
      out,
    ]);
    expect(five.status).toBe(0);
    const fiveCalls = received.length;

    // The flag moved the run itself: five candidates drove more requests
    // than three.
    expect(fiveCalls).toBeGreaterThan(threeCalls);

    const records = readEvalRunRecords(out);
    expect(records).toHaveLength(2);
    const [first, second] = records;
    expect(first?.settings["consensusCandidates"]).toBe(3);
    expect(second?.settings["consensusCandidates"]).toBe(5);
    // The consensus count is not in the fingerprint, so the fingerprints agree...
    expect(first?.fingerprint).toBe(second?.fingerprint);
    // ...but the two records are not the same measurement.
    expect(isRecordCurrent(first!, second!)).toBe(false);
    expect(isRecordCurrent(second!, first!)).toBe(false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a run over several arms writes one record per arm", async () => {
  const corpus = corpusWithoutDocuments();
  const out = mkdtempSync(join(tmpdir(), "ribo-eval-out-"));
  try {
    const result = await run([
      ...baseArgs(corpus),
      "--strategy",
      "single-shot",
      "--strategy",
      "per-group",
      "--out",
      out,
    ]);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as EvalReport;
    expect(report.arms).toHaveLength(2);

    const records = readEvalRunRecords(out);
    expect(records).toHaveLength(2);
    // The arms differ in their settings, not in what they were asked.
    expect(records[0]?.fingerprint).toBe(records[1]?.fingerprint);
    for (const record of records) {
      expect(
        isRecordCurrent(record, {
          backend: record.backend,
          model: record.model,
          settings: record.settings,
          fingerprint: record.fingerprint,
        }),
      ).toBe(true);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("--out naming an existing file exits 2, and prints no report", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ribo-eval-cwd-"));
  try {
    const corpus = corpusWithoutDocuments();
    const notADirectory = join(cwd, "a-file");
    writeFileSync(notADirectory, "not a directory");

    const fault = await run(
      [...baseArgs(corpus), "--strategy", "single-shot", "--out", notADirectory],
      {},
      cwd,
    );

    expect(fault.status).toBe(2);
    expect(fault.stdout).toBe("");
    expect(fault.stderr).toContain(notADirectory);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a malformed record beside the run's own exits 2, naming the file", async () => {
  const corpus = corpusWithoutDocuments();
  const out = mkdtempSync(join(tmpdir(), "ribo-eval-out-"));
  try {
    const broken = join(out, "broken.json");
    writeFileSync(broken, "{ not a record");

    const fault = await run(
      [...baseArgs(corpus), "--strategy", "single-shot", "--out", out],
      {},
      out,
    );

    expect(fault.status).toBe(2);
    expect(fault.stdout).toBe("");
    expect(fault.stderr).toContain(broken);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// --- The cross-arm comparison summary (T14a) ---------------------------------------

/** The counters a totals line carries, in the record's own names. */
const TOTAL_COUNTERS = [
  "cases",
  "correct",
  "wrong",
  "missed",
  "hallucinated",
  "unscorable",
  "judged",
  "answered",
] as const;

/** A record's totals, as the summary's one `name=value` totals line renders them. */
const totalsLineOf = (record: { readonly totals: EvalScoreTotals }): string =>
  TOTAL_COUNTERS.map((key) => `${key}=${record.totals[key]}`).join(" ");

test("a multi-arm run prints one cross-arm comparison summary to stderr, naming every arm", async () => {
  const corpus = corpusWithoutDocuments();
  const out = mkdtempSync(join(tmpdir(), "ribo-eval-out-"));
  try {
    const result = await run([
      ...baseArgs(corpus),
      "--strategy",
      "single-shot",
      "--strategy",
      "per-group",
      "--out",
      out,
    ]);
    expect(result.status).toBe(0);

    // The stdout report keeps its shipped shape: still the run's JSON.
    const report = JSON.parse(result.stdout) as EvalReport;
    expect(report.arms).toHaveLength(2);

    // Every arm's ladder is named in the summary.
    expect(result.stderr).toContain("cross-arm comparison");
    expect(result.stderr).toContain("single-shot");
    expect(result.stderr).toContain("per-group");

    // The summary's per-arm totals equal the totals in the records the run
    // wrote to the same directory — the summary renders those records.
    const records = readEvalRunRecords(out);
    expect(records).toHaveLength(2);
    const summaryTotals = [...result.stderr.matchAll(/(?:left|right) totals\s+(.*)/g)].map(
      (match) => match[1]!,
    );
    expect(summaryTotals).toHaveLength(2);
    expect(summaryTotals.sort()).toEqual(
      [totalsLineOf(records[0]!), totalsLineOf(records[1]!)].sort(),
    );
    // And the summary is not the stdout report: the JSON stays clean.
    expect(result.stdout).not.toContain("cross-arm comparison");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a single-arm run emits no cross-arm comparison summary", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([...baseArgs(corpus), "--strategy", "single-shot"]);

  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("cross-arm comparison");
});

// --- --help (criterion 6) ---------------------------------------------------------------

test("ribo eval --help teaches the surface: flags, environment, exit codes", async () => {
  const help = await runBin(["eval", "--help"]);
  expect(help.status).toBe(0);
  for (const flag of [
    "--corpus",
    "--backend",
    "--model",
    "--strategy",
    "--out",
    "--consensus",
    "--consensus-arbiter",
    "--max-retries",
    "--response-cap",
    "--timeout",
    "--max-nullable-unions-per-group",
    "--max-serialized-chars-per-group",
    "--max-spend",
    "--yes",
  ]) {
    expect(help.stdout).toContain(flag);
  }
  expect(help.stdout).toContain("OPENAI_BASE_URL");
  expect(help.stdout).toContain("OPENAI_API_KEY");
  expect(help.stdout).toContain(".env.local");
  expect(help.stdout).toContain("Exit codes:");
  expect(help.stdout).toContain("  0 ");
  expect(help.stdout).toContain("  2 ");
});

// --- Exit-code discipline (criteria 7, 8, 9, 10, 11) -------------------------------------

test("a usage error exits 2 with an empty stdout", async () => {
  const corpus = corpusWithoutDocuments();
  const cases: readonly (readonly string[])[] = [
    ["--bogus-flag"],
    ["--corpus"],
    ["--backend", "nope"],
    ["--backend"],
    ["--model"],
    ["--corpus", corpus, "--backend", "openai-compatible"],
    ["--corpus", corpus, "--model", "ribo-test"],
    ["--backend", "openai-compatible", "--model", "ribo-test"],
  ];
  for (const args of cases) {
    const fault = await run(args);
    expect(fault.status).toBe(2);
    expect(fault.stdout).toBe("");
    expect(fault.stderr).not.toBe("");
  }
});

test("an unrecognised --backend names every accepted backend", async () => {
  const fault = await run(["--backend", "nope"]);

  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  for (const backend of ["openai-compatible", "claude-cli", "codex-cli"]) {
    expect(fault.stderr).toContain(backend);
  }
});

test("an unreadable corpus path exits 2 naming the path", async () => {
  const missing = join(REPO_ROOT, "packages", "ribo-cli", "no-such-corpus");
  const fault = await run([...baseArgs(missing), "--strategy", "single-shot"]);

  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain(missing);
  expect(received.length).toBe(0);
});

test("a corpus holding a document case runs: the PDF is transcribed under Node, exit 0, a record written", async () => {
  const corpus = copiedCorpus(FIXTURE_CORPUS);
  const result = await run([...baseArgs(corpus), "--strategy", "single-shot"]);

  // Must-fail: the document path's predecessor refused this corpus whole,
  // exit 2, before any model call.
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as EvalReport;
  const arm = report.arms[0]!;
  expect(arm.results.map((entry) => entry.caseId)).toEqual([
    "service-sheet",
    "spoken-note",
    "written-ticket",
  ]);
  expect(arm.results.every((entry) => entry.status === "extracted")).toBe(true);
  // The document case reached the model as transcribed text.
  expect(received.length).toBeGreaterThan(0);
  // The record the report names was written.
  expect(existsSync(arm.record)).toBe(true);
});

test("a corpus whose document case has no text layer refuses the whole run before any model call", async () => {
  const corpus = corpusWithNoTextLayerDocument();
  const fault = await run([...baseArgs(corpus), "--strategy", "single-shot"]);

  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("service-sheet");
  expect(fault.stderr).toContain("no-text-layer");
  // The refusal fires before the run starts: nothing was spent.
  expect(received.length).toBe(0);
});

const settingsRefusals: readonly (readonly [string, readonly string[]])[] = [
  ["an unknown strategy id", ["--strategy", "no-such-strategy"]],
  ["the same strategy twice in one ladder", ["--strategy", "single-shot,single-shot"]],
  ["a trailing comma", ["--strategy", "single-shot,"]],
  ["a consensus count of one", ["--strategy", "single-shot", "--consensus", "1"]],
  ["a fractional consensus count", ["--strategy", "single-shot", "--consensus", "2.5"]],
  ["a non-numeric consensus count", ["--strategy", "single-shot", "--consensus", "abc"]],
  [
    "an arbiter without a candidate count",
    ["--strategy", "single-shot", "--consensus-arbiter", "majority"],
  ],
  [
    "an unknown arbiter value",
    ["--strategy", "single-shot", "--consensus", "3", "--consensus-arbiter", "bogus"],
  ],
];

test.each(settingsRefusals)(
  "%s is refused: exit 2, an empty stdout, a diagnostic naming it",
  async (_label, extra) => {
    const corpus = corpusWithoutDocuments();
    const fault = await run([...baseArgs(corpus), ...extra]);

    expect(fault.status).toBe(2);
    expect(fault.stdout).toBe("");
    expect(fault.stderr).not.toBe("");
    expect(received.length).toBe(0);
  },
);

test("a settings refusal names the setting it refused", async () => {
  const corpus = corpusWithoutDocuments();

  const unknownStrategy = await run([...baseArgs(corpus), "--strategy", "no-such-strategy"]);
  expect(unknownStrategy.stderr).toContain("strategies");
  expect(unknownStrategy.stderr).toContain("no-such-strategy");

  const badCount = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--consensus",
    "abc",
  ]);
  expect(badCount.stderr).toContain("consensusCandidates");

  const badArbiter = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--consensus",
    "3",
    "--consensus-arbiter",
    "bogus",
  ]);
  expect(badArbiter.stderr).toContain("consensusArbiter");
  expect(badArbiter.stderr).toContain("bogus");
});

test("a run with no --strategy is a usage error naming the flag", async () => {
  const corpus = corpusWithoutDocuments();
  const fault = await run(baseArgs(corpus));

  expect(fault.status).toBe(2);
  expect(fault.stdout).toBe("");
  expect(fault.stderr).toContain("--strategy");
});

test("a missing credential exits 2 naming the variable and the places it looked", async () => {
  const corpus = corpusWithoutDocuments();
  // A fresh empty working directory, so the operator's own `.env.local` can
  // neither leak in nor make this test pass vacuously.
  const cwd = mkdtempSync(join(tmpdir(), "ribo-eval-cwd-"));
  try {
    const fault = await run(
      [...baseArgs(corpus), "--strategy", "single-shot"],
      {
        OPENAI_API_KEY: undefined,
      },
      cwd,
    );

    expect(fault.status).toBe(2);
    expect(fault.stdout).toBe("");
    expect(fault.stderr).toContain("OPENAI_API_KEY");
    expect(fault.stderr).toContain(join(cwd, ".env.local"));
    expect(received.length).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- Diagnostics (criterion 12) ---------------------------------------------------------

test("every diagnostic names the command, and no diagnostic carries colour when piped", async () => {
  const corpus = corpusWithoutDocuments();

  const fault = await run([...baseArgs(corpus), "--strategy", "no-such-strategy"]);
  expect(fault.stderr).toContain("ribo eval:");

  const usage = await run(["--bogus-flag"]);
  expect(usage.stderr).toContain("ribo eval:");
  expect(usage.stderr).not.toContain("\x1b");
  expect(fault.stderr).not.toContain("\x1b");
});

// --- The settings flags reach the runner (criteria 13, 14, 15, 16) ----------------------

test("--consensus drives exactly that many candidates", async () => {
  const corpus = corpusWithoutDocuments();

  const plain = await run([...baseArgs(corpus), "--strategy", "single-shot"]);
  expect(plain.status).toBe(0);
  const plainCount = received.length;
  expect(plainCount).toBeGreaterThan(0);

  const consensus = await run([
    ...baseArgs(corpus),
    "--strategy",
    "single-shot",
    "--consensus",
    "3",
  ]);
  expect(consensus.status).toBe(0);
  const consensusCount = received.length;
  expect(consensusCount).toBeGreaterThan(0);
  expect(consensusCount).toBe(plainCount * 3);
});

/** The call counts of the split corpus under a set of caps, read off `describeCalls`. */
const callsUnder = (
  corpus: LoadedCorpus,
  caps: { readonly maxSerializedCharsPerGroup?: number },
): ReturnType<typeof describeCalls> =>
  describeCalls(describeExtraction({ schema: corpus.schema, ...caps }), caps);

test("a tight byte cap splits the groups the way describeCalls reports", async () => {
  const corpus = loadCorpus(copiedCorpus(FIXTURE_SPLIT_CORPUS));

  const defaultCalls = callsUnder(corpus, {});
  const baseline = defaultCalls.perGroup;
  expect(baseline).not.toBeNull();
  expect(baseline!).toBeGreaterThan(0);

  // The tight cap is derived from the split's own pieces, never restated.
  const description = describeExtraction({ schema: corpus.schema });
  const pieces = description.pieces ?? [];
  expect(pieces.length).toBeGreaterThan(0);
  const widest = Math.max(...pieces.map((piece) => piece.serializedChars));
  let tight: number | undefined;
  for (let cap = widest - 1; cap >= 1; cap--) {
    const count = callsUnder(corpus, { maxSerializedCharsPerGroup: cap }).perGroup;
    if (count !== null && count > baseline!) {
      tight = cap;
      break;
    }
  }
  expect(tight).toBeDefined();

  const capped = await run([
    ...baseArgs(corpus.root),
    "--strategy",
    "per-group",
    "--max-serialized-chars-per-group",
    String(tight!),
  ]);
  expect(capped.status).toBe(0);
  const expected = callsUnder(corpus, { maxSerializedCharsPerGroup: tight! }).perGroup;
  expect(expected).not.toBeNull();
  expect(received.length).toBe(expected! * corpus.cases.length);

  // The same run without the cap makes strictly fewer requests.
  const uncapped = await run([...baseArgs(corpus.root), "--strategy", "per-group"]);
  expect(uncapped.status).toBe(0);
  expect(received.length).toBe(baseline! * corpus.cases.length);
  expect(received.length).toBeLessThan(expected! * corpus.cases.length);
});

test.each(["--max-serialized-chars-per-group", "--max-nullable-unions-per-group"])(
  "%s refuses the values inspect refuses: exit 2, a diagnostic naming the flag",
  async (flag) => {
    const corpus = corpusWithoutDocuments();
    for (const value of ["0", "-5", "2.5", "abc"]) {
      const fault = await run([...baseArgs(corpus), "--strategy", "single-shot", flag, value]);
      expect(fault.status).toBe(2);
      expect(fault.stdout).toBe("");
      expect(fault.stderr).toContain(flag);
      // A known flag's own validation, not the unknown-option diagnostic.
      expect(fault.stderr).not.toMatch(/unknown option/i);
    }
  },
);

test("absent settings flags leave the strategies' own defaults standing", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([...baseArgs(corpus), "--strategy", "single-shot"]);

  expect(result.status).toBe(0);
  const settings = (JSON.parse(result.stdout) as EvalReport).arms[0]!.settings;
  expect(Object.keys(settings).sort()).toEqual(["model", "strategies"]);
  expect(settings["consensusCandidates"]).toBeUndefined();
  expect(settings["maxRetries"]).toBeUndefined();
  expect(settings["responseCap"]).toBeUndefined();
  expect(settings["splitCaps"]).toBeUndefined();
});

test("the corpus the command runs is the one the caller named", async () => {
  const corpus = corpusWithoutDocuments();
  const result = await run([...baseArgs(corpus), "--strategy", "single-shot"]);
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as EvalReport;
  const caseIds = report.arms[0]!.results.map((entry) => entry.caseId).sort();
  const loaded = loadCorpus(corpus);
  expect(caseIds).toEqual(loaded.cases.map((entry) => entry.id));
});
