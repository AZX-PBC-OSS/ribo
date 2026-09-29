import type { ChatClient, ChatCompletion, ChatRequest } from "../../phases/chat-client.js";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { proposeExtractionShape, proposeShapeOperations } from "./operations-proposer.js";
import { renderLeafInventory, walkLeafInventory } from "./leaf-inventory.js";

/**
 * @file The proposer sees the caller's declarations.
 *
 * `proposeExtractionShape` used to hand `provenance`, `requiredOnCreate` and
 * `identifyingFields` to the final derive only. The proposer validated each
 * attempt without them, so a drop that strands a declaration was accepted on
 * the first turn — no repair — and the final derive threw. The declarations
 * now reach the per-attempt validation, and the inventory tags what they name
 * so the model can avoid the conflict in the first place.
 */

const surveySchema = z.object({
  vessel: z.object({
    name: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  engines: z.array(
    z.object({
      make: z.string().describe("The engine manufacturer.").nullable().optional(),
      serialNumber: z.string().nullable().optional(),
    }),
  ),
  surveyor: z.string().nullable().optional(),
});

const declarations = {
  provenance: { engines: "row" },
  requiredOnCreate: { engines: ["make"] },
  identifyingFields: { engines: ["serialNumber"], surveyor: ["surveyor"] },
} as const;

/** A ChatClient that records every request and replays a script of completions. */
function scriptedChat(script: readonly ChatCompletion[]): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      const step = script[requests.length - 1];
      return step === undefined
        ? Promise.reject(new Error("scripted chat exhausted"))
        : Promise.resolve(step);
    },
  };
  return { chat, requests };
}

const completion = (body: unknown): ChatCompletion => ({
  content: JSON.stringify(body),
  finishReason: "stop",
});

const proposeOptions = (chat: ChatClient) => ({
  chat,
  model: "m",
  context: "declarations",
  instructions: "",
});

const messageContent = (request: ChatRequest | undefined, role: string): string =>
  request?.messages.find((message) => message.role === role)?.content ?? "";

describe("proposer — declarations reach the per-attempt validation", () => {
  test("a drop that strands requiredOnCreate is repaired, not thrown at the final derive", async () => {
    const { chat, requests } = scriptedChat([
      completion({
        operations: [
          { op: "drop", path: "engines.make" },
          { op: "drop", path: "vessel.notes" },
        ],
      }),
      completion({ operations: [{ op: "drop", path: "vessel.notes" }] }),
    ]);

    const shape = await proposeExtractionShape(surveySchema, proposeOptions(chat), declarations);

    expect(requests).toHaveLength(2);
    const repair = requests[1]!.messages.at(-1)?.content ?? "";
    expect(repair).toContain('drop "engines.make"');
    expect(repair).toContain("requiredOnCreate declaration");
    expect(Object.keys(shape.mapping.leaves)).not.toContain("vessel.notes");
    expect(shape.requiredOnCreate).toEqual({ engines: ["make"] });
  });

  test("at exhaustion the surviving subset excludes a drop that strands a declaration", async () => {
    const { chat } = scriptedChat([
      completion({
        operations: [
          { op: "drop", path: "surveyor" },
          { op: "drop", path: "vessel.notes" },
        ],
      }),
    ]);

    const operations = await proposeShapeOperations(
      surveySchema,
      { ...proposeOptions(chat), maxRepairAttempts: 0 },
      declarations,
    );

    expect(operations).toEqual([{ op: "drop", path: "vessel.notes" }]);
  });

  test("a drop that strands provenance is refused too", async () => {
    const { chat } = scriptedChat([completion({ operations: [{ op: "drop", path: "engines" }] })]);

    const operations = await proposeShapeOperations(
      surveySchema,
      { ...proposeOptions(chat), maxRepairAttempts: 0 },
      declarations,
    );

    expect(operations).toEqual([]);
  });
});

describe("proposer — the inventory tags what the declarations name", () => {
  test("declared leaves and groups carry their tags; undeclared ones carry none", () => {
    const text = renderLeafInventory(walkLeafInventory(surveySchema), declarations);

    expect(text).toContain("- engines (array) [provenance: row]");
    expect(text).toContain('    - make (string) [required on create] — "The engine manufacturer."');
    expect(text).toContain("    - serialNumber (string) [identifying]");
    expect(text).toContain("- surveyor (string) [identifying]");
    expect(text).toContain("- vessel (object)\n");
    expect(text).toContain("    - notes (string)\n");
  });

  test("without declarations the inventory is unchanged", () => {
    const entries = walkLeafInventory(surveySchema);
    expect(renderLeafInventory(entries, {})).toBe(renderLeafInventory(entries));
    expect(renderLeafInventory(entries)).not.toContain("[");
  });

  test("the proposer sends the tagged inventory and a directive that explains the tags", async () => {
    const { chat, requests } = scriptedChat([completion({ operations: [] })]);

    await proposeShapeOperations(surveySchema, proposeOptions(chat), declarations);

    expect(messageContent(requests[0], "user")).toContain("make (string) [required on create]");
    const system = messageContent(requests[0], "system");
    expect(system).toContain("[required on create]");
    expect(system).toContain("[identifying]");
    expect(system).toContain("[provenance: ");
  });
});
