import { describe, expect, test } from "vitest";
import { buildWriteBody } from "./body.js";

/**
 * The two absence cases, measured against staging 2026-09-21: an absent leaf
 * means "field left alone" and an explicit `null` means "field cleared". The
 * vendor gives them opposite meanings, so a body builder that fills absent
 * keys with `null` silently clears fields on a real audit — the pinned
 * no-overwrite test below exists so that regression is loud.
 */
describe("buildWriteBody", () => {
  test("stringifies a numeric value where the spec types the parameter string", () => {
    // `hvacHeatingSystemModelYear` is the worked example: spec-typed `string`,
    // schema-typed `z.number()` — the reviewer edits a number, the wire wants a string.
    expect(buildWriteBody("hvac", "create", { hvacHeatingSystemModelYear: 2011 })).toEqual({
      hvacHeatingSystemModelYear: "2011",
    });

    // Driven off the table's declared type, not a field-name list: every
    // spec-`string` parameter holding a number stringify, spec-`integer` ones
    // stay numeric.
    expect(
      buildWriteBody("basedata", "upsert", {
        yearBuilt: 1987,
        heatingSetpointHigh: 70,
        totalNumberOfLightBulbs: 42,
      }),
    ).toEqual({
      yearBuilt: "1987",
      heatingSetpointHigh: "70",
      totalNumberOfLightBulbs: 42,
    });
  });

  test("maps a duct-insulation alias to the vendor's quoted literal", () => {
    expect(buildWriteBody("hvac", "create", { hvacDuctInsulation: "Duct Board 1.5 inch" })).toEqual(
      {
        hvacDuctInsulation: 'Duct Board 1.5"',
      },
    );

    // A member that never carried a quote passes through unchanged.
    expect(buildWriteBody("hvac", "update", { hvacDuctInsulation: "No Insulation" })).toEqual({
      hvacDuctInsulation: "No Insulation",
    });
  });

  test("omits keys the operation does not declare", () => {
    expect(
      buildWriteBody("concern", "create", {
        concernSummary: "Drafty bedroom",
        concernDetail: null,
        notASnuggField: "noise the endpoint never asked for",
      }),
    ).toEqual({ concernSummary: "Drafty bedroom", concernDetail: null });
  });

  test("keeps create-only keys on create and drops them on update", () => {
    const values = {
      hvacSystemEquipmentType: "Boiler",
      hvacUpgradeAction: "Keep an existing system as is",
    };
    expect(buildWriteBody("hvac", "create", values)).toEqual({
      hvacSystemEquipmentType: "Boiler",
      hvacUpgradeAction: "Keep an existing system as is",
    });
    expect(buildWriteBody("hvac", "update", values)).toEqual({
      hvacUpgradeAction: "Keep an existing system as is",
    });
  });

  test("refuses an unresolved reference leaf instead of sending it", () => {
    // job.accountId is captured as the spoken assignee's name — never an
    // invented id. Sending the spoken string is a terminal 400; resolving it
    // against the real account list is a human, review-time step.
    expect(() => buildWriteBody("job", "update", { accountId: "Dave" })).toThrow(/job\.accountId/);
    expect(() => buildWriteBody("job", "update", { accountId: "Dave" })).toThrow(/resolv/i);

    expect(() =>
      buildWriteBody("incentive", "create", { fromTemplateUuid: "Mass Save rebate" }),
    ).toThrow(/incentive\.fromTemplateUuid/);
  });

  test("an absent key stays absent and an explicit null reaches the wire as null", () => {
    // One key set, siblings absent: exactly that one key reaches the body —
    // the vendor leaves an absent field alone.
    expect(buildWriteBody("job", "update", { note: "Bring the blower door" })).toStrictEqual({
      note: "Bring the blower door",
    });

    // Present as null: the human cleared the field — the body carries the null.
    expect(buildWriteBody("job", "update", { note: null })).toStrictEqual({ note: null });

    // An explicitly-undefined key counts as absent, not as a null.
    expect(buildWriteBody("job", "update", { note: undefined })).toStrictEqual({});
  });

  test("refuses a group or operation the endpoint table does not declare", () => {
    expect(() => buildWriteBody("notAGroup", "update", {})).toThrow(/notAGroup/);
    // `job` has no create — the vendor launches the app with an existing job.
    expect(() => buildWriteBody("job", "create", { note: "x" })).toThrow(/create/);
  });
});
