import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { MAX_RETRIES_DEFAULT } from "./inspect/calls.js";

/**
 * @file The package README's load-bearing claims, pinned: the `npx ribo`
 * name-collision warning that names this package, the invocation paths the
 * warning recommends, and the docs links the README ends its sections with.
 * The README ships in the packed tarball (the pack-readme suite pins that),
 * so what it says is what an installed user gets.
 *
 * The schema doc's own claims are pinned here too: the shipped page is what
 * an installed user reads about the report contract, so the v4 threshold
 * rules live in the same suite as the README that links it.
 */

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const SCHEMA_DOC = readFileSync(
  fileURLToPath(new URL("../../../docs/cli/schema.md", import.meta.url)),
  "utf8",
);
const SPEND_DOC = readFileSync(
  fileURLToPath(new URL("../../../docs/cli/spend.md", import.meta.url)),
  "utf8",
);

test("the README warns that `npx ribo` resolves an unrelated package, and names @azx/ribo-cli", () => {
  expect(README).toContain("npx ribo");
  expect(README).toMatch(/npx ribo[^\n]*\bunrelated\b|`npx ribo`[^\n]*\bunrelated\b/i);
  expect(README).toContain("@azx/ribo-cli");
});

test("the README names the three invocation paths the warning recommends", () => {
  expect(README).toContain("npx @azx/ribo-cli");
  expect(README).toContain("pnpm exec ribo");
  expect(README).toContain("./node_modules/.bin/ribo");
});

test("the README covers every command and links each docs page by its published URL path", () => {
  for (const command of ["schema inspect", "corpus text", "eval", "compare"]) {
    expect(README).toContain(`ribo ${command}`);
  }
  for (const page of ["index", "schema", "planning", "corpus", "scoring", "spend"]) {
    expect(README).toContain(`https://ribo-docs.azx.helix.azxlabs.io/cli/${page}.html`);
  }
});

test("the README walks the committed example corpus the package ships", () => {
  expect(README).toContain("examples/basic-corpus");
});

test("the README covers the authoring commands schema init and schema plan", () => {
  expect(README).toContain("ribo schema init");
  expect(README).toContain("ribo schema plan");
});

test("the README documents the planned strategy, its --plan flag, and both refusal directions", () => {
  expect(README).toContain("planned");
  expect(README).toContain("--plan");
  expect(README).toMatch(/planned without `--plan`/u);
  expect(README).toMatch(/`--plan` without a planned rung/u);
});

test("the README documents plan staleness and the --update fix", () => {
  expect(README).toMatch(/\bstale\b/u);
  expect(README).toContain("--update");
});

test("the README documents both update output forms, never in-place mutation", () => {
  expect(README).toMatch(/complete (JSON artifact|artifact) on stdout/u);
  expect(README).toMatch(/--out[^\n]*distinct new file/u);
  expect(README).toMatch(/never modifies the stored input plan/u);
});

test("the README documents additive record-v1 planned identity and old-reader behavior", () => {
  expect(README).toContain("settings.planFingerprint");
  expect(README).toMatch(/optional[^\n]*record|record[^\n]*optional/u);
  expect(README).toMatch(/old(er)? v1 records/u);
  expect(README).toMatch(/old(er)? (strict )?readers? refuse/u);
});

test("the README states the selected-layout threshold rule and the shared depth", () => {
  expect(README).toMatch(/rule-based[^\n]*without a plan|without a plan[^\n]*rule-based/u);
  expect(README).toMatch(/planned packed call/u);
  expect(README).toMatch(/depth[^\n]*shared|shared[^\n]*depth/u);
});

test("the README pins inspect's 0/1/2 exits with exit 1 keeping the report on stdout", () => {
  expect(README).toMatch(/1\*\* — [^\n]*threshold[^\n]*breached/u);
  expect(README).toMatch(
    /exit 1[^\n]*full report is still on stdout|full report is still on stdout/u,
  );
  expect(README).toMatch(/exit 2[^\n]*stdout (stays |is )?empty|stdout empty/u);
});

test("the README's production path parses the plan in core and builds plannedExtractor, not a CLI import", () => {
  expect(README).toContain("plannedExtractor");
  expect(README).toMatch(/import\s*[{][^}]*plannedExtractor[^}]*[}]\s*from\s*"@azx\/ribo-core"/u);
  expect(README).toContain("parseSchemaPlan");
});

test("the README links the shipped planning page and the example plan", () => {
  expect(README).toContain("(docs/cli/planning.md");
  expect(README).toContain("(examples/basic-corpus/plan.json");
});

test("the schema doc carries the report-v4 no-plan compatibility note", () => {
  expect(SCHEMA_DOC).toMatch(/contractVersion[^\n]*\b4\b|v4/u);
  expect(SCHEMA_DOC).toMatch(/without `--plan`/u);
  expect(SCHEMA_DOC).toMatch(/rule-based/u);
});

test("the schema doc requires a layout on every threshold row, with depth shared", () => {
  expect(SCHEMA_DOC).toMatch(/layout/u);
  expect(SCHEMA_DOC).toMatch(/depth[^\n]*`shared`|`shared`[^\n]*depth/u);
  expect(SCHEMA_DOC).toMatch(/pieceChars|piece-character/u);
  expect(SCHEMA_DOC).toMatch(/`rule-based` or `planned`/u);
});

test("the schema doc pins the one-based size-split call label", () => {
  expect(SCHEMA_DOC).toContain("call <i> of <n>");
  expect(SCHEMA_DOC).toMatch(/one-based/u);
});

test("the spend doc names --max-retries, and its stated default is the call model's", () => {
  expect(SPEND_DOC).toContain("--max-retries");
  const stated = /`--max-retries` \(default: (\d+)\)/.exec(SPEND_DOC)?.[1];
  expect(stated).toBeDefined();
  expect(Number(stated)).toBe(MAX_RETRIES_DEFAULT);
});

test("the schema doc distinguishes unbuildable-plan exit 2 with no report from a judged-breach exit 1", () => {
  expect(SCHEMA_DOC).toMatch(/exit 2[^.\n]*no report|no report[^.\n]*exit 2/u);
  expect(SCHEMA_DOC).toMatch(/whether or not `--max-piece-chars`/u);
  expect(SCHEMA_DOC).toMatch(
    /exit 1[^\n]*report is still on stdout|report is still on stdout[^\n]*exit 1/u,
  );
});

test("schema docs explain call-count reasons and explicit single-shot eval behavior", () => {
  // The old explanation was wrong for single-shot: a flat schema is not why
  // the single-shot count is unavailable — the per-group shape's exclusions
  // are. The doc names the union cap as one of those causes and states that
  // an explicit single-shot eval run still sends one call per attempt.
  expect(SCHEMA_DOC).not.toContain("a flat schema has no per-group bound");
  expect(SCHEMA_DOC).toMatch(/nullable unions over the cap/u);
  expect(SCHEMA_DOC).toContain("--max-nullable-unions-per-group");
  expect(SCHEMA_DOC).toMatch(/ribo eval --strategy single-shot[^.]*still sends one call/u);
});
