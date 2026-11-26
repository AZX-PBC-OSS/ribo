import { expect, test } from "vitest";

import { SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { SchemaPlan } from "@azx/ribo-core";

import { schemaFingerprint } from "./inspect/fingerprint.js";
import { schemaPlanFreshness } from "./schema-plan.js";

const document = {
  type: "object",
  properties: {
    home: {
      type: "object",
      properties: {
        address: { type: "string", description: "Street address." },
        yearBuilt: { type: "number", description: "Year of construction." },
      },
      required: ["address", "yearBuilt"],
    },
    audit: {
      type: "object",
      properties: {
        auditor: { type: "string", description: "Person performing the audit." },
      },
      required: ["auditor"],
    },
  },
  required: ["home", "audit"],
};

const plan: SchemaPlan = {
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: "a".repeat(64),
  fieldPaths: ["home.address", "home.yearBuilt", "audit.auditor"],
  pieces: [
    {
      name: "Home identity",
      description: "Where the home is and when it was built.",
      key: "home",
      paths: ["home.address", "home.yearBuilt"],
    },
    {
      name: "Auditor",
      description: "Who performed the audit.",
      key: "audit",
      paths: ["audit.auditor"],
    },
  ],
  provenance: {
    model: "stub-model",
    backend: "stub-backend",
    createdAt: "2026-10-01T02:03:04.000Z",
  },
};

test("freshness returns independent sorted added and removed lists, with renames present in both", () => {
  const changed = {
    ...document,
    properties: {
      home: {
        ...document.properties.home,
        properties: {
          address: document.properties.home.properties.address,
          vintage: { type: "number", description: "Construction vintage." },
        },
        required: ["address", "vintage"],
      },
      audit: {
        ...document.properties.audit,
        properties: {
          assessor: { type: "string", description: "Person assessing the home." },
          completed: { type: "boolean", description: "Whether the audit is complete." },
        },
        required: ["assessor", "completed"],
      },
    },
  };

  const freshness = schemaPlanFreshness(changed, plan);

  expect(freshness.status).toBe("stale");
  expect(freshness.added).toEqual(["audit.assessor", "audit.completed", "home.vintage"]);
  expect(freshness.removed).toEqual(["audit.auditor", "home.yearBuilt"]);
  expect(freshness.added).not.toBe(freshness.removed);
  expect(freshness.added).toContain("home.vintage");
  expect(freshness.removed).toContain("home.yearBuilt");
});

test("fingerprint-only drift returns one note and stale guidance returns exactly ribo schema plan --update", () => {
  const currentPlan = { ...plan, schemaFingerprint: schemaFingerprint(document) };
  const unchanged = schemaPlanFreshness(document, currentPlan);
  expect(unchanged).toEqual({
    status: "unchanged",
    added: [],
    removed: [],
    notes: [],
  });

  const redescribed = structuredClone(document);
  redescribed.properties.home.properties.address.description = "A new description only.";
  const drift = schemaPlanFreshness(redescribed, currentPlan);
  expect(drift.status).toBe("fingerprint-only");
  expect(drift.added).toEqual([]);
  expect(drift.removed).toEqual([]);
  expect(drift.notes).toHaveLength(1);
  expect(drift.fix).toBeUndefined();

  const removedField = structuredClone(document);
  delete (removedField.properties.home.properties as Record<string, unknown>).yearBuilt;
  removedField.properties.home.required = ["address"];
  const stale = schemaPlanFreshness(removedField, currentPlan);
  expect(stale.status).toBe("stale");
  expect(stale.removed).toEqual(["home.yearBuilt"]);
  expect(stale.fix).toBe("ribo schema plan --update");
  expect(stale.notes.join("\n")).toContain("home.yearBuilt");
  expect(stale.notes.join("\n")).not.toMatch(/update the plan|regenerate|re-run/iu);
});
