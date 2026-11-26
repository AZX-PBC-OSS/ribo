import { expect, test } from "vitest";

import { SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { ChatClient, ChatRequest, SchemaPlan } from "@azx/ribo-core";

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

const validReply = {
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
};

function scriptedChat(contents: readonly string[]): {
  readonly chat: ChatClient;
  readonly requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      async complete(request) {
        requests.push(request);
        const content = contents[requests.length - 1];
        if (content === undefined) throw new Error("unexpected planning call");
        return { content };
      },
    },
  };
}

const options = (chat: ChatClient) => ({
  chat,
  model: "stub-planner",
  backend: "stub-backend",
  clock: () => new Date("2026-10-01T02:03:04.000Z"),
});

test("malformed and schema-invalid replies receive named repair feedback", async () => {
  const malformed = scriptedChat(["this is not JSON", JSON.stringify(validReply)]);
  await planSchema(document, options(malformed.chat));
  expect(malformed.requests).toHaveLength(2);
  expect(malformed.requests[1]!.messages.at(-1)!.content).toMatch(
    /malformed.*JSON|JSON.*malformed/iu,
  );

  const invalidPiece = {
    pieces: [{ name: "", description: "", key: "home", paths: [] }],
  };
  const invalid = scriptedChat([JSON.stringify(invalidPiece), JSON.stringify(validReply)]);
  await planSchema(document, options(invalid.chat));
  const feedback = invalid.requests[1]!.messages.at(-1)!.content;
  expect(feedback).toMatch(/pieces\.0\.name/iu);
  expect(feedback).toMatch(/pieces\.0\.paths/iu);
  expect(feedback).toMatch(/empty|at least/iu);
});

test("unknown, duplicate, omitted and cross-key replies name every violation on repair", async () => {
  const invalidReply = {
    pieces: [
      {
        name: "Mixed up",
        description: "An invalid assignment.",
        key: "home",
        paths: ["home.address", "home.address", "audit.auditor", "home.unknown"],
      },
      {
        name: "Duplicate auditor",
        description: "A second invalid owner.",
        key: "audit",
        paths: ["audit.auditor"],
      },
    ],
  };
  const { chat, requests } = scriptedChat([
    JSON.stringify(invalidReply),
    JSON.stringify(validReply),
  ]);

  await planSchema(document, options(chat));

  const feedback = requests[1]!.messages.at(-1)!.content;
  expect(feedback).toMatch(/unknown path[^\n]*home\.unknown/iu);
  expect(feedback).toMatch(/duplicate path[^\n]*home\.address/iu);
  expect(feedback).toMatch(/duplicate path[^\n]*audit\.auditor/iu);
  expect(feedback).toMatch(/omitted path[^\n]*home\.yearBuilt/iu);
  expect(feedback).toMatch(/cross(?:es|ing|-key)[^\n]*audit\.auditor[^\n]*home/iu);
});

test("a valid first response needs no repair, the second repair is final, and exhaustion returns no plan", async () => {
  const valid = scriptedChat([JSON.stringify(validReply)]);
  await expect(planSchema(document, options(valid.chat))).resolves.toMatchObject({
    fieldPaths: ["home.address", "home.yearBuilt", "audit.auditor"],
  });
  expect(valid.requests).toHaveLength(1);

  const secondRepair = scriptedChat(["bad one", "bad two", JSON.stringify(validReply)]);
  await expect(planSchema(document, options(secondRepair.chat))).resolves.toMatchObject({
    pieces: validReply.pieces,
  });
  expect(secondRepair.requests).toHaveLength(3);

  const exhausted = scriptedChat(["bad one", "bad two", "bad three", "must not be read"]);
  await expect(planSchema(document, options(exhausted.chat))).rejects.toThrow(
    /exhausted|no valid|after 3/iu,
  );
  expect(exhausted.requests).toHaveLength(3);
});

test("initial, repair and update prompts omit sentinel cap names and values", async () => {
  const initial = scriptedChat(["bad", JSON.stringify(validReply)]);
  await planSchema(document, options(initial.chat));

  const existingPlan: SchemaPlan = {
    version: SCHEMA_PLAN_CONTRACT_VERSION,
    schemaFingerprint: "a".repeat(64),
    fieldPaths: ["home.address", "home.yearBuilt", "audit.auditor"],
    pieces: validReply.pieces,
    provenance: {
      model: "earlier-model",
      backend: "earlier-backend",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  };
  const withAddition = structuredClone(document) as typeof document & {
    properties: {
      home: {
        properties: Record<string, unknown>;
        required: string[];
      };
    };
  };
  withAddition.properties.home.properties.nickname = {
    type: "string",
    description: "The household's name for the home.",
  };
  withAddition.properties.home.required.push("nickname");
  const updateReply = {
    pieces: [
      {
        name: "Home identity",
        description: "Where the home is and when it was built.",
        key: "home",
        paths: ["home.nickname"],
      },
    ],
  };
  const update = scriptedChat(["bad", JSON.stringify(updateReply)]);
  await planSchema(withAddition, { ...options(update.chat), existingPlan });

  const capSentinels = [
    "maxSerializedCharsPerGroup",
    "maxNullableUnionsPerGroup",
    "maxSingleShotTokens",
    "maxPerGroupTokens",
    "maxTokens",
    "responseCap",
    "response-cap",
    "73129",
    "81293",
  ];
  for (const request of [...initial.requests, ...update.requests]) {
    const serialized = JSON.stringify(request);
    for (const sentinel of capSentinels) expect(serialized).not.toContain(sentinel);
    expect(request.maxTokens).toBeUndefined();
  }

  const updatePrompt = JSON.stringify(update.requests[0]);
  expect(updatePrompt).toContain("home.nickname");
  expect(updatePrompt).toContain("Home identity");
  expect(updatePrompt).not.toContain("home.address");
  expect(updatePrompt).not.toContain("audit.auditor");
  expect(updatePrompt).not.toContain("Auditor");
});
