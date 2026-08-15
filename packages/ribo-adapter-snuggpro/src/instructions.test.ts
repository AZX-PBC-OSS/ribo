import { buildGroupMessages } from "@azx/ribo-extractor-openai";
import type { ExtractionTarget } from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { snuggProAdapter } from "./adapter.js";
import { snuggExamples } from "./examples.js";
import {
  SNUGG_GROUP_KEYS,
  SNUGG_RULES,
  snuggGroupInstructions,
  snuggProInstructions,
} from "./instructions.js";
import type { SnuggValues } from "./schema.js";

/**
 * @file R3 Task 4 — per-group prompt tests.
 *
 * Five tests that must be able to FAIL, one per plan requirement. Each covers a
 * distinct correctness property of the per-group prompt assembly; the "prove they
 * can fail" step (breaking the implementation and confirming the test goes red)
 * is reported separately in the task report.
 *
 *   1. A group's prompt contains its own rules and **not** another group's.
 *   2. **Every** group's prompt contains the universal rules.
 *   3. A group's prompt names that group as the **sole** top-level key.
 *   4. The projected example carries only that group's fields, transcript unchanged.
 *   5. **No rule is lost** — every numbered rule appears in at least one group's
 *      prompt. A rule belonging to no group is a silent accuracy regression.
 *
 * These tests live on the adapter side because the rule-to-group mapping is
 * adapter-specific knowledge (`snuggGroupInstructions`). The generic projection
 * and message assembly (`buildGroupMessages`, `projectExample`) are tested in
 * `per-group.test.ts` on the extractor side.
 */

// --- Helpers ------------------------------------------------------------------

/**
 * A distinctive phrase from each rule — unique enough to identify the rule's
 * presence in a prompt without matching unrelated text. Drawn from the rule's
 * bold heading, which is the first thing in the rule's text.
 */
const RULE_MARKERS: readonly string[] = [
  "Extract only what was actually said",
  "is a correct answer",
  "character-for-character substring",
  "may still carry a",
  "When the auditor corrects themselves",
  "Only the auditor's own observations count",
  "Fuel is a SEPARATE axis",
  "Attic insulation: a depth band",
  "Health & safety is a fixed matrix",
  "Efficiency (AFUE / SEER / HSPF) has NO field",
  "Enum members are exact strings",
  "Numbers spoken as words become numerals",
  "is a number from 0 to 1",
];

/** The group-specific rules (7–10) and the groups they belong to. */
const GROUP_SPECIFIC_RULES: ReadonlyArray<{
  readonly rule: number;
  readonly marker: string;
  readonly groups: readonly string[];
}> = [
  { rule: 7, marker: RULE_MARKERS[6]!, groups: ["hvac", "dhw"] },
  { rule: 8, marker: RULE_MARKERS[7]!, groups: ["attic", "dhw"] },
  { rule: 9, marker: RULE_MARKERS[8]!, groups: ["health"] },
  { rule: 10, marker: RULE_MARKERS[9]!, groups: ["hvac"] },
];

/** Groups that should NOT see a given group-specific rule. */
const OTHER_GROUPS = (ruleGroups: readonly string[]): readonly string[] =>
  SNUGG_GROUP_KEYS.filter((k) => !ruleGroups.includes(k));

// The adapter as an ExtractionTarget — the shape `buildGroupMessages` reads.
const target: ExtractionTarget<SnuggValues> = {
  name: snuggProAdapter.name,
  extractionSchema: snuggProAdapter.extractionSchema,
  instructions: snuggProAdapter.instructions,
  examples: snuggProAdapter.examples,
};

const example = snuggExamples[0];
if (!example) throw new Error("expected the Snugg Pro adapter to carry a few-shot example");

// --- Test 1: own rules, not another group's ----------------------------------

describe("per-group instructions — own rules, not another group's", () => {
  test("a group's prompt contains its own group-specific rules", () => {
    for (const { marker, groups } of GROUP_SPECIFIC_RULES) {
      for (const key of groups) {
        const prompt = snuggGroupInstructions(key);
        expect(prompt, `group "${key}" should contain rule: ${marker}`).toContain(marker);
      }
    }
  });

  test("a group's prompt does NOT contain another group's rules", () => {
    for (const { marker, groups } of GROUP_SPECIFIC_RULES) {
      for (const key of OTHER_GROUPS(groups)) {
        const prompt = snuggGroupInstructions(key);
        expect(prompt, `group "${key}" should NOT contain rule: ${marker}`).not.toContain(marker);
      }
    }
  });
});

// --- Test 2: every group's prompt contains the universal rules ----------------

describe("per-group instructions — universal rules in every group", () => {
  test("every group's prompt contains all universal rules (1–6, 11–13)", () => {
    const universalMarkers = [0, 1, 2, 3, 4, 5, 10, 11, 12].map((i) => RULE_MARKERS[i]!);
    for (const key of SNUGG_GROUP_KEYS) {
      const prompt = snuggGroupInstructions(key);
      for (const marker of universalMarkers) {
        expect(prompt, `group "${key}" should contain universal rule: ${marker}`).toContain(marker);
      }
    }
  });
});

// --- Test 3: a group's prompt names that group as the sole top-level key ------

describe("per-group instructions — sole top-level key", () => {
  test("each group's output section asserts exactly one top-level key", () => {
    for (const key of SNUGG_GROUP_KEYS) {
      const prompt = snuggGroupInstructions(key);
      // The per-group output section must say "exactly one top-level key".
      expect(prompt, `group "${key}"`).toContain("exactly one top-level key");
      // And must name the group's key specifically.
      expect(prompt, `group "${key}"`).toContain(`\`${key}\``);
      // And must NOT say "seven top-level keys" (the full-prompt output section).
      expect(prompt, `group "${key}"`).not.toContain("seven top-level keys");
    }
  });

  test("the full instructions still assert seven top-level keys", () => {
    // The single-shot path keeps the full output section — this is the guard
    // against accidentally changing the full instructions too.
    expect(snuggProInstructions).toContain("seven top-level keys");
  });
});

// --- Test 4: projected example carries only that group's fields ----------------

describe("per-group instructions — projected example", () => {
  test("the projected example carries only that group's fields, and its transcript is unchanged", () => {
    const liveTranscript = "Live transcript for the test.";
    for (const key of SNUGG_GROUP_KEYS) {
      const messages = buildGroupMessages(target, key, liveTranscript, snuggGroupInstructions);

      // With one example, the message structure is:
      //   [0] system  — per-group instructions
      //   [1] user    — example transcript
      //   [2] assistant — example fields (projected)
      //   [3] user    — live transcript
      expect(messages).toHaveLength(4);

      // The system message is the per-group instructions, not the full ones.
      expect(messages[0]!.content).toBe(snuggGroupInstructions(key));
      expect(messages[0]!.content).not.toBe(snuggProInstructions);

      // The example transcript (user turn) is unchanged.
      expect(messages[1]).toEqual({ role: "user", content: example.transcript });

      // The assistant turn carries only this group's key.
      const assistantContent = JSON.parse(messages[2]!.content) as Record<string, unknown>;
      expect(Object.keys(assistantContent), `group "${key}" example fields`).toEqual([key]);
      const expectedFields = (example.fields as Record<string, unknown>)[key];
      expect(assistantContent[key]).toEqual(expectedFields);

      // The live transcript is the final user message.
      expect(messages[3]).toEqual({ role: "user", content: liveTranscript });
    }
  });
});

// --- Test 5: no rule is lost --------------------------------------------------

describe("per-group instructions — no rule is lost", () => {
  test("every numbered rule appears in at least one group's prompt", () => {
    // A rule that belongs to no group — dropped from the mapping or assigned to
    // a non-existent group — is a silent accuracy regression: nothing fails, the
    // model just gets worse. This test catches that by checking every rule in
    // SNUGG_RULES appears in at least one group's prompt.
    for (const rule of SNUGG_RULES) {
      const marker = RULE_MARKERS[rule.number - 1];
      if (!marker) throw new Error(`no marker for rule ${rule.number}`);

      const appearsInSomeGroup = SNUGG_GROUP_KEYS.some((key) =>
        snuggGroupInstructions(key).includes(marker),
      );

      expect(
        appearsInSomeGroup,
        `rule ${rule.number} ("${marker}") must appear in at least one group's prompt`,
      ).toBe(true);
    }
  });

  test("the rule count is 13 — adding or removing a rule is a conscious decision", () => {
    // A guard against accidentally deleting a rule entry: the count is pinned so
    // a dropped entry makes this test fail before the "no rule lost" test even
    // needs to identify which one.
    expect(SNUGG_RULES).toHaveLength(13);
    expect(SNUGG_RULES.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });
});
