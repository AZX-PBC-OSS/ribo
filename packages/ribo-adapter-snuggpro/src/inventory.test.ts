import { z } from "zod";
import { describe, expect, test } from "vitest";

import { TRANSCRIPT_SECTION } from "./instructions.js";
import { rosterCandidateSchema, rosterSchema, snuggInventoryInstructions } from "./inventory.js";

/**
 * Must-fail tests for the inventory roster schema and instructions (Task 9).
 * All assertions are schema-level or string-level; no model, no network.
 */

describe("rosterCandidateSchema", () => {
  test("rejects a candidate without mentionSpan", () => {
    const candidate = {
      discriminator: "the boiler",
      distinguishedBy: null,
      eligibility: "current" as const,
      eligibilitySpan: null,
    };
    const parsed = rosterCandidateSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  test("rejects a non-current eligibility without eligibilitySpan", () => {
    // The discriminated union requires eligibilitySpan to be a string when
    // eligibility is not "current".
    const candidate = {
      mentionSpan: "the old boiler",
      discriminator: "the old boiler",
      distinguishedBy: null,
      eligibility: "decommissioned" as const,
      eligibilitySpan: null,
    };
    const parsed = rosterCandidateSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  test("accepts a current candidate with eligibilitySpan null", () => {
    const candidate = {
      mentionSpan: "the boiler",
      discriminator: "the boiler",
      distinguishedBy: null,
      eligibility: "current" as const,
      eligibilitySpan: null,
    };
    expect(rosterCandidateSchema.safeParse(candidate).success).toBe(true);
  });

  test("accepts an excluded candidate with a non-null eligibilitySpan", () => {
    const candidate = {
      mentionSpan: "the old boiler",
      discriminator: "the old boiler",
      distinguishedBy: null,
      eligibility: "decommissioned" as const,
      eligibilitySpan: "the old boiler is decommissioned",
    };
    expect(rosterCandidateSchema.safeParse(candidate).success).toBe(true);
  });
});

describe("rosterSchema", () => {
  const emptyGroup = () =>
    z
      .array(
        z.object({
          mentionSpan: z.string(),
          discriminator: z.string(),
          distinguishedBy: z.string().nullable(),
          eligibility: z.string(),
          eligibilitySpan: z.string().nullable(),
        }),
      )
      .parse([]);

  test("rejects a second candidate in a group without distinguishedBy", () => {
    const first = {
      mentionSpan: "the furnace in the basement",
      discriminator: "the basement furnace",
      distinguishedBy: null,
      eligibility: "current" as const,
      eligibilitySpan: null,
    };
    const second = {
      mentionSpan: "the other one in the attic",
      discriminator: "the attic unit",
      distinguishedBy: null,
      eligibility: "current" as const,
      eligibilitySpan: null,
    };
    const roster = {
      hvac: [first, second],
      attic: emptyGroup(),
      wall: emptyGroup(),
      window: emptyGroup(),
      dhw: emptyGroup(),
    };
    const parsed = rosterSchema.safeParse(roster);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("distinguishedBy");
  });

  test("accepts the first candidate with distinguishedBy null", () => {
    const roster = {
      hvac: [
        {
          mentionSpan: "the furnace in the basement",
          discriminator: "the basement furnace",
          distinguishedBy: null,
          eligibility: "current" as const,
          eligibilitySpan: null,
        },
      ],
      attic: emptyGroup(),
      wall: emptyGroup(),
      window: emptyGroup(),
      dhw: emptyGroup(),
    };
    expect(rosterSchema.safeParse(roster).success).toBe(true);
  });

  test("accepts a second candidate when distinguishedBy is non-null", () => {
    const roster = {
      hvac: [
        {
          mentionSpan: "the furnace in the basement",
          discriminator: "the basement furnace",
          distinguishedBy: null,
          eligibility: "current" as const,
          eligibilitySpan: null,
        },
        {
          mentionSpan: "the other one in the attic",
          discriminator: "the attic unit",
          distinguishedBy: "the other one in the attic",
          eligibility: "current" as const,
          eligibilitySpan: null,
        },
      ],
      attic: emptyGroup(),
      wall: emptyGroup(),
      window: emptyGroup(),
      dhw: emptyGroup(),
    };
    expect(rosterSchema.safeParse(roster).success).toBe(true);
  });

  test("a group the transcript never mentions is valid as an empty list", () => {
    const roster = {
      hvac: [],
      attic: [],
      wall: [],
      window: [],
      dhw: [],
    };
    const parsed = rosterSchema.safeParse(roster);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.hvac).toHaveLength(0);
  });
});

describe("snuggInventoryInstructions", () => {
  test("keeps the transcript injection boundary last", () => {
    // The instructions must end with the exact transcript section, so a
    // transcript appended after it is strictly data and never instructions.
    expect(snuggInventoryInstructions.endsWith(TRANSCRIPT_SECTION)).toBe(true);
  });

  test("mentions all five collection groups and the roster fields", () => {
    expect(snuggInventoryInstructions).toContain("hvac");
    expect(snuggInventoryInstructions).toContain("attic");
    expect(snuggInventoryInstructions).toContain("wall");
    expect(snuggInventoryInstructions).toContain("window");
    expect(snuggInventoryInstructions).toContain("dhw");
    expect(snuggInventoryInstructions).toContain("mentionSpan");
    expect(snuggInventoryInstructions).toContain("distinguishedBy");
    expect(snuggInventoryInstructions).toContain("eligibilitySpan");
  });
});
