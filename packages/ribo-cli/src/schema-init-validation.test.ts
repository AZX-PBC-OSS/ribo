import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import type { ChatClient, ChatRequest } from "@azx/ribo-core";
import { expect, test, vi } from "vitest";

import { initSchema } from "./index.js";
import type { SchemaInitSample, SchemaInitSampleInput } from "./index.js";
import { joinCaseInputTexts } from "./eval/case-text.js";
import { OperatorError } from "./operator/error.js";
import { runSchemaInitCommand } from "./schema-init/command.js";
import { validateSchemaInitProposal } from "./schema-init/validate.js";

const sample = (
  name: string,
  kind: SchemaInitSampleInput["kind"],
  text: string,
): SchemaInitSample => ({
  name,
  inputs: [
    {
      path: `/samples/${name}.txt`,
      file: `${name}.txt`,
      kind,
      text,
      bytes: new TextEncoder().encode(text),
    },
  ],
  text,
});

const multiInputSample = (
  name: string,
  ...inputs: readonly { file: string; kind: SchemaInitSampleInput["kind"]; text: string }[]
): SchemaInitSample => ({
  name,
  inputs: inputs.map((input) => ({
    path: `/samples/${name}/${input.file}`,
    file: input.file,
    kind: input.kind,
    text: input.text,
    bytes: new TextEncoder().encode(input.text),
  })),
  text: joinCaseInputTexts(inputs),
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

test("evidence cannot span inputs, quote a marker, or borrow the document layout fold through a text input", () => {
  const joined = multiInputSample(
    "mixed",
    { file: "input.pdf", kind: "document", text: "An unrelated service sheet.\n" },
    { file: "note.txt", kind: "text", text: "Chain re- \n  placed\n" },
  );
  const markerQuote = "\n===== CAPTURE seq:1 kind:document id:input.pdf =====\n";
  const spanning = {
    root: object([
      property("span", leaf("mixed", `${joined.inputs[0]!.text} ${joined.inputs[1]!.text}`.trim())),
      property("marker", leaf("mixed", markerQuote)),
      property("borrowed", leaf("mixed", "Chain replaced")),
    ]),
  };

  const result = validateSchemaInitProposal(JSON.stringify(spanning), [joined]);

  expect(result.success).toBe(false);
  if (result.success) return;
  // A quote spanning two inputs exists only in the joined text, never inside
  // one input, so no input's own rule accepts it.
  expect(result.problems.some((problem) => problem.startsWith("span.evidence.quote:"))).toBe(true);
  // A quote equal to a capture marker line is never evidence: markers are not
  // part of any input's text.
  expect(result.problems.some((problem) => problem.startsWith("marker.evidence.quote:"))).toBe(
    true,
  );
  // A text input matches exactly: the document fold is never borrowed for it.
  expect(result.problems.some((problem) => problem.startsWith("borrowed.evidence.quote:"))).toBe(
    true,
  );
  expect(result.problems).toHaveLength(3);
});

test("a document-only folded quote and its enum fold follow the matching input in either declaration order", async () => {
  const documentText = "Chain re- \n  placed, carefully.";
  const foldedQuote = "Chain replaced";
  const build = (documentFirst: boolean): SchemaInitSample =>
    documentFirst
      ? multiInputSample(
          "mixed",
          { file: "scan.pdf", kind: "document", text: documentText },
          { file: "note.txt", kind: "text", text: "Nothing about chains here.\n" },
        )
      : multiInputSample(
          "mixed",
          { file: "note.txt", kind: "text", text: "Nothing about chains here.\n" },
          { file: "scan.pdf", kind: "document", text: documentText },
        );
  const proposalFor = (source: string) =>
    proposalWith(
      leaf(source, foldedQuote, {
        enum: [{ value: "replaced", evidence: evidence(source, "re- \n  placed, carefully.") }],
      }),
    );

  for (const documentFirst of [true, false]) {
    const mixed = build(documentFirst);
    const reply = JSON.stringify(proposalFor("mixed"));
    // Direct validation: the document input's own rule accepts the quote, so
    // the non-matching text input cannot reject it.
    expect(validateSchemaInitProposal(reply, [mixed]).success).toBe(true);
    // Through the draft loop: accepted without repair, whichever order.
    const { chat, requests } = scriptedChat([reply]);
    await initSchema([mixed], options(chat));
    expect(requests).toHaveLength(1);
  }

  // The same quote against a text-only sample is rejected: exact matching.
  const textOnly = multiInputSample("texty", {
    file: "note.txt",
    kind: "text",
    text: documentText,
  });
  const textOnlyResult = validateSchemaInitProposal(JSON.stringify(proposalFor("texty")), [
    textOnly,
  ]);
  expect(textOnlyResult.success).toBe(false);
});

test("an enum member found in the input but absent from its own quote is refused", async () => {
  const invented = proposalWith(
    leaf("notes", "Chain replaced", {
      enum: [{ value: "replaced", evidence: evidence("notes", "Chain") }],
    }),
  );
  const { chat, requests } = scriptedChat([JSON.stringify(invented), validReply]);

  await initSchema([notes], options(chat));

  expect(repairFeedback(requests)).toContain('enum value "replaced" does not appear in its own');
});

// --- --draft-from: evidence may name only a drafting sample ---

test("schema init rejects and repairs evidence citing a non-drafting sample", async () => {
  const drafting = sample("case-b", "text", "Beta text for the draft.\n");
  const others: readonly SchemaInitSample[] = [
    sample("case-a", "text", "Alpha text for the draft.\n"),
    drafting,
    sample("case-c", "text", "Gamma text for the draft.\n"),
  ];
  const citingNonDrafting = JSON.stringify({
    root: object([property("value", leaf("case-a", "Alpha text for the draft."))]),
  });
  const valid = JSON.stringify({
    root: object([property("value", leaf("case-b", "Beta text for the draft."))]),
  });
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    async complete(request) {
      requests.push(request);
      return { content: requests.length === 1 ? citingNonDrafting : valid };
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "ribo-schema-init-validation-"));
  try {
    const result = await runSchemaInitCommand(
      ["./case-a", "./case-b", "./case-c"],
      {
        backend: "openai-compatible",
        model: "stub-schema-author",
        corpus: "draft-corpus",
        corpusName: "Subset corpus",
        corpusProvenance: "real",
        draftFrom: ["case-b"],
      },
      {
        cwd: directory,
        env: {},
        stdout: new Writable({ write: (_c, _e, cb) => cb() }),
        stderr: new Writable({ write: (_c, _e, cb) => cb() }),
        confirmation: null,
        loadSamples: async () => others,
        prepareBackend: async () => chat,
      },
    );

    // The first reply named a sample the model was never shown: it is
    // rejected by name, then the valid drafting-sample reply is accepted.
    expect(requests).toHaveLength(2);
    const feedback = requests[1]!.messages.at(-1)!.content;
    expect(feedback).toContain('unknown source "case-a"');
    expect(result.draft.proposal.root.properties[0]!.node).toMatchObject({
      kind: "string",
      evidence: { source: "case-b" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
