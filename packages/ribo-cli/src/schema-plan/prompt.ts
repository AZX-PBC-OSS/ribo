import type { ChatRequest, LeafInventoryEntry, SchemaPlanPiece } from "@azx/ribo-core";

export interface SchemaPlanPromptInput {
  readonly document: unknown;
  readonly inventory: readonly LeafInventoryEntry[];
  readonly model: string;
  readonly existingPieces?: readonly SchemaPlanPiece[];
  readonly additions?: readonly string[];
}

const responseSchema = (paths: readonly string[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: ["pieces"],
  properties: {
    pieces: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "key", "paths"],
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          key: { type: "string", minLength: 1 },
          paths: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: [...paths] },
          },
        },
      },
    },
  },
});

const request = (
  model: string,
  update: boolean,
  paths: readonly string[],
  instructions: string,
): ChatRequest => ({
  model,
  messages: [
    {
      role: "system",
      content:
        "Author semantic schema-plan pieces. Return only the requested JSON object. " +
        "Use only the request's closed path vocabulary, place every placeable path exactly once, " +
        "and keep each piece within one top-level key: every path's first dotted segment must " +
        "equal that piece's key. Give pieces stable, human-reviewable names and descriptions.",
    },
    { role: "user", content: instructions },
  ],
  responseFormat: {
    type: "json_schema",
    json_schema: {
      name: update ? "ribo_schema_plan_update" : "ribo_schema_plan",
      schema: responseSchema(paths),
      strict: true,
    },
  },
});

const inventoryJson = (entries: readonly LeafInventoryEntry[]): string =>
  JSON.stringify(entries, null, 2);

/** Build an initial request whose model output is semantic pieces only. */
export function initialSchemaPlanPrompt(input: SchemaPlanPromptInput): ChatRequest {
  const paths = input.inventory.map((entry) => entry.path);
  return request(
    input.model,
    false,
    paths,
    `Create a complete semantic partition for this schema. Code owns artifact metadata and the ` +
      `root inventory; you own only the ordered pieces and their ordered paths.\n\n` +
      `Schema document:\n${JSON.stringify(input.document, null, 2)}\n\n` +
      `Field inventory in schema order, including each field's meaning:\n${inventoryJson(input.inventory)}\n\n` +
      `Closed path vocabulary:\n${JSON.stringify(paths)}\n\n` +
      `Return every listed path exactly once. Do not invent, omit or duplicate a path.`,
  );
}

/** Build an update request that exposes additions and eligible surviving targets, nothing else. */
export function updateSchemaPlanPrompt(input: SchemaPlanPromptInput): ChatRequest {
  const additions = input.additions ?? [];
  const additionSet = new Set(additions);
  const additionKeys = new Set(additions.map((path) => path.split(".")[0]));
  const additionInventory = input.inventory.filter((entry) => additionSet.has(entry.path));
  const targets = (input.existingPieces ?? [])
    .filter((piece) => additionKeys.has(piece.key))
    .map(({ name, description, key }) => ({ name, description, key }));
  return request(
    input.model,
    true,
    additions,
    `Place only the added fields below into the surviving plan. Surviving assignments, path order ` +
      `and piece order are locked and are not shown as placeable input. To add to a surviving ` +
      `same-key piece, repeat its name, description and key verbatim. To create a piece, supply ` +
      `new semantic metadata. Return only additions, never surviving paths.\n\n` +
      `Added field inventory, including each addition's meaning:\n${inventoryJson(additionInventory)}\n\n` +
      `Closed added-path vocabulary:\n${JSON.stringify(additions)}\n\n` +
      `Surviving same-key targets:\n${JSON.stringify(targets, null, 2)}\n\n` +
      `Place every addition exactly once. A rename is an addition here; its vanished old path is ` +
      `not part of this request.`,
  );
}

/** Append the previous reply and all named validation problems as one bounded repair turn. */
export function repairSchemaPlanPrompt(
  base: ChatRequest,
  previousReply: string,
  problems: readonly string[],
  repairNumber: number,
): ChatRequest {
  return {
    ...base,
    messages: [
      ...base.messages,
      { role: "assistant", content: previousReply },
      {
        role: "user",
        content:
          `Repair ${repairNumber}: the previous reply was not a valid schema-plan proposal. ` +
          `Correct every named problem without dropping, completing or reordering valid data ` +
          `silently.\n${problems.map((problem) => `- ${problem}`).join("\n")}\n` +
          "Return only a corrected JSON object under the same contract.",
      },
    ],
  };
}
