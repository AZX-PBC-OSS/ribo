import type { core, ZodObject, ZodType } from "zod";

import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
/**
 * Required-on-create declarations per group, typed against the adapter's value
 * schema so a typo in a group or leaf name is a compile error.
 *
 * Keys are the group path (e.g. `"hvac"`), and values are the leaf names within
 * that group (e.g. `["hvacSystemEquipmentType", "hvacUpgradeAction"]`). A record is
 * used instead of a flat list of full paths because a collection group has N
 * instances, and the same two leaves are required for every one of them; full
 * paths with instance keys are not known until the data arrives. This shape lets
 * {@link buildReviewRequest} mark the matching leaves on every emitted instance
 * without the adapter having to enumerate keyed paths.
 *
 * The leaf names are local to the group, not full dotted paths, because the group
 * is the create-end boundary: Snugg Pro requires these two fields to create an
 * HVAC record, not to create any record anywhere.
 *
 * Leaf names resolve against the group's own shape: a collection group's element type, a
 * singleton group's own keys, and for a top-level leaf the group key itself — the same name the
 * runtime matches against.
 */
export type RequiredOnCreate<V extends Record<string, unknown>> = Readonly<{
  [K in keyof V & string]?: readonly GroupLeafKey<V[K], K>[];
}>;

/** The valid leaf names within one group, keyed by the group's own top-level key. */
type GroupLeafKey<G, K extends string> = G extends readonly (infer E)[]
  ? keyof NonNullable<E> & string
  : G extends Record<string, unknown>
    ? keyof NonNullable<G> & string
    : K;

/** Loose runtime shape used inside review.ts, where the schema has already been walked. */
export type RequiredOnCreateMap = Readonly<Record<string, readonly string[]>>;

/**
 * Identifying-fields declarations per group, typed against the adapter's value schema
 * so a typo in a group or leaf name is a compile error — the same shape, and the same
 * reason, as {@link RequiredOnCreate} beside which it lives: tool-specific knowledge,
 * declared per group, consumed generically. Per group rather than per instance path
 * for the reason that one gives — a collection group has N instances, the same leaves
 * identify every one, and full paths need instance keys that only exist after
 * extraction.
 *
 * The **typed** form lives here because it is what an adapter *declares*; the **widened**
 * `IdentifyingFieldsMap` lives in `instance-identity.ts` because it is what the matcher
 * *consumes* and that file is the declared home for identity vocabulary. No import is
 * needed between them — structural assignability carries it, the same move
 * {@link RequiredOnCreate} → {@link RequiredOnCreateMap} makes in `review.ts`.
 */
export type IdentifyingFields<V extends Record<string, unknown>> = Readonly<{
  [K in keyof V & string]?: readonly GroupLeafKey<V[K], K>[];
}>;

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
   * Send as `Idempotency-Key`. Generated once, with the item, by the queue, and
   * stable across every retry of it — but **nothing rests on that**: measured
   * 2026-09-21 against Snugg Pro's staging API, replaying a byte-identical
   * create with the same key returned a new uuid. The key is still sent
   * (harmless, and free if a vendor ever honours it); duplicate protection is
   * the write receipt a retry UPDATEs, not this header.
   */
  readonly idempotencyKey: string;
  /**
   * The existing record this write should UPDATE, when a human linked the instance
   * at review; absent means create — an optional member rather than `LinkTarget`'s
   * `string | null`, because an optional member is what keeps every adapter written
   * before linking existed compiling, and `WriteMetadata` is a published contract.
   *
   * The type cannot enforce that an adapter honours this, and it must say so: an
   * adapter that ignores it will silently create duplicates once a host starts
   * linking, so honouring it is not optional for an adapter that supports updates.
   */
  readonly linkTarget?: string;
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
 *
 * @typeParam P - the per-group provenance granularity this adapter's extraction schema was derived
 * with (`enveloped(schema, { provenance })`), defaulting to none — every group at `"leaf"`, which
 * is what every adapter written before the option had. It appears here because `extractionSchema`
 * is `Enveloped<V, P>`: a group at `"row"` produces plain leaves and a row `sourceSpan`, which is
 * not a `Enveloped<V>`, so without this parameter the only way to declare such an adapter would be
 * a cast — and a cast at this boundary is precisely the schema drift the derivation exists to make
 * impossible.
 */
export interface ToolAdapter<V extends Record<string, unknown>, C, P = NoProvenance> {
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
  readonly extractionSchema: ZodType<Enveloped<V, P>>;
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
  /**
   * Leaf names, grouped by the group that owns the create endpoint, that the host
   * tool refuses to CREATE the record without.
   *
   * Surfaced to a human during review (`ReviewField.required`), so a write that
   * would be rejected by the host becomes a question asked while the auditor is
   * still on site rather than a dead queue row found that evening.
   *
   * **A parallel declaration here rather than metadata on `schema`.** zod `.meta()`
   * propagates through `enveloped()` into the derived extraction schema and lands
   * in the JSON Schema sent to the model, where an unknown keyword is what strict
   * structured-output mode rejects. The cost of a parallel declaration is drift, so
   * an adapter must pin it: assert every group and every leaf named here appears in
   * `schema`, which fails loudly on a typo or a rename instead of silently marking
   * nothing required.
   *
   * Declared per group, not per instance path, because a collection group has N
   * instances and the same leaves are required for every one of them. A flat list
   * of full paths would need to know instance keys (`hvac[k1].hvacSystemEquipmentType`)
   * that only exist after extraction; this shape marks the leaves on every instance
   * as review builds the request.
   */
  readonly requiredOnCreate?: RequiredOnCreate<V>;
  /**
   * Leaf names, grouped by collection group, that can make two descriptions certainly
   * *different* real-world things: the fields an instance of that group is identified
   * by well enough for a sameness judgement.
   *
   * Exactly the {@link RequiredOnCreate} precedent, and per group for the same reason
   * (see {@link IdentifyingFields}). Consumed through core's `contradictionMatcher` —
   * which vetoes on a committed disagreement and refuses to judge otherwise. It NEVER
   * merges on agreement: what makes two descriptions *the same* thing is host
   * judgement, because agreement is not identity (two identical furnaces in one house
   * agree on every field declared here and are two records). A wrong create is visible
   * at review and removable; a wrong merge is invisible and permanent.
   *
   * The same parallel-declaration caveat as `requiredOnCreate` applies, and the same
   * drift guard answers it: pin every named group and leaf against the schema in a
   * test, so a rename fails loudly instead of silently identifying nothing.
   */
  readonly identifyingFields?: IdentifyingFields<V>;
  readonly instructions: string;
  /** Optional few-shot examples, in the enveloped shape the model emits. */
  readonly examples?: readonly ToolAdapterExample<Enveloped<V, P>>[];
  /**
   * Writes accepted fields into the host tool. Rejects if the write fails.
   *
   * Resolves with the vendor's own identifier for the record it just created —
   * the id a future amend pass needs in order to update that record rather than
   * duplicate it.
   *
   * `meta` is a third parameter rather than a member of `ctx` deliberately: `ctx`
   * is *where to write* and travels with the recording, while `meta` is *how to
   * write safely* and comes from the queue. They have different lifetimes and
   * different sources, and merging them would let a host persist an idempotency
   * key into a recording's context.
   */
  write: (fields: V, ctx: C, meta: WriteMetadata) => Promise<{ readonly uuid: string }>;
}
