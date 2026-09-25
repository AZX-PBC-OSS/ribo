/**
 * @file The trust-boundary parse shared by every extractor that receives model
 * output: parse raw JSON against a zod schema, throwing a recognisable,
 * retryable error on failure. Moved to core beside `SchemaParseError` (which it
 * throws) so `groupedExtractor`'s second parse and the managed extractors' first
 * parse are the same function, not two copies of the same semantics.
 */
import type { z } from "zod";

import { SchemaParseError } from "./schema-parse-error.js";

/**
 * Parse `raw` against a zod schema, throwing a {@link SchemaParseError} on failure.
 *
 * A response that does not satisfy the schema is *sampled*: the same request can fail
 * zod once and pass on re-send, so the failure stays transient/retryable. The queue
 * keeps retrying rather than losing a recording someone drove to a house to make. At the
 * same time the error is now recognisable: a strategy ladder can see it and fall through
 * to a different shape instead of sampling the same broken one indefinitely. Both halves
 * matter — making it transient alone would keep the ladder from moving on; making it
 * terminal alone would strip retries from the very recordings that have no second chance.
 * The terminal cases (truncation, content filtering) are caught earlier, before this
 * parse, by the transport's finish-reason check.
 *
 * @param context - a descriptive prefix for the error
 */
export function parseWithSchema<T>(schema: z.ZodType<T>, raw: unknown, context: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // `output` carries the rejected payload so a self-correction retry
    // (schema-retry.ts) can show the model its own answer as a conversation
    // turn — never by touching the transcript.
    throw new SchemaParseError(`${context} did not match the schema: ${parsed.error.message}`, {
      cause: parsed.error,
      output: raw,
    });
  }
  return parsed.data;
}
