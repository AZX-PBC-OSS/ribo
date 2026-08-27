import type { ZodError } from "zod";

/**
 * A model response parsed as JSON but failed validation against the expected
 * extraction schema.
 *
 * This is deliberately **not** a {@link TerminalQueueError}: a schema miss is
 * *sampled*, not deterministic. The same request can fail zod once and pass on
 * re-send, so the queue must still retry it. But the failure is also recognisable
 * so an extraction strategy ladder can fall through to the next strategy instead
 * of burning the same request shape repeatedly.
 */
export class SchemaParseError extends Error {
  override readonly name = "SchemaParseError";

  constructor(message: string, options?: { readonly cause?: ZodError }) {
    super(message, options);
  }
}
