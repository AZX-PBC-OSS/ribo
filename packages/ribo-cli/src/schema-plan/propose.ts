import type { ChatClient, ChatRequest, SchemaPlanPiece } from "@azx/ribo-core";

import { OperatorError } from "../operator/error.js";
import {
  initialSchemaPlanPrompt,
  repairSchemaPlanPrompt,
  updateSchemaPlanPrompt,
} from "./prompt.js";
import type { SchemaPlanPromptInput } from "./prompt.js";
import { validateSchemaPlanReply } from "./validate.js";

const MAX_REPAIRS = 2;

export interface ProposeSchemaPlanOptions extends SchemaPlanPromptInput {
  readonly chat?: ChatClient;
}

/** Drive one initial request and its bounded, validation-feedback repairs. */
export async function proposeSchemaPlanPieces(
  options: ProposeSchemaPlanOptions,
): Promise<readonly SchemaPlanPiece[]> {
  if (options.chat === undefined) {
    throw new OperatorError(
      "schema planning needs a chat client for an initial plan or an update with added fields " +
        "(fix: inject the prepared backend chat client)",
    );
  }

  const update = options.existingPieces !== undefined;
  const expectedPaths = update
    ? (options.additions ?? [])
    : options.inventory.map((entry) => entry.path);
  let activeRequest: ChatRequest = update
    ? updateSchemaPlanPrompt(options)
    : initialSchemaPlanPrompt(options);
  let lastProblems: readonly string[] = ["no response was validated"];

  for (let repair = 0; repair <= MAX_REPAIRS; repair++) {
    const completion = await options.chat.complete(activeRequest);
    const validated = validateSchemaPlanReply(completion.content, {
      expectedPaths,
      ...(update ? { existingPieces: options.existingPieces } : {}),
    });
    if (validated.success) return validated.reply.pieces;
    lastProblems = validated.problems;
    if (repair < MAX_REPAIRS) {
      activeRequest = repairSchemaPlanPrompt(
        update ? updateSchemaPlanPrompt(options) : initialSchemaPlanPrompt(options),
        completion.content,
        validated.problems,
        repair + 1,
      );
    }
  }

  throw new OperatorError(
    `schema planning exhausted its validation repairs; no plan was produced. Last feedback: ` +
      lastProblems.join("; "),
  );
}
