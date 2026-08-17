import { describe, expect, test } from "vitest";

import { buildDefinition } from "./definition.js";

/**
 * Builder tests for the `definition` form part — the Task 5 must-fail tests from
 * `docs/roadmap/design/managed-transcription-plan.md`, driven at the pure builder.
 *
 * The request-body-level wiring is asserted in `transcribe.test.ts`; this file
 * pins the shape the builder produces directly, because a plausible-looking wrong
 * key (`phrase_list`, `phraseHints`, a bare array) is silently ignored by the
 * service — no error, just worse transcription (design §6).
 */

describe("buildDefinition — phrase list", () => {
  test("supplied terms appear at definition.phraseList.phrases with the exact nesting", () => {
    const definition = buildDefinition(["R-19", "CFM50", "blower door"]);

    // The exact nesting is load-bearing: `phraseList.phrases` is the only key
    // the service reads. A sibling like `phrase_list` or a bare array is
    // silently ignored, so assert the shape rather than merely "it has phrases".
    expect(definition.phraseList).toBeDefined();
    expect(definition.phraseList).toEqual({ phrases: ["R-19", "CFM50", "blower door"] });
  });

  test("no terms supplied omits phraseList entirely rather than sending an empty object or array", () => {
    const definition = buildDefinition(undefined);

    // An empty phrase list is no phrase list. Sending `phraseList: { phrases: [] }`
    // or `phraseList: {}` would be a meaningless part the service did not ask for;
    // asserting the key is absent (not merely empty) catches a builder that
    // always attaches the object.
    expect(definition.phraseList).toBeUndefined();
    expect("phraseList" in definition).toBe(false);
  });

  test("locales is still present when a phrase list is supplied", () => {
    const definition = buildDefinition(["R-19"]);

    // A builder that *replaces* the definition instead of extending it would
    // pass a naive phrase-list test while silently breaking language selection.
    // `locales` must survive alongside `phraseList`.
    expect(definition.locales).toEqual(["en-US"]);
    expect(definition.phraseList).toBeDefined();
  });

  test("blank/whitespace-only terms are dropped, and an all-blank list omits phraseList", () => {
    // Trimming keeps a stray space from becoming a phrase the service biases on,
    // and an all-blank list is treated as no list at all — same omission as the
    // no-terms case, so the request never carries an empty `phrases` array.
    const trimmed = buildDefinition(["  R-19  ", "  ", "CFM50"]);
    expect(trimmed.phraseList?.phrases).toEqual(["R-19", "CFM50"]);

    const allBlank = buildDefinition(["  ", ""]);
    expect(allBlank.phraseList).toBeUndefined();
  });
});
