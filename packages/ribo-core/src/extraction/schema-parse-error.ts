import type { ZodError } from "zod";

/**
 * A model response parsed as JSON but failed validation against the expected
 * extraction schema.
 *
 * This is deliberately **not** a `TerminalError`: a schema miss is
 * *sampled*, not deterministic. The same request can fail zod once and pass on
 * re-send, so the queue must still retry it. But the failure is also recognisable
 * so an extraction strategy ladder can fall through to the next strategy instead
 * of burning the same request shape repeatedly.
 * @category Extraction
 */
export class SchemaParseError extends Error {
  override readonly name = "SchemaParseError";

  /**
   * The parsed-JSON payload that failed validation, when the thrower had it.
   *
   * Optional because not every throw site parses model output (an arbiter
   * synthesising one for a test need not), and `unknown` because the whole point
   * is that it did NOT satisfy the schema. A self-correction retry shows this
   * back to the model as its own previous answer — out of band, as a
   * conversation turn, never appended to the transcript.
   */
  readonly output?: unknown;

  constructor(message: string, options?: { readonly cause?: ZodError; readonly output?: unknown }) {
    super(message, options);
    if (options && "output" in options) this.output = options.output;
  }
}
