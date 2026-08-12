# Extraction Accuracy Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every acceptance-gate run as a committed artifact and render it on the docs site, so extraction accuracy is visible to an engineer mid-prompt-change and to a stakeholder asking "is this good enough yet".

**Architecture:** The manual gate gains one call — it hands its 14 scored reports to a pure `buildRunRecord()` densifier, which produces a self-contained `RunRecord` (aggregates + a 51×14 verdict grid), and a `RunStore` writes that record to `acceptance/runs/` as an overwritten `current-*.json` plus an appended `history-*.jsonl`. A VitePress data loader reads the same store at docs-build time and a Vue component renders headline / trend / drill-down.

**Tech Stack:** TypeScript (ESM-only), zod 4.4.3, Vitest 4 (`unit` project, node environment), VitePress + Vue 3, Node >= 24, pnpm 10.34.5.

**Design doc:** [`extraction-accuracy-report-design.md`](./extraction-accuracy-report-design.md)

## Global Constraints

Everything in [`AGENTS.md`](../../../AGENTS.md) applies, plus:

- **Do not break `./check.sh`.** It is the one "am I done?" signal. Run it before every commit that touches package code.
- **Never edit `spikes/extraction-snuggpro/score.mjs` or `ground-truth.mjs`.** They are imported read-only so the gate grades exactly as the spike does.
- **Never put `node:*` imports under `packages/ribo-adapter-snuggpro/src/`.** That directory compiles into the published, browser-targeted `dist/`. This is the defect commit `deceacd` fixed by moving `cliChat` out of `@azx/ribo-extractor-openai`.
- **New acceptance test files must be named `*.test.ts` and sit FLAT in `acceptance/`.** The root vitest `unit` project's glob is `packages/ribo-adapter-snuggpro/acceptance/*.test.{ts,tsx}` — one level, not `**`. A file in a subdirectory silently never runs.
- **`*.manual.ts` is the manual-only naming convention.** `vitest.acceptance.config.ts` includes `packages/ribo-adapter-snuggpro/acceptance/**/*.manual.ts` and nothing else.
- **ESM-only, `import type` for type-only imports, zod at trust boundaries, Prettier-formatted** (100 columns, double quotes, semicolons, trailing commas). Run `pnpm format` — never hand-format.
- **No new dependencies.** zod, Vitest, VitePress and Vue are all already present. Adding a catalog entry would be a deliberate decision under AGENTS §5.4 and is out of scope here.
- **`docs:build` stays out of `./check.sh`.**

---

## File Structure

| File                                                                 | Status           | Responsibility                                                        |
| -------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `packages/ribo-adapter-snuggpro/tsconfig.json`                       | Modify           | Becomes a solution config referencing the two below                   |
| `packages/ribo-adapter-snuggpro/tsconfig.src.json`                   | Create           | The browser library source (`src/`) — unchanged options, new filename |
| `packages/ribo-adapter-snuggpro/tsconfig.acceptance.json`            | Create           | Node-run acceptance TS files. `types: ["node"]`, explicit file list   |
| `packages/ribo-adapter-snuggpro/acceptance/run-record.ts`            | Create           | zod schemas + inferred types for `RunRecord`, `HistoryEntry`, `Cell`  |
| `packages/ribo-adapter-snuggpro/acceptance/run-record.test.ts`       | Create           | Schema accept/reject tests                                            |
| `packages/ribo-adapter-snuggpro/acceptance/build-run-record.ts`      | Create           | Pure densifier: scored reports + GT statuses → `RunRecord`            |
| `packages/ribo-adapter-snuggpro/acceptance/build-run-record.test.ts` | Create           | Verdict-precedence and grid-completeness tests                        |
| `packages/ribo-adapter-snuggpro/acceptance/run-store.ts`             | Create           | The CRUD interface over `runs/`                                       |
| `packages/ribo-adapter-snuggpro/acceptance/run-store.test.ts`        | Create           | Round-trip, delete, prune, crash-safety tests                         |
| `packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts`           | Modify           | Build the record and save it, before the assertions                   |
| `packages/ribo-adapter-snuggpro/acceptance/runs/`                    | Create           | Data only. Committed                                                  |
| `docs/deep-dives/accuracy.data.ts`                                   | Create           | VitePress `defineLoader` over the store                               |
| `docs/deep-dives/accuracy.md`                                        | Create           | The page                                                              |
| `docs/.vitepress/theme/components/AccuracyReport.vue`                | Create           | Headline + trend + drill-down                                         |
| `docs/.vitepress/theme/index.ts`                                     | Create or Modify | Register the component                                                |
| `docs/.vitepress/config.ts`                                          | Modify           | Sidebar/nav entry                                                     |

**Why `buildRunRecord` is pure and takes plain data.** `gate.manual.ts` imports untyped `.mjs` spike modules, which is why `acceptance/` is not typechecked today. Task 1 turns typechecking on for the acceptance files that _do not_ import `.mjs` and deliberately leaves `gate.manual.ts` out. That forces the densifier to receive already-loaded reports as parameters instead of importing `score.mjs` — which is also what makes it unit-testable with fixtures and no inference.

---

### Task 1: Typecheck the acceptance directory

Today `packages/ribo-adapter-snuggpro/tsconfig.json` is `{"extends": "@azx/tsconfig/browser-library.json", "include": ["src"]}`, so `cli-chat.ts` and `gate.manual.ts` have never been typechecked. The new store, schemas and densifier need that safety net. This mirrors the playground's three-tsconfig pattern exactly (AGENTS §5.3): a solution config with `files: []`, leaf projects with `composite: true`, and `tsc -b --force` so a stale `.tsbuildinfo` can never report a false pass.

**Files:**

- Create: `packages/ribo-adapter-snuggpro/tsconfig.src.json`
- Create: `packages/ribo-adapter-snuggpro/tsconfig.acceptance.json`
- Modify: `packages/ribo-adapter-snuggpro/tsconfig.json`
- Modify: `packages/ribo-adapter-snuggpro/package.json` (the `typecheck` script)

**Interfaces:**

- Consumes: nothing.
- Produces: a `typecheck` script that covers `acceptance/cli-chat.ts` and every file added in Tasks 2–4.

- [ ] **Step 1: Create the source project config**

`packages/ribo-adapter-snuggpro/tsconfig.src.json`:

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@azx/tsconfig/browser-library.json",
  "compilerOptions": {
    // Required so the solution config can reference this project.
    "composite": true,
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.src.tsbuildinfo",
  },
  // Published, browser-targeted library code. Deliberately no `"types": ["node"]`
  // — nothing under src/ may reach for Node built-ins, because everything here
  // compiles into dist/.
  "include": ["src"],
}
```

- [ ] **Step 2: Create the acceptance project config**

`packages/ribo-adapter-snuggpro/tsconfig.acceptance.json`:

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@azx/tsconfig/browser-library.json",
  "compilerOptions": {
    "composite": true,
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.acceptance.tsbuildinfo",

    // These files run in Node (node:fs, node:path, node:child_process). The shared
    // base ships no `types` on purpose — @types/node is ambient, so enabling it
    // globally would let shipped browser code reference Node globals and still
    // typecheck. Scoped here, to the Node-run developer harness only, exactly as
    // playground/tsconfig.node.json scopes it to vite.config.ts.
    "types": ["node"],
  },
  // An EXPLICIT file list, not `["acceptance"]`. `gate.manual.ts` is deliberately
  // absent: it imports the spike's untyped `.mjs` modules (score.mjs,
  // ground-truth.mjs), which have no declarations and which we must never edit.
  // Listing files individually keeps that exclusion visible instead of hiding it
  // in an `exclude` block — and it is the constraint that keeps buildRunRecord a
  // pure function over plain data rather than an importer of the scorer.
  "include": [
    "acceptance/cli-chat.ts",
    "acceptance/run-record.ts",
    "acceptance/build-run-record.ts",
    "acceptance/run-store.ts",
    "acceptance/*.test.ts",
  ],
}
```

- [ ] **Step 3: Turn the package tsconfig into a solution config**

Replace the whole of `packages/ribo-adapter-snuggpro/tsconfig.json` with:

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  // Solution-style config: no files of its own. `src/` is published browser code
  // and `acceptance/` is a Node-run developer harness; they need different
  // `types`, so they cannot share one project. `tsc -b` checks both.
  "files": [],
  "references": [{ "path": "./tsconfig.src.json" }, { "path": "./tsconfig.acceptance.json" }],
}
```

- [ ] **Step 4: Point the typecheck script at build mode, and declare `@types/node`**

In `packages/ribo-adapter-snuggpro/package.json`, change the `typecheck` script:

```jsonc
"typecheck": "tsc -b --force",
```

`tsc --noEmit` against a solution config with `files: []` checks **nothing and exits 0** — a green typecheck that verified zero files. `-b` follows the references; `--force` skips the incremental cache. Same reasoning as AGENTS §5.3.

In the same file, add `@types/node` to `devDependencies`, in alphabetical position (after `@azx/tsconfig`, before `ajv`):

```jsonc
"@types/node": "catalog:",
```

`tsconfig.acceptance.json` sets `"types": ["node"]`, which fails with `TS2688: Cannot find type definition file for 'node'` unless the package itself declares it. The catalog already pins it at `24.13.3` (held back deliberately — AGENTS §5.4), so this uses the existing entry and adds no new one. Then run `pnpm install`.

Verified: this does **not** leak Node globals into `src/`. `tsconfig.src.json` sets no `types`, but a `process.cwd()` added to `src/context.ts` still fails with `TS2591: Cannot find name 'process'`. The seal AGENTS §5.3 describes holds.

- [ ] **Step 4b: Point tsdown at the source project**

In `packages/ribo-adapter-snuggpro/tsdown.config.ts`, add one line to the config object:

```ts
tsconfig: "tsconfig.src.json",
```

**This is required, not optional.** tsdown's dts plugin reads `tsconfig.json`, and the `references` field added in Step 3 makes it fail outright:

```
Unable to load src/index.ts; You have "references" in your tsconfig file
```

so `pnpm build:packages` — and therefore `./check.sh` — cannot pass without it. Verified by removing the line and watching the build fail, then restoring it and watching it succeed.

- [ ] **Step 5: Verify it now checks acceptance files, by breaking one on purpose**

Add a deliberate type error to `acceptance/cli-chat.ts` — e.g. insert `const proof: number = "not a number";` as the first line of the file body.

Run: `pnpm --filter @azx/ribo-adapter-snuggpro typecheck`
Expected: FAIL, naming `acceptance/cli-chat.ts` and `Type 'string' is not assignable to type 'number'`.

A gate that has never failed is not known to work. If this passes, the include list or the references are wrong — fix before continuing.

- [ ] **Step 6: Remove the deliberate error and confirm green**

Delete the `const proof` line.

Run: `pnpm --filter @azx/ribo-adapter-snuggpro typecheck`
Expected: PASS, no output.

- [ ] **Step 7: Confirm the whole gate is still green**

Run: `./check.sh`
Expected: PASS, every stage — including `build:packages`, which Step 4b is what makes possible.

- [ ] **Step 8: Commit**

```bash
git add packages/ribo-adapter-snuggpro/tsconfig.json \
        packages/ribo-adapter-snuggpro/tsconfig.src.json \
        packages/ribo-adapter-snuggpro/tsconfig.acceptance.json \
        packages/ribo-adapter-snuggpro/tsdown.config.ts \
        packages/ribo-adapter-snuggpro/package.json \
        pnpm-lock.yaml
git commit -m "Typecheck the snuggpro acceptance harness, which src-only include never reached"
```

---

### Task 2: The run record schemas

**Files:**

- Create: `packages/ribo-adapter-snuggpro/acceptance/run-record.ts`
- Test: `packages/ribo-adapter-snuggpro/acceptance/run-record.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `RunRecordSchema`, `HistoryEntrySchema`, `CellSchema`, `HazardsSchema`, `ShapeConformanceSchema`, `CELL_VERDICTS`, and the inferred types `RunRecord`, `HistoryEntry`, `Cell`, `Hazards`, `ShapeConformance`, `CellVerdict`. Tasks 3, 4 and 6 all import from here.

- [ ] **Step 1: Write the failing test**

`packages/ribo-adapter-snuggpro/acceptance/run-record.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { RunRecord } from "./run-record.js";
import { HistoryEntrySchema, RunRecordSchema } from "./run-record.js";

/** The smallest record that must round-trip: one leaf, one transcript, one cell. */
function minimalRun(): RunRecord {
  return {
    capturedAt: "2026-08-11T12:00:00.000Z",
    schemaFingerprint: `sha256:${"a".repeat(64)}`,
    backend: "codex-cli",
    backendLabel: "codex-cli",
    model: "codex-cli",
    passed: true,
    hallRate: 0.0075,
    missRate: 0.0151,
    hazards: {
      fuelDropped: 0,
      fuelInvented: 0,
      hallucinatedPass: 0,
      rvalueConversion: 0,
      enumWrongMember: 0,
      enumInvalid: 0,
      spanFabricated: 0,
      spanMissing: 0,
    },
    shapeConformance: { applicable: true, firstTry: 12, retried: 1, never: 1 },
    totals: { gtNull: 398, gtNonNull: 134 },
    leafPaths: ["attic.rValue"],
    transcripts: [{ slug: "01-attic-r-value-shell", status: "scored", problem: null }],
    grid: {
      "attic.rValue": {
        "01-attic-r-value-shell": {
          verdict: "correct",
          expected: "38",
          got: "38",
          sourceSpan: "R-38 in the attic",
          spanIssue: null,
          detail: null,
        },
      },
    },
  };
}

describe("RunRecordSchema", () => {
  test("accepts a well-formed record and round-trips through JSON", () => {
    const parsed = RunRecordSchema.parse(JSON.parse(JSON.stringify(minimalRun())));
    expect(parsed.grid["attic.rValue"]?.["01-attic-r-value-shell"]?.verdict).toBe("correct");
  });

  test("rejects an unknown cell verdict rather than letting it render", () => {
    const bad = {
      ...minimalRun(),
      grid: {
        "attic.rValue": {
          "01-attic-r-value-shell": {
            verdict: "probably-fine",
            expected: null,
            got: null,
            sourceSpan: null,
            spanIssue: null,
            detail: null,
          },
        },
      },
    };
    expect(() => RunRecordSchema.parse(bad)).toThrow();
  });

  test("rejects a fingerprint that is not a sha256 hex digest", () => {
    expect(() =>
      RunRecordSchema.parse({ ...minimalRun(), schemaFingerprint: "sha256:xyz" }),
    ).toThrow();
  });

  test("rejects a capturedAt that is not an ISO instant", () => {
    expect(() => RunRecordSchema.parse({ ...minimalRun(), capturedAt: "last tuesday" })).toThrow();
  });
});

describe("HistoryEntrySchema", () => {
  test("a full run record satisfies the history entry shape (history is a strict prefix)", () => {
    expect(() => HistoryEntrySchema.parse(minimalRun())).not.toThrow();
  });

  test("rejects an entry missing its hazard counts", () => {
    expect(() => HistoryEntrySchema.parse({ ...minimalRun(), hazards: undefined })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/ribo-adapter-snuggpro/acceptance/run-record.test.ts`
Expected: FAIL — `Failed to load ./run-record.js` / cannot find module.

- [ ] **Step 3: Write the schemas**

`packages/ribo-adapter-snuggpro/acceptance/run-record.ts`:

```ts
import { z } from "zod";

/**
 * The persisted shape of one extraction-accuracy run. Written by the manual
 * acceptance gate (`gate.manual.ts`), read by the docs site's accuracy page.
 *
 * These are PERSISTED RECORDS crossing a trust boundary — a hand-edited file, a
 * half-written line, or an artifact from an older format — so they are zod-parsed
 * on read, never cast (AGENTS §4). A malformed run must fail loudly at the docs
 * build rather than render as a plausible-looking data point.
 *
 * See docs/roadmap/design/extraction-accuracy-report-design.md.
 */

/**
 * What happened at one (leaf path, transcript) cell.
 *
 * `correct-null` is deliberately distinct from `correct`: a degenerate all-null
 * extraction scores a perfect 0% hallucination rate and is useless, so a grid
 * that painted both the same green would flatter exactly the failure the gate's
 * miss guard exists to catch.
 *
 * There is no `health-silent-not-tested` member even though `score.mjs` counts
 * `hSilentNotTested`: that case increments a counter and pushes NOTHING onto any
 * per-field list, so it cannot be attributed to a cell from the report alone. It
 * lands in `correct-null`, and the aggregate count remains available in `totals`.
 */
export const CELL_VERDICTS = [
  "correct",
  "correct-null",
  "miss",
  "miss-excused",
  "hallucination",
  "hallucination-soft",
  "sanctioned",
  "wrong",
  "unscorable",
  "health-hallucinated-pass",
  "health-hallucinated-problem",
  "health-clean-dropped",
  "health-miss",
  "health-wrong",
] as const;

export const CellVerdictSchema = z.enum(CELL_VERDICTS);

export const CellSchema = z.object({
  verdict: CellVerdictSchema,
  /** Ground truth, stringified for display. `null` when ground truth is null. */
  expected: z.string().nullable(),
  /** What the extractor produced, stringified. `null` when it produced nothing. */
  got: z.string().nullable(),
  sourceSpan: z.string().nullable(),
  /**
   * A span problem, if any — `fabricated`, `fabricated-decline`, `missing` or
   * `near-miss`. Kept SEPARATE from `verdict` because span verbatim-ness is its
   * own axis: a value can be correct and its span fabricated.
   */
  spanIssue: z.string().nullable(),
  detail: z.string().nullable(),
});

export const HazardsSchema = z.object({
  fuelDropped: z.number().int().nonnegative(),
  fuelInvented: z.number().int().nonnegative(),
  hallucinatedPass: z.number().int().nonnegative(),
  rvalueConversion: z.number().int().nonnegative(),
  enumWrongMember: z.number().int().nonnegative(),
  enumInvalid: z.number().int().nonnegative(),
  spanFabricated: z.number().int().nonnegative(),
  spanMissing: z.number().int().nonnegative(),
});

export const ShapeConformanceSchema = z.object({
  /** `false` for the `openai` backend, whose endpoint enforces shape server-side. */
  applicable: z.boolean(),
  firstTry: z.number().int().nonnegative(),
  retried: z.number().int().nonnegative(),
  never: z.number().int().nonnegative(),
});

/**
 * One line of `history-<backend>.jsonl`. Every field here also appears in a
 * RunRecord, so `RunRecordSchema` is a strict extension and `toHistoryEntry`
 * is a projection rather than a translation.
 */
export const HistoryEntrySchema = z.object({
  capturedAt: z.iso.datetime(),
  schemaFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** The backend IDENTITY: `openai:<model>`, `claude-cli`, or `codex-cli`. */
  backend: z.string().min(1),
  /** The filename-safe label: the OpenAI model id, or the backend id. */
  backendLabel: z.string().min(1),
  model: z.string().min(1),
  /** Whether the gate's assertions passed. A failing run is still recorded. */
  passed: z.boolean(),
  hallRate: z.number(),
  missRate: z.number(),
  hazards: HazardsSchema,
  shapeConformance: ShapeConformanceSchema,
});

export const TranscriptColumnSchema = z.object({
  slug: z.string().min(1),
  status: z.enum(["scored", "unscored"]),
  problem: z.string().nullable(),
});

export const RunRecordSchema = HistoryEntrySchema.extend({
  /** Every raw counter from `aggregate()`, kept verbatim for anything not modelled above. */
  totals: z.record(z.string(), z.number()),
  leafPaths: z.array(z.string().min(1)),
  transcripts: z.array(TranscriptColumnSchema),
  /** `grid[leafPath][slug]` — dense: every leaf path × every transcript. */
  grid: z.record(z.string(), z.record(z.string(), CellSchema)),
});

export type CellVerdict = z.infer<typeof CellVerdictSchema>;
export type Cell = z.infer<typeof CellSchema>;
export type Hazards = z.infer<typeof HazardsSchema>;
export type ShapeConformance = z.infer<typeof ShapeConformanceSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type TranscriptColumn = z.infer<typeof TranscriptColumnSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/ribo-adapter-snuggpro/acceptance/run-record.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and format**

Run: `pnpm --filter @azx/ribo-adapter-snuggpro typecheck && pnpm format && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-adapter-snuggpro/acceptance/run-record.ts \
        packages/ribo-adapter-snuggpro/acceptance/run-record.test.ts
git commit -m "Add the persisted run-record schemas for extraction accuracy"
```

---

### Task 3: The densifier

Turns the scorer's _sparse_ problem lists into a _dense_ grid. Pure — no `fs`, no imports from `spikes/`.

**Files:**

- Create: `packages/ribo-adapter-snuggpro/acceptance/build-run-record.ts`
- Test: `packages/ribo-adapter-snuggpro/acceptance/build-run-record.test.ts`

**Interfaces:**

- Consumes: `RunRecord`, `Cell`, `Hazards`, `ShapeConformance` from Task 2.
- Produces: `buildRunRecord(input: BuildRunRecordInput): RunRecord`, `toHistoryEntry(run: RunRecord): HistoryEntry`, and the `ScoreReportLike` / `BuildRunRecordInput` interfaces. Task 5 (the gate) calls both.

- [ ] **Step 1: Write the failing test**

`packages/ribo-adapter-snuggpro/acceptance/build-run-record.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { BuildRunRecordInput, ScoreReportLike } from "./build-run-record.js";
import { buildRunRecord, toHistoryEntry } from "./build-run-record.js";
import { RunRecordSchema } from "./run-record.js";

const LEAVES = ["attic.rValue", "hvac.heatingFuel", "health.coTest"];
const SLUGS = ["01-one", "02-two"];

function emptyReport(slug: string): ScoreReportLike {
  return {
    slug,
    status: "scored",
    problem: null,
    hallucinations: [],
    softAlternatives: [],
    sanctionedRows: [],
    misses: [],
    excused: [],
    wrong: [],
    unscorableRows: [],
    badSpans: [],
    health: [],
  };
}

function input(overrides: Partial<BuildRunRecordInput> = {}): BuildRunRecordInput {
  return {
    capturedAt: "2026-08-11T12:00:00.000Z",
    schemaFingerprint: `sha256:${"a".repeat(64)}`,
    backend: "codex-cli",
    backendLabel: "codex-cli",
    model: "codex-cli",
    passed: true,
    hallRate: 0,
    missRate: 0,
    totals: { gtNull: 4 },
    hazards: {
      fuelDropped: 0,
      fuelInvented: 0,
      hallucinatedPass: 0,
      rvalueConversion: 0,
      enumWrongMember: 0,
      enumInvalid: 0,
      spanFabricated: 0,
      spanMissing: 0,
    },
    shapeConformance: { applicable: true, firstTry: 2, retried: 0, never: 0 },
    leafPaths: LEAVES,
    reports: SLUGS.map(emptyReport),
    assertedLeaves: { "01-one": ["attic.rValue"], "02-two": [] },
    ...overrides,
  };
}

describe("buildRunRecord — the grid is dense", () => {
  test("emits exactly one cell per leaf path per transcript", () => {
    const run = buildRunRecord(input());
    expect(Object.keys(run.grid)).toHaveLength(LEAVES.length);
    for (const leaf of LEAVES) {
      expect(Object.keys(run.grid[leaf] ?? {})).toEqual(SLUGS);
    }
  });

  test("a leaf mentioned in no problem list is correct when ground truth asserted it", () => {
    const run = buildRunRecord(input());
    expect(run.grid["attic.rValue"]?.["01-one"]?.verdict).toBe("correct");
  });

  test("...and correct-null when ground truth was null — the two are never conflated", () => {
    const run = buildRunRecord(input());
    expect(run.grid["attic.rValue"]?.["02-two"]?.verdict).toBe("correct-null");
    expect(run.grid["hvac.heatingFuel"]?.["01-one"]?.verdict).toBe("correct-null");
  });

  test("the output satisfies RunRecordSchema", () => {
    expect(() => RunRecordSchema.parse(buildRunRecord(input()))).not.toThrow();
  });
});

describe("buildRunRecord — verdict attribution", () => {
  test("a hallucination is attributed to its own cell, with value and span", () => {
    const report = emptyReport("01-one");
    report.hallucinations.push({
      field: "hvac.heatingFuel",
      value: "Natural Gas",
      sourceSpan: "the gas furnace",
      confidence: 0.9,
      rvalueConversion: false,
    });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    const cell = run.grid["hvac.heatingFuel"]?.["01-one"];
    expect(cell?.verdict).toBe("hallucination");
    expect(cell?.got).toBe("Natural Gas");
    expect(cell?.sourceSpan).toBe("the gas furnace");
  });

  test("a miss carries what was expected", () => {
    const report = emptyReport("01-one");
    report.misses.push({ field: "attic.rValue", expected: 38, span: "R-38 up there" });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    const cell = run.grid["attic.rValue"]?.["01-one"];
    expect(cell?.verdict).toBe("miss");
    expect(cell?.expected).toBe("38");
    expect(cell?.got).toBeNull();
  });

  test("a wrong value carries both sides and the scorer's detail", () => {
    const report = emptyReport("01-one");
    report.wrong.push({
      field: "attic.rValue",
      expected: 38,
      got: 30,
      tag: "numeric",
      detail: "off by 8",
    });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    const cell = run.grid["attic.rValue"]?.["01-one"];
    expect(cell?.verdict).toBe("wrong");
    expect(cell?.expected).toBe("38");
    expect(cell?.got).toBe("30");
    expect(cell?.detail).toBe("off by 8");
  });

  test("a health row maps onto its own verdict namespace", () => {
    const report = emptyReport("01-one");
    report.health.push({
      test: "health.coTest",
      gt: null,
      got: "Passed",
      category: "hallucinatedPass",
    });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    expect(run.grid["health.coTest"]?.["01-one"]?.verdict).toBe("health-hallucinated-pass");
  });

  test("a span problem is recorded WITHOUT overriding the content verdict", () => {
    const report = emptyReport("01-one");
    report.badSpans.push({
      field: "attic.rValue",
      value: 38,
      span: "invented quote",
      status: "fabricated",
      detail: "not present in transcript",
    });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    const cell = run.grid["attic.rValue"]?.["01-one"];
    expect(cell?.verdict).toBe("correct");
    expect(cell?.spanIssue).toBe("fabricated");
  });

  test("an unscored transcript is marked as such and its problem preserved", () => {
    const report: ScoreReportLike = {
      ...emptyReport("02-two"),
      status: "unscored",
      problem: "cliChat: never conformed after 3 attempts",
    };
    const run = buildRunRecord(input({ reports: [emptyReport("01-one"), report] }));
    const column = run.transcripts.find((t) => t.slug === "02-two");
    expect(column?.status).toBe("unscored");
    expect(column?.problem).toBe("cliChat: never conformed after 3 attempts");
  });
});

describe("toHistoryEntry", () => {
  test("projects the record's summary fields and drops the grid", () => {
    const entry = toHistoryEntry(buildRunRecord(input()));
    expect(entry.backend).toBe("codex-cli");
    expect(entry.hazards.fuelDropped).toBe(0);
    expect(entry).not.toHaveProperty("grid");
    expect(entry).not.toHaveProperty("leafPaths");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/ribo-adapter-snuggpro/acceptance/build-run-record.test.ts`
Expected: FAIL — cannot find module `./build-run-record.js`.

- [ ] **Step 3: Write the densifier**

`packages/ribo-adapter-snuggpro/acceptance/build-run-record.ts`:

```ts
import type {
  Cell,
  CellVerdict,
  Hazards,
  HistoryEntry,
  RunRecord,
  ShapeConformance,
} from "./run-record.js";
import { HistoryEntrySchema } from "./run-record.js";

/**
 * Densifies the acceptance gate's scored reports into a self-contained RunRecord.
 *
 * PURE, and deliberately imports NOTHING from `spikes/`. Two reasons, both
 * load-bearing:
 *
 *   1. `score.mjs` and `ground-truth.mjs` are untyped `.mjs` and must never be
 *      edited. `tsconfig.acceptance.json` therefore excludes `gate.manual.ts`
 *      (the only file that imports them). Keeping this module free of those
 *      imports is what lets it be typechecked at all.
 *   2. A pure function over plain data is unit-testable with fixtures, with no
 *      inference, no corpus and no network — so it runs in `./check.sh` while
 *      the gate that feeds it stays manual.
 *
 * See docs/roadmap/design/extraction-accuracy-report-design.md §3.
 */

/**
 * The subset of `score.mjs`'s per-transcript report this module reads. Declared
 * structurally rather than imported, per the note above. Every list is keyed by
 * leaf path (`field`, or `test` for health rows).
 */
export interface ScoreReportLike {
  slug: string;
  status: string;
  problem: string | null;
  hallucinations: Array<{
    field: string;
    value: unknown;
    confidence?: number | null;
    sourceSpan?: string | null;
    rvalueConversion?: boolean;
  }>;
  softAlternatives: Array<{ field: string; value: unknown; note?: string }>;
  sanctionedRows: Array<{ field: string; value: unknown; note?: string }>;
  misses: Array<{ field: string; expected: unknown; span?: string | null }>;
  excused: Array<{ field: string; note?: string }>;
  wrong: Array<{
    field: string;
    expected: unknown;
    got: unknown;
    tag?: string | null;
    detail?: string | null;
  }>;
  unscorableRows: Array<{ field: string; got: unknown; detail?: string | null }>;
  badSpans: Array<{
    field: string;
    value: unknown;
    span?: string | null;
    status: string;
    detail?: string | null;
  }>;
  health: Array<{ test: string; gt: string | null; got: unknown; category: string }>;
}

export interface BuildRunRecordInput {
  capturedAt: string;
  schemaFingerprint: string;
  backend: string;
  backendLabel: string;
  model: string;
  passed: boolean;
  hallRate: number;
  missRate: number;
  totals: Record<string, number>;
  hazards: Hazards;
  shapeConformance: ShapeConformance;
  /** Every leaf path in the schema, generic and health alike, in display order. */
  leafPaths: string[];
  reports: ScoreReportLike[];
  /**
   * Per transcript slug, the leaf paths whose ground truth `status` is
   * `"asserted"`. This is the ONLY thing that separates `correct` from
   * `correct-null`, and the gate is the only place with the raw ground truth in
   * hand — hence a parameter rather than a lookup.
   */
  assertedLeaves: Record<string, string[]>;
}

/** `null`/`undefined` stay null; everything else becomes a display string. */
function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

const HEALTH_VERDICTS: Record<string, CellVerdict> = {
  hallucinatedPass: "health-hallucinated-pass",
  hallucinatedProblem: "health-hallucinated-problem",
  cleanDropped: "health-clean-dropped",
  miss: "health-miss",
};

function emptyCell(): Cell {
  return {
    verdict: "correct",
    expected: null,
    got: null,
    sourceSpan: null,
    spanIssue: null,
    detail: null,
  };
}

/**
 * Build one transcript's column. Precedence matters: a leaf can legitimately
 * appear in more than one list (a health row is also a miss; a sanctioned row is
 * also a near-match), and the FIRST assignment wins. Health rows are applied
 * first because they carry the more specific vocabulary.
 */
function cellsForReport(
  report: ScoreReportLike,
  leafPaths: string[],
  asserted: Set<string>,
): Record<string, Cell> {
  const cells: Record<string, Cell> = {};
  for (const path of leafPaths) cells[path] = emptyCell();

  const claimed = new Set<string>();
  const claim = (path: string, patch: Partial<Cell> & { verdict: CellVerdict }): void => {
    const cell = cells[path];
    if (cell === undefined || claimed.has(path)) return; // unknown leaf, or already decided
    claimed.add(path);
    Object.assign(cell, patch);
  };

  for (const row of report.health) {
    claim(row.test, {
      verdict: HEALTH_VERDICTS[row.category] ?? "health-wrong",
      expected: show(row.gt),
      got: show(row.got),
    });
  }
  for (const row of report.hallucinations) {
    claim(row.field, {
      verdict: "hallucination",
      got: show(row.value),
      sourceSpan: row.sourceSpan ?? null,
      detail: row.rvalueConversion === true ? "R-value converted to a band" : null,
    });
  }
  for (const row of report.softAlternatives) {
    claim(row.field, {
      verdict: "hallucination-soft",
      got: show(row.value),
      detail: row.note ?? null,
    });
  }
  for (const row of report.sanctionedRows) {
    claim(row.field, { verdict: "sanctioned", got: show(row.value), detail: row.note ?? null });
  }
  for (const row of report.misses) {
    claim(row.field, {
      verdict: "miss",
      expected: show(row.expected),
      sourceSpan: row.span ?? null,
    });
  }
  for (const row of report.excused) {
    claim(row.field, { verdict: "miss-excused", detail: row.note ?? null });
  }
  for (const row of report.wrong) {
    claim(row.field, {
      verdict: "wrong",
      expected: show(row.expected),
      got: show(row.got),
      detail: row.detail ?? row.tag ?? null,
    });
  }
  for (const row of report.unscorableRows) {
    claim(row.field, { verdict: "unscorable", got: show(row.got), detail: row.detail ?? null });
  }

  // Everything unclaimed was neither a problem nor an omission: it is correct.
  // Ground truth decides WHICH kind of correct, and the distinction is the whole
  // reason `assertedLeaves` is threaded through — see the design doc §3.
  for (const path of leafPaths) {
    if (claimed.has(path)) continue;
    const cell = cells[path];
    if (cell !== undefined) cell.verdict = asserted.has(path) ? "correct" : "correct-null";
  }

  // Span problems are a SEPARATE axis and never overwrite a content verdict: a
  // value can be right and its quote fabricated. Applied last, to every cell,
  // claimed or not.
  for (const row of report.badSpans) {
    const cell = cells[row.field];
    if (cell === undefined) continue;
    cell.spanIssue = row.status;
    if (cell.sourceSpan === null) cell.sourceSpan = row.span ?? null;
    if (cell.detail === null) cell.detail = row.detail ?? null;
  }

  return cells;
}

export function buildRunRecord(input: BuildRunRecordInput): RunRecord {
  const grid: Record<string, Record<string, Cell>> = {};
  for (const path of input.leafPaths) grid[path] = {};

  for (const report of input.reports) {
    const asserted = new Set(input.assertedLeaves[report.slug] ?? []);
    const cells = cellsForReport(report, input.leafPaths, asserted);
    for (const path of input.leafPaths) {
      const column = grid[path];
      const cell = cells[path];
      if (column !== undefined && cell !== undefined) column[report.slug] = cell;
    }
  }

  return {
    capturedAt: input.capturedAt,
    schemaFingerprint: input.schemaFingerprint,
    backend: input.backend,
    backendLabel: input.backendLabel,
    model: input.model,
    passed: input.passed,
    hallRate: input.hallRate,
    missRate: input.missRate,
    hazards: input.hazards,
    shapeConformance: input.shapeConformance,
    totals: input.totals,
    leafPaths: [...input.leafPaths],
    transcripts: input.reports.map((r) => ({
      slug: r.slug,
      status: r.status === "scored" ? "scored" : "unscored",
      problem: r.problem,
    })),
    grid,
  };
}

/**
 * Projects a run down to the one line appended to `history-<backend>.jsonl`.
 * Uses the schema's own key list rather than a hand-written pick, so a field
 * added to HistoryEntrySchema cannot be silently forgotten here.
 */
export function toHistoryEntry(run: RunRecord): HistoryEntry {
  return HistoryEntrySchema.parse(run);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/ribo-adapter-snuggpro/acceptance/build-run-record.test.ts`
Expected: PASS, 11 tests.

Note on `toHistoryEntry`: zod strips unknown keys by default, so parsing a full `RunRecord` through `HistoryEntrySchema` returns only the history fields. That is what makes the `not.toHaveProperty("grid")` assertion pass, and it is why the projection cannot drift from the schema.

- [ ] **Step 5: Typecheck, lint, format**

Run: `pnpm --filter @azx/ribo-adapter-snuggpro typecheck && pnpm format && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-adapter-snuggpro/acceptance/build-run-record.ts \
        packages/ribo-adapter-snuggpro/acceptance/build-run-record.test.ts
git commit -m "Densify scored reports into a self-contained accuracy run record"
```

---

### Task 4: The run store

**Files:**

- Create: `packages/ribo-adapter-snuggpro/acceptance/run-store.ts`
- Test: `packages/ribo-adapter-snuggpro/acceptance/run-store.test.ts`

**Interfaces:**

- Consumes: `RunRecord`, `HistoryEntry`, `RunRecordSchema`, `HistoryEntrySchema` (Task 2); `toHistoryEntry` (Task 3).
- Produces: `openRunStore(opts?: { dir?: string }): RunStore` and the `RunStore` interface. Tasks 5 and 6 both call it.

- [ ] **Step 1: Write the failing test**

`packages/ribo-adapter-snuggpro/acceptance/run-store.test.ts`:

```ts
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { RunRecord } from "./run-record.js";
import { openRunStore } from "./run-store.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ribo-runs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    capturedAt: "2026-08-11T12:00:00.000Z",
    schemaFingerprint: `sha256:${"a".repeat(64)}`,
    backend: "codex-cli",
    backendLabel: "codex-cli",
    model: "codex-cli",
    passed: true,
    hallRate: 0.01,
    missRate: 0.02,
    hazards: {
      fuelDropped: 0,
      fuelInvented: 0,
      hallucinatedPass: 0,
      rvalueConversion: 0,
      enumWrongMember: 0,
      enumInvalid: 0,
      spanFabricated: 0,
      spanMissing: 0,
    },
    shapeConformance: { applicable: true, firstTry: 1, retried: 0, never: 0 },
    totals: { gtNull: 1 },
    leafPaths: ["attic.rValue"],
    transcripts: [{ slug: "01-one", status: "scored", problem: null }],
    grid: {
      "attic.rValue": {
        "01-one": {
          verdict: "correct",
          expected: "38",
          got: "38",
          sourceSpan: null,
          spanIssue: null,
          detail: null,
        },
      },
    },
    ...overrides,
  };
}

describe("openRunStore — create, read, update", () => {
  test("saveRun then readCurrent round-trips the full grid", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    const read = await store.readCurrent("codex-cli");
    expect(read?.grid["attic.rValue"]?.["01-one"]?.expected).toBe("38");
  });

  test("readCurrent returns null for a backend that has never run", async () => {
    expect(await openRunStore({ dir }).readCurrent("codex-cli")).toBeNull();
  });

  test("a second run OVERWRITES current but APPENDS to history", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    await store.saveRun(run({ capturedAt: "2026-08-12T12:00:00.000Z", hallRate: 0.05 }));

    expect((await store.readCurrent("codex-cli"))?.hallRate).toBe(0.05);
    const history = await store.readHistory("codex-cli");
    expect(history.map((h) => h.hallRate)).toEqual([0.01, 0.05]);
    expect(readdirSync(dir).filter((f) => f.startsWith("current-"))).toHaveLength(1);
  });

  test("history lines carry no grid — they are the small, appendable projection", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    const line = readFileSync(join(dir, "history-codex-cli.jsonl"), "utf8").trim();
    expect(JSON.parse(line)).not.toHaveProperty("grid");
    expect(line).not.toContain("\n");
  });

  test("listBackends reports every backend with a current run", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    await store.saveRun(run({ backend: "openai:gpt-4o", backendLabel: "gpt-4o", model: "gpt-4o" }));
    expect((await store.listBackends()).sort()).toEqual(["codex-cli", "gpt-4o"]);
  });
});

describe("openRunStore — the trust boundary", () => {
  test("a malformed history line throws, naming the file and the line number", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    writeFileSync(join(dir, "history-codex-cli.jsonl"), '{"capturedAt":"nope"}\n', { flag: "a" });
    await expect(store.readHistory("codex-cli")).rejects.toThrow(
      /history-codex-cli\.jsonl.*line 2/s,
    );
  });

  test("a corrupt current file throws rather than returning a partial record", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    writeFileSync(join(dir, "current-codex-cli.json"), "{ not json");
    await expect(store.readCurrent("codex-cli")).rejects.toThrow(/current-codex-cli\.json/);
  });

  test("blank lines in history are skipped, not treated as corruption", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    writeFileSync(join(dir, "history-codex-cli.jsonl"), "\n\n", { flag: "a" });
    expect(await store.readHistory("codex-cli")).toHaveLength(1);
  });
});

describe("openRunStore — delete", () => {
  test("deleteHistoryEntry removes one point by capturedAt and leaves neighbours", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run({ capturedAt: "2026-08-11T12:00:00.000Z" }));
    await store.saveRun(run({ capturedAt: "2026-08-12T12:00:00.000Z" }));
    await store.saveRun(run({ capturedAt: "2026-08-13T12:00:00.000Z" }));

    await store.deleteHistoryEntry("codex-cli", "2026-08-12T12:00:00.000Z");

    expect((await store.readHistory("codex-cli")).map((h) => h.capturedAt)).toEqual([
      "2026-08-11T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
    ]);
  });

  test("pruneHistory keeps the newest N", async () => {
    const store = openRunStore({ dir });
    for (const day of ["11", "12", "13"]) {
      await store.saveRun(run({ capturedAt: `2026-08-${day}T12:00:00.000Z` }));
    }
    await store.pruneHistory("codex-cli", { keep: 2 });
    expect((await store.readHistory("codex-cli")).map((h) => h.capturedAt)).toEqual([
      "2026-08-12T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
    ]);
  });

  test("deleteRun removes BOTH files, retiring the backend entirely", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    await store.deleteRun("codex-cli");

    expect(await store.readCurrent("codex-cli")).toBeNull();
    expect(await store.readHistory("codex-cli")).toEqual([]);
    expect(await store.listBackends()).toEqual([]);
  });

  test("deleting from a backend that never ran is a no-op, not a crash", async () => {
    const store = openRunStore({ dir });
    await expect(store.deleteRun("codex-cli")).resolves.toBeUndefined();
    await expect(
      store.deleteHistoryEntry("codex-cli", "2026-08-11T12:00:00.000Z"),
    ).resolves.toBeUndefined();
  });
});

describe("openRunStore — durability", () => {
  test("no temp file survives a completed save", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(run());
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("a backend label with path-unsafe characters is sanitised into the filename", async () => {
    const store = openRunStore({ dir });
    await store.saveRun(
      run({ backendLabel: "gpt-4o/2024-08-06", backend: "openai:gpt-4o/2024-08-06" }),
    );
    expect(readdirSync(dir)).toContain("current-gpt-4o_2024-08-06.json");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/ribo-adapter-snuggpro/acceptance/run-store.test.ts`
Expected: FAIL — cannot find module `./run-store.js`.

- [ ] **Step 3: Write the store**

`packages/ribo-adapter-snuggpro/acceptance/run-store.ts`:

```ts
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { toHistoryEntry } from "./build-run-record.js";
import type { HistoryEntry, RunRecord } from "./run-record.js";
import { HistoryEntrySchema, RunRecordSchema } from "./run-record.js";

/**
 * CRUD over the committed extraction-accuracy run artifacts.
 *
 * Two files per backend, in `acceptance/runs/`:
 *   - `current-<label>.json`  — one run in full, OVERWRITTEN each time (~150 KB)
 *   - `history-<label>.jsonl` — one appended summary line per run (~400 B)
 *
 * `openRunStore({ dir })` takes an injectable directory, mirroring
 * `openOutbox({ storage })` (AGENTS §5.5): the default is the real committed
 * `runs/` directory, and tests pass a temp dir so they never touch the tree.
 *
 * Everything read back is zod-parsed, never cast — these are persisted records
 * crossing a trust boundary (AGENTS §4).
 *
 * See docs/roadmap/design/extraction-accuracy-report-design.md §4.
 */
export interface RunStore {
  /** Overwrite `current` (temp + rename), then append one `history` line. */
  saveRun(run: RunRecord): Promise<void>;
  readCurrent(backendLabel: string): Promise<RunRecord | null>;
  readHistory(backendLabel: string): Promise<HistoryEntry[]>;
  listBackends(): Promise<string[]>;
  /** Drop ONE bogus trend point, leaving `current` alone. */
  deleteHistoryEntry(backendLabel: string, capturedAt: string): Promise<void>;
  /** Trim the trend to the newest N. Maintenance, not correction. */
  pruneHistory(backendLabel: string, opts: { keep: number }): Promise<void>;
  /** Remove BOTH files — retire the backend entirely. */
  deleteRun(backendLabel: string): Promise<void>;
}

const DEFAULT_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "runs");

/** Same sanitisation the gate already applies to its results directory. */
function safe(label: string): string {
  return label.replace(/[^\w.-]+/g, "_");
}

export function openRunStore(opts: { dir?: string } = {}): RunStore {
  const dir = opts.dir ?? DEFAULT_DIR;
  const currentPath = (label: string): string => join(dir, `current-${safe(label)}.json`);
  const historyPath = (label: string): string => join(dir, `history-${safe(label)}.jsonl`);

  function readHistorySync(label: string): HistoryEntry[] {
    const path = historyPath(label);
    if (!existsSync(path)) return [];
    const entries: HistoryEntry[] = [];
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue; // trailing newline, or a blank a human left
      try {
        entries.push(HistoryEntrySchema.parse(JSON.parse(line)));
      } catch (cause) {
        throw new Error(
          `Malformed accuracy history in ${historyPath(label)} at line ${index + 1}. ` +
            `Fix or remove the line — a run summary that cannot be parsed must never be ` +
            `rendered as a data point.`,
          { cause },
        );
      }
    }
    return entries;
  }

  function writeHistorySync(label: string, entries: HistoryEntry[]): void {
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(historyPath(label), entries.length === 0 ? "" : `${body}\n`);
  }

  return {
    async saveRun(run) {
      const parsed = RunRecordSchema.parse(run);
      mkdirSync(dir, { recursive: true });

      // Temp + rename so an interrupted write cannot leave a half-written grid,
      // and so `current` is never observed partially written. History is appended
      // AFTER the rename: a crash between the two loses a trend point, which is
      // recoverable; the reverse order would leave a history point referencing a
      // grid that was never written, which is not.
      const target = currentPath(parsed.backendLabel);
      const temp = `${target}.tmp`;
      writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`);
      renameSync(temp, target);

      appendFileSync(
        historyPath(parsed.backendLabel),
        `${JSON.stringify(toHistoryEntry(parsed))}\n`,
      );
    },

    async readCurrent(backendLabel) {
      const path = currentPath(backendLabel);
      if (!existsSync(path)) return null;
      try {
        return RunRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch (cause) {
        throw new Error(
          `Malformed accuracy run in ${path}. Delete it and re-run the acceptance gate.`,
          { cause },
        );
      }
    },

    async readHistory(backendLabel) {
      return readHistorySync(backendLabel);
    },

    async listBackends() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.startsWith("current-") && f.endsWith(".json"))
        .map((f) => f.slice("current-".length, -".json".length));
    },

    async deleteHistoryEntry(backendLabel, capturedAt) {
      if (!existsSync(historyPath(backendLabel))) return;
      const kept = readHistorySync(backendLabel).filter((e) => e.capturedAt !== capturedAt);
      writeHistorySync(backendLabel, kept);
    },

    async pruneHistory(backendLabel, { keep }) {
      if (!existsSync(historyPath(backendLabel))) return;
      const entries = readHistorySync(backendLabel);
      writeHistorySync(backendLabel, keep <= 0 ? [] : entries.slice(-keep));
    },

    async deleteRun(backendLabel) {
      rmSync(currentPath(backendLabel), { force: true });
      rmSync(historyPath(backendLabel), { force: true });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/ribo-adapter-snuggpro/acceptance/run-store.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Confirm the new tests actually run in the shared gate**

Run: `pnpm vitest run packages/ribo-adapter-snuggpro`
Expected: PASS, and the output lists `acceptance/run-record.test.ts`, `acceptance/build-run-record.test.ts` and `acceptance/run-store.test.ts` under `|unit|`. If any is absent, it is in the wrong directory — the glob is one level deep (see Global Constraints).

- [ ] **Step 6: Typecheck, lint, format, full gate**

Run: `pnpm --filter @azx/ribo-adapter-snuggpro typecheck && pnpm format && pnpm lint && ./check.sh`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ribo-adapter-snuggpro/acceptance/run-store.ts \
        packages/ribo-adapter-snuggpro/acceptance/run-store.test.ts
git commit -m "Add a CRUD store over the committed accuracy run artifacts"
```

---

### Task 5: Wire the gate to save every run

**Files:**

- Modify: `packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts`
- Modify: `packages/ribo-adapter-snuggpro/acceptance/README.md`

**Interfaces:**

- Consumes: `buildRunRecord`, `toHistoryEntry` (Task 3); `openRunStore` (Task 4).
- Produces: `runs/current-<label>.json` and `runs/history-<label>.jsonl`, which Task 6 reads.

This task has no unit test — the gate needs a real backend and is manual by design. It is verified by running it. Everything it _calls_ was tested in Tasks 3 and 4; this task is wiring.

- [ ] **Step 1: Add the imports**

At the top of `gate.manual.ts`, alongside the existing sibling imports of `./cli-chat.js`:

```ts
import { buildRunRecord } from "./build-run-record.js";
import { openRunStore } from "./run-store.js";
```

And extend the existing `ground-truth.mjs` import to bring in the resolver — it is already exported from that module, so this adds an import and edits nothing in `spikes/`:

```ts
import {
  readGroundTruth,
  resolveGroundTruth,
} from "../../../spikes/extraction-snuggpro/ground-truth.mjs";
```

Also import the leaf-path lists from the scorer, extending the existing `score.mjs` import line:

```ts
import {
  GENERIC_LEAF_PATHS,
  HEALTH_TEST_PATHS,
  aggregate,
  scoreTranscript,
} from "../../../spikes/extraction-snuggpro/score.mjs";
```

- [ ] **Step 2: Record which leaves ground truth asserted, inside the existing extraction loop**

The loop currently reads `gt` and pushes a report. Add an `assertedLeaves` accumulator declared just above the loop (next to `const reports = []`):

```ts
// Which leaves ground truth actually ASSERTS, per transcript. This is the only
// thing that separates a `correct` cell from a `correct-null` one in the grid —
// without it a degenerate all-null extraction would paint the whole grid green.
// `resolveGroundTruth` is the corpus's own resolver (explicit leaf, then
// disclaimer default, then "unmentioned"), so this agrees with the scorer by
// construction rather than by re-deriving the rules here.
const assertedLeaves: Record<string, string[]> = {};
```

and, inside the loop immediately after `const gt = JSON.parse(...)`:

```ts
const resolved = resolveGroundTruth(gt) as { leaves: Record<string, { status: string }> };
assertedLeaves[slug] = Object.entries(resolved.leaves)
  .filter(([, truth]) => truth.status === "asserted")
  .map(([path]) => path);
```

- [ ] **Step 3: Build and save the record — BEFORE the first assertion**

Immediately after the existing `const enumAccuracy = pct(...)` line and the `const fingerprint = currentSchemaFingerprint();` line, and **before** any `expect(...)` call, insert:

```ts
// Persist the run BEFORE asserting. A run that FAILS its hazard assertions is
// exactly the run whose grid someone wants to open — "hazard 2 tripped, which
// transcript, which field, what did it say?" If this sat after the assertions,
// the first `expect` would throw and the interesting run would publish nothing.
// The record therefore describes WHAT THE RUN MEASURED, independent of pass/fail,
// and carries `passed` so the docs page can show a failing run as failing.
const hazards = {
  fuelDropped,
  fuelInvented,
  hallucinatedPass: totals.hHallucinatedPass ?? 0,
  rvalueConversion: totals.rvalueConversion ?? 0,
  enumWrongMember: totals.enumWrongMember ?? 0,
  enumInvalid: totals.enumInvalid ?? 0,
  spanFabricated: totals.spanFabricated ?? 0,
  spanMissing: totals.spanMissing ?? 0,
};
const passed =
  scored === slugs.length &&
  Object.values(hazards).every((count) => count === 0) &&
  shapeResults.every((r) => r.conforming);

await openRunStore().saveRun(
  buildRunRecord({
    capturedAt: new Date().toISOString(),
    schemaFingerprint: fingerprint,
    backend: backendIdentity,
    backendLabel,
    model: backendLabel,
    passed,
    hallRate,
    missRate,
    totals,
    hazards,
    shapeConformance: {
      applicable: backendId !== "openai",
      firstTry: shapeResults.filter((r) => r.conforming && r.attempts === 1).length,
      retried: shapeResults.filter((r) => r.conforming && r.attempts > 1).length,
      never: shapeResults.filter((r) => !r.conforming).length,
    },
    leafPaths: [...GENERIC_LEAF_PATHS, ...HEALTH_TEST_PATHS],
    reports,
    assertedLeaves,
  }),
);
console.log(`[acceptance] run record written to acceptance/runs/current-${backendLabel}.json`);
```

Note `passed` deliberately reflects the **baseline-independent** checks only (coverage, the four hazards, span verbatim-ness via `spanFabricated`/`spanMissing`, and shape conformance). The two rate-vs-baseline assertions are skipped entirely when the baseline is stale or missing, so folding them in would make `passed` mean different things on different runs.

- [ ] **Step 4: Verify the shape-result field names against `cli-chat.ts`**

Open `packages/ribo-adapter-snuggpro/acceptance/cli-chat.ts` and confirm `CliShapeResult` really has `conforming: boolean` and `attempts: number`. If the names differ, fix the four references in Step 3 to match — do **not** rename anything in `cli-chat.ts`.

Run: `pnpm --filter @azx/ribo-adapter-snuggpro typecheck`
Expected: PASS. (`gate.manual.ts` is outside the typechecked project, so this will not catch a mismatch there — that is why this step is a manual read.)

- [ ] **Step 5: Run the gate for real against a CLI backend (no key needed)**

Run:

```bash
RIBO_ACCEPTANCE_BACKEND=codex-cli \
  pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts
```

Expected: the suite runs (several minutes — 14 real inference calls), prints the run-record path, and creates:

- `packages/ribo-adapter-snuggpro/acceptance/runs/current-codex-cli.json`
- `packages/ribo-adapter-snuggpro/acceptance/runs/history-codex-cli.jsonl`

- [ ] **Step 6: Verify the artifact is dense and well-formed**

Run:

```bash
node --input-type=module -e '
import { openRunStore } from "./packages/ribo-adapter-snuggpro/acceptance/run-store.ts";
const s = openRunStore();
const r = await s.readCurrent("codex-cli");
const leaves = r.leafPaths.length, cols = r.transcripts.length;
const cells = Object.values(r.grid).reduce((n, c) => n + Object.keys(c).length, 0);
console.log({ leaves, cols, cells, expected: leaves * cols, passed: r.passed });
console.log("history:", (await s.readHistory("codex-cli")).length);
'
```

Expected: `cells === expected` (51 × 14 = 714), and `history: 1`. If `cells` is short, `leafPaths` or the report slugs disagree — fix before committing.

If Node cannot execute the `.ts` file directly, run the same check inside a throwaway `*.test.ts` under `acceptance/` instead, then delete it.

- [ ] **Step 7: Prove the record is written even when the gate FAILS**

This is the property Step 3 exists for, and an unverified property is not a property. Temporarily force a hazard: in `packages/ribo-adapter-snuggpro/src/normalization.ts`, make `normalizeFields` set the heating-fuel leaf to `null` (the mutation the acceptance README's "Watching it fail" section already describes).

Run the gate again with `RIBO_ACCEPTANCE_BACKEND=codex-cli`.

Expected: the Hazard 1 assertion FAILS, **and** `runs/current-codex-cli.json` is rewritten with `"passed": false`, and `history-codex-cli.jsonl` gains a second line.

- [ ] **Step 8: Revert the mutation and delete the bad data**

Revert `normalization.ts` (`git checkout -- packages/ribo-adapter-snuggpro/src/normalization.ts`), then re-run the gate to restore a good `current`, and drop the deliberately-broken history point using the store's own delete — which also exercises it end to end:

```bash
node --input-type=module -e '
import { openRunStore } from "./packages/ribo-adapter-snuggpro/acceptance/run-store.ts";
const s = openRunStore();
const h = await s.readHistory("codex-cli");
for (const e of h.filter((e) => !e.passed)) await s.deleteHistoryEntry("codex-cli", e.capturedAt);
console.log("remaining:", (await s.readHistory("codex-cli")).map((e) => e.capturedAt));
'
```

Expected: only passing runs remain.

- [ ] **Step 9: Document the artifacts in the acceptance README**

Add a section to `packages/ribo-adapter-snuggpro/acceptance/README.md`, after "Baseline freshness":

````markdown
## Every run writes a committed run record

Alongside the console report, each run writes two files under `acceptance/runs/`,
both committed to git:

| File                            | Write mode  | Contents                                                                                                                     |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `current-<backend-label>.json`  | overwritten | the full run: aggregates, hazard counts, shape conformance, and a dense verdict grid of every schema leaf × every transcript |
| `history-<backend-label>.jsonl` | appended    | one summary line per run — the trend                                                                                         |

These are what the docs site's accuracy page renders (`docs/deep-dives/accuracy.md`).
There is no publish step and no flag: the gate always writes them, and `git diff`
is the review gate.

**The record is written BEFORE the assertions run**, so a failing run still
publishes its grid — that is the run you most want to inspect. It carries
`"passed": false`, and the page shows it as failed.

That means a run against a deliberately-broken extractor (see "Watching it fail"
above) WILL leave a bad point in the append-only history if committed. Remove it
by identity rather than hand-editing the file:

```ts
import { openRunStore } from "./run-store.js";
await openRunStore().deleteHistoryEntry("codex-cli", "<capturedAt>");
```
````

`pruneHistory(label, { keep })` trims the trend; `deleteRun(label)` removes both
files and retires a backend entirely.

````

- [ ] **Step 10: Format, lint, full gate, and commit**

Run: `pnpm format && pnpm lint && ./check.sh`
Expected: PASS.

```bash
git add packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts \
        packages/ribo-adapter-snuggpro/acceptance/README.md \
        packages/ribo-adapter-snuggpro/acceptance/runs/
git commit -m "Write a committed run record on every acceptance-gate run, pass or fail"
````

---

### Task 6: The docs page

**Files:**

- Create: `docs/deep-dives/accuracy.data.ts`
- Create: `docs/deep-dives/accuracy.md`
- Create: `docs/.vitepress/theme/components/AccuracyReport.vue`
- Create or Modify: `docs/.vitepress/theme/index.ts`
- Modify: `docs/.vitepress/config.ts`

**Interfaces:**

- Consumes: `openRunStore` (Task 4), `RunRecord` / `HistoryEntry` (Task 2).
- Produces: the rendered page. Nothing consumes it.

- [ ] **Step 1: Read the existing VitePress config before touching it**

Run: `cat docs/.vitepress/config.ts` and `ls docs/.vitepress/theme 2>/dev/null`

You need to know the existing sidebar structure and whether a custom theme already exists. Follow whatever pattern is there; the snippets below assume the default theme with no custom `theme/index.ts` yet. If one exists, extend it rather than replacing it.

- [ ] **Step 2: Write the data loader**

`docs/deep-dives/accuracy.data.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineLoader } from "vitepress";

import { openRunStore } from "../../packages/ribo-adapter-snuggpro/acceptance/run-store.js";
import type {
  HistoryEntry,
  RunRecord,
} from "../../packages/ribo-adapter-snuggpro/acceptance/run-record.js";

/**
 * Build-time data for the extraction-accuracy page. Runs in Node and reads the
 * committed run artifacts through the acceptance harness's own store, so there
 * is exactly ONE definition of the record format and it is zod-parsed here as
 * everywhere else.
 *
 * Reaching into `packages/` from the docs build introduces no new coupling: the
 * generated Reference section already builds from `packages/*\/src/index.ts` via
 * TypeDoc.
 */

const ACCEPTANCE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "packages",
  "ribo-adapter-snuggpro",
  "acceptance",
);
const RUNS_DIR = join(ACCEPTANCE, "runs");
const FIXTURE_SCHEMA = join(
  ACCEPTANCE,
  "..",
  "src",
  "__fixtures__",
  "snugg-fields-json-schema.json",
);

export interface BackendReport {
  label: string;
  current: RunRecord;
  history: HistoryEntry[];
  /** True when the run was measured against a schema that is no longer current. */
  stale: boolean;
}

export interface AccuracyData {
  backends: BackendReport[];
  currentFingerprint: string;
}

declare const data: AccuracyData;
export { data };

export default defineLoader({
  watch: ["../../packages/ribo-adapter-snuggpro/acceptance/runs/*"],
  async load(): Promise<AccuracyData> {
    const currentFingerprint = existsSync(FIXTURE_SCHEMA)
      ? `sha256:${createHash("sha256").update(readFileSync(FIXTURE_SCHEMA, "utf8")).digest("hex")}`
      : "";

    const store = openRunStore({ dir: RUNS_DIR });
    const backends: BackendReport[] = [];

    // No runs published yet is a NORMAL state, not a build failure: the page says
    // so rather than rendering an empty chart that implies zero hallucinations.
    for (const label of await store.listBackends()) {
      const current = await store.readCurrent(label);
      if (current === null) continue;
      backends.push({
        label,
        current,
        history: await store.readHistory(label),
        stale: current.schemaFingerprint !== currentFingerprint,
      });
    }

    backends.sort((a, b) => a.label.localeCompare(b.label));
    return { backends, currentFingerprint };
  },
});
```

**If the build cannot resolve `../../packages/.../run-store.js`:** the imports above use the
TypeScript `.js`-for-`.ts` convention the rest of this repo uses. Vite normally resolves that, but
if it does not here, drop the extension (`.../run-store`) rather than reaching for an alias or a
tsconfig path — the loader is the only file crossing this boundary, and a one-file exception is
cheaper than new resolution config.

- [ ] **Step 3: Write the page**

`docs/deep-dives/accuracy.md`:

```markdown
---
title: Extraction accuracy
---

# Extraction accuracy

These are measured numbers, not targets. Every figure below comes from running the
built default extractor (`singleShotExtractor`) over a 14-transcript corpus of
synthetic home-energy-audit dictations, scoring each result against
hand-annotated ground truth across all 51 schema leaves.

The gate that produces them is manual and makes real inference calls, so it runs
when someone runs it — the timestamps below say when.

**What "hallucination" means here:** ground truth says a field was never
mentioned, and the extractor filled it in anyway. **"Miss"** is the reverse — the
auditor said it and the extractor dropped it. Both matter, and a system that
optimises one at the other's expense is not better: an extractor that returns
nothing at all scores a perfect 0% hallucination rate and is useless.

<AccuracyReport />

## How to read the grid

Each row is one schema leaf; each column one transcript. Click a cell for the
expected value, what the extractor produced, and the source span it cited.

`correct` and `correct-null` are shown differently on purpose. A leaf nobody
mentioned and the extractor correctly left empty is not the same evidence as a
leaf that was stated and correctly captured.

Span problems are tracked separately from content: a value can be right and its
quote fabricated, and that is a real defect in a system whose review UI shows
auditors the quote.
```

- [ ] **Step 4: Write the component**

`docs/.vitepress/theme/components/AccuracyReport.vue`. Build it in this order, checking the page renders after each band:

```vue
<script setup lang="ts">
import { computed, ref } from "vue";

import { data } from "../../../deep-dives/accuracy.data.js";
import type { Cell } from "../../../../packages/ribo-adapter-snuggpro/acceptance/run-record.js";

const selected = ref(data.backends[0]?.label ?? "");
const report = computed(() => data.backends.find((b) => b.label === selected.value));
const openCell = ref<{ leaf: string; slug: string; cell: Cell } | null>(null);

const VERDICT_CLASS: Record<string, string> = {
  correct: "ok",
  "correct-null": "ok-null",
  sanctioned: "ok-null",
  miss: "miss",
  "miss-excused": "ok-null",
  "health-miss": "miss",
  "health-clean-dropped": "miss",
  hallucination: "bad",
  "hallucination-soft": "warn",
  wrong: "bad",
  unscorable: "warn",
  "health-hallucinated-pass": "bad",
  "health-hallucinated-problem": "bad",
  "health-wrong": "bad",
};

const pct = (n: number) => `${(100 * n).toFixed(2)}%`;

/** Two-series sparkline over the history, as inline SVG — no charting dependency. */
function polyline(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 0.0001);
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  return values.map((v, i) => `${i * step},${height - (v / max) * height}`).join(" ");
}

function rowSummary(leaf: string): string {
  const row = report.value?.current.grid[leaf] ?? {};
  const cells = Object.values(row);
  const good = cells.filter((c) => c.verdict === "correct" || c.verdict === "correct-null").length;
  return `${good}/${cells.length}`;
}
</script>

<template>
  <p v-if="data.backends.length === 0">
    <strong>No accuracy runs have been published yet.</strong> Run the manual acceptance gate to
    produce one — see <code>packages/ribo-adapter-snuggpro/acceptance/README.md</code>.
  </p>

  <template v-else>
    <p>
      <label>Backend: </label>
      <select v-model="selected">
        <option v-for="b in data.backends" :key="b.label" :value="b.label">{{ b.label }}</option>
      </select>
    </p>

    <template v-if="report">
      <div v-if="report.stale" class="danger custom-block">
        <p class="custom-block-title">These numbers are stale</p>
        <p>
          This run was measured against a different version of the Snugg Pro schema than the one in
          the tree today. The field set and enum vocabulary shape what "normal" looks like, so the
          rates below are not comparable to the current schema. Re-run the acceptance gate.
        </p>
      </div>

      <h2>Latest run</h2>
      <table>
        <tbody>
          <tr>
            <td>Result</td>
            <td>{{ report.current.passed ? "passed" : "FAILED" }}</td>
          </tr>
          <tr>
            <td>Captured</td>
            <td>{{ new Date(report.current.capturedAt).toUTCString() }}</td>
          </tr>
          <tr>
            <td>Model</td>
            <td>
              <code>{{ report.current.model }}</code>
            </td>
          </tr>
          <tr>
            <td>Hallucination rate</td>
            <td>{{ pct(report.current.hallRate) }}</td>
          </tr>
          <tr>
            <td>Miss rate</td>
            <td>{{ pct(report.current.missRate) }}</td>
          </tr>
          <tr v-for="(count, name) in report.current.hazards" :key="name">
            <td>{{ name }}</td>
            <td>{{ count === 0 ? "0 — clear" : `${count} — TRIPPED` }}</td>
          </tr>
          <tr v-if="report.current.shapeConformance.applicable">
            <td>Shape conformance</td>
            <td>
              {{ report.current.shapeConformance.firstTry }} first-try /
              {{ report.current.shapeConformance.retried }} retried /
              {{ report.current.shapeConformance.never }} never
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Trend</h2>
      <p v-if="report.history.length < 2">Only one run recorded — no trend yet.</p>
      <svg
        v-else
        viewBox="0 0 600 120"
        class="accuracy-trend"
        role="img"
        aria-label="Hallucination and miss rate over time"
      >
        <polyline
          :points="
            polyline(
              report.history.map((h) => h.hallRate),
              600,
              110,
            )
          "
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        />
        <polyline
          :points="
            polyline(
              report.history.map((h) => h.missRate),
              600,
              110,
            )
          "
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-dasharray="5 4"
        />
      </svg>
      <p v-if="report.history.length >= 2">
        <small
          >Solid: hallucination rate. Dashed: miss rate. {{ report.history.length }} runs.</small
        >
      </p>

      <h2>Per-field detail</h2>
      <div class="accuracy-grid-scroll">
        <table class="accuracy-grid">
          <thead>
            <tr>
              <th>Leaf</th>
              <th>OK</th>
              <th v-for="t in report.current.transcripts" :key="t.slug" :title="t.slug">
                {{ t.slug.slice(0, 2) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="leaf in report.current.leafPaths" :key="leaf">
              <th class="leaf">{{ leaf }}</th>
              <td>{{ rowSummary(leaf) }}</td>
              <td
                v-for="t in report.current.transcripts"
                :key="t.slug"
                :class="[
                  'cell',
                  VERDICT_CLASS[report.current.grid[leaf]?.[t.slug]?.verdict ?? ''] ?? '',
                ]"
                :title="report.current.grid[leaf]?.[t.slug]?.verdict"
                @click="openCell = { leaf, slug: t.slug, cell: report.current.grid[leaf][t.slug] }"
              ></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="openCell" class="tip custom-block">
        <p class="custom-block-title">{{ openCell.leaf }} — {{ openCell.slug }}</p>
        <ul>
          <li>
            Verdict: <strong>{{ openCell.cell.verdict }}</strong>
          </li>
          <li>
            Expected: <code>{{ openCell.cell.expected ?? "null" }}</code>
          </li>
          <li>
            Extracted: <code>{{ openCell.cell.got ?? "null" }}</code>
          </li>
          <li v-if="openCell.cell.sourceSpan">Span: "{{ openCell.cell.sourceSpan }}"</li>
          <li v-if="openCell.cell.spanIssue">Span problem: {{ openCell.cell.spanIssue }}</li>
          <li v-if="openCell.cell.detail">{{ openCell.cell.detail }}</li>
        </ul>
        <p><button @click="openCell = null">Close</button></p>
      </div>
    </template>
  </template>
</template>

<style scoped>
.accuracy-grid-scroll {
  overflow-x: auto;
}
.accuracy-grid {
  font-size: 0.8em;
  border-collapse: collapse;
}
.accuracy-grid .leaf {
  text-align: left;
  white-space: nowrap;
  font-weight: 400;
}
.accuracy-grid .cell {
  width: 1.4em;
  height: 1.4em;
  cursor: pointer;
  border: 1px solid var(--vp-c-divider);
}
/* Colour is never the only signal — every cell carries its verdict in `title`,
   and the drill-down states it in words. */
.accuracy-grid .ok {
  background: var(--vp-c-green-3);
}
.accuracy-grid .ok-null {
  background: var(--vp-c-green-soft);
}
.accuracy-grid .miss {
  background: var(--vp-c-yellow-3);
}
.accuracy-grid .warn {
  background: var(--vp-c-yellow-1);
}
.accuracy-grid .bad {
  background: var(--vp-c-red-3);
}
.accuracy-trend {
  width: 100%;
  height: auto;
}
</style>
```

- [ ] **Step 5: Register the component**

If `docs/.vitepress/theme/index.ts` does not exist, create it:

```ts
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";

import AccuracyReport from "./components/AccuracyReport.vue";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("AccuracyReport", AccuracyReport);
  },
} satisfies Theme;
```

If it already exists, add only the import and the `app.component(...)` line.

- [ ] **Step 6: Add the page to the sidebar**

In `docs/.vitepress/config.ts`, add an item to the Deep Dives sidebar group, matching the surrounding style exactly:

```ts
{ text: "Extraction accuracy", link: "/deep-dives/accuracy" },
```

- [ ] **Step 7: Verify it renders with real data**

Run: `pnpm docs:dev`
Open the Deep Dives → Extraction accuracy page.

Expected: the backend selector shows `codex-cli`; the headline table shows the run from Task 5; the grid is 51 rows wide enough to scroll horizontally on a narrow window but not to push the page body sideways; clicking a cell opens the detail block.

- [ ] **Step 8: Verify the empty state does not break the build**

Temporarily move the artifacts aside:

```bash
mv packages/ribo-adapter-snuggpro/acceptance/runs /tmp/runs-backup
pnpm docs:build
```

Expected: the build SUCCEEDS and the page reads "No accuracy runs have been published yet."

Restore: `mv /tmp/runs-backup packages/ribo-adapter-snuggpro/acceptance/runs`

- [ ] **Step 9: Verify the stale banner**

Temporarily edit `packages/ribo-adapter-snuggpro/acceptance/runs/current-codex-cli.json` and change one hex character of `schemaFingerprint`.

Run: `pnpm docs:dev`
Expected: the red "These numbers are stale" block appears above the headline table.

Restore: `git checkout -- packages/ribo-adapter-snuggpro/acceptance/runs/`

- [ ] **Step 10: Full static build and the code gate**

Run: `pnpm docs:build && pnpm format && pnpm lint && ./check.sh`
Expected: all PASS. `docs:build` emits static output; `check.sh` is unaffected (docs are not one of its stages).

- [ ] **Step 11: Commit**

```bash
git add docs/deep-dives/accuracy.md docs/deep-dives/accuracy.data.ts \
        docs/.vitepress/theme/ docs/.vitepress/config.ts
git commit -m "Render extraction accuracy on the docs site: headline, trend, per-field grid"
```

---

## Definition of Done

Every item from the design doc's §9, verified rather than assumed:

- [ ] `run-record.ts`, `build-run-record.ts`, `run-store.ts` and their three test files exist; all three test files appear under `|unit|` in `pnpm vitest run packages/ribo-adapter-snuggpro` output.
- [ ] `pnpm --filter @azx/ribo-adapter-snuggpro typecheck` covers `acceptance/`, proven by Task 1 Step 5 having failed on a deliberate error.
- [ ] A manual gate run writes `runs/current-<backend>.json` and appends `runs/history-<backend>.jsonl`.
- [ ] The record is written when assertions FAIL, proven by Task 5 Step 7.
- [ ] The grid is dense: `leafPaths.length × transcripts.length` cells, proven by Task 5 Step 6.
- [ ] `pnpm docs:dev` renders the page from committed artifacts; `pnpm docs:build` emits it statically.
- [ ] With `runs/` absent, `docs:build` succeeds and the page says so (Task 6 Step 8).
- [ ] With a mutated fingerprint, the page shows the stale banner (Task 6 Step 9).
- [ ] `./check.sh` is green.
- [ ] No new dependency was added to `pnpm-workspace.yaml`.
- [ ] `spikes/extraction-snuggpro/score.mjs` and `ground-truth.mjs` are untouched (`git diff --stat spikes/` is empty).
