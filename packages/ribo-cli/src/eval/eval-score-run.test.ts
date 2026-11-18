/**
 * @file The scorer over a real run: the fixture corpus, the stub chat, and
 * the verdicts that come out.
 *
 * Every run here is driven by the stub chat — no transport, no network, no
 * credential — and every suite asserts that the stub saw calls, so a run
 * that drove nothing can never pass vacuously.
 *
 * The suites are the ones the ticket names: the all-abstain run, the
 * hallucination run, and the round trip — the same run scored against a
 * loader-round-tripped schema and against the same schema built by hand.
 */
import { rmSync } from "node:fs";
import path from "node:path";

import { z } from "zod";
import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import { runEval, runEvalOverSchema } from "./run.js";
import { scoreEvalOverSchema, scoreEvalRun } from "./score.js";
import {
  FIXTURE_CORPUS,
  copiedCorpus,
  corpusWithoutDocuments,
  editJson,
  removeTemporaries,
} from "./test-support/corpus.js";
import { stubChat } from "./test-support/stub-chat.js";

afterEach(() => {
  removeTemporaries();
});

/** The fixture corpus's four leaves, as the all-abstain corpus asserts them. */
const ALL_LEAVES = ["frame.material", "frame.serial", "service.date", "service.notes"];

/**
 * A copy of the fixture corpus holding exactly the named cases.
 *
 * The document case is always removed: these suites measure scoring over
 * transcript and text cases.
 * @param caseIds - The case ids to keep.
 * @returns The copied corpus's path.
 */
const corpusWithout = (...caseIds: readonly string[]): string =>
  copiedCorpus(FIXTURE_CORPUS, (dir) => {
    for (const name of ["service-sheet", "spoken-note", "written-ticket"]) {
      if (caseIds.includes(name)) continue;
      rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  });

/**
 * A copy of the fixture corpus holding one case that asserts every leaf.
 *
 * The committed corpus's cases leave leaves unmentioned or declare a scope
 * absent, and a leaf the corpus declares absent is CORRECT when the run
 * abstains — so the all-abstain run needs a case that asserts every leaf to
 * be measurable at all.
 * @param caseId - The case to keep.
 * @returns The copied corpus's path.
 */
const corpusAssertingEveryLeaf = (caseId: string): string =>
  copiedCorpus(FIXTURE_CORPUS, (dir) => {
    rmSync(path.join(dir, "service-sheet"), { recursive: true, force: true });
    rmSync(path.join(dir, "spoken-note"), { recursive: true, force: true });
    editJson(path.join(dir, caseId, "case.json"), (document) => {
      document.expected = {
        "frame.material": { status: "asserted", value: "steel" },
        "frame.serial": { status: "asserted", value: "BW-4471" },
        "service.date": { status: "asserted", value: "2026-02-04" },
        "service.notes": { status: "asserted", value: "brake pad replacement" },
      };
    });
  });

test("an all-abstain run reports no accuracy and no answer rate", async () => {
  const corpus = loadCorpus(corpusAssertingEveryLeaf("written-ticket"));
  const chat = stubChat({
    values: Object.fromEntries(ALL_LEAVES.map((leaf) => [leaf, null])),
  });

  const results = await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });
  expect(chat.calls.length).toBeGreaterThan(0);

  const score = scoreEvalRun(corpus, results);
  // The zeroes are real: there were judged cells to be wrong about.
  expect(score.totals.judged).toBeGreaterThan(0);
  expect(score.totals.answered).toBe(0);
  expect(score.totals.answerRate).toBe(0);
  expect(score.totals.accuracyOverAll).toBe(0);
  // Nothing was answered, so there is no accuracy over what was answered.
  expect(score.totals.accuracyOverAnswered).toBeNull();
  // Every leaf abstained, so every asserted leaf is missed.
  for (const leaf of ALL_LEAVES) {
    expect(score.cases[0]?.cells[leaf]?.verdict).toBe("missed");
  }
});

test("a run that answers one cell is perfect over what it answered and poor over all", async () => {
  const corpus = loadCorpus(corpusAssertingEveryLeaf("written-ticket"));
  const chat = stubChat({
    values: {
      ...Object.fromEntries(ALL_LEAVES.map((leaf) => [leaf, null])),
      "service.date": "2026-02-04",
    },
  });

  const results = await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });
  expect(chat.calls.length).toBeGreaterThan(0);

  const score = scoreEvalRun(corpus, results);
  expect(score.totals.accuracyOverAnswered).toBe(1);
  expect(score.totals.answerRate).toBeLessThan(1);
  expect(score.totals.accuracyOverAll).toBeLessThan(1);
  // The three rates travel together: a caller cannot read one without the
  // other two.
  expect(score.totals).toHaveProperty("answerRate");
  expect(score.totals).toHaveProperty("accuracyOverAll");
});

test("a value where the corpus declared absence is a hallucination, and is counted", async () => {
  const corpus = loadCorpus(corpusWithout("spoken-note"));
  const chat = stubChat();

  const results = await runEval(corpus, chat, { strategies: ["single-shot"], model: "ribo-test" });
  expect(chat.calls.length).toBeGreaterThan(0);

  const score = scoreEvalRun(corpus, results);
  const cells = score.cases[0]?.cells ?? {};
  // The spoken-note case's defaults declare the service scope absent.
  expect(cells["service.date"]?.verdict).toBe("hallucinated");
  expect(cells["service.notes"]?.verdict).toBe("hallucinated");
  expect(score.totals.hallucinated).toBe(2);
  // A hallucinated cell is answered: the run said something.
  expect(score.totals.answered).toBe(score.totals.judged);
  // No hallucinated cell is dropped from the dense grid.
  expect(Object.keys(cells).sort()).toEqual([...score.leafPaths].sort());
});

test("the same run scores identically against a round-tripped schema and a hand-built one", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const cases = corpus.cases.map((entry) => {
    const [input] = entry.inputs;
    if (input === undefined || input.kind === "document") {
      throw new Error("the fixture case holds a document input");
    }
    return { id: entry.id, text: input.text };
  });

  // The same schema, built by hand: the fixture's bicycle workshop.
  const built = z.object({
    frame: z.object({ material: z.string(), serial: z.string() }),
    service: z.object({ date: z.string(), notes: z.string() }),
  });

  const loadedChat = stubChat();
  const loaded = await runEvalOverSchema({
    schema: corpus.schema,
    prompt: corpus.manifest.prompt,
    manifestName: corpus.manifest.name,
    cases,
    chat: loadedChat,
    settings: { strategies: ["single-shot"], model: "ribo-test" },
  });

  const builtChat = stubChat();
  const builtRun = await runEvalOverSchema({
    schema: built,
    prompt: corpus.manifest.prompt,
    manifestName: corpus.manifest.name,
    cases,
    chat: builtChat,
    settings: { strategies: ["single-shot"], model: "ribo-test" },
  });

  // The comparison is over real data: both runs produced the same fields.
  expect(builtChat.calls.length).toBe(loadedChat.calls.length);
  expect(builtRun.map((entry) => entry.fields)).toEqual(loaded.map((entry) => entry.fields));

  const loadedScore = scoreEvalRun(corpus, loaded);
  const builtScore = scoreEvalOverSchema({
    schema: built,
    cases: corpus.cases.map((entry) => ({
      id: entry.id,
      expected: entry.expected,
      defaults: entry.defaults,
    })),
    results: builtRun,
  });

  expect(loadedScore.leafPaths).toEqual(builtScore.leafPaths);
  expect(loadedScore.leafPaths.length).toBeGreaterThan(0);
  expect(loadedScore.cases.length).toBe(builtScore.cases.length);
  for (const [index, entry] of loadedScore.cases.entries()) {
    expect(Object.keys(entry.cells).length).toBeGreaterThan(0);
    expect(builtScore.cases[index]?.cells).toEqual(entry.cells);
  }
  expect(builtScore.totals).toEqual(loadedScore.totals);
});
