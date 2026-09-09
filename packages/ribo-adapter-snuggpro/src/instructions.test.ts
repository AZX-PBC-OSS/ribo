import { buildGroupMessages } from "@azx/ribo-extractor-openai";
import type { ExtractionTarget } from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { snuggProAdapter } from "./adapter.js";
import { snuggExamples } from "./examples.js";
import {
  SNUGG_GROUP_KEYS,
  SNUGG_RULES,
  snuggGroupFillInstructions,
  snuggGroupInstructions,
  snuggProInstructions,
  TRANSCRIPT_SECTION,
} from "./instructions.js";
import type { FillScope } from "./instructions.js";
import type { SnuggValues } from "./schema.js";

/**
 * @file Per-group prompt tests: each group's prompt carries its own rules (not another
 * group's), the universal rules, and that group as the sole top-level key; the projected
 * example carries only that group's fields; and no rule is lost — a rule belonging to no
 * group is a silent accuracy regression.
 *
 * These live on the adapter side because the rule-to-group mapping is adapter-specific
 * (`snuggGroupInstructions`). The generic projection and message assembly are tested in
 * `per-group.test.ts` on the extractor side.
 */

// --- Helpers ------------------------------------------------------------------

/** A distinctive phrase per rule — drawn from the rule's bold heading, unique enough to
 * identify the rule's presence without matching unrelated text. */
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
  "Efficiency (AFUE / SEER / HSPF) is recorded ONLY when a number was stated",
  "Enum members are exact strings",
  "Numbers spoken as words become numerals",
  "is a number from 0 to 1",
  "A concern is the HOMEOWNER's",
  "is the SPOKEN rebate name",
  "A vault is a vaulted / cathedral ceiling",
  "is AUTHORED report copy",
];

/** The group-specific rules and the groups they belong to. */
const GROUP_SPECIFIC_RULES: ReadonlyArray<{
  readonly rule: number;
  readonly marker: string;
  readonly groups: readonly string[];
}> = [
  { rule: 7, marker: RULE_MARKERS[6]!, groups: ["hvac", "dhw"] },
  { rule: 8, marker: RULE_MARKERS[7]!, groups: ["attic", "vault", "dhw"] },
  { rule: 9, marker: RULE_MARKERS[8]!, groups: ["health"] },
  { rule: 10, marker: RULE_MARKERS[9]!, groups: ["hvac"] },
  { rule: 14, marker: RULE_MARKERS[13]!, groups: ["concern"] },
  { rule: 15, marker: RULE_MARKERS[14]!, groups: ["incentive"] },
  { rule: 16, marker: RULE_MARKERS[15]!, groups: ["vault"] },
  { rule: 17, marker: RULE_MARKERS[16]!, groups: ["report"] },
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
      expect(prompt, `group "${key}"`).toContain("exactly one top-level key");
      expect(prompt, `group "${key}"`).toContain(`\`${key}\``);
      // The per-group prompt must not carry the full-prompt output section's wording.
      expect(prompt, `group "${key}"`).not.toContain("twelve top-level keys");
    }
  });

  test("the full instructions still assert twelve top-level keys", () => {
    // The single-shot path keeps the full output section — guard against changing it too.
    expect(snuggProInstructions).toContain("twelve top-level keys");
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

      expect(messages[0]!.content).toBe(snuggGroupInstructions(key));
      expect(messages[0]!.content).not.toBe(snuggProInstructions);

      expect(messages[1]).toEqual({ role: "user", content: example.transcript });

      // The assistant turn carries only this group's key.
      const assistantContent = JSON.parse(messages[2]!.content) as Record<string, unknown>;
      expect(Object.keys(assistantContent), `group "${key}" example fields`).toEqual([key]);
      const expectedFields = (example.fields as Record<string, unknown>)[key];
      expect(assistantContent[key]).toEqual(expectedFields);

      expect(messages[3]).toEqual({ role: "user", content: liveTranscript });
    }
  });
});

// --- Test 5: no rule is lost --------------------------------------------------

describe("per-group instructions — no rule is lost", () => {
  test("every numbered rule appears in at least one group's prompt", () => {
    // A rule dropped from the mapping or assigned to a non-existent group is a silent
    // accuracy regression: nothing fails, the model just gets worse.
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

  test("the rule count is pinned — adding or removing a rule is a conscious decision", () => {
    // A dropped rule entry fails here before the "no rule lost" test even needs to
    // identify which one.
    expect(SNUGG_RULES).toHaveLength(17);
    expect(SNUGG_RULES.map((r) => r.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });
});

// --- Task 10 — scoped per-instance fill instructions ------------------------

describe("snuggGroupFillInstructions", () => {
  const fillScope = (positiveIndex = 0): FillScope => ({
    groupKey: "hvac",
    positive: {
      mentionSpan: "the basement furnace",
      discriminator: "the basement furnace",
      distinguishedBy: positiveIndex === 0 ? null : "the basement furnace",
      eligibility: "current",
      eligibilitySpan: null,
    },
    positiveIndex,
    siblings: [
      {
        mentionSpan: "the attic heat pump",
        discriminator: "the attic heat pump",
        distinguishedBy: "the attic heat pump",
        eligibility: "current",
        eligibilitySpan: null,
      },
    ],
    excluded: [
      {
        mentionSpan: "the old boiler",
        discriminator: "the old boiler",
        distinguishedBy: null,
        eligibility: "decommissioned",
        eligibilitySpan: "the old boiler is decommissioned and capped off",
      },
    ],
  });

  test("the scope block names the positive record, siblings, and excluded candidates", () => {
    const prompt = snuggGroupFillInstructions("hvac", fillScope(0));

    expect(prompt).toContain("the basement furnace");
    expect(prompt).toContain("the attic heat pump");
    expect(prompt).toContain("the old boiler");
    expect(prompt).toContain("the old boiler is decommissioned and capped off");
  });

  test("the scope block is inserted before the transcript section", () => {
    const prompt = snuggGroupFillInstructions("hvac", fillScope(0));

    expect(prompt.endsWith(TRANSCRIPT_SECTION)).toBe(true);
    const transcriptIdx = prompt.indexOf(TRANSCRIPT_SECTION);
    const scopeIdx = prompt.indexOf("## Scope");
    expect(scopeIdx).toBeGreaterThanOrEqual(0);
    expect(scopeIdx).toBeLessThan(transcriptIdx);
  });

  test("the fill prompt still carries the per-group rules and output section", () => {
    const prompt = snuggGroupFillInstructions("hvac", fillScope(0));

    // A group-specific rule (rule 10) and the one-key output section survive.
    expect(prompt).toContain("Efficiency (AFUE / SEER / HSPF) is recorded ONLY when");
    expect(prompt).toContain("exactly one top-level key");
    expect(prompt).toContain("`hvac`");
  });

  test("a second instance distinguishes itself with a non-null span", () => {
    const prompt = snuggGroupFillInstructions("hvac", fillScope(1));

    expect(prompt).toContain('Distinguished from earlier instances by: "the basement furnace"');
  });
});
