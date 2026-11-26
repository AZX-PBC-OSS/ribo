import { expect, test } from "vitest";

import { parseSchemaPlan, planFingerprint, SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { ChatClient, ChatRequest, SchemaPlan } from "@azx/ribo-core";

import { convertDocument } from "./inspect/convert.js";
import { schemaFingerprint } from "./inspect/fingerprint.js";
import { planSchema } from "./schema-plan.js";

const document = {
  type: "object",
  properties: {
    home: {
      type: "object",
      description: "The home being audited.",
      properties: {
        address: { type: "string", description: "Street address." },
        yearBuilt: { type: "number", description: "Year of construction." },
        nickname: { type: "string", description: "The household's name for the home." },
      },
      required: ["address", "yearBuilt", "nickname"],
    },
    audit: {
      type: "object",
      properties: {
        auditor: { type: "string", description: "Person performing the audit." },
        completed: { type: "boolean", description: "Whether the audit is complete." },
      },
      required: ["auditor", "completed"],
    },
  },
  required: ["home", "audit"],
};

const initialReply = {
  pieces: [
    {
      name: "Home identity",
      description: "Where the home is and when it was built.",
      key: "home",
      paths: ["home.address", "home.yearBuilt"],
    },
    {
      name: "Household nickname",
      description: "What the household calls the home.",
      key: "home",
      paths: ["home.nickname"],
    },
    {
      name: "Auditor",
      description: "Who performed the audit.",
      key: "audit",
      paths: ["audit.auditor"],
    },
    {
      name: "Audit status",
      description: "Whether the audit is complete.",
      key: "audit",
      paths: ["audit.completed"],
    },
  ],
};

const createdAt = "2026-10-01T02:03:04.000Z";

function replyingChat(reply: unknown): {
  readonly chat: ChatClient;
  readonly requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      async complete(request) {
        requests.push(request);
        return { content: JSON.stringify(reply) };
      },
    },
  };
}

const options = (chat: ChatClient) => ({
  chat,
  model: "stub-planner",
  backend: "stub-backend",
  clock: () => new Date(createdAt),
});

async function initialPlan(): Promise<SchemaPlan> {
  const { chat } = replyingChat(initialReply);
  return planSchema(document, options(chat));
}

test("initial planning carries inspect's fingerprint, complete schema-ordered inventory and injected-call provenance", async () => {
  const { chat, requests } = replyingChat(initialReply);
  const plan = await planSchema(document, options(chat));

  expect(plan.version).toBe(SCHEMA_PLAN_CONTRACT_VERSION);
  expect(plan.schemaFingerprint).toBe(schemaFingerprint(document));
  expect(plan.fieldPaths).toEqual([
    "home.address",
    "home.yearBuilt",
    "home.nickname",
    "audit.auditor",
    "audit.completed",
  ]);
  expect(plan.pieces).toEqual(initialReply.pieces);
  expect(plan.provenance).toEqual({
    model: "stub-planner",
    backend: "stub-backend",
    createdAt,
  });
  expect(requests).toHaveLength(1);
  expect(parseSchemaPlan(plan, convertDocument(document))).toEqual(plan);
});

test("updates lock surviving assignments and order, treat renames as remove/add, and delete emptied pieces", async () => {
  const existingPlan = await initialPlan();
  const changed = structuredClone(document);
  const homeProperties = changed.properties.home.properties as Record<string, unknown>;
  delete homeProperties.yearBuilt;
  homeProperties.constructionYear = {
    type: "number",
    description: "Year construction finished.",
  };
  changed.properties.home.required = ["address", "nickname", "constructionYear"];
  const auditProperties = changed.properties.audit.properties as Record<string, unknown>;
  delete auditProperties.auditor;
  auditProperties.assessor = {
    type: "string",
    description: "Person assessing the home.",
  };
  changed.properties.audit.required = ["completed", "assessor"];

  const updateReply = {
    pieces: [
      {
        name: "Home identity",
        description: "Where the home is and when it was built.",
        key: "home",
        paths: ["home.constructionYear"],
      },
      {
        name: "Assessor",
        description: "Who assessed the home.",
        key: "audit",
        paths: ["audit.assessor"],
      },
    ],
  };
  const { chat, requests } = replyingChat(updateReply);
  const later = "2026-11-02T03:04:05.000Z";
  const updated = await planSchema(changed, {
    chat,
    model: "update-model",
    backend: "update-backend",
    existingPlan,
    clock: () => new Date(later),
  });

  expect(requests).toHaveLength(1);
  expect(updated.fieldPaths).toEqual([
    "home.address",
    "home.nickname",
    "home.constructionYear",
    "audit.completed",
    "audit.assessor",
  ]);
  expect(updated.pieces).toEqual([
    {
      ...existingPlan.pieces[0]!,
      paths: ["home.address", "home.constructionYear"],
    },
    existingPlan.pieces[1]!,
    existingPlan.pieces[3]!,
    updateReply.pieces[1]!,
  ]);
  expect(updated.pieces.map((piece) => piece.name)).not.toContain("Auditor");
  expect(updated.schemaFingerprint).toBe(schemaFingerprint(changed));
  expect(updated.provenance).toEqual({
    model: "update-model",
    backend: "update-backend",
    createdAt: later,
  });
  expect(parseSchemaPlan(updated, convertDocument(changed))).toEqual(updated);
});

test("removal-only, schema-order-only and fingerprint-refresh updates make no chat or clock call and preserve provenance", async () => {
  const existingPlan = await initialPlan();
  const noCalls = () => {
    throw new Error("a zero-call update invoked its chat or clock");
  };
  const chat: ChatClient = { complete: noCalls };

  const removal = structuredClone(document);
  delete (removal.properties.audit.properties as Record<string, unknown>).auditor;
  removal.properties.audit.required = ["completed"];
  const removed = await planSchema(removal, {
    chat,
    model: "unused-model",
    backend: "unused-backend",
    existingPlan,
    clock: noCalls,
  });
  expect(removed.pieces.map((piece) => piece.name)).toEqual([
    "Home identity",
    "Household nickname",
    "Audit status",
  ]);
  expect(removed.provenance).toEqual(existingPlan.provenance);

  const reordered = {
    ...document,
    properties: { audit: document.properties.audit, home: document.properties.home },
    required: ["audit", "home"],
  };
  const orderRefreshed = await planSchema(reordered, {
    chat,
    model: "unused-model",
    backend: "unused-backend",
    existingPlan,
    clock: noCalls,
  });
  expect(orderRefreshed.fieldPaths).toEqual([
    "audit.auditor",
    "audit.completed",
    "home.address",
    "home.yearBuilt",
    "home.nickname",
  ]);
  expect(orderRefreshed.pieces).toEqual(existingPlan.pieces);
  expect(orderRefreshed.provenance).toEqual(existingPlan.provenance);

  const redescribed = structuredClone(document);
  redescribed.properties.home.description = "A changed description with identical fields.";
  const fingerprintRefreshed = await planSchema(redescribed, {
    chat,
    model: "unused-model",
    backend: "unused-backend",
    existingPlan,
    clock: noCalls,
  });
  expect(fingerprintRefreshed.schemaFingerprint).toBe(schemaFingerprint(redescribed));
  expect(fingerprintRefreshed.schemaFingerprint).not.toBe(existingPlan.schemaFingerprint);
  expect(fingerprintRefreshed.fieldPaths).toEqual(existingPlan.fieldPaths);
  expect(fingerprintRefreshed.pieces).toEqual(existingPlan.pieces);
  expect(fingerprintRefreshed.provenance).toEqual(existingPlan.provenance);
});

test("reordering only root fieldPaths to a new schema order leaves core planFingerprint unchanged", async () => {
  const original = await initialPlan();
  const reordered: SchemaPlan = { ...original, fieldPaths: [...original.fieldPaths].reverse() };

  expect(await planFingerprint(reordered)).toBe(await planFingerprint(original));
  expect(reordered.fieldPaths).toEqual([...original.fieldPaths].reverse());
});

test("piece-path order, membership and other semantic edits move identity while provenance and stored schema fingerprint do not", async () => {
  const original = await initialPlan();
  const identity = await planFingerprint(original);
  const edits: ReadonlyArray<readonly [string, (plan: SchemaPlan) => void]> = [
    ["piece-path order", (plan) => plan.pieces[0]!.paths.reverse()],
    [
      "piece membership",
      (plan) => {
        plan.pieces[0]!.paths = ["home.address"];
        plan.pieces[1]!.paths.push("home.yearBuilt");
      },
    ],
    ["piece order", (plan) => plan.pieces.reverse()],
    ["piece name", (plan) => void (plan.pieces[0]!.name = "Renamed piece")],
    [
      "piece description",
      (plan) => void (plan.pieces[0]!.description = "A different semantic description."),
    ],
    ["piece key", (plan) => void (plan.pieces[0]!.key = "different")],
  ];
  for (const [name, edit] of edits) {
    const changed = structuredClone(original);
    edit(changed);
    expect(await planFingerprint(changed), name).not.toBe(identity);
  }

  const nonSemantic = structuredClone(original);
  nonSemantic.schemaFingerprint = "f".repeat(64);
  nonSemantic.provenance = {
    model: "another-model",
    backend: "another-backend",
    createdAt: "2027-01-02T03:04:05.000Z",
  };
  expect(await planFingerprint(nonSemantic)).toBe(identity);
});
