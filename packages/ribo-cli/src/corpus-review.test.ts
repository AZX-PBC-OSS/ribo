/**
 * @file The `ribo corpus review` core over a temp corpus: the sheet's
 * evidence (row-major collections, the absence block, grounded and literal
 * flags) and every decision's semantics — no model, no network, no
 * credential; the read side is free and writes nothing, the decisions go
 * through the guarded writer.
 *
 * The corpus is built in a temp directory per test, so the committed fixtures
 * are never written and tests never share state.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { runCorpusReviewCommand } from "./corpus/review-command.js";
import { valueOccursLiterally } from "./corpus/review.js";
import { resolveExpectation } from "./corpus/expectations.js";
import type { ResolvedExpectation } from "./corpus/expectations.js";
import { CorpusCaseSchema } from "./index.js";
import type { CorpusCase } from "./index.js";

const PROPOSED_AT = "2026-11-13T09:00:00.000Z";
const PROPOSER = { backend: "openai-compatible", model: "stub-proposer" };

/** The review trial's schema: scalars of each kind beside one two-leaf collection. */
const SCHEMA = {
  type: "object",
  properties: {
    frame: {
      type: "object",
      properties: {
        material: { type: "string", description: "The frame's material." },
        serial: { type: "string", description: "The frame's serial number." },
      },
      required: ["material", "serial"],
    },
    service: {
      type: "object",
      properties: {
        quotedTotal: { type: "number", description: "The quoted total." },
        warranty: { type: "boolean", description: "Whether warranty covered the work." },
        date: { type: "string", description: "The day of the work." },
      },
      required: ["quotedTotal", "warranty", "date"],
    },
    upgrades: {
      type: "array",
      items: {
        type: "object",
        properties: {
          measure: { type: "string", description: "The measure's name." },
          cost: { type: "number", description: "The measure's cost." },
        },
        required: ["measure", "cost"],
      },
    },
  },
  required: ["frame", "service", "upgrades"],
};

/** The input the default trial case grounds every quote in. */
const INPUT_TEXT = [
  "Dropped off a steel frame, serial number BW-4471.",
  "Attic insulation top-up quoted at $1,800 in March.",
  "Air sealing quoted at 400 the same visit.",
  "",
].join("\n");

/** A pending asserted proposal, stamped with the trial proposer. */
const assertedProposal = (value: unknown, evidence: unknown): Record<string, unknown> => ({
  status: "asserted",
  value,
  evidence,
  backend: PROPOSER.backend,
  model: PROPOSER.model,
  proposedAt: PROPOSED_AT,
});

/** A pending proposed absence, stamped with the trial proposer. */
const absentProposal = (): Record<string, unknown> => ({
  status: "declared-absent",
  backend: PROPOSER.backend,
  model: PROPOSER.model,
  proposedAt: PROPOSED_AT,
});

const pendingAsserted = (value: unknown, evidence: unknown): Record<string, unknown> => ({
  status: "asserted",
  value,
  proposal: assertedProposal(value, evidence),
  review: "pending",
});

const pendingAbsent = (): Record<string, unknown> => ({
  status: "declared-absent",
  proposal: absentProposal(),
  review: "pending",
});

/** The default trial case's pending proposals: one of everything the sheet shows. */
const DEFAULT_EXPECTED: Record<string, unknown> = {
  "frame.material": pendingAsserted("steel", { quote: "steel frame", input: "input.txt" }),
  "frame.serial": pendingAsserted("BW-4471", {
    quote: "serial number BW-4471",
    input: "input.txt",
  }),
  "service.quotedTotal": pendingAsserted(1800, {
    quote: "quoted at $1,800 in March",
    input: "input.txt",
  }),
  "service.warranty": pendingAsserted(true, {
    quote: "Dropped off a steel frame, serial number BW-4471.",
    input: "input.txt",
  }),
  "service.date": pendingAbsent(),
  "upgrades.measure": pendingAsserted(
    { "0": "insulation", "1": "air sealing" },
    {
      "0": { quote: "Attic insulation top-up", input: "input.txt" },
      "1": { quote: "Air sealing", input: "input.txt" },
    },
  ),
  // The cost leaf says nothing about row 1 — the sheet's missing cell.
  "upgrades.cost": pendingAsserted(
    { "0": 1800 },
    { "0": { quote: "quoted at $1,800 in March", input: "input.txt" } },
  ),
};

interface MakeCorpusOptions {
  readonly expected?: Record<string, unknown>;
  readonly inputsText?: string;
  readonly defaults?: readonly unknown[];
}

const madeCorpora: string[] = [];

/** Build a one-case review corpus in a fresh temp directory. */
const makeCorpus = (options: MakeCorpusOptions = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "ribo-corpus-review-"));
  madeCorpora.push(dir);
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        name: "review-trial",
        schema: "schema.json",
        provenance: "synthetic",
        prompt: { instructions: "Extract the visit's fields." },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "schema.json"), `${JSON.stringify(SCHEMA, null, 2)}\n`);
  const caseDir = join(dir, "visit-one");
  mkdirSync(caseDir);
  writeFileSync(join(caseDir, "input.txt"), options.inputsText ?? INPUT_TEXT);
  writeFileSync(
    join(caseDir, "case.json"),
    `${JSON.stringify(
      {
        id: "visit-one",
        inputs: [{ file: "input.txt", kind: "text" }],
        expected: options.expected ?? DEFAULT_EXPECTED,
        ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
      },
      null,
      2,
    )}\n`,
  );
  return dir;
};

afterEach(() => {
  for (const dir of madeCorpora.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A captured stream: everything the runner writes to it, readable after the run. */
const capture = (): { stream: NodeJS.WritableStream; text: () => string } => {
  const state = { buffer: "" };
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        state.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      },
    } as unknown as NodeJS.WritableStream,
    text: () => state.buffer,
  };
};

/** A run's result, discriminated so the assertions narrow. */
type RunOk = { ok: true; stdout: string; stderr: string; report: unknown };
type RunFail = { ok: false; stdout: string; stderr: string; error: unknown };

/** Run the review command over a made corpus with captured streams. */
const run = async (
  dir: string,
  flags: Parameters<typeof runCorpusReviewCommand>[2],
  caseId?: string,
): Promise<RunOk | RunFail> => {
  const out = capture();
  const err = capture();
  try {
    const report = await runCorpusReviewCommand(dir, caseId, flags, {
      stdout: out.stream,
      stderr: err.stream,
    });
    return { ok: true, stdout: out.text(), stderr: err.text(), report };
  } catch (error) {
    return { ok: false, stdout: out.text(), stderr: err.text(), error };
  }
};

/** Assert the run succeeded; hand back the narrowed result. */
const mustOk = (result: RunOk | RunFail): RunOk => {
  expect(result.ok, result.ok ? undefined : String(result.error)).toBe(true);
  return result as RunOk;
};

/** Assert the run was refused; hand back the narrowed result. */
const mustFail = (result: RunOk | RunFail): RunFail => {
  expect(result.ok, "the run should have been refused").toBe(false);
  return result as RunFail;
};

/** Read a made corpus's case file back — through the same schema the loader parses it with. */
const caseFileOf = (dir: string): CorpusCase =>
  CorpusCaseSchema.parse(JSON.parse(readFileSync(join(dir, "visit-one", "case.json"), "utf8")));

/** Resolve one leaf of a made corpus's case file, after decisions. */
const resolvedOf = (dir: string, path: string): ResolvedExpectation =>
  resolveExpectation(caseFileOf(dir), path);

/** Resolve one leaf to an explicit entry, so its review class is readable. */
const explicitOf = (
  dir: string,
  path: string,
): Extract<ResolvedExpectation, { origin: "explicit" }> => {
  const resolved = resolvedOf(dir, path);
  // Only an explicit entry carries a review class.
  if (!("reviewClass" in resolved)) {
    throw new Error(`"${path}" did not resolve to an explicit entry`);
  }
  return resolved;
};

/** The sheet shape the tests read, as the JSON contract renders it. */
interface SheetShape {
  contractVersion: number;
  corpus: string;
  cases: {
    caseId: string;
    values: {
      path: string;
      value: unknown;
      quote: string;
      input: string;
      grounded: boolean;
      literal: boolean;
    }[];
    collections: {
      collectionPath: string;
      rows: {
        ordinal: string;
        cells: Record<string, { value: unknown; grounded: boolean; literal: boolean }>;
      }[];
    }[];
    absences: { path: string }[];
  }[];
}

const asSheet = (report: unknown): SheetShape => {
  expect(report).toMatchObject({ contractVersion: 1 });
  return report as SheetShape;
};

const cellOf = (
  sheet: ReturnType<typeof asSheet>,
  path: string,
): { value: unknown; grounded: boolean; literal: boolean } => {
  for (const value of sheet.cases[0]!.values) {
    if (value.path === path) return value;
  }
  throw new Error(`the sheet has no scalar row for "${path}"`);
};

test("the sheet is row-major for a two-row collection with one missing cell, and the read side writes nothing", async () => {
  const dir = makeCorpus();
  const before = readFileSync(join(dir, "visit-one", "case.json"), "utf8");

  const result = mustOk(await run(dir, { json: true }, "visit-one"));
  const sheet = asSheet(result.report);

  expect(sheet.corpus).toBe("review-trial");
  expect(sheet.cases).toHaveLength(1);
  expect(sheet.cases[0]!.caseId).toBe("visit-one");
  // The scalars, in expected-map order.
  expect(sheet.cases[0]!.values.map((row) => row.path)).toEqual([
    "frame.material",
    "frame.serial",
    "service.quotedTotal",
    "service.warranty",
  ]);
  // The collection is row-major: one row per instance ordinal, each row
  // carrying its leaves' cells — and the row the cost leaf says nothing
  // about shows the cell as missing, not as a zero.
  const collections = sheet.cases[0]!.collections;
  expect(collections).toHaveLength(1);
  expect(collections[0]!.collectionPath).toBe("upgrades");
  const rows = collections[0]!.rows;
  expect(rows.map((row) => row.ordinal)).toEqual(["0", "1"]);
  expect(Object.keys(rows[0]!.cells)).toEqual(["upgrades.measure", "upgrades.cost"]);
  expect(Object.keys(rows[1]!.cells)).toEqual(["upgrades.measure"]);
  expect(rows[0]!.cells["upgrades.cost"]!.value).toBe(1800);
  // The absences sit in their own block, never mixed into the values.
  expect(sheet.cases[0]!.absences.map((entry) => entry.path)).toEqual(["service.date"]);

  expect(readFileSync(join(dir, "visit-one", "case.json"), "utf8")).toBe(before);
});

test("literal is true for a string and for a number with separators or a currency sign in its quote, false for a boolean", async () => {
  const dir = makeCorpus();
  const result = mustOk(await run(dir, { json: true }, "visit-one"));
  const sheet = asSheet(result.report);

  expect(cellOf(sheet, "frame.material")).toMatchObject({ literal: true, grounded: true });
  expect(cellOf(sheet, "frame.serial")).toMatchObject({ literal: true, grounded: true });
  // The number's quote carries a currency sign and a thousands separator.
  expect(cellOf(sheet, "service.quotedTotal")).toMatchObject({ value: 1800, literal: true });
  expect(cellOf(sheet, "service.warranty")).toMatchObject({ value: true, literal: false });

  // The collection cells carry their own flags.
  const rows = sheet.cases[0]!.collections[0]!.rows;
  expect(rows[0]!.cells["upgrades.measure"]!.literal).toBe(true);
  expect(rows[1]!.cells["upgrades.measure"]!.literal).toBe(true);
  expect(rows[0]!.cells["upgrades.cost"]!.literal).toBe(true);
});

test("the review-side number comparator tolerates separators and currency signs and is not parseNumberish", () => {
  expect(valueOccursLiterally(1800, "quoted at 1,800 total")).toBe(true);
  expect(valueOccursLiterally(1800, "quoted at $1,800")).toBe(true);
  expect(valueOccursLiterally(1800, "quoted at 1800")).toBe(true);
  expect(valueOccursLiterally(400, "quoted at 400")).toBe(true);
  // Spelled in words is a scoring fold's answer, not evidence of the value
  // itself — and a near-number is not the number.
  expect(valueOccursLiterally(1800, "about eighteen hundred")).toBe(false);
  expect(valueOccursLiterally(1800, "the 18,00 x")).toBe(false);
  expect(valueOccursLiterally(1800, "1,8000")).toBe(false);
  expect(valueOccursLiterally(true, "true")).toBe(false);
});

test("grounded goes false after the input file is edited", async () => {
  const dir = makeCorpus();
  writeFileSync(join(dir, "visit-one", "input.txt"), "The frame was replaced entirely.\n");

  const result = mustOk(await run(dir, { json: true }, "visit-one"));
  const sheet = asSheet(result.report);
  expect(cellOf(sheet, "frame.material")).toMatchObject({ grounded: false, literal: true });
  expect(cellOf(sheet, "frame.serial")).toMatchObject({ grounded: false, literal: true });
  // A quote that still occurs is still grounded.
  expect(cellOf(sheet, "service.quotedTotal")).toMatchObject({ grounded: false });
});

test("a whole-case confirm leaves exactly the absences and the non-literals pending, and prints why", async () => {
  const dir = makeCorpus();
  const before = caseFileOf(dir);

  const result = mustOk(await run(dir, { confirm: true }, "visit-one"));
  expect(result.stdout).toContain("left pending");
  expect(result.stdout).toContain("service.warranty");
  expect(result.stdout).toContain("not literal");
  expect(result.stdout).toContain("service.date");
  expect(result.stdout).toContain("absence");

  const after = caseFileOf(dir);
  // Confirmed: every entry whose every value is literal in a still-grounded
  // quote — including the collection entry with its missing row cell.
  for (const path of [
    "frame.material",
    "frame.serial",
    "service.quotedTotal",
    "upgrades.measure",
    "upgrades.cost",
  ]) {
    expect(after.expected[path]).toMatchObject({ review: "confirmed" });
    expect(explicitOf(dir, path).reviewClass).toBe("accepted-unchanged");
  }
  // Left pending: the non-literal value and the proposed absence.
  expect(after.expected["service.warranty"]).toMatchObject({ review: "pending" });
  expect(after.expected["service.date"]).toMatchObject({ review: "pending" });
  // The proposal block is never modified.
  for (const path of Object.keys(before.expected)) {
    expect(JSON.stringify(after.expected[path]?.proposal)).toBe(
      JSON.stringify(before.expected[path]?.proposal),
    );
  }
});

test("--leaf confirms the named pending entries whatever they are", async () => {
  const dir = makeCorpus();

  const result = mustOk(
    await run(dir, { confirm: true, leaf: ["service.warranty", "service.date"] }, "visit-one"),
  );
  expect(result.stdout).toContain("confirmed in visit-one: service.warranty, service.date");

  const after = caseFileOf(dir);
  expect(after.expected["service.warranty"]).toMatchObject({ review: "confirmed" });
  expect(after.expected["service.date"]).toMatchObject({ review: "confirmed" });
  expect(after.expected["frame.material"]).toMatchObject({ review: "pending" });
  expect(explicitOf(dir, "service.date").reviewClass).toBe("accepted-unchanged");
});

test("a decision on a leaf with no pending proposal is refused by name, stdout empty", async () => {
  const dir = makeCorpus({
    expected: {
      ...DEFAULT_EXPECTED,
      // A hand-written entry: no proposal, so no decision applies to it.
      // It replaces the leaf's pending proposed absence.
      "service.date": { status: "asserted", value: "2026-03-14" },
    },
  });
  const before = readFileSync(join(dir, "visit-one", "case.json"), "utf8");

  for (const flags of [
    { confirm: true, leaf: ["service.date"] },
    { confirm: true, leaf: ["no.such.leaf"] },
    { markAbsent: true, leaf: ["service.date"] },
    { markAbsent: true, leaf: ["no.such.leaf"] },
    { reject: true, leaf: ["service.date"] },
    { reject: true, leaf: ["no.such.leaf"] },
  ]) {
    const result = mustFail(await run(dir, { ...flags }, "visit-one"));
    expect(result.stdout).toBe("");
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    expect(message).toContain("visit-one");
    expect(message).toContain(flags.leaf[0]!);
    expect(message).toContain("no pending proposal");
  }
  expect(readFileSync(join(dir, "visit-one", "case.json"), "utf8")).toBe(before);
});

test("mark-absent sets the entry declared-absent and confirmed, and the classified entry is corrected", async () => {
  const dir = makeCorpus();

  const result = mustOk(
    await run(dir, { markAbsent: true, leaf: ["frame.material"] }, "visit-one"),
  );
  expect(result.stdout).toContain("marked absent");

  const entry = caseFileOf(dir).expected["frame.material"]!;
  expect(entry.status).toBe("declared-absent");
  expect(entry).toMatchObject({ review: "confirmed" });
  // The proposal block survives untouched, so the record can tell corrected
  // from hand-written.
  expect(entry.proposal).toMatchObject({ status: "asserted", value: "steel" });
  const resolved = explicitOf(dir, "frame.material");
  expect(resolved.status).toBe("declared-absent");
  expect(resolved.reviewClass).toBe("corrected");
  expect(resolved.proposerBackend).toBe("openai-compatible");
  expect(resolved.proposerModel).toBe("stub-proposer");
});

test("reject leaves the leaf unmentioned when no default covers it", async () => {
  const dir = makeCorpus({ defaults: [] });

  const result = mustOk(await run(dir, { reject: true, leaf: ["service.date"] }, "visit-one"));
  expect(result.stdout).toContain("rejected in visit-one: service.date");

  const after = caseFileOf(dir);
  expect("service.date" in after.expected).toBe(false);
  // Unmentioned: not through an explicit unmentioned entry — the key is gone.
  const resolved = resolvedOf(dir, "service.date");
  expect(resolved.status).toBe("unmentioned");
  expect(resolved.origin).toBe("none");
});

test("reject with a covering default resolves through that default, and never edits it", async () => {
  const dir = makeCorpus({
    defaults: [{ scope: "service", status: "declared-absent", sourceSpan: "no service" }],
  });

  const result = mustOk(await run(dir, { reject: true, leaf: ["service.date"] }, "visit-one"));
  expect(result.stdout).toContain("rejected in visit-one: service.date");

  const after = caseFileOf(dir);
  expect("service.date" in after.expected).toBe(false);
  expect(after.defaults).toEqual([
    { scope: ["service"], status: "declared-absent", sourceSpan: "no service" },
  ]);
  const resolved = resolvedOf(dir, "service.date");
  expect(resolved.status).toBe("declared-absent");
  expect(resolved.origin).toBe("default");
});

test("a decision requires a case id and exactly one action", async () => {
  const dir = makeCorpus();
  const before = readFileSync(join(dir, "visit-one", "case.json"), "utf8");

  for (const [caseId, flags] of [
    ["visit-one", { confirm: true, markAbsent: true }],
    ["visit-one", { confirm: true, reject: true }],
    [undefined, { confirm: true }],
    ["visit-one", { leaf: ["frame.material"] }],
    ["visit-one", { markAbsent: true }],
    ["visit-one", { reject: true }],
    ["visit-one", { reject: true, leaf: ["a", "b"] }],
  ] as const) {
    const result = mustFail(await run(dir, { ...flags }, caseId));
    expect(result.stdout).toBe("");
  }
  expect(readFileSync(join(dir, "visit-one", "case.json"), "utf8")).toBe(before);
});
