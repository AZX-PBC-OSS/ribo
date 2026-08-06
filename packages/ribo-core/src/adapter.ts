import type { ZodObject, ZodType } from "zod";

import type { Enveloped } from "./enveloped.js";

/**
 * An object schema that is both **walkable** and **binding**: it has a `shape`, so
 * `enveloped()` and `buildReviewRequest` can enumerate its leaves, and it parses to
 * exactly `V`, so the adapter's field type is still checked at the boundary.
 *
 * It has to be an intersection, because zod 4 offers no single spelling for
 * "`ZodObject` whose output is `V`". `ZodObject<Shape, Config>` derives its output
 * *from* its shape — there is no output type parameter to pin — and `ZodType<V>` pins
 * the output but declares no `shape`. Each half supplies what the other lacks:
 *
 *   - `ZodObject` alone would drop `V` entirely. Bare, it is
 *     `ZodObject<$ZodLooseShape, $strip>`, whose parsed output is `{}` — assignable to
 *     any all-optional patch type, so a `ToolAdapter<A, C>` would happily accept
 *     schema `B` and `write` would receive values it was never checked against.
 *   - `ZodType<V>` alone is what this member used to be, and it is why
 *     `buildReviewRequest(extracted, transcript, adapter.schema)` did not compile: the
 *     leaves review presents are enumerated off `.shape`, which `ZodType` has no
 *     concept of. The information was never missing — `enveloped(schema)` already
 *     requires `T extends ZodObject` to derive `extractionSchema` at all — only
 *     discarded on the way through this interface.
 *
 * Adapters need no cast: a `z.object({...}).strict()` satisfies both halves, because
 * `ZodObject`'s two parameters are covariant (`out Shape`, `out Config`), so a concrete
 * strict shape is assignable to the bare form. `adapter.test.ts` pins both directions —
 * that a walk compiles, and that a schema whose leaves disagree with `V` does not.
 *
 * **One thing the intersection gives up, measured rather than assumed.** A patch `V` is
 * all-optional by construction (design §2.1), which makes it a *weak type*, and
 * TypeScript's weak-type check — "this has no properties in common with that" — is what
 * used to refuse a schema for an entirely different field set against the old
 * `ZodType<V>`. That check is skipped when the target is an intersection, so this member
 * alone now admits a fully disjoint schema (a leaf whose type merely *disagrees* is still
 * refused, which is the drift that actually happens). It is not a hole in the interface:
 * `extractionSchema` is `ZodType<Enveloped<V>>` and `Enveloped<V>` is fully required, so
 * the weak-type check still applies there and an adapter wired to a foreign field set
 * cannot be declared. `adapter.test.ts` pins that compensating refusal, so it cannot be
 * removed without this trade becoming a real one.
 */
export type ValuesSchema<V> = ZodObject & ZodType<V>;

/**
 * A few-shot example: a transcript, and the fields it should produce.
 *
 * Used to steer extraction. Kept as data on the adapter rather than baked into
 * a prompt so the extractor owns prompt assembly and the adapter owns only
 * tool-specific knowledge.
 *
 * On a {@link ToolAdapter} this is instantiated at `Enveloped<V>`, not `V`: the
 * example's `fields` become the **assistant** turn the model is asked to imitate,
 * so they must be the provenance-enveloped shape the model actually emits.
 */
export interface ToolAdapterExample<F> {
  readonly transcript: string;
  readonly fields: F;
}

/**
 * Metadata for one write attempt. Not part of `V` and not part of `C` — see
 * {@link ToolAdapter}'s note on `write`'s third parameter.
 */
export interface WriteMetadata {
  /**
   * Send as `Idempotency-Key`. **Stable across every retry of this queue item**,
   * so a retry after an ambiguous success (the request landed, the response did
   * not) is recognised by the host tool as the same write rather than a second
   * one. Generated once, with the item, by the queue.
   */
  readonly idempotencyKey: string;
}

/**
 * The one place tool-specific knowledge lives: how a host tool's fields are
 * shaped, how to describe them to an extractor, and how to write them back.
 *
 * ## Two field shapes, one derived from the other
 *
 * An adapter carries **two** field schemas because two different things happen to
 * its fields, and one shape cannot serve both (design
 * `r1.5-field-shape-contracts-design.md` §1.1–§2.2):
 *
 *   - `schema` is the **patch** that gets written — plain values, and the source
 *     of truth for `V`. Every leaf is optional (a rejected field is absent from
 *     the patch, so the write leaves it alone) and nullable where a null is a
 *     meaningful written value ("write this field as empty").
 *   - `extractionSchema` is what the **model** is asked to produce: the same
 *     fields with the patch's optionality stripped and every leaf wrapped in a
 *     provenance envelope, closed and fully required at every level — because
 *     `provenance.ts`'s anti-hallucination rule needs an explicit `null` rather
 *     than an omitted key.
 *
 * `extractionSchema` is **derived, not hand-written**: `enveloped(schema)` is the
 * one supported way to build it. Declaring both by hand is how the two shapes
 * drift apart without anything noticing, which is exactly the defect R1.5 exists
 * to fix.
 *
 * @typeParam V - the plain field VALUES this adapter writes. `schema` is the
 * source of truth for `V`; declare the schema and `z.infer` the type from it.
 * The extraction side is `Enveloped<V>`, computed from `V` rather than declared.
 * @typeParam C - the host context `write` needs in order to write: whatever
 * identifies the destination (`{ jobId: string }`, a session handle, an API
 * client). This is a **real type parameter, never `unknown`.** An earlier design
 * used `ctx: unknown`, which review rejected: it hid the host↔adapter coupling
 * from the type system, so nothing checked that a caller had what the adapter
 * actually needed. `adapter.test.ts` pins that down with `@ts-expect-error`.
 *
 * `write` is a function *property*, not a method. TypeScript checks method
 * parameters bivariantly, which would make a `ToolAdapter<V, {jobId, userId}>`
 * assignable where a `ToolAdapter<V, {jobId}>` is expected — reintroducing the
 * hole `C` exists to close. The property form gets strict contravariance.
 */
export interface ToolAdapter<V, C> {
  /** Stable identifier for this adapter, e.g. `"snuggpro-attic-insulation"`. */
  readonly name: string;
  /**
   * The PATCH that gets written, in plain values. Source of truth for `V`, and
   * the trust boundary a reviewed submission is parsed through before a write
   * ({@link toWriteStep} is what installs that boundary).
   *
   * A {@link ValuesSchema}, not a bare `ZodType<V>`: review enumerates this
   * schema's leaves to build a review card, so it must be walkable as well as
   * binding. See that type's note.
   */
  readonly schema: ValuesSchema<V>;
  /**
   * What the model must produce: `schema` stripped of its patch optionality with
   * every leaf enveloped. Build it with `enveloped(schema)` — see the note above
   * on why this is derived rather than declared.
   */
  readonly extractionSchema: ZodType<Enveloped<V>>;
  /**
   * Parses `Recording.ctx` into the destination this adapter writes to.
   *
   * A schema and not merely the `C` type parameter, because `Recording.ctx` comes
   * back out of IndexedDB and so crosses a trust boundary — a *type* cannot parse
   * an `unknown` off a persisted row. `recordingSchema(jobContext)` already
   * anticipates this shape: the host supplies its context as a zod schema and the
   * type is inferred back off it.
   */
  readonly ctxSchema: ZodType<C>;
  /** Natural-language guidance for the extractor: what each field means. */
  readonly instructions: string;
  /** Optional few-shot examples, in the enveloped shape the model emits. */
  readonly examples?: readonly ToolAdapterExample<Enveloped<V>>[];
  /**
   * Writes accepted fields into the host tool. Rejects if the write fails.
   *
   * `meta` is a third parameter rather than a member of `ctx` deliberately: `ctx`
   * is *where to write* and travels with the recording, while `meta` is *how to
   * write safely* and comes from the queue. They have different lifetimes and
   * different sources, and merging them would let a host persist an idempotency
   * key into a recording's context.
   */
  write: (fields: V, ctx: C, meta: WriteMetadata) => Promise<void>;
}
