import { z } from "zod";
import { describe, expect, test } from "vitest";

import { TRANSCRIPT_SECTION } from "./instructions.js";
import {
  rosterCandidateSchema,
  rosterGroupSchema,
  rosterSchema,
  snuggInventoryInstructions,
} from "./inventory.js";

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
    // The discriminated union requires a string eligibilitySpan when eligibility is not
    // "current".
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
      vault: emptyGroup(),
      wall: emptyGroup(),
      window: emptyGroup(),
      dhw: emptyGroup(),
      concern: emptyGroup(),
      incentive: emptyGroup(),
      clothesDryer: emptyGroup(),
      freezer: emptyGroup(),
      range: emptyGroup(),
      refrigerator: emptyGroup(),
      pv: emptyGroup(),
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
      vault: emptyGroup(),
      wall: emptyGroup(),
      window: emptyGroup(),
      dhw: emptyGroup(),
      concern: emptyGroup(),
      incentive: emptyGroup(),
      clothesDryer: emptyGroup(),
      freezer: emptyGroup(),
      range: emptyGroup(),
      refrigerator: emptyGroup(),
      pv: emptyGroup(),
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
      vault: emptyGroup(),
      wall: emptyGroup(),
      window: emptyGroup(),
      dhw: emptyGroup(),
      concern: emptyGroup(),
      incentive: emptyGroup(),
      clothesDryer: emptyGroup(),
      freezer: emptyGroup(),
      range: emptyGroup(),
      refrigerator: emptyGroup(),
      pv: emptyGroup(),
    };
    expect(rosterSchema.safeParse(roster).success).toBe(true);
  });

  test("a group the transcript never mentions is valid as an empty list", () => {
    const roster = {
      hvac: [],
      attic: [],
      vault: [],
      wall: [],
      window: [],
      dhw: [],
      concern: [],
      incentive: [],
      clothesDryer: [],
      freezer: [],
      range: [],
      refrigerator: [],
      pv: [],
    };
    const parsed = rosterSchema.safeParse(roster);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.hvac).toHaveLength(0);
  });
});

describe("rosterGroupSchema — stated none union value", () => {
  test("an empty array still succeeds (no candidates recorded, unchanged)", () => {
    expect(rosterGroupSchema.safeParse([]).success).toBe(true);
  });

  test("a stated-none object with a span succeeds", () => {
    expect(rosterGroupSchema.safeParse({ stated: "none", span: "there's no attic" }).success).toBe(
      true,
    );
  });

  test("a stated-none object missing span fails", () => {
    expect(rosterGroupSchema.safeParse({ stated: "none" }).success).toBe(false);
  });

  test("a stated-none object with an empty string span fails", () => {
    expect(rosterGroupSchema.safeParse({ stated: "none", span: "" }).success).toBe(false);
  });
});

describe("snuggInventoryInstructions", () => {
  test("keeps the transcript injection boundary last", () => {
    // Ending with the exact transcript section makes an appended transcript strictly
    // data, never instructions.
    expect(snuggInventoryInstructions.endsWith(TRANSCRIPT_SECTION)).toBe(true);
  });

  test("mentions every collection group and the roster fields", () => {
    expect(snuggInventoryInstructions).toContain("hvac");
    expect(snuggInventoryInstructions).toContain("attic");
    expect(snuggInventoryInstructions).toContain("vault");
    expect(snuggInventoryInstructions).toContain("wall");
    expect(snuggInventoryInstructions).toContain("window");
    expect(snuggInventoryInstructions).toContain("dhw");
    expect(snuggInventoryInstructions).toContain("concern");
    expect(snuggInventoryInstructions).toContain("incentive");
    expect(snuggInventoryInstructions).toContain("clothesDryer");
    expect(snuggInventoryInstructions).toContain("freezer");
    expect(snuggInventoryInstructions).toContain("range");
    expect(snuggInventoryInstructions).toContain("refrigerator");
    expect(snuggInventoryInstructions).toContain("pv");
    expect(snuggInventoryInstructions).toContain("mentionSpan");
    expect(snuggInventoryInstructions).toContain("distinguishedBy");
    expect(snuggInventoryInstructions).toContain("eligibilitySpan");
  });
});
