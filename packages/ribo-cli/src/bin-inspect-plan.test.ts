import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSchemaPlan, planFingerprint, SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { SchemaPlan, SchemaPlanPiece } from "@azx/ribo-core";
import { afterAll, beforeAll, expect, test } from "vitest";

import { SchemaInspectReportSchema } from "./index.js";
import type { SchemaInspectReport } from "./index.js";
import { convertDocument } from "./inspect/convert.js";
import { schemaFingerprint } from "./inspect/fingerprint.js";
import { schemaPlanFreshness } from "./schema-plan.js";
import { buildCliOnce } from "./test-support/build-once.js";

/**
 * @file The installed inspect command's plan input, diagnostics and threshold selection. Every
 * scenario drives the built bin without a model; the fixtures are parsed against their schemas
 * before they reach the subprocess so a bad fixture cannot masquerade as a CLI refusal.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(REPO_ROOT, "packages", "ribo-cli", "dist", "bin.js");

const leaf = (description: string) => ({ type: "string", nullable: true, description });

const nestedDocument = {
  type: "object",
  properties: {
    home: {
      type: "object",
      properties: {
        identity: {
          type: "object",
          properties: {
            address: leaf("The street address, with enough guidance to make the piece oversized."),
            yearBuilt: leaf("The construction year, with enough guidance to make it oversized."),
          },
          required: ["address", "yearBuilt"],
        },
        condition: {
          type: "object",
          properties: {
            roof: leaf("The roof condition, with enough guidance to make the piece oversized."),
            heating: leaf("The heating condition, with enough guidance to make it oversized."),
          },
          required: ["roof", "heating"],
        },
      },
      required: ["identity", "condition"],
    },
  },
  required: ["home"],
};

const nestedPaths = [
  "home.identity.address",
  "home.identity.yearBuilt",
  "home.condition.roof",
  "home.condition.heating",
];
const wholePieces: readonly SchemaPlanPiece[] = [
  {
    name: "Whole home",
    description: "The semantic home layout is reviewed before core packs it.",
    key: "home",
    paths: nestedPaths,
  },
];
const splitPieces: readonly SchemaPlanPiece[] = [
  {
    name: "Identity",
    description: "Identity facts stay together.",
    key: "home",
    paths: nestedPaths.slice(0, 2),
  },
  {
    name: "Condition",
    description: "Condition facts stay together.",
    key: "home",
    paths: nestedPaths.slice(2),
  },
];

const packedOnlyDocument = {
  type: "object",
  properties: {
    home: {
      type: "object",
      properties: {
        a: { type: "string", description: `a ${"d".repeat(300)}` },
        x: { type: "string", description: `x ${"d".repeat(200)}` },
        b: { type: "string", description: `b ${"d".repeat(300)}` },
        c: { type: "string", description: `c ${"d".repeat(50)}` },
      },
      required: ["a", "x", "b", "c"],
    },
  },
  required: ["home"],
};
const packedOnlyPieces: readonly SchemaPlanPiece[] = [
  {
    name: "Combined",
    description: "These fields form one reviewed semantic piece.",
    key: "home",
    paths: ["home.a", "home.b", "home.c"],
  },
  {
    name: "Separate",
    description: "This field is reviewed separately.",
    key: "home",
    paths: ["home.x"],
  },
];

const unbuildableDocument = {
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
const unbuildablePieces: readonly SchemaPlanPiece[] = [
  {
    name: "Oversized detail",
    description: "One projected property cannot fit the requested cap.",
    key: "home",
    paths: ["home.details.oversized"],
  },
];

function makePlan(document: unknown, pieces: readonly SchemaPlanPiece[]): SchemaPlan {
  return parseSchemaPlan(
    {
      version: SCHEMA_PLAN_CONTRACT_VERSION,
      schemaFingerprint: schemaFingerprint(document),
      fieldPaths: pieces.flatMap((piece) => piece.paths),
      pieces: [...pieces],
      provenance: {
        model: "stub-model",
        backend: "stub-backend",
        createdAt: "2026-10-01T02:03:04.000Z",
      },
    },
    convertDocument(document),
  );
}

const wholePlan = makePlan(nestedDocument, wholePieces);
const splitPlan = makePlan(nestedDocument, splitPieces);
const packedOnlyPlan = makePlan(packedOnlyDocument, packedOnlyPieces);
const unbuildablePlan = makePlan(unbuildableDocument, unbuildablePieces);
const driftPlan: SchemaPlan = { ...splitPlan, schemaFingerprint: "0".repeat(64) };
const operatorPlan: SchemaPlan = {
  ...splitPlan,
  provenance: { ...splitPlan.provenance, backend: "codex-cli", model: "gpt-test" },
};

let directory: string;

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(value));
}

beforeAll(() => {
  buildCliOnce();
  directory = mkdtempSync(join(tmpdir(), "ribo-cli-inspect-plan-"));
  writeJson("nested.json", nestedDocument);
  writeJson("whole-plan.json", wholePlan);
  writeJson("split-plan.json", splitPlan);
  writeJson("drift-plan.json", driftPlan);
  writeJson("operator plan.json", operatorPlan);
  writeJson("packed-only.json", packedOnlyDocument);
  writeJson("packed-only-plan.json", packedOnlyPlan);
  writeJson("unbuildable.json", unbuildableDocument);
  writeJson("unbuildable-plan.json", unbuildablePlan);
  writeJson("invalid-plan.json", { version: SCHEMA_PLAN_CONTRACT_VERSION });

  const renamed = structuredClone(nestedDocument);
  const identity = renamed.properties.home.properties.identity;
  const identityProperties = identity.properties as Record<string, unknown>;
  delete identityProperties["yearBuilt"];
  identityProperties["vintage"] = leaf("The construction vintage.");
  identity.required = ["address", "vintage"];
  const condition = renamed.properties.home.properties.condition;
  const conditionProperties = condition.properties as Record<string, unknown>;
  delete conditionProperties["roof"];
  conditionProperties["covering"] = leaf("The roof covering.");
  condition.required = ["covering", "heating"];
  writeJson("renamed.json", renamed);
}, 120_000);

afterAll(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function inspect(args: string[], input?: string): Run {
  const outcome = spawnSync(process.execPath, [BIN, "schema", "inspect", ...args], {
    cwd: directory,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
  return { status: outcome.status, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
}

function reportOf(outcome: Run): SchemaInspectReport {
  expect(outcome.stdout).not.toBe("");
  return SchemaInspectReportSchema.parse(JSON.parse(outcome.stdout));
}

function worstPackedCall(report: SchemaInspectReport) {
  const calls = report.planned?.packedCalls ?? [];
  expect(calls.length).toBeGreaterThan(0);
  return calls.reduce((worst, call) =>
    call.serializedChars > worst.serializedChars ? call : worst,
  );
}

function pieceThreshold(report: SchemaInspectReport) {
  const row = report.thresholds?.find((entry) => entry.measure === "pieceChars");
  if (row === undefined) throw new Error("the report has no pieceChars threshold");
  return row;
}

test("planned human and JSON views carry the same core identity, layout rows and thresholds", async () => {
  const args = [
    "--plan",
    "split-plan.json",
    "--max-depth",
    "50",
    "--max-piece-chars",
    "100000",
    "nested.json",
  ];
  const json = inspect(["--json", ...args]);
  const human = inspect(args);
  expect(json.status).toBe(0);
  expect(human.status).toBe(0);
  expect(json.stderr).toBe("");
  expect(human.stderr).toBe("");
  const report = reportOf(json);

  expect(report.planFingerprint).toBe(await planFingerprint(splitPlan));
  expect(human.stdout).toContain(report.schemaFingerprint);
  expect(human.stdout).toContain(report.planFingerprint!);
  expect(human.stdout).toContain(
    `${report.planned!.totals.semanticPieces} semantic piece(s), ${report.planned!.totals.packedCalls} packed call(s)`,
  );
  for (const piece of report.planned!.semanticPieces) {
    expect(human.stdout).toContain(piece.name);
    expect(human.stdout).toContain(`${piece.serializedChars} serialized chars`);
  }
  for (const call of report.planned!.packedCalls) {
    expect(human.stdout).toContain(call.requestName);
    expect(human.stdout).toContain(`${call.serializedChars} serialized chars`);
  }
  for (const row of report.thresholds!) {
    expect(human.stdout).toContain(`threshold ${row.measure} (${row.layout})`);
    expect(human.stdout).toContain(`${row.measured}`);
    expect(human.stdout).toContain(`within the limit ${row.limit}`);
  }
});

test("a stale rename names added and removed paths independently and gives the exact update fix", () => {
  for (const threshold of [[], ["--max-piece-chars", "1"]]) {
    const outcome = inspect(["--plan", "split-plan.json", ...threshold, "--json", "renamed.json"]);
    expect(outcome.status).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain(
      "added [home.condition.covering, home.identity.vintage]; " +
        "removed [home.condition.roof, home.identity.yearBuilt]",
    );
    // The recorded backend is not one the command accepts, so it stays a placeholder.
    expect(outcome.stderr).toContain(
      "fix: ribo schema plan renamed.json --update split-plan.json " +
        "--backend <backend> --model stub-model",
    );
  }
  const recorded = inspect(["--plan", "operator plan.json", "renamed.json"]);
  expect(recorded.status).toBe(2);
  expect(recorded.stderr).toContain(
    "fix: ribo schema plan renamed.json --update 'operator plan.json' " +
      "--backend codex-cli --model gpt-test",
  );
  const piped = inspect(
    ["--plan", "split-plan.json", "-"],
    readFileSync(join(directory, "renamed.json"), "utf8"),
  );
  expect(piped.status).toBe(2);
  expect(piped.stderr).toContain("fix: ribo schema plan <schema> --update split-plan.json");
});

test("an invalid plan is refused before a report, with or without threshold flags", () => {
  for (const threshold of [[], ["--max-piece-chars", "1"]]) {
    const outcome = inspect(["--plan", "invalid-plan.json", ...threshold, "--json", "nested.json"]);
    expect(outcome.status).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("invalid-plan.json");
    expect(outcome.stderr).toContain("invalid");
    expect(outcome.stderr).toContain("pieces");
  }
});

test("fingerprint-only drift emits the shared freshness note once in either rendering", () => {
  const expected = schemaPlanFreshness(nestedDocument, driftPlan);
  expect(expected.status).toBe("fingerprint-only");
  expect(expected.notes).toHaveLength(1);

  const json = inspect(["--json", "--plan", "drift-plan.json", "nested.json"]);
  const human = inspect(["--plan", "drift-plan.json", "nested.json"]);
  expect(json.status).toBe(0);
  expect(human.status).toBe(0);
  const report = reportOf(json);
  expect(report.planned?.notes).toEqual(expected.notes);
  expect(report.planned?.notes).toHaveLength(1);
  expect(human.stdout.match(/planned note/gu)).toHaveLength(1);
  expect(human.stdout).toContain(expected.notes[0]!);
  for (const outcome of [json, human]) {
    expect(outcome.stderr.split(expected.notes[0]!)).toHaveLength(2);
    expect(outcome.stderr).toMatch(/^ribo schema inspect: note: /u);
  }
});

test("an unbuildable planned layout exits 2 with a named reason and no report, unlike a no-plan finding", () => {
  for (const threshold of [[], ["--max-piece-chars", "1"]]) {
    const outcome = inspect([
      "--plan",
      "unbuildable-plan.json",
      "--max-serialized-chars-per-group",
      "100",
      ...threshold,
      "--json",
      "unbuildable.json",
    ]);
    expect(outcome.status).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("could not construct the planned call layout");
    expect(outcome.stderr).toContain('group "home"');
    expect(outcome.stderr).toContain('property "details"');
    expect(outcome.stderr).toContain("maxSerializedCharsPerGroup");
    expect(outcome.stderr).toContain("100");
  }

  const noPlan = inspect([
    "--max-serialized-chars-per-group",
    "100",
    "--max-piece-chars",
    "1",
    "--json",
    "unbuildable.json",
  ]);
  expect(noPlan.status).toBe(0);
  const report = reportOf(noPlan);
  expect(report.refusal?.stage).toBe("split");
  expect(pieceThreshold(report)).toMatchObject({
    layout: "rule-based",
    measured: null,
    breached: false,
  });
});

test("piece-character thresholds select only the planned packed calls while depth stays uninvolved", () => {
  const nestedRule = reportOf(inspect(["--json", "nested.json"]));
  const nestedPlanned = reportOf(inspect(["--json", "--plan", "split-plan.json", "nested.json"]));
  const ruleChars = nestedRule.worstPiece!.serializedChars;
  const plannedChars = worstPackedCall(nestedPlanned).serializedChars;
  expect(ruleChars).toBeGreaterThan(plannedChars);

  const packedOnlyArgs = ["--max-serialized-chars-per-group", "1400", "packed-only.json"];
  const packedOnlyRule = reportOf(inspect(["--json", ...packedOnlyArgs]));
  const packedOnlyPlanned = reportOf(
    inspect(["--json", "--plan", "packed-only-plan.json", ...packedOnlyArgs]),
  );
  const packedOnlyRuleChars = packedOnlyRule.worstPiece!.serializedChars;
  const packedOnlyPlannedChars = worstPackedCall(packedOnlyPlanned).serializedChars;
  expect(packedOnlyPlannedChars).toBeGreaterThan(packedOnlyRuleChars);

  const bothLimit = Math.min(ruleChars, plannedChars) - 1;
  const neitherLimit = Math.max(ruleChars, plannedChars);
  const cases = [
    {
      name: "no-plan rule-based breach",
      args: ["--max-piece-chars", `${plannedChars}`, "nested.json"],
      status: 1,
      planned: false,
    },
    {
      name: "with-plan rule-based-only breach",
      args: ["--plan", "split-plan.json", "--max-piece-chars", `${plannedChars}`, "nested.json"],
      status: 0,
      planned: true,
    },
    {
      name: "planned-only breach",
      args: [
        "--plan",
        "packed-only-plan.json",
        "--max-piece-chars",
        `${packedOnlyRuleChars}`,
        ...packedOnlyArgs,
      ],
      status: 1,
      planned: true,
    },
    {
      name: "both-layout breach",
      args: ["--plan", "split-plan.json", "--max-piece-chars", `${bothLimit}`, "nested.json"],
      status: 1,
      planned: true,
    },
    {
      name: "neither breach",
      args: ["--plan", "split-plan.json", "--max-piece-chars", `${neitherLimit}`, "nested.json"],
      status: 0,
      planned: true,
    },
  ];

  const reports: SchemaInspectReport[] = [];
  for (const entry of cases) {
    const outcome = inspect(["--json", ...entry.args]);
    expect(outcome.status, entry.name).toBe(entry.status);
    const report = reportOf(outcome);
    reports.push(report);
    expect(report.whole).toBeDefined();
    expect(report.thresholds?.some((row) => row.measure === "depth")).toBe(false);
    expect(report.planned !== undefined).toBe(entry.planned);
    const row = pieceThreshold(report);
    expect(row.layout).toBe(entry.planned ? "planned" : "rule-based");
    expect(row.breached).toBe(entry.status === 1);
    if (entry.status === 1) {
      expect(outcome.stderr).toContain("pieceChars");
      expect(outcome.stderr).toContain(row.piece!);
    }
  }
  expect(reports.map((report) => pieceThreshold(report).breached)).toEqual([
    true,
    false,
    true,
    true,
    false,
  ]);

  const plannedOnlyControl = inspect([
    "--json",
    "--max-piece-chars",
    `${packedOnlyRuleChars}`,
    ...packedOnlyArgs,
  ]);
  expect(plannedOnlyControl.status).toBe(0);
  expect(pieceThreshold(reportOf(plannedOnlyControl)).breached).toBe(false);
  const bothControl = inspect(["--json", "--max-piece-chars", `${bothLimit}`, "nested.json"]);
  expect(bothControl.status).toBe(1);
  expect(pieceThreshold(reportOf(bothControl)).layout).toBe("rule-based");
  const neitherControl = inspect(["--json", "--max-piece-chars", `${neitherLimit}`, "nested.json"]);
  expect(neitherControl.status).toBe(0);
  expect(pieceThreshold(reportOf(neitherControl)).layout).toBe("rule-based");

  const plannedReport = reports[2]!;
  const worst = worstPackedCall(plannedReport);
  const expectedLabel =
    worst.callCount === 1
      ? worst.semantic
      : `${worst.semantic} — call ${worst.callIndex} of ${worst.callCount}`;
  expect(pieceThreshold(plannedReport).piece).toBe(expectedLabel);
  const human = inspect(cases[2]!.args);
  expect(human.status).toBe(1);
  expect(human.stdout).toContain(worst.requestName);
  expect(human.stdout).toContain(expectedLabel);
  expect(human.stderr).toContain(`piece ${expectedLabel}`);
});

test("compliant packed calls from an oversized semantic piece do not inherit its breach", () => {
  const args = [
    "--plan",
    "whole-plan.json",
    "--max-serialized-chars-per-group",
    "1600",
    "nested.json",
  ];
  const baseline = reportOf(inspect(["--json", ...args]));
  const semantic = baseline.planned!.semanticPieces[0]!;
  const worst = worstPackedCall(baseline);
  expect(semantic.packedCount).toBeGreaterThan(1);
  expect(semantic.serializedChars).toBeGreaterThan(worst.serializedChars);
  expect(baseline.planned!.packedCalls.every((call) => call.serializedChars <= 1600)).toBe(true);

  const outcome = inspect(["--json", "--max-piece-chars", `${worst.serializedChars}`, ...args]);
  expect(outcome.status).toBe(0);
  const report = reportOf(outcome);
  expect(pieceThreshold(report)).toMatchObject({
    layout: "planned",
    measured: worst.serializedChars,
    breached: false,
  });
});

test("a shared-depth breach exits 1 with a complete report both without and with a plan", () => {
  const baseline = reportOf(inspect(["--json", "nested.json"]));
  const limit = baseline.whole!.depth - 1;
  for (const plan of [[], ["--plan", "split-plan.json"]]) {
    const outcome = inspect(["--json", ...plan, "--max-depth", `${limit}`, "nested.json"]);
    expect(outcome.status).toBe(1);
    const report = reportOf(outcome);
    expect(report.thresholds).toEqual([
      {
        measure: "depth",
        layout: "shared",
        limit,
        measured: baseline.whole!.depth,
        breached: true,
      },
    ]);
    expect(outcome.stderr).toContain("depth");
  }
});

test("inspect help names both piece-character layouts, shared depth and unchanged exit codes", () => {
  const help = inspect(["--help"]);
  expect(help.status).toBe(0);
  const wrapped = help.stdout.replace(/\s+/gu, " ");
  expect(wrapped).toContain("--plan <path>");
  expect(wrapped).toContain(
    "threshold on the worst rule-based piece without --plan, or the worst actual planned packed call with --plan",
  );
  expect(wrapped).toContain(
    "threshold on the whole schema's nesting depth, shared by rule-based and planned layouts",
  );
  expect(wrapped).toContain(
    "--max-piece-chars judges the worst rule-based piece without --plan, and only the planned packed calls with --plan.",
  );
  expect(wrapped).toContain(
    "--max-depth always judges the whole schema's shared depth, with or without --plan.",
  );
  for (const line of [
    "  0  the report was computed and no supplied threshold was breached (a refusal is a finding, not a failure)",
    "  1  the report was computed, and a supplied threshold was breached — the full report is still on stdout",
    "  2  the command could not run: unreadable file, empty input, malformed JSON, not a JSON Schema document,",
    "     an unconvertible document, a refused draft-2020-12-form document, or a usage error",
  ]) {
    expect(help.stdout).toContain(line);
  }
});
