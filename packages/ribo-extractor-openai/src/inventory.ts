/**
 * The inventory-pass extraction phase — one house-wide call that returns a roster
 * of candidate instances per collection group.
 *
 * This is the generic, tool-agnostic half of Task 9. The adapter owns the roster
 * schema and the instructions that describe what the vendor counts as one record;
 * this module owns the chat call, the prompt shape, and the trust-boundary parse.
 *
 * The roster is scaffolding for the scoped per-instance fills that follow (Task 10)
 * and is not persisted or reviewed.
 */

import { z } from "zod";

import type { ChatClient, ChatRequest } from "./chat-client.js";
import {
  assertStopFinishReason,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "./extraction-common.js";

/** Options for {@link extractInventory}. */
export interface InventoryOptions<R> {
  /** Identifies the call in error messages and the structured-output schema name. */
  readonly name: string;
  /** The inventory instructions, including the transcript injection boundary. */
  readonly instructions: string;
  /** The roster schema the response is parsed against. */
  readonly schema: z.ZodType<R>;
  /** The injected chat transport. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /**
   * Cap on generated tokens, passed through to `ChatRequest.maxTokens`. See
   * {@link SingleShotOptions.maxTokens} for the rationale.
   */
  readonly maxTokens?: number;
}

/**
 * Run one house-wide inventory call.
 *
 * The prompt is `[system: instructions, user: transcript]` and the transcript is
 * the last message — the injection boundary depends on it (R3 pinned this
 * ordering). The response is parsed against the supplied roster schema, so a
 * fabricated candidate without the required verbatim spans is rejected at the
 * trust boundary.
 */
export async function extractInventory<R>(
  options: InventoryOptions<R>,
  transcript: string,
): Promise<R> {
  const { name, instructions, schema, chat, model, maxTokens } = options;
  const context = `extractInventory: model response for "${name}"`;

  const request: ChatRequest = {
    model,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: transcript },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name,
        schema: z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>,
        strict: true,
      },
    },
    maxTokens,
  };

  const completion = await completeOrClassify(chat, request, context);
  assertStopFinishReason(completion, context);
  const raw = parseJsonContent(completion.content, context);
  return parseWithSchema(schema, raw, context);
}
