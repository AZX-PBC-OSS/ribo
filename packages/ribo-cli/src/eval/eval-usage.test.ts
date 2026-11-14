/**
 * @file The call accounting: what a run is metered, and what the meter says.
 *
 * The presence bound is read from the inspect command's own `describeCalls`
 * for the same schema and caps — the one place a call count is compared for
 * equality against a number the report computes. Every other count in this
 * suite is an at-most bound, a comparison between two runs' own counts, or the
 * meter agreeing with the requests the stub received. The retry fixture pins
 * the last of those: the reported count and the requests the stub received are
 * the same number.
 */
import { ChatError, describeExtraction, scriptedChat } from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import { describeCalls } from "../inspect/calls.js";
import { runEval, runEvalOverSchema } from "./run.js";
import { replyFor, stubChat } from "./test-support/stub-chat.js";
import { FIXTURE_SPLIT_CORPUS, corpusWithCases, removeTemporaries } from "./test-support/corpus.js";
import type { EvalSplitCaps } from "./types.js";

afterEach(() => {
  removeTemporaries();
});

/** The byte cap the split fixture's groups are packed under. */
const CAPS: EvalSplitCaps = { maxSerializedCharsPerGroup: 1500 };

// ---------------------------------------------------------------------------
// The presence bound
// ---------------------------------------------------------------------------

test("the presence-narrowed calls equal the presence bound on an all-present fixture", async () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const calls = describeCalls(describeExtraction({ schema: corpus.schema, ...CAPS }), CAPS);
  // The bound exists: the fixture's groups split into several pieces.
  expect(calls.presenceNarrowedAtMost).not.toBeNull();

  const chat = stubChat();
  const results = await runEval(corpus, chat, {
    strategies: ["presence-narrowed"],
    model: "ribo-test",
    splitCaps: CAPS,
  });

  expect(results[0]?.usage?.calls).toBe(calls.presenceNarrowedAtMost);
  // And the meter agrees with what the stub was asked for.
  // Must-fail: an implementation that bills one fill call per group — the
  // fixture's groups each split into two pieces under this cap, so the fill
  // makes four calls, not two — fails the equality above.
  expect(chat.calls.length).toBe(calls.presenceNarrowedAtMost);
});

test("a group presence finds empty costs strictly fewer calls than the bound", async () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const calls = describeCalls(describeExtraction({ schema: corpus.schema, ...CAPS }), CAPS);
  expect(calls.presenceNarrowedAtMost).not.toBeNull();

  // The site's leaves are absent: presence asks about the group, is told
  // nothing in it is discussed, and the fill never asks about it.
  const chat = stubChat({
    absentLeaves: ["siteName", "address", "technician", "visits", "accessNotes", "alarms"],
  });
  const results = await runEval(corpus, chat, {
    strategies: ["presence-narrowed"],
    model: "ribo-test",
    splitCaps: CAPS,
  });

  expect(results[0]?.usage?.calls).toBeLessThan(calls.presenceNarrowedAtMost ?? 0);
  expect(chat.calls.length).toBe(results[0]?.usage?.calls);
});

// ---------------------------------------------------------------------------
// The retry
// ---------------------------------------------------------------------------

test("the reported call count equals the requests the stub received, retries included", async () => {
  const corpus = loadCorpus(corpusWithCases("spoken-note"));
  const spoken = corpus.cases.find((entry) => entry.id === "spoken-note");
  if (spoken === undefined) throw new Error("the fixture lost its case");
  if (spoken.input.kind === "document") throw new Error("the fixture case is a document case");

  // The first attempt fails transiently; the retry succeeds.
  const chat = scriptedChat((request, context) => {
    if (context.call === 0) throw ChatError.transport("the uplink dropped");
    return { content: replyFor(request) };
  });

  const results = await runEvalOverSchema({
    schema: corpus.schema,
    prompt: corpus.manifest.prompt,
    manifestName: corpus.manifest.name,
    cases: [{ id: spoken.id, kind: spoken.input.kind, text: spoken.input.text }],
    chat,
    settings: { strategies: ["per-group"], model: "ribo-test" },
    // The retry never waits real backoff.
    delay: () => Promise.resolve(),
  });

  // The retry happened...
  expect(chat.calls.length).toBeGreaterThan(1);
  // ...and the meter counts it.
  // Must-fail: an implementation that counts attempts without the retries, or
  // that reports a count of its own, fails this assertion.
  expect(results[0]?.usage?.calls).toBe(chat.calls.length);
});
