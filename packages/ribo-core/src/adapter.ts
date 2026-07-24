import type { ZodType } from "zod";

/**
 * A few-shot example: a transcript, and the fields it should produce.
 *
 * Used to steer extraction. Kept as data on the adapter rather than baked into
 * a prompt so the extractor owns prompt assembly and the adapter owns only
 * tool-specific knowledge.
 */
export interface ToolAdapterExample<F> {
  readonly transcript: string;
  readonly fields: F;
}

/**
 * The one place tool-specific knowledge lives: how a host tool's fields are
 * shaped, how to describe them to an extractor, and how to write them back.
 *
 * @typeParam F - the fields this adapter extracts and writes. `schema` is the
 * source of truth for `F`; declare the schema and `z.infer` the type from it.
 * @typeParam C - the host context `write` needs in order to write: whatever
 * identifies the destination (`{ jobId: string }`, a session handle, an API
 * client). This is a **real type parameter, never `unknown`.** An earlier design
 * used `ctx: unknown`, which review rejected: it hid the host↔adapter coupling
 * from the type system, so nothing checked that a caller had what the adapter
 * actually needed. `adapter.test.ts` pins that down with `@ts-expect-error`.
 *
 * `write` is a function *property*, not a method. TypeScript checks method
 * parameters bivariantly, which would make a `ToolAdapter<F, {jobId, userId}>`
 * assignable where a `ToolAdapter<F, {jobId}>` is expected — reintroducing the
 * hole `C` exists to close. The property form gets strict contravariance.
 */
export interface ToolAdapter<F, C> {
  /** Stable identifier for this adapter, e.g. `"snuggpro-attic-insulation"`. */
  readonly name: string;
  /** Parses extractor output into `F`. Adapter input crosses a trust boundary. */
  readonly schema: ZodType<F>;
  /** Natural-language guidance for the extractor: what each field means. */
  readonly instructions: string;
  /** Optional few-shot examples. */
  readonly examples?: readonly ToolAdapterExample<F>[];
  /** Writes accepted fields into the host tool. Rejects if the write fails. */
  write: (fields: F, ctx: C) => Promise<void>;
}
