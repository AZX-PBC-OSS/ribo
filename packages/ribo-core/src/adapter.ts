import type { core, ZodObject, ZodType } from "zod";

import type { Enveloped } from "./enveloped.js";

/**
 * An object schema that is both **walkable** and **binding**: it has a `shape`, so
 * `enveloped()` and `buildReviewRequest` can enumerate its leaves, and it parses to
 * exactly `V`, so the adapter's field type is still checked at the boundary.
 *
 * Zod 4 has no single spelling for "`ZodObject` whose output is `V`" —
 * `ZodObject<Shape, Config>` derives its output *from* its shape, so there is no output
 * parameter to pin, and `ZodType<V>` pins the output but declares no `shape`. So this
 * type supplies the missing half itself, by **extending** `ZodObject` and narrowing the
 * two members that carry the output type.
 *
 * ## Why an interface and not `ZodObject & ZodType<V>`
 *
 * The intersection is the obvious spelling, it compiles, and it is **wrong** — for a
 * reason that is invisible until you try to declare a broken adapter. A patch `V` is
 * all-optional by construction (design §2.1), which makes it a TypeScript *weak type*,
 * and the weak-type check ("type has no properties in common with…") is what refuses a
 * schema written for an entirely different tool. **That check is skipped whenever the
 * target is an intersection.** Under `ZodObject & ZodType<V>` this compiled clean:
 *
 * ```ts
 * const mixed: ToolAdapter<AtticFields, JobContext> = {
 *   schema: someOtherToolsPatch,             // disjoint — and accepted
 *   extractionSchema: atticExtractionSchema, // correct, so nothing else objected
 *   ...
 * };
 * ```
 *
 * which is not a contrived pairing: it is what copying an adapter module for a second
 * tool and updating everything *except* `schema:` produces. The consequences are quiet
 * ones — `buildReviewRequest` walks the wrong schema, so the review card shows another
 * tool's leaves as sentinel envelopes, and `toWriteStep` parses the reviewed patch
 * against the wrong schema. Nothing unchecked reaches the host tool (the runtime parse
 * still runs, and rejects), but the type that was supposed to make this unrepresentable
 * did not.
 *
 * An interface target is not an intersection, so the weak-type check applies again.
 *
 * **The two narrowed members do different jobs, and both are load-bearing** — established
 * by deleting each and reading the failure, not by inspection:
 *
 *   - `_output` is what carries the **refusal**. Drop it and both the disjoint pin and
 *     the mixed pin in `adapter.test.ts` stop firing, because the surviving `_zod`
 *     narrowing is itself written as an intersection (`$ZodObjectInternals<…> & {…}`) and
 *     so suppresses the weak-type check in exactly the way this type exists to avoid.
 *   - `_zod.output` is what carries the **binding**. Drop it and
 *     `adapter.schema.safeParse(reviewed)` in `write-step.ts` stops returning `V` —
 *     zod's `parse` is declared as `core.output<this>`, which reads `this["_zod"]["output"]`
 *     and never looks at `_output`.
 *
 * Narrowing only one would therefore be silently half-right in either direction.
 *
 * ## Two costs, recorded rather than absorbed
 *
 *   - **`V` must be a `Record<string, unknown>`**, which propagates to
 *     `ToolAdapter<V, C>` and everything generic over it. Every `V` in this repo is a
 *     `z.infer` alias and satisfies it (anonymous object types get an implicit index
 *     signature); a host that declared its values as a hand-written `interface` would
 *     not, and would need a `type` alias instead. That is a real if small tax on a
 *     consumer, and it is the price of the check above.
 *   - **It names `_output` and `_zod`**, which are zod internals rather than its
 *     documented surface. A zod major could rename them, and the failure would be a
 *     compile error here rather than anything silent. `adapter.test.ts` walks a real
 *     schema through this type, so an upgrade that changed them fails the typecheck.
 *
 * The considered alternative was a `defineToolAdapter` factory tying `extractionSchema`
 * to the schema actually passed. It catches the same mistake without touching zod
 * internals, but only at a declaration site that goes through the factory — a hand-built
 * object literal typed `ToolAdapter<V, C>` stays unchecked — so it constrains less than
 * this does. Worth revisiting if either cost above bites.
 *
 * Adapters need no cast: a `z.object({...}).strict()`, nested objects and all, satisfies
 * this directly, because `ZodObject`'s parameters are covariant (`out Shape`,
 * `out Config`). `adapter.test.ts` pins every direction — the walk compiles, `enveloped()`
 * accepts it, a disjoint schema does not, a disagreeing leaf does not, and the mixed
 * pairing above does not.
 */
export interface ValuesSchema<V extends Record<string, unknown>> extends ZodObject {
  readonly _output: V;
  readonly _zod: core.$ZodObjectInternals<core.$ZodLooseShape, core.$strip> & { output: V };
}

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
export interface ToolAdapter<V extends Record<string, unknown>, C> {
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
