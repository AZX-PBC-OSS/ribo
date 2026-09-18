import { describe, expect, test } from "vitest";

import { contradictionMatcher } from "./instance-identity.js";
import type { InstanceEvidence, InstanceFacts } from "./instance-identity.js";

/**
 * Tests for the three-valued matcher vocabulary: the "are these two descriptions the
 * same real-world thing?" decision, lifted out of the one adapter that made it today so
 * the next consumer shares the evidence shapes and the veto rather than the matcher.
 *
 * The load-bearing pin is the central one: a matcher in this library NEVER returns
 * `"same"` on agreement. Two identical furnaces — an upstairs and a downstairs Lennox of
 * the same model year — agree on every field an adapter names and are still two records;
 * merging on agreement would be invisible and permanent where a wrong create is visible
 * and removable. `"same"` needs positive evidence core cannot possess, so it is always
 * host judgement, and every pin here double-checks the shipped matcher stays conservative.
 */

/** Evidence from one leaf. `sourceSpan` is always null here — the type has no producer yet. */
const evidence = (value: unknown): InstanceEvidence => ({ value, sourceSpan: null });

/** A whole instance: the group it belongs to and the leaf evidence captured for it. */
const facts = (group: string, values: Record<string, unknown>): InstanceFacts => ({
  group,
  leaves: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, evidence(v)])),
});

/** The identifying fields an HVAC-declaring host would name for its `hvac` group. */
const HVAC = { hvac: ["manufacturer", "model", "modelYear"] };

describe("contradictionMatcher", () => {
  test("a disagreement on one identifying field, both sides committed, is a 'different'", () => {
    const matcher = contradictionMatcher(HVAC);
    const a = facts("hvac", { manufacturer: "Lennox", model: "EL296", modelYear: 2019 });
    const b = facts("hvac", { manufacturer: "Carrier", model: "EL296", modelYear: 2019 });
    expect(matcher(a, b)).toBe("different");
  });

  test("two identical furnaces agree on every identifying field and are 'unknown', never 'same'", () => {
    // The central pin. An upstairs and a downstairs Lennox of the same model year agree
    // on every identifying field and are two records; agreement is not identity. The
    // matcher vetoes on contradiction and refuses to judge otherwise — it cannot say
    // "same", because saying that needs positive evidence core does not have.
    const matcher = contradictionMatcher(HVAC);
    const upstairs = facts("hvac", { manufacturer: "Lennox", model: "EL296", modelYear: 2019 });
    const downstairs = facts("hvac", { manufacturer: "Lennox", model: "EL296", modelYear: 2019 });
    expect(matcher(upstairs, downstairs)).toBe("unknown");
  });

  test("one side null and the other committed is missing information, not a contradiction", () => {
    const matcher = contradictionMatcher(HVAC);
    const a = facts("hvac", { manufacturer: "Lennox" });
    const b = facts("hvac", { manufacturer: null });
    expect(matcher(a, b)).toBe("unknown");
  });

  test("both sides null is 'unknown' — two abstentions agree about nothing", () => {
    const matcher = contradictionMatcher(HVAC);
    const a = facts("hvac", { manufacturer: null });
    const b = facts("hvac", { manufacturer: null });
    expect(matcher(a, b)).toBe("unknown");
  });

  test("neither side carrying any identifying field at all is 'unknown'", () => {
    const matcher = contradictionMatcher(HVAC);
    const a = facts("hvac", {});
    const b = facts("hvac", {});
    expect(matcher(a, b)).toBe("unknown");
  });

  test("a different group is 'different', whatever the leaves say", () => {
    // Group is not an identifying field — it is the collection the instance belongs to,
    // and two facts about different collections cannot be the same real-world thing.
    const matcher = contradictionMatcher(HVAC);
    const a = facts("hvac", { manufacturer: "Lennox" });
    const b = facts("attic", { manufacturer: "Lennox" });
    expect(matcher(a, b)).toBe("different");
  });

  test("a group with no identifying fields configured is 'unknown' whatever the values", () => {
    const matcher = contradictionMatcher(HVAC);
    const a = facts("attic", { rValue: 19 });
    const b = facts("attic", { rValue: 30 });
    expect(matcher(a, b)).toBe("unknown");
  });

  test("a matcher built with no map at all has nothing to read, so nothing can contradict", () => {
    // The zero-knowledge construction — what a host with no identifying knowledge gets.
    const matcher = contradictionMatcher();
    const a = facts("hvac", { manufacturer: "Lennox" });
    const b = facts("hvac", { manufacturer: "Carrier" });
    expect(matcher(a, b)).toBe("unknown");
  });

  test("a field named in the map that neither instance carries is not an error", () => {
    // An identifying field is a *veto opportunity*, not an expectation: a record that
    // never captured the serial number is missing information, not malformed.
    const matcher = contradictionMatcher({ hvac: ["manufacturer", "serialNumber"] });
    const a = facts("hvac", { manufacturer: "Lennox" });
    const b = facts("hvac", { manufacturer: "Lennox" });
    expect(matcher(a, b)).toBe("unknown");
  });

  // Object.is is a deliberate change from today's `!==`, and the two differ on exactly
  // two inputs — both pinned here, because a rewrite back to `!==` would pass every
  // other test in this file.

  test("NaN vs NaN is missing a value, not disagreeing about one — Object.is, not !==", () => {
    // Two records whose year is NaN are both missing a year; today's `!==` would read
    // the shared absence as a veto.
    const matcher = contradictionMatcher({ hvac: ["modelYear"] });
    const a = facts("hvac", { modelYear: NaN });
    const b = facts("hvac", { modelYear: NaN });
    expect(matcher(a, b)).toBe("unknown");
  });

  test("+0 vs -0 is a disagreement — Object.is, not !==", () => {
    // `!==` cannot see the sign of a zero, so the values would pass as equal and the
    // veto would be silently lost.
    const matcher = contradictionMatcher({ hvac: ["modelYear"] });
    const a = facts("hvac", { modelYear: 0 });
    const b = facts("hvac", { modelYear: -0 });
    expect(matcher(a, b)).toBe("different");
  });

  test("an Extracted envelope passed where a value belongs throws, naming the field", () => {
    // Two envelope objects are never Object.is-equal, so a caller who forgot to flatten
    // would otherwise get a matcher that vetoes every pair — a silent, total failure
    // that looks like data. It throws instead, naming the field and the contract.
    const matcher = contradictionMatcher({ hvac: ["model"] });
    const a = facts("hvac", {});
    const envelope = { value: "EL296", confidence: 1, sourceSpan: null };
    const b: InstanceFacts = { group: "hvac", leaves: { model: envelope } };
    expect(() => matcher(a, b)).toThrow(/model/);
    expect(() => matcher(a, b)).toThrow(/flatten/i);
  });

  test("a DOUBLE-WRAPPED envelope throws too — the case the obvious check misses", () => {
    // `isExtractedLeaf` is false for `{ value: envelope, sourceSpan: null }`, because
    // the outer object has no numeric `confidence`. So a guard that checks only the
    // evidence object lets this through — and then both sides compare as envelope
    // OBJECTS, which are never `Object.is`-equal, so every pair vetoes. A matcher that
    // reports "different" for two identical instances, silently, forever.
    //
    // This is the dangerous half of the flattening contract; the case above merely
    // violates it. Reverting the guard to a single level passes that test and fails
    // this one, which is the whole reason this test exists.
    const matcher = contradictionMatcher({ hvac: ["model"] });
    const envelope = { value: "EL296", confidence: 1, sourceSpan: null };
    const doubleWrapped: InstanceFacts = {
      group: "hvac",
      leaves: { model: { value: envelope, sourceSpan: null } },
    };

    expect(() => matcher(doubleWrapped, doubleWrapped)).toThrow(/model/);
    expect(() => matcher(doubleWrapped, doubleWrapped)).toThrow(/flatten/i);
  });
});
