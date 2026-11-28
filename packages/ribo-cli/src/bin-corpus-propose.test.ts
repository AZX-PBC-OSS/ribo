/**
 * @file `ribo corpus propose`, driven through the BUILT bin: the priced,
 * capped, additive proposal command end to end.
 *
 * The model paths are stubs at the two true boundaries — a loopback HTTP
 * server for the openai-compatible backend, and a shadowing stub `claude`
 * executable first on the child's PATH for the CLI backend — so no test can
 * inherit a real endpoint, credential or binary. The stub HTTP server records
 * every request body it receives, which is how "the refusal spent nothing",
 * "the rerun made zero requests" and the byte-equality of the prompt's case
 * text against `ribo corpus text`'s output are all measured.
 *
 * The corpus fixtures are copied from the committed fixture corpus into temp
 * directories; the case files under test are written in the writer's own
 * two-space trailing-newline serialisation, which is the format the
 * byte-preservation comparison assumes.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { buildCliOnce } from "./test-support/build-once.js";

import { loadCorpus } from "./corpus/loader.js";
import { collectCorpusText } from "./corpus/text.js";
import { editJson, FIXTURE_CORPUS, removeTemporaries } from "./eval/test-support/corpus.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

vi.setConfig({ testTimeout: 60_000 });

/** The wire body a proposal request carries. */
interface WireBody {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

/** The leaf paths a request's prompt asks for, in prompt order. */
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
  if (begin < "--- BEGIN CASE TEXT ---\n".length || end < 0) {
    throw new Error("the proposal prompt carries no case-text delimiters");
  }
  return content.slice(begin, end);
};

/** A reply that answers the first asked leaf with a value grounded in the note, the rest silent. */
const noteGroundedReply = (body: WireBody): string => {
  const leaves = askedLeavesOf(body);
  const items = leaves.map((path, index) =>
    index === 0
      ? { path, value: "insulation", quote: "attic insulation R-49", absent: null }
      : { path, value: null, quote: null, absent: true },
  );
  return JSON.stringify({ items, collections: [] });
};

/** A reply that answers every asked leaf with silence — every leaf a proposed absence. */
const silentReply = (body: WireBody): string => {
  const items = askedLeavesOf(body).map((path) => ({
    path,
    value: null,
    quote: null,
    absent: true,
  }));
  return JSON.stringify({ items, collections: [] });
};

let server: Server;
let baseUrl: string;
/** Every request body the stub server has received, since the last run. */
const received: WireBody[] = [];
/** The reply script the stub server answers the next requests with. */
let replier: (body: WireBody) => string = silentReply;

beforeAll(async () => {
  buildCliOnce();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
      received.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: replier(body) }, finish_reason: "stop" }],
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
  received.length = 0;
  replier = silentReply;
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The shadowing stub `claude`: answers the preflight, proposes from the prompt's leaf list. */
const CLAUDE_STUB_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.STUB_LOG;
if (args.includes("--version")) {
  if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");
  process.stdout.write("stub-cli 0.0.0\\n");
  process.exit(0);
}
const prompt = fs.readFileSync(0, "utf8");
if (log) fs.appendFileSync(log, JSON.stringify(args.concat(prompt)) + "\\n");
const start = prompt.indexOf("Leaves to answer (full dotted paths):");
const section = prompt.slice(start);
const leaves = [...section.matchAll(/^- (.+?) \\((?:string|number|boolean|enum|literal)/gm)].map(function (m) { return m[1]; });
const items = leaves.map(function (path) {
  if (path.endsWith("material")) return { path: path, value: "steel", quote: "steel frame", absent: null };
  if (path.endsWith("serial")) return { path: path, value: "BW-4471", quote: "BW-4471", absent: null };
  return { path: path, value: null, quote: null, absent: true };
});
process.stdout.write("stub banner\\n" + JSON.stringify({ items: items, collections: [] }) + "\\n");
`;

/** The stub executables' directory and its call log. */
let stubDir: string;
let stubLog: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "ribo-corpus-propose-stub-"));
  stubLog = join(stubDir, "calls.log");
  writeFileSync(join(stubDir, "claude"), CLAUDE_STUB_SOURCE);
  chmodSync(join(stubDir, "claude"), 0o755);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

const stubCalls = (): readonly string[][] => {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
};

/**
 * Drive the built bin. The environment is explicit: the stub directories and
 * endpoints the test chooses, and nothing else that could carry a credential.
 */
const runBin = async (
  args: readonly string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<Run> => {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: {
      PATH: `${stubDir}:${process.env["PATH"] ?? ""}`,
      HOME: process.env["HOME"] ?? "",
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: "test-key",
      STUB_LOG: stubLog,
      ...env,
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

/** The versioned stdout report, parsed. */
interface ProposeReport {
  readonly contractVersion: number;
  readonly corpus: string;
  readonly cases: readonly {
    readonly caseId: string;
    readonly outcome: string;
    readonly proposed: readonly string[];
    readonly unproposed: readonly { readonly path: string; readonly reason: string }[];
    readonly reason?: string;
  }[];
}

/** A fresh corpus holding only the text case, every leaf unanswered. */
const textCaseCorpus = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ribo-corpus-propose-run-"));
  cpSync(FIXTURE_CORPUS, dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "spoken-note") {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
    }
  }
  editJson(join(dir, "spoken-note", "case.json"), (document) => {
    document["expected"] = {};
    delete document["defaults"];
  });
  return dir;
};

test("a multi-input case with a PDF proposes the exact shared case text, and the evidence names the note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ribo-corpus-propose-run-"));
  cpSync(FIXTURE_CORPUS, dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "service-sheet") {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
    }
  }
  writeFileSync(
    join(dir, "service-sheet", "site-note.txt"),
    "Observed attic insulation R-49 at the entry hatch.\n",
  );
  editJson(join(dir, "service-sheet", "case.json"), (document) => {
    document["inputs"] = [
      {
        file: "input.pdf",
        kind: "document",
        capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 },
      },
      { file: "site-note.txt", kind: "text" },
    ];
    document["expected"] = {};
    delete document["defaults"];
  });

  replier = noteGroundedReply;
  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);

  expect(result.status).toBe(0);
  // Exactly one request: one initial proposal call for the one case.
  expect(received).toHaveLength(1);
  // The prompt's case text is byte-equal to `ribo corpus text`'s output —
  // the PDF's transcription, then the note, markers included.
  const collected = await collectCorpusText(loadCorpus(dir), "service-sheet");
  expect(collected.cases).toHaveLength(1);
  expect(caseTextOf(received[0]!)).toBe(collected.cases[0]!.text);
  // Both contributions, in declared order: PDF text before the note.
  const promptCaseText = caseTextOf(received[0]!);
  expect(promptCaseText.indexOf("Chain replaced")).toBeGreaterThan(-1);
  expect(promptCaseText.indexOf("Observed attic insulation R-49")).toBeGreaterThan(
    promptCaseText.indexOf("Chain replaced"),
  );
  // The manifest's instructions are not the proposal prompt.
  expect(received[0]!.messages.at(-1)!.content).not.toContain("Read the bicycle's workshop note");

  const report = JSON.parse(result.stdout) as ProposeReport;
  expect(report.contractVersion).toBe(1);
  expect(report.corpus).toBe("workshop-bicycles");
  expect(report.cases).toHaveLength(1);
  const caseReport = report.cases[0]!;
  expect(caseReport.outcome).toBe("proposed");
  expect(caseReport.proposed).toEqual([
    "frame.material",
    "frame.serial",
    "service.date",
    "service.notes",
  ]);

  // The persisted pending entry's evidence names the note by its declared file.
  const caseDocument = JSON.parse(
    readFileSync(join(dir, "service-sheet", "case.json"), "utf8"),
  ) as {
    expected: Record<
      string,
      { review?: string; proposal?: { status?: string; evidence?: unknown } }
    >;
  };
  const material = caseDocument.expected["frame.material"]!;
  expect(material.review).toBe("pending");
  expect(material.proposal!.status).toBe("asserted");
  expect(material.proposal!.evidence).toEqual({
    quote: "attic insulation R-49",
    input: "site-note.txt",
  });
  // The silent leaves became pending proposed absences.
  expect(caseDocument.expected["service.date"]).toMatchObject({
    review: "pending",
    proposal: { status: "declared-absent" },
  });

  // stderr ends with the review handoff, naming `ribo corpus review`.
  expect(result.stderr).toContain("ribo corpus propose: review handoff");
  expect(result.stderr).toContain("ribo corpus review");
  expect(result.stderr).toContain(dir);
});

test("the write is add-only: existing entries and every byte outside `expected` survive", async () => {
  const dir = textCaseCorpus();
  const caseFile = join(dir, "spoken-note", "case.json");
  // A hand-written entry, written in the writer's own two-space
  // serialisation — the precondition asserted before anything proposes into it.
  editJson(caseFile, (document) => {
    document["expected"] = {
      "frame.material": { status: "asserted", value: "timber", sourceSpan: "timber" },
    };
  });
  const before = readFileSync(caseFile, "utf8");
  const beforeDocument = JSON.parse(before) as Record<string, unknown>;
  expect(before).toBe(`${JSON.stringify(beforeDocument, null, 2)}\n`);

  replier = silentReply;
  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);

  expect(result.status).toBe(0);
  // The hand-written leaf was not asked: it is already answered.
  expect(askedLeavesOf(received[0]!)).toEqual(["frame.serial", "service.date", "service.notes"]);

  const after = readFileSync(caseFile, "utf8");
  const afterDocument = JSON.parse(after) as {
    expected: Record<string, unknown>;
    defaults?: unknown;
  };
  // Only new keys appeared in `expected`; the hand-written entry is unchanged.
  expect(Object.keys(afterDocument.expected)).toEqual([
    "frame.material",
    "frame.serial",
    "service.date",
    "service.notes",
  ]);
  expect(JSON.stringify(afterDocument.expected["frame.material"])).toBe(
    JSON.stringify((beforeDocument["expected"] as Record<string, unknown>)["frame.material"]),
  );
  // Every new entry is pending review.
  for (const key of ["frame.serial", "service.date", "service.notes"]) {
    expect(afterDocument.expected[key]).toMatchObject({ review: "pending" });
  }
  // The whole file is the canonical serialisation of the original document
  // with exactly the new entries appended — bytes outside `expected` included.
  const canonical = `${JSON.stringify({ ...beforeDocument, expected: afterDocument.expected }, null, 2)}\n`;
  expect(after).toBe(canonical);
  // No temporary survivor.
  expect(existsSync(`${caseFile}.tmp`)).toBe(false);
});

test("a successful round with no valid entry writes nothing", async () => {
  const dir = textCaseCorpus();
  const caseFile = join(dir, "spoken-note", "case.json");
  const before = readFileSync(caseFile, "utf8");
  // Every asked leaf named with a value whose quote grounds nowhere: the
  // parsed round validates, every item is dropped, and no rewrite happens.
  replier = (body) => {
    const items = askedLeavesOf(body).map((path) => ({
      path,
      value: "ghost",
      quote: "a quote from nowhere",
      absent: null,
    }));
    return JSON.stringify({ items, collections: [] });
  };
  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as ProposeReport;
  expect(report.cases[0]).toMatchObject({ outcome: "proposed", proposed: [] });
  expect(report.cases[0]!.unproposed).toHaveLength(4);
  expect(readFileSync(caseFile, "utf8")).toBe(before);
});

test("a rerun after every selected leaf was answered makes zero requests and zero spawns", async () => {
  const dir = textCaseCorpus();
  replier = silentReply;
  const first = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(first.status).toBe(0);
  expect(received).toHaveLength(1);
  const afterFirst = readFileSync(join(dir, "spoken-note", "case.json"), "utf8");

  // The identical rerun: zero model requests, zero spawns (not even the CLI
  // preflight's --version), nothing written, and every case nothing-to-propose.
  const second = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "claude-cli",
    "--model",
    "claude-haiku-5-5",
  ]);
  expect(second.status).toBe(0);
  expect(received).toHaveLength(1);
  expect(stubCalls()).toHaveLength(0);
  expect(readFileSync(join(dir, "spoken-note", "case.json"), "utf8")).toBe(afterFirst);
  const report = JSON.parse(second.stdout) as ProposeReport;
  expect(report.cases).toHaveLength(1);
  expect(report.cases[0]).toMatchObject({ outcome: "nothing-to-propose", proposed: [] });
  expect(second.stderr).toContain("USD 0");
});

test("a rerun after a dropped item asks the unanswered leaf again, and only it", async () => {
  const dir = textCaseCorpus();
  // Run 1: frame.material grounds, frame.serial's quote is in no input, the
  // service leaves are silent. The dropped leaf is the only one left over.
  replier = (body) => {
    const leaves = askedLeavesOf(body);
    const items = leaves.map((path) => {
      if (path === "frame.material") {
        return { path, value: "steel", quote: "steel frame", absent: null };
      }
      if (path === "frame.serial") {
        return { path, value: "BW-4471", quote: "a quote from nowhere", absent: null };
      }
      return { path, value: null, quote: null, absent: true };
    });
    return JSON.stringify({ items, collections: [] });
  };
  const first = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(first.status).toBe(0);
  expect(askedLeavesOf(received[0]!)).toEqual([
    "frame.material",
    "frame.serial",
    "service.date",
    "service.notes",
  ]);
  const report = JSON.parse(first.stdout) as ProposeReport;
  expect(report.cases[0]).toMatchObject({
    outcome: "proposed",
    proposed: ["frame.material", "service.date", "service.notes"],
  });
  expect(report.cases[0]!.unproposed.map((entry) => entry.path)).toEqual(["frame.serial"]);
  const afterFirst = readFileSync(join(dir, "spoken-note", "case.json"), "utf8");

  // Run 2: the dropped leaf is asked again; the answered ones are not.
  received.length = 0;
  replier = (body) => {
    const leaves = askedLeavesOf(body);
    const items = leaves.map((path) =>
      path === "frame.serial"
        ? { path, value: "BW-4471", quote: "BW-4471", absent: null }
        : { path, value: null, quote: null, absent: true },
    );
    return JSON.stringify({ items, collections: [] });
  };
  const second = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(second.status).toBe(0);
  expect(received).toHaveLength(1);
  expect(askedLeavesOf(received[0]!)).toEqual(["frame.serial"]);
  const secondReport = JSON.parse(second.stdout) as ProposeReport;
  expect(secondReport.cases[0]).toMatchObject({ outcome: "proposed", proposed: ["frame.serial"] });
  // The leaves already written were not altered: their bytes are untouched
  // except for the newly appended key.
  const afterSecond = JSON.parse(readFileSync(join(dir, "spoken-note", "case.json"), "utf8")) as {
    expected: Record<string, unknown>;
  };
  const beforeParsed = JSON.parse(afterFirst) as { expected: Record<string, unknown> };
  for (const [key, entry] of Object.entries(beforeParsed.expected)) {
    expect(JSON.stringify(afterSecond.expected[key])).toBe(JSON.stringify(entry));
  }
  expect(Object.keys(afterSecond.expected)).toHaveLength(4);
});

test("a scoped run asks only the covered leaves, and a scoped rerun asks only what is left", async () => {
  const dir = textCaseCorpus();
  replier = silentReply;
  const first = await runBin([
    "corpus",
    "propose",
    dir,
    "--only",
    "service",
    "--only",
    "frame.serial",
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(first.status).toBe(0);
  // The union of the two scopes, in inventory order.
  expect(askedLeavesOf(received[0]!)).toEqual(["frame.serial", "service.date", "service.notes"]);
  const firstReport = JSON.parse(first.stdout) as ProposeReport;
  expect(firstReport.cases[0]).toMatchObject({
    outcome: "proposed",
    proposed: ["frame.serial", "service.date", "service.notes"],
  });

  received.length = 0;
  const second = await runBin([
    "corpus",
    "propose",
    dir,
    "--only",
    "frame",
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(second.status).toBe(0);
  // Only the one leaf the new scope covers that is still unanswered.
  expect(askedLeavesOf(received[0]!)).toEqual(["frame.material"]);
  const secondReport = JSON.parse(second.stdout) as ProposeReport;
  expect(secondReport.cases[0]).toMatchObject({
    outcome: "proposed",
    proposed: ["frame.material"],
  });
});

test("a covering default answers its leaves without asking them", async () => {
  const dir = textCaseCorpus();
  editJson(join(dir, "spoken-note", "case.json"), (document) => {
    document["defaults"] = [{ scope: "service", status: "declared-absent" }];
  });
  replier = silentReply;
  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(result.status).toBe(0);
  // The default answers both service leaves, whatever its status: only the
  // frame leaves are asked.
  expect(askedLeavesOf(received[0]!)).toEqual(["frame.material", "frame.serial"]);
  const report = JSON.parse(result.stdout) as ProposeReport;
  expect(report.cases[0]).toMatchObject({
    outcome: "proposed",
    proposed: ["frame.material", "frame.serial"],
  });
});

test("an over-ceiling run makes zero requests and changes no file; --yes proceeds", async () => {
  const dir = textCaseCorpus();
  const caseFile = join(dir, "spoken-note", "case.json");
  const before = readFileSync(caseFile, "utf8");

  const refused = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--max-spend",
    "0.000001",
  ]);
  expect(refused.status).toBe(2);
  expect(refused.stdout).toBe("");
  expect(received).toHaveLength(0);
  expect(readFileSync(caseFile, "utf8")).toBe(before);
  expect(existsSync(`${caseFile}.tmp`)).toBe(false);
  expect(refused.stderr).toContain("spend estimate");
  expect(refused.stderr).toContain("above the ceiling");
  // The HTTP refusal may recommend the response cap.
  expect(refused.stderr).toContain("--response-cap");

  // The override proceeds — and still prints the estimate first.
  replier = silentReply;
  const allowed = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--max-spend",
    "0.000001",
    "--yes",
  ]);
  expect(allowed.status).toBe(0);
  expect(allowed.stderr).toContain("spend estimate");
  expect(received).toHaveLength(1);
  expect(JSON.parse(allowed.stdout) as ProposeReport).toMatchObject({
    cases: [
      {
        outcome: "proposed",
        proposed: ["frame.material", "frame.serial", "service.date", "service.notes"],
      },
    ],
  });
});

test("one failing case leaves the others written, and the run still exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ribo-corpus-propose-run-"));
  cpSync(FIXTURE_CORPUS, dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "spoken-note" && entry.name !== "written-ticket") {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
    }
  }
  editJson(join(dir, "spoken-note", "case.json"), (document) => {
    document["expected"] = {};
    delete document["defaults"];
  });
  editJson(join(dir, "written-ticket", "case.json"), (document) => {
    document["expected"] = {};
  });
  const failFile = join(dir, "spoken-note", "case.json");
  const okFile = join(dir, "written-ticket", "case.json");
  const failBefore = readFileSync(failFile, "utf8");
  const okBefore = readFileSync(okFile, "utf8");

  // The failing case's requests get unparseable replies, past the repair
  // bound; the other case's get valid ones. The cases are told apart by a
  // token only one case's text carries.
  replier = (body) => {
    // The failing case is the one whose text names the serial: its replies
    // are unparseable past the repair bound; the other case's are valid. The
    // check is over every message, so the repair round is told apart too.
    const named = body.messages.some((message) => message.content.includes("BW-4471"));
    if (named) return '{"nope"';
    return JSON.stringify({
      items: [{ path: "service.date", value: "2026-02-04", quote: "2026-02-04", absent: null }],
      collections: [],
    });
  };
  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);

  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as ProposeReport;
  expect(report.cases.map((entry) => entry.caseId)).toEqual(["spoken-note", "written-ticket"]);
  const failed = report.cases[0]!;
  expect(failed.outcome).toBe("failed");
  expect(failed.proposed).toEqual([]);
  expect(failed.reason).toBeDefined();
  expect(failed.unproposed.map((entry) => entry.path)).toEqual([
    "frame.material",
    "frame.serial",
    "service.date",
    "service.notes",
  ]);
  expect(report.cases[1]).toMatchObject({
    outcome: "proposed",
    proposed: ["frame.material", "frame.serial", "service.date", "service.notes"],
  });
  // The failed case's file is unchanged; the successful case is written.
  expect(readFileSync(failFile, "utf8")).toBe(failBefore);
  expect(readFileSync(okFile, "utf8")).not.toBe(okBefore);
  // The failed case is named, with its reason, in the stdout report.
  expect(result.stdout).toContain("spoken-note");
  expect(result.stdout).toContain("failed");
  expect(result.stdout).toContain("repair round");

  // The rerun asks the failed case's still-unanswered leaves again, and does
  // not ask the case the earlier run already wrote.
  received.length = 0;
  replier = silentReply;
  const rerun = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(rerun.status).toBe(0);
  expect(received).toHaveLength(1);
  expect(askedLeavesOf(received[0]!)).toEqual([
    "frame.material",
    "frame.serial",
    "service.date",
    "service.notes",
  ]);
  const rerunReport = JSON.parse(rerun.stdout) as ProposeReport;
  expect(rerunReport.cases[0]).toMatchObject({ outcome: "proposed" });
  expect(rerunReport.cases[1]).toMatchObject({ outcome: "nothing-to-propose", proposed: [] });
});

test("an unknown case id is refused before transcription, naming the corpus's cases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ribo-corpus-propose-run-"));
  cpSync(FIXTURE_CORPUS, dir, { recursive: true });
  const before = readFileSync(join(dir, "spoken-note", "case.json"), "utf8");

  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "no-such-case",
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(received).toHaveLength(0);
  expect(result.stderr).toContain("no-such-case");
  expect(result.stderr).toContain("spoken-note");
  expect(result.stderr).toContain("service-sheet");
  expect(result.stderr).toContain("(fix:");
  expect(readFileSync(join(dir, "spoken-note", "case.json"), "utf8")).toBe(before);
});

test("selection precedes transcription: a text-only case runs while an unselected case's PDF has no text layer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ribo-corpus-propose-run-"));
  cpSync(FIXTURE_CORPUS, dir, { recursive: true });
  const NO_TEXT_LAYER_PDF = fileURLToPath(
    new URL("../../ribo-transcriber-pdfjs/src/fixtures/no-text-layer.pdf", import.meta.url),
  );
  writeFileSync(join(dir, "service-sheet", "input.pdf"), readFileSync(NO_TEXT_LAYER_PDF));
  editJson(join(dir, "spoken-note", "case.json"), (document) => {
    document["expected"] = {};
    delete document["defaults"];
  });

  replier = silentReply;
  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "spoken-note",
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout) as ProposeReport).toMatchObject({
    cases: [{ caseId: "spoken-note", outcome: "proposed" }],
  });

  // The unknown-id run over the same corpus reports the id, not the PDF fault.
  const unknown = await runBin([
    "corpus",
    "propose",
    dir,
    "no-such-case",
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
  ]);
  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain("no-such-case");
  expect(unknown.stderr).not.toContain("text layer");
});

test("--response-cap with a CLI backend is refused before the binary even answers --version", async () => {
  const dir = textCaseCorpus();
  rmSync(stubLog, { force: true });
  const before = readFileSync(join(dir, "spoken-note", "case.json"), "utf8");

  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "claude-cli",
    "--model",
    "claude-haiku-5-5",
    "--response-cap",
    "256",
  ]);

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--response-cap");
  expect(result.stderr).toContain("claude-cli");
  expect(result.stderr).toContain("(fix:");
  // The stub's log proves not even the preflight ran.
  expect(stubCalls()).toHaveLength(0);
  // No file was touched.
  expect(readFileSync(join(dir, "spoken-note", "case.json"), "utf8")).toBe(before);

  // The mirror refusal: --timeout on the HTTP backend.
  const httpRefusal = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "openai-compatible",
    "--model",
    "gpt-4o",
    "--timeout",
    "30",
  ]);
  expect(httpRefusal.status).toBe(2);
  expect(httpRefusal.stdout).toBe("");
  expect(httpRefusal.stderr).toContain("--timeout");
  expect(httpRefusal.stderr).toContain("openai-compatible");
  expect(received).toHaveLength(0);
});

test("a successful CLI run goes through the shadowing stub, with no credential", async () => {
  const dir = textCaseCorpus();
  rmSync(stubLog, { force: true });

  const result = await runBin([
    "corpus",
    "propose",
    dir,
    "--backend",
    "claude-cli",
    "--model",
    "claude-haiku-5-5",
  ]);

  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as ProposeReport;
  expect(report.cases[0]).toMatchObject({
    outcome: "proposed",
    proposed: ["frame.material", "frame.serial", "service.date", "service.notes"],
  });
  // The stub's log: one preflight, one proposal call whose stdin carried the
  // case text — and the run needed no credential anywhere.
  const calls = stubCalls();
  expect(calls[0]).toEqual(["--version"]);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.some((element) => element.includes("Leaves to answer"))).toBe(true);
  const caseDocument = JSON.parse(readFileSync(join(dir, "spoken-note", "case.json"), "utf8")) as {
    expected: Record<string, { proposal?: { evidence?: { input?: string } } }>;
  };
  expect(caseDocument.expected["frame.material"]!.proposal!.evidence).toEqual({
    quote: "steel frame",
    input: "input.txt",
  });
  expect(result.stderr).toContain("ribo corpus review");
});
