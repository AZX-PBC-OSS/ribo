import { expect, test } from "vitest";

import { SESSION_DOCUMENT_UPGRADES, SESSION_DOCUMENT_VERSION } from "./sessions.js";

test("the session ladder has one rung per version", () => {
  expect(SESSION_DOCUMENT_UPGRADES).toHaveLength(SESSION_DOCUMENT_VERSION);
});

test("the session document is at shape version 2", () => {
  expect(SESSION_DOCUMENT_VERSION).toBe(2);
});

test("every session rung says why the version moved", () => {
  for (const rung of SESSION_DOCUMENT_UPGRADES) {
    expect(rung.reason.length).toBeGreaterThan(0);
  }
});

const instanceKeysRung = () => {
  const rung = SESSION_DOCUMENT_UPGRADES[1]!;
  if (!("upgrade" in rung)) throw new Error("rung 1 should rewrite");
  return rung.upgrade;
};

const keysOf = (document: Record<string, unknown>): Record<string, string[]> =>
  (document.reviewOutcome as { instanceKeys: Record<string, string[]> }).instanceKeys;

test("instance keys are synthesised for a group that has none", () => {
  const result = instanceKeysRung()({
    id: "s1",
    reviewOutcome: { status: "accepted", fields: { hvac: [{ a: 1 }, { a: 2 }], basedata: [] } },
  });

  // One key per instance, and an empty group gets none.
  expect(keysOf(result)).toEqual({ hvac: ["k1", "k2"] });
});

// The guard the first draft of this rung dropped, and the reason this test exists
// rather than only the one above. These keys identify instances in the
// destination system: a session reviewed after the field landed already has real
// ones, and overwriting them with synthetic `k1..kN` would silently break the
// mapping between a reviewed group and what was actually written. Nothing would
// throw; the write would just land against the wrong instance.
test("instance keys a document already carries are left alone", () => {
  const result = instanceKeysRung()({
    id: "s1",
    reviewOutcome: {
      status: "accepted",
      fields: { hvac: [{ a: 1 }, { a: 2 }], attic: [{ b: 1 }] },
      instanceKeys: { hvac: ["real-uuid-1", "real-uuid-2"] },
    },
  });

  expect(keysOf(result)).toEqual({
    hvac: ["real-uuid-1", "real-uuid-2"],
    attic: ["k1"],
  });
});

test("a discarded review outcome is left untouched", () => {
  const document = { id: "s1", reviewOutcome: { status: "discarded" as const, fields: {} } };
  expect(instanceKeysRung()(document)).toEqual(document);
});

test("a session with no review outcome is left untouched", () => {
  const document = { id: "s1", status: "open" };
  expect(instanceKeysRung()(document)).toEqual(document);
});

test("the instance-key rung is idempotent", () => {
  const document = {
    id: "s1",
    reviewOutcome: { status: "accepted", fields: { hvac: [{ a: 1 }, { a: 2 }] } },
  };

  const once = instanceKeysRung()(document);
  const twice = instanceKeysRung()({ ...once });

  expect(twice).toEqual(once);
});
