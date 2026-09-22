import { describe, expect, test } from "vitest";

import { snuggValuesSchema } from "../schema.js";
import { prunePersistedValues } from "./prune-persisted.js";

/**
 * A persisted review outcome's `fields` is a loose record read back after schema
 * changes. The contract under test: keys `snuggValuesSchema` no longer declares go —
 * a top-level group key or a leaf inside a group — and every declared key's value
 * survives untouched, `null` included (a `null` means "write this field empty", never
 * "leave this out").
 */

// A mid-flight session's outcome stranded by the removal of the unwritable `job`
// creation leaves: one leaf the schema still declares beside one it no longer does.
const strandedJobOutcome = {
  job: {
    serviceTime: "2026-09-18 09:00:00",
    firstName: "Dana",
  },
};

describe("prunePersistedValues", () => {
  test("prunes a removed `job` leaf, keeps the declared one, and the result parses", () => {
    const pruned = prunePersistedValues(strandedJobOutcome);
    const job = pruned.job as Record<string, unknown>;
    expect(Object.hasOwn(job, "serviceTime")).toBe(true);
    expect(job.serviceTime).toBe("2026-09-18 09:00:00");
    expect(Object.hasOwn(job, "firstName")).toBe(false);
    // The bug, stated as an assertion: without pruning, the strict patch schema
    // rejects the outcome and the write step marks the session dead.
    expect(() => snuggValuesSchema.parse(pruned)).not.toThrow();
  });

  test("prunes every instance of a collection group, preserving length and order", () => {
    const fields = {
      hvac: [
        { hvacSystemEquipmentType: "Boiler", hvacNotes: "old upstairs unit" },
        {
          hvacSystemEquipmentType: "Furnace with standalone ducts",
          hvacNotes: "added last winter",
        },
      ],
    };
    const pruned = prunePersistedValues(fields);
    const hvac = pruned.hvac as Record<string, unknown>[];
    expect(hvac).toHaveLength(2);
    expect(hvac[0]?.hvacSystemEquipmentType).toBe("Boiler");
    expect(hvac[1]?.hvacSystemEquipmentType).toBe("Furnace with standalone ducts");
    expect(Object.hasOwn(hvac[0]!, "hvacNotes")).toBe(false);
    expect(Object.hasOwn(hvac[1]!, "hvacNotes")).toBe(false);
  });

  test("is idempotent — pruning twice yields exactly what pruning once yields", () => {
    const fields = {
      ...strandedJobOutcome,
      hvac: [{ hvacSystemEquipmentType: "Boiler", hvacNotes: "old upstairs unit" }],
      prefill: { whatever: 1 },
    };
    const once = prunePersistedValues(fields);
    expect(prunePersistedValues(once)).toEqual(once);
  });

  test("leaves surviving values present and untouched — `null` included", () => {
    // Presence assertions, not equality between two pruned results: a comparison of
    // an optional member across two outputs passes when the member vanishes from both,
    // which guards agreement rather than presence.
    const fields = {
      basedata: { yearBuilt: 1998, blowerDoorReading: null, sidingNotes: "aluminum" },
      health: { healthAmbientCarbonMonoxide: "Passed" },
    };
    const pruned = prunePersistedValues(fields);
    const basedata = pruned.basedata as Record<string, unknown>;
    expect(Object.hasOwn(basedata, "yearBuilt")).toBe(true);
    expect(basedata.yearBuilt).toBe(1998);
    expect(Object.hasOwn(basedata, "blowerDoorReading")).toBe(true);
    expect(basedata.blowerDoorReading).toBeNull();
    expect(Object.hasOwn(basedata, "sidingNotes")).toBe(false);
    const health = pruned.health as Record<string, unknown>;
    expect(Object.hasOwn(health, "healthAmbientCarbonMonoxide")).toBe(true);
    expect(health.healthAmbientCarbonMonoxide).toBe("Passed");
  });

  test("drops a top-level key that is not a group at all; the real groups beside it survive", () => {
    const fields = {
      prefill: { whatever: 1 },
      job: { note: "check the flue" },
    };
    const pruned = prunePersistedValues(fields);
    expect(Object.hasOwn(pruned, "prefill")).toBe(false);
    const job = pruned.job as Record<string, unknown>;
    expect(Object.hasOwn(job, "note")).toBe(true);
    expect(job.note).toBe("check the flue");
  });

  test("does not mutate its input", () => {
    const fields = {
      job: { serviceTime: "2026-09-18 09:00:00", firstName: "Dana" },
    };
    prunePersistedValues(fields);
    const job = fields.job as Record<string, unknown>;
    expect(Object.hasOwn(job, "firstName")).toBe(true);
    expect(Object.hasOwn(job, "serviceTime")).toBe(true);
  });
});
