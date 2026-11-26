import type { ChatClient, ChatRequest } from "@azx/ribo-core";
import { expect, test, vi } from "vitest";

import { initSchema } from "./index.js";
import type { SchemaInitSample } from "./index.js";
import { OperatorError } from "./operator/error.js";
import { validateSchemaInitProposal } from "./schema-init/validate.js";

const sample = (name: string, kind: SchemaInitSample["kind"], text: string): SchemaInitSample => ({
  name,
  kind,
  text,
  source: {
    path: `/samples/${name}.txt`,
    file: `${name}.txt`,
    bytes: new TextEncoder().encode(text),
  },
});

const evidence = (source: string, quote: string) => ({ source, quote });
const property = (name: string, node: unknown) => ({ name, node });
const object = (properties: readonly unknown[], description = "An observed object.") => ({
  kind: "object",
  description,
  properties,
});
const leaf = (source: string, quote: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  kind: "string",
  description: "An observed value.",
  evidence: evidence(source, quote),
  ...extra,
});
const proposalWith = (node: unknown) => ({
  root: object([property("value", node)]),
});
const validProposal = proposalWith(leaf("notes", "Chain replaced"));
const validReply = JSON.stringify(validProposal);

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
        if (content === undefined) throw new Error("unexpected schema-init call");
        return { content };
      },
    },
  };
}

const options = (chat: ChatClient, clock: () => Date = () => new Date("2026-10-01T02:03:04Z")) => ({
  chat,
  model: "stub-schema-author",
  clock,
});

const notes = sample("notes", "text", "Chain replaced");
const repairFeedback = (requests: readonly ChatRequest[], repair = 1): string =>
  requests[repair]!.messages.at(-1)!.content;

test("malformed JSON and malformed declarations receive named feedback and can recover on either repair", async () => {
  const malformed = scriptedChat(["not JSON", validReply]);
  await expect(initSchema([notes], options(malformed.chat))).resolves.toBeDefined();
  expect(malformed.requests).toHaveLength(2);
  expect(repairFeedback(malformed.requests)).toMatch(/repair 1/iu);
  expect(repairFeedback(malformed.requests)).toMatch(/malformed JSON/iu);
  expect(malformed.requests[1]!.messages.at(-2)).toEqual({
    role: "assistant",
    content: "not JSON",
  });

  const malformedDeclaration = {
    root: object([
      property("value", {
        kind: "string",
        evidence: evidence("notes", "Chain replaced"),
        arbitraryJsonSchema: { anyOf: [{ type: "string" }, { type: "null" }] },
      }),
    ]),
  };
  const secondRepair = scriptedChat([
    JSON.stringify(malformedDeclaration),
    "still not JSON",
    validReply,
  ]);
  await expect(initSchema([notes], options(secondRepair.chat))).resolves.toBeDefined();
  expect(secondRepair.requests).toHaveLength(3);
  expect(repairFeedback(secondRepair.requests)).toMatch(/description/iu);
  expect(repairFeedback(secondRepair.requests)).toMatch(/arbitraryJsonSchema/iu);
  expect(repairFeedback(secondRepair.requests, 2)).toMatch(/repair 2/iu);
  expect(repairFeedback(secondRepair.requests, 2)).toMatch(/malformed JSON/iu);
});

test("unknown sources, non-matching quotes and wrong-sample quotes are all named without cross-source fallback", async () => {
  const other = sample("other", "text", "A quote that exists only elsewhere");
  const invalid = {
    root: object([
      property("unknown", leaf("missing", "Chain replaced")),
      property("absent", leaf("notes", "Not in the sample")),
      property("wrong", leaf("notes", "A quote that exists only elsewhere")),
    ]),
  };
  const { chat, requests } = scriptedChat([JSON.stringify(invalid), validReply]);

  await initSchema([notes, other], options(chat));

  const feedback = repairFeedback(requests);
  expect(feedback).toMatch(/unknown source[^\n]*missing|missing[^\n]*unknown source/iu);
  expect(feedback).toMatch(/absent\.evidence|root\.properties\.1/iu);
  expect(feedback).toMatch(/quote[^\n]*not found|evidence[^\n]*does not match/iu);
  expect(feedback).toMatch(/wrong\.evidence|root\.properties\.2/iu);
  expect(feedback).toContain("A quote that exists only elsewhere");
});

test("duplicate recursive paths are rejected with their full path", async () => {
  const duplicate = {
    root: object([
      property(
        "home",
        object([
          property("address", leaf("notes", "Chain replaced")),
          property("address", leaf("notes", "Chain replaced")),
        ]),
      ),
    ]),
  };
  const { chat, requests } = scriptedChat([JSON.stringify(duplicate), validReply]);

  await initSchema([notes], options(chat));

  expect(repairFeedback(requests)).toMatch(/duplicate path[^\n]*home\.address/iu);
});

test.each(["integer", "null", "array", "union"])(
  "unsupported leaf kind %s is repairable rather than rendered",
  async (kind) => {
    const invalid = proposalWith({ ...leaf("notes", "Chain replaced"), kind });
    const { chat, requests } = scriptedChat([JSON.stringify(invalid), validReply]);

    const draft = await initSchema([notes], options(chat));

    expect(requests).toHaveLength(2);
    expect(repairFeedback(requests)).toMatch(/kind/iu);
    expect(JSON.stringify(draft.document)).not.toContain(`"${kind}"`);
  },
);

test("unions, arbitrary JSON Schema keywords and scalar collection elements are refused", async () => {
  const invalid = {
    root: object([
      property("union", {
        kind: "string",
        description: "A union smuggled into a declaration.",
        evidence: evidence("notes", "Chain replaced"),
        anyOf: [{ type: "string" }, { type: "number" }],
      }),
      property("scalars", {
        kind: "collection",
        description: "An unsupported scalar array.",
        items: leaf("notes", "Chain replaced"),
      }),
    ]),
  };
  const { chat, requests } = scriptedChat([JSON.stringify(invalid), validReply]);

  await initSchema([notes], options(chat));

  const feedback = repairFeedback(requests);
  expect(feedback).toMatch(/anyOf/iu);
  expect(feedback).toMatch(/items/iu);
  expect(feedback).toMatch(/object|invalid|expected/iu);
});

test("missing leaf evidence and missing enum-member evidence produce path-named repairs", async () => {
  const withoutLeafEvidence = leaf("notes", "Chain replaced");
  delete (withoutLeafEvidence as { evidence?: unknown }).evidence;
  const invalid = {
    root: object([
      property("plain", withoutLeafEvidence),
      property(
        "status",
        leaf("notes", "Chain replaced", {
          enum: [{ value: "replaced" }, { value: "Chain", evidence: {} }],
        }),
      ),
    ]),
  };
  const { chat, requests } = scriptedChat([JSON.stringify(invalid), validReply]);

  await initSchema([notes], options(chat));

  const feedback = repairFeedback(requests);
  expect(feedback).toMatch(/root\.properties\.0[^\n]*evidence|evidence[^\n]*root\.properties\.0/iu);
  expect(feedback).toMatch(/enum/iu);
  expect(feedback).toMatch(/source/iu);
  expect(feedback).toMatch(/quote/iu);
});

test("enums are string-only, evidenced and unique rather than unsupported numeric unions", async () => {
  const invalid = proposalWith(
    leaf("notes", "Chain replaced", {
      kind: "number",
      enum: [
        { value: "12", evidence: evidence("notes", "Chain replaced") },
        { value: "12", evidence: evidence("notes", "Chain replaced") },
      ],
    }),
  );
  const { chat, requests } = scriptedChat([JSON.stringify(invalid), validReply]);

  await initSchema([notes], options(chat));

  const feedback = repairFeedback(requests);
  expect(feedback).toMatch(/enum[^\n]*string|string[^\n]*enum/iu);
  expect(feedback).toMatch(/duplicate enum|duplicate[^\n]*value/iu);
});

test("an enum member whose own quote does not contain it is refused as invented", async () => {
  const invented = proposalWith(
    leaf("notes", "Chain replaced", {
      enum: [
        { value: "replaced", evidence: evidence("notes", "Chain replaced") },
        { value: "vacant", evidence: evidence("notes", "Chain replaced") },
      ],
    }),
  );
  const { chat, requests } = scriptedChat([JSON.stringify(invented), validReply]);

  await initSchema([notes], options(chat));

  const feedback = repairFeedback(requests);
  expect(feedback).toContain('enum value "vacant" does not appear in its own evidence quote');
  expect(feedback).not.toContain('enum value "replaced"');
});

test("null optional members from a strict transport parse as absent", () => {
  const strictReply = proposalWith(leaf("notes", "Chain replaced", { optional: null, enum: null }));
  const result = validateSchemaInitProposal(JSON.stringify(strictReply), [notes]);
  expect(result.success).toBe(true);
});

test("the second failed repair exhausts the draft with no clock call or partial result", async () => {
  const clock = vi.fn(() => new Date("2026-10-01T02:03:04Z"));
  const { chat, requests } = scriptedChat(["bad one", "bad two", "bad three", "unused"]);

  const failure = await initSchema([notes], options(chat, clock)).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(OperatorError);
  expect(failure instanceof Error ? failure.message : String(failure)).toMatch(
    /exhausted|no draft|no schema/iu,
  );
  expect(failure instanceof Error ? failure.message : String(failure)).toMatch(/malformed JSON/iu);
  expect(requests).toHaveLength(3);
  expect(clock).not.toHaveBeenCalled();
});

test.each([
  ["text" as const, "Chain\nreplaced"],
  ["transcript" as const, "Chain  replaced"],
  ["text" as const, "Chain\treplaced"],
])("direct %s evidence does not normalize whitespace %j", async (kind, quote) => {
  const direct = sample("direct", kind, "Chain replaced");
  const invalid = proposalWith(leaf("direct", quote));
  const valid = JSON.stringify(proposalWith(leaf("direct", "Chain replaced")));
  const { chat, requests } = scriptedChat([JSON.stringify(invalid), valid]);

  await initSchema([direct], options(chat));

  expect(requests).toHaveLength(2);
  expect(repairFeedback(requests)).toMatch(/quote|evidence/iu);
});

test("direct text evidence is an exact raw substring, including compatibility characters", async () => {
  const direct = sample("direct", "text", "The ﬂoor is １２ mm thick");
  const invalid = proposalWith(leaf("direct", "The floor is 12 mm thick"));
  const valid = JSON.stringify(proposalWith(leaf("direct", "The ﬂoor is １２ mm thick")));
  const { chat, requests } = scriptedChat([JSON.stringify(invalid), valid]);

  await initSchema([direct], options(chat));

  expect(requests).toHaveLength(2);
});

test.each([
  ["CRLF and CR", "Chain\r\nreplaced\r01", "Chain\nreplaced\n01"],
  ["wrapped whitespace", "Chain   replaced\n\t 01", "Chain replaced 01"],
  ["Unicode compatibility", "The ﬂoor is １２ mm thick", "The floor is 12 mm thick"],
  ["letter-surrounded line-end hyphen", "Chain re- \n  placed", "Chain replaced"],
])("document-only %s differences pass without repair", async (_name, text, quote) => {
  const document = sample("document", "document", text);
  const originalText = document.text;
  const originalQuote = quote;
  const { chat, requests } = scriptedChat([JSON.stringify(proposalWith(leaf("document", quote)))]);

  const draft = await initSchema([document], options(chat));

  expect(requests).toHaveLength(1);
  expect(document.text).toBe(originalText);
  expect(draft.proposal.root.properties[0]!.node.kind).toBe("string");
  const draftedLeaf = draft.proposal.root.properties[0]!.node;
  if (draftedLeaf.kind !== "string") throw new Error("test expected a string leaf");
  expect(draftedLeaf.evidence.quote).toBe(originalQuote);
});

test.each([
  ["changed words", "Chain substituted 12 mm, carefully."],
  ["changed case", "chain replaced 12 mm, carefully."],
  ["changed punctuation", "Chain replaced 12 mm carefully."],
  ["changed numbers", "Chain replaced 13 mm, carefully."],
  ["changed units", "Chain replaced 12 cm, carefully."],
  ["a non-line-end hyphen", "Chainreplaced 12 mm, carefully."],
])("document evidence with %s fails rather than fuzzy matching", async (_name, quote) => {
  const text =
    quote === "Chainreplaced 12 mm, carefully."
      ? "Chain-replaced 12 mm, carefully."
      : "Chain replaced 12 mm, carefully.";
  const document = sample("document", "document", text);
  const valid = JSON.stringify(proposalWith(leaf("document", text)));
  const { chat, requests } = scriptedChat([
    JSON.stringify(proposalWith(leaf("document", quote))),
    valid,
  ]);

  await initSchema([document], options(chat));

  expect(requests).toHaveLength(2);
});

test("document hyphen folding never removes a digit-surrounded line-end hyphen", async () => {
  const document = sample("document", "document", "Thickness 12-\nmm");
  const invalid = proposalWith(leaf("document", "Thickness 12mm"));
  const valid = JSON.stringify(proposalWith(leaf("document", "Thickness 12- mm")));
  const { chat, requests } = scriptedChat([JSON.stringify(invalid), valid]);

  await initSchema([document], options(chat));

  expect(requests).toHaveLength(2);
});
