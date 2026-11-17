// Unit tests for the accuracy-page generator (scripts/generate-accuracy-page.mjs), run in
// the Vitest `unit` project via the "scripts/*.test.mjs" include.
//
// Everything runs in-process against a committed fixture corpus
// (scripts/test-fixtures/generate-accuracy-page/corpus/): the tests that render a page point
// `main()`'s `out` at a temp file, and the tests that need a records directory write one into
// a fresh temp dir. Nothing writes into the repo, no test spawns the script as a bare-node
// subprocess (which would resolve `@azx/ribo-cli` to `dist/` and couple the suite to a prior
// build) and no test makes a model call.
//
// Fixture records get their fingerprints stamped at test time — computed from the fixture
// corpus with the same exported CLI functions the generator uses — rather than committed
// precomputed: a committed fingerprint would silently rot on any whitespace-level fixture
// edit. The "stale" variants substitute a different 64-hex key. The fixture tree deliberately
// holds no Snugg fixture schema file, so a surviving fixture-file-hash staleness check would
// make every "current" test fail rather than pass vacuously.

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import { corpusFingerprint, loadCorpus, runFingerprint } from "@azx/ribo-cli";

import {
  bucketCounts,
  collectProblems,
  grid as gridSection,
  main,
  workedExample,
} from "./generate-accuracy-page.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "test-fixtures",
  "generate-accuracy-page",
);

/** Assert the fixture exists before asserting on it — a mistyped name would otherwise pass vacuously. */
function fixture(name) {
  const dir = path.join(FIXTURES, name);
  if (!existsSync(dir)) throw new Error(`fixture missing: ${dir}`);
  return dir;
}

const CORPUS_DIR = fixture("corpus");
const CORPUS = loadCorpus(CORPUS_DIR);

const LEAF_PATHS = [
  "attic.atticInsulation",
  "attic.atticInsulationDepth",
  "basedata.basedataConditionedFloorArea",
  "basedata.basedataYearBuilt",
];

function cell(overrides = {}) {
  return { verdict: "correct", expected: null, got: null, origin: "none", ...overrides };
}

/** A dense grid over LEAF_PATHS × [case-one, case-two] covering all five verdicts. */
function grid() {
  return {
    "basedata.basedataYearBuilt": {
      "case-one": cell({
        verdict: "correct",
        expected: "1975",
        got: "1975",
        sourceSpan: "built in seventy-five",
        origin: "explicit",
      }),
      "case-two": cell({
        verdict: "hallucinated",
        expected: null,
        got: "Victorian",
        origin: "explicit",
      }),
    },
    "basedata.basedataConditionedFloorArea": {
      "case-one": cell({ verdict: "unscorable", reason: "unmentioned" }),
      "case-two": cell({}),
    },
    "attic.atticInsulation": {
      "case-one": cell({
        verdict: "correct",
        expected: 38,
        got: 38,
        sourceSpan: "R-38 up top",
        origin: "explicit",
      }),
      "case-two": cell({
        verdict: "missed",
        expected: 12,
        got: null,
        sourceSpan: "about a foot of blown-in",
        origin: "explicit",
      }),
    },
    "attic.atticInsulationDepth": {
      "case-one": cell({}),
      "case-two": cell({
        verdict: "wrong",
        expected: "10-12",
        got: "16-18",
        origin: "explicit",
      }),
    },
  };
}

const TOTALS = {
  cases: 8,
  correct: 3,
  wrong: 1,
  missed: 1,
  hallucinated: 1,
  unscorable: 1,
  judged: 8,
  answered: 5,
  answerRate: 5 / 8,
  accuracyOverAnswered: 3 / 5,
  accuracyOverAll: 3 / 8,
};

/** A valid new-format record, stamped with the fixture corpus's current keys. */
function record(overrides = {}) {
  return {
    contractVersion: 1,
    capturedAt: "2026-11-20T12:00:00.000Z",
    corpus: {
      name: "accuracy-page-fixture",
      fingerprint: corpusFingerprint(CORPUS),
      provenance: "synthetic",
    },
    fingerprint: runFingerprint(CORPUS.schemaDocument, CORPUS.manifest.prompt),
    backend: "codex-cli",
    model: "gpt-test",
    settings: { strategies: ["single-shot"] },
    totals: TOTALS,
    leafPaths: LEAF_PATHS,
    grid: grid(),
    history: [],
    ...overrides,
  };
}

let tempDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), `accuracy-page-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** Write records into a fresh temp records directory; return its path. */
function recordsDir(records) {
  const dir = tempDir("records");
  records.forEach((r, i) => {
    writeFileSync(
      path.join(dir, `${String(i + 1).padStart(2, "0")}-${r.backend}.json`),
      `${JSON.stringify(r, null, 2)}\n`,
    );
  });
  return dir;
}

/** Run main() against a records dir (or record list) and the fixture corpus; return the page. */
function page(records, corpusDir = CORPUS_DIR) {
  const out = path.join(tempDir("out"), "accuracy.md");
  main([typeof records === "string" ? records : recordsDir(records), corpusDir], {
    out,
    log: () => {},
  });
  return readFileSync(out, "utf8");
}

test("the fixture corpus tree carries no Snugg fixture schema file — staleness cannot be a fixture-file hash", () => {
  const names = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else names.push(name);
    }
  };
  walk(CORPUS_DIR);
  expect(names).not.toContain("snugg-fields-json-schema.json");
});

test("usage: an invocation with no arguments fails naming the records directory", () => {
  expect(() => main([])).toThrow(/records directory/);
});

test("usage: an invocation with only the records directory fails naming the corpus directory", () => {
  expect(() => main([tempDir("arg")])).toThrow(/corpus directory/);
});

test("a records directory that does not exist renders the empty state, naming ribo eval", () => {
  const text = page(path.join(tempDir("missing"), "nope"));
  expect(text).toMatch(/No accuracy runs have been published yet/);
  expect(text).toMatch(/ribo eval/);
  expect(text).toMatch(/--out/);
  // Exactly one empty state, and the old gate is not what produces the first run.
  expect(text).not.toMatch(/manual acceptance gate/);
});

test("an old-format record in the records directory makes the generator throw, naming the file", () => {
  const dir = tempDir("old-format");
  cpSync(fixture("old-format-record.json"), path.join(dir, "current-codex-cli.json"));
  expect(() => page(dir)).toThrow(/current-codex-cli\.json/);
});

test("records present but the corpus directory missing fails loudly, naming the corpus directory, and writes no page", () => {
  const out = path.join(tempDir("no-corpus"), "accuracy.md");
  expect(() =>
    main([recordsDir([record()]), path.join(tempDir("no-corpus"), "nope")], { out, log: () => {} }),
  ).toThrow(/corpus directory/);
  expect(existsSync(out)).toBe(false);
});

test("a current record renders without the stale notice, naming its backend, model and settings", () => {
  const text = page([record()]);
  expect(text).not.toMatch(/ar-stale/);
  expect(text).toMatch(/<code>codex-cli<\/code>/);
  expect(text).toMatch(/<code>gpt-test<\/code>/);
  expect(text).toMatch(/single-shot/);
  // Numbers derive from the record's own fields, never hard-coded corpus figures.
  expect(text).toMatch(/nothing to find<\/b>, 2 slots/); // the record's own absent count
  expect(text).toMatch(/would score 8 of those/); // leafPaths × cases, derived
  expect(text).toMatch(/4 fields down, 2 captures across/);
  expect(text).toMatch(/4 &times;[\s\S]*2 = 8 slots/);
});

test("a record whose run fingerprint differs from the current corpus's renders stale", () => {
  const stale = record({ fingerprint: "a".repeat(64) });
  expect(stale.fingerprint).not.toBe(runFingerprint(CORPUS.schemaDocument, CORPUS.manifest.prompt));
  expect(page([stale])).toMatch(/ar-stale/);
});

test("a record whose corpus fingerprint differs from the current corpus's renders stale", () => {
  const stale = record({
    corpus: { name: "accuracy-page-fixture", fingerprint: "b".repeat(64), provenance: "synthetic" },
  });
  expect(stale.corpus.fingerprint).not.toBe(corpusFingerprint(CORPUS));
  expect(page([stale])).toMatch(/ar-stale/);
});

test("two records differing only in backend render as two current headed sections, each naming its own backend and model", () => {
  const text = page([record(), record({ backend: "claude-cli", model: "claude-test" })]);
  expect(text).toMatch(/## codex-cli · gpt-test/);
  expect(text).toMatch(/## claude-cli · claude-test/);
  expect(text).not.toMatch(/ar-stale/);
});

test("a record without the hazards extension renders no hazards section", () => {
  expect(page([record()])).not.toMatch(/ar-gates/);
});

test("a record carrying the self-describing hazards extension renders its counts", () => {
  const withHazards = record({
    hazards: { kind: "gate-hazards", version: 1, counts: { fuelDropped: 0, spanFabricated: 2 } },
  });
  const text = page([withHazards]);
  expect(text).toMatch(/ar-gates/);
  expect(text).toMatch(/fuelDropped/);
  expect(text).toMatch(/spanFabricated/);
  expect(text).toMatch(/gate-hazards/);
});

// ---------------------------------------------------------------- verdict lookups
// An out-of-vocabulary verdict is refused at record-parse time, so each lookup path is
// driven directly with a synthetic cell — one test per path, so fixing one fall-through
// and leaving another silent fails the suite.

/** A valid record with exactly one cell's verdict replaced by an out-of-vocabulary one. */
function bogusRun() {
  const run = record();
  run.grid["attic.atticInsulation"]["case-one"].verdict = "bogus";
  return run;
}

test("the per-record verdict tally throws on an out-of-vocabulary verdict", () => {
  expect(() => bucketCounts(bogusRun())).toThrow(/unknown verdict "bogus"/);
});

test("the worked-example section throws on an out-of-vocabulary verdict", () => {
  expect(() => workedExample(bogusRun())).toThrow(/unknown verdict "bogus"/);
});

test("the coverage grid's cells throw on an out-of-vocabulary verdict", () => {
  expect(() => gridSection(bogusRun(), new Map())).toThrow(/unknown verdict "bogus"/);
});

test("the problems list throws on an out-of-vocabulary verdict", () => {
  expect(() => collectProblems(bogusRun())).toThrow(/unknown verdict "bogus"/);
});
