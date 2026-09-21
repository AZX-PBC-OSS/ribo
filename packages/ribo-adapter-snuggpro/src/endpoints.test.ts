import { describe, expect, test } from "vitest";

import { SNUGG_ENDPOINTS } from "./endpoints.generated.js";
import { snuggValuesSchema } from "./schema.js";

/**
 * Must-fail tests pinning the generated endpoint table against the vendor shapes as
 * measured from the live spec. The uniform-collection rule, the `incentive` overrides,
 * the singleton upserts and the update-only `job` group are each pinned by their own
 * test — a plausible-looking wrong table (most easily, one that mistook
 * `PUT /jobs/{jobId}` for the singletons' update endpoint) must fail here, not ship.
 */

const uniformCollections = [
  "hvac",
  "attic",
  "vault",
  "wall",
  "window",
  "door",
  "dhw",
  "concern",
  "clothesDryer",
  "freezer",
  "range",
  "refrigerator",
  "pv",
] as const;

const singletons = ["basedata", "health", "stage", "report", "utilities"] as const;

/** Throws rather than asserting on undefined if the table drops a group. */
function entryFor(group: string) {
  const entry = SNUGG_ENDPOINTS[group];
  if (!entry) throw new Error(`no SNUGG_ENDPOINTS entry for group ${group}`);
  return entry;
}

describe("SNUGG_ENDPOINTS", () => {
  test("has an entry for every top-level group of snuggValuesSchema", () => {
    expect(Object.keys(SNUGG_ENDPOINTS).sort()).toEqual(
      Object.keys(snuggValuesSchema.shape).sort(),
    );
  });

  test("each collection creates at POST /jobs/{jobId}/<group> and updates at POST /jobs/<group>/{uuid}", () => {
    for (const group of uniformCollections) {
      const { create, update, upsert } = entryFor(group);
      expect(upsert, group).toBeUndefined();
      expect(Object.keys(create ?? {}).sort(), `${group} create`).toEqual([
        "params",
        "path",
        "verb",
      ]);
      expect(create?.verb, group).toBe("POST");
      expect(create?.path, group).toBe(`/jobs/{jobId}/${group}`);
      expect(Object.keys(update ?? {}).sort(), `${group} update`).toEqual([
        "params",
        "path",
        "verb",
      ]);
      expect(update?.verb, group).toBe("POST");
      expect(update?.path, group).toBe(`/jobs/${group}/{uuid}`);
    }
  });

  test("every collection carries a list path, and it is the PLURAL one — not the create path", () => {
    // A live write against staging returned 404 on the read because the adapter used
    // `create.path`. The vendor reads plural and creates singular, so the two are
    // different paths for every collection, and `incentive` is the reason the fix is
    // not `create.path + "s"` — its create is already plural, which that rule would
    // turn into `incentivess`.
    for (const group of [...uniformCollections, "incentive"]) {
      const { create, list } = entryFor(group);
      expect(list?.verb, group).toBe("GET");
      expect(list?.path, group).toBe(`/jobs/{jobId}/${group}s`);
      if (group !== "incentive") {
        expect(list?.path, `${group} list must differ from create`).not.toBe(create?.path);
      }
    }
    // `incentive` is the one group whose list and create paths coincide.
    const incentive = entryFor("incentive");
    expect(incentive.list?.path).toBe(incentive.create?.path);
  });

  test("a non-collection group has no list path", () => {
    for (const group of [...singletons, "job"]) {
      expect(entryFor(group).list, group).toBeUndefined();
    }
  });

  test("incentive is the override: plural create path, PUT update", () => {
    const { create, update, upsert } = entryFor("incentive");
    expect(create?.verb).toBe("POST");
    expect(create?.path).toBe("/jobs/{jobId}/incentives");
    expect(update?.verb).toBe("PUT");
    expect(update?.path).toBe("/jobs/{jobId}/incentives/{uuid}");
    expect(upsert).toBeUndefined();
  });

  test("each singleton upserts at POST /jobs/{jobId}/<group> and has no create or update", () => {
    for (const group of singletons) {
      const { create, update, upsert } = entryFor(group);
      // The trap this table must not fall into: `PUT /jobs/{jobId}` is the `job`
      // group's endpoint, not the singletons' update twin.
      expect(create, group).toBeUndefined();
      expect(update, group).toBeUndefined();
      expect(upsert?.verb, group).toBe("POST");
      expect(upsert?.path, group).toBe(`/jobs/{jobId}/${group}`);
    }
  });

  test("job is update-only at PUT /jobs/{jobId}", () => {
    const { create, update, upsert } = entryFor("job");
    expect(create).toBeUndefined();
    expect(upsert).toBeUndefined();
    expect(update?.verb).toBe("PUT");
    expect(update?.path).toBe("/jobs/{jobId}");
  });

  test("no path template bakes an id in", () => {
    for (const [group, entry] of Object.entries(SNUGG_ENDPOINTS)) {
      for (const op of [entry.create, entry.update, entry.upsert]) {
        if (!op) continue;
        expect(op.path, `${group} ${op.verb}`).toMatch(/^\/jobs(\/\{[a-zA-Z]+\}|\/[a-zA-Z]+)+$/);
      }
    }
  });

  test("create-only is exactly hvac.hvacSystemEquipmentType and incentive.fromTemplateUuid", () => {
    const withCreateOnly = Object.entries(SNUGG_ENDPOINTS)
      .filter(([, entry]) => entry.createOnly.length > 0)
      .map(([group, entry]) => [group, entry.createOnly]);
    expect(withCreateOnly).toEqual([
      ["hvac", ["hvacSystemEquipmentType"]],
      ["incentive", ["fromTemplateUuid"]],
    ]);
  });

  test("required-on-create is exactly hvac's pair and incentive.fromTemplateUuid", () => {
    const required = Object.fromEntries(
      Object.entries(SNUGG_ENDPOINTS)
        .filter(([, entry]) => entry.requiredOnCreate.length > 0)
        .map(([group, entry]) => [group, entry.requiredOnCreate]),
    );
    expect(required).toEqual({
      hvac: ["hvacSystemEquipmentType", "hvacUpgradeAction"],
      incentive: ["fromTemplateUuid"],
    });
  });

  test("every createOnly and requiredOnCreate name is an accepted create parameter", () => {
    for (const [_group, entry] of Object.entries(SNUGG_ENDPOINTS)) {
      if (!entry.create) continue;
      for (const name of [...entry.createOnly, ...entry.requiredOnCreate]) {
        expect(entry.create.params, name).toHaveProperty(name);
      }
    }
  });

  test("parameters carry the vendor's declared spec type", () => {
    const hvac = entryFor("hvac");
    expect(hvac.create?.params.hvacSystemEquipmentType).toBe("string");
    expect(hvac.create?.params.hvacHeatingCapacity).toBe("integer");
    expect(hvac.create?.params.hvacPercentOfTotalHeatingLoad).toBe("number");
    expect(hvac.create?.params.customFields).toBe("array");
    expect(entryFor("stage").upsert?.params.stageId).toBe("integer");
    expect(entryFor("incentive").create?.params.fromTemplateUuid).toBe("string");
  });

  test("every write operation accepts at least one parameter", () => {
    for (const [group, entry] of Object.entries(SNUGG_ENDPOINTS)) {
      for (const [name, op] of Object.entries({
        create: entry.create,
        update: entry.update,
        upsert: entry.upsert,
      })) {
        if (!op) continue;
        expect(Object.keys(op.params).length, `${group}.${name}`).toBeGreaterThan(0);
      }
    }
  });
});
