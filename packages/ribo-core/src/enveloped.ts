import { z } from "zod";

import { extractedSchema, type Extracted } from "./provenance.js";

/**
 * `enveloped()` derives the **extraction schema** — what the model is asked to produce — from a
 * **patch schema** — what a host writes back. See `docs/roadmap/design/r1.5-field-shape-contracts-design.md`
 * §2.1–§3 for the full rationale; this is the summary needed to read the code below.
 *
 * A patch (`V`) is open and optional everywhere: every leaf is `X.nullable().optional()`, and
 * `resolveReview` omits a rejected leaf entirely, so the patch must tolerate a key being absent.
 * The extraction schema cannot be: `provenance.ts`'s anti-hallucination rule requires every key
 * present and nullable, so the model emits an explicit `null` rather than silently omitting a
 * field it never considered. `enveloped()` is the one place that gap is bridged: it walks a
 * patch's shape, strips the `.optional()`/`.nullable()` that make it a patch, wraps each leaf in
 * `extractedSchema`, and rebuilds every object — top-level and nested — as closed and required.
 *
 * The walk (this is the literal decision table, see design §3):
 *
 *   - `.optional()` / `.nullable()` wrapper, in either order, any number of times → unwrap and
 *     continue. This is the step that must happen BEFORE `extractedSchema`, not after: skipping it
 *     turns `X.nullable().optional()` into `value: X.nullable().nullable()` — a doubly-nullable
 *     leaf that serializes to a nested `anyOf` in the JSON Schema, silently changing what the model
 *     is asked for. See `enveloped.test.ts`'s stripping tests, which assert on the JSON Schema
 *     string for exactly this reason — a zod-level assertion alone would not catch it.
 *   - a nested `z.ZodObject` → recurse, producing a closed, fully-required object of its own. This
 *     is NOT the same as wrapping the whole nested object in one envelope — a matrix of 11 named
 *     tests must stay 11 independently-reviewable envelopes, not one envelope over an object.
 *   - `z.ZodEnum`, `z.ZodLiteral`, `z.ZodString`, `z.ZodNumber`, `z.ZodBoolean` → `extractedSchema(leaf)`.
 *   - anything else — arrays, records, unions (including discriminated unions, and including a
 *     union of objects) — **throw**, naming the field path. These shapes become the JSON Schema
 *     sent in OpenAI strict structured-output mode, where an unsupported shape surfaces as an
 *     opaque API error far from its cause; throwing here, with the path, is strictly more useful
 *     than that.
 */

/** A patch or extraction shape's raw fields: the record `z.object({ ... })` is built from. */
type RawShape = Record<string, z.ZodType>;

/**
 * Strip every `.optional()` / `.nullable()` wrapper off `field`, in whatever order and however
 * many of them there are. A patch leaf may be wrapped as `X.nullable().optional()` OR
 * `X.optional().nullable()` — both must reduce to bare `X`. `.unwrap()` is the public zod 4.4.3
 * API for peeling off exactly one `ZodOptional` / `ZodNullable` layer; looping while either
 * wrapper is still present handles both orders (and, defensively, deeper stacks) uniformly.
 */
const stripOptionalNullable = (field: z.ZodType): z.ZodType => {
  let current = field;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    // `.unwrap()`'s declared return type is generic over the wrapped type, defaulting to the
    // core (not classic) `$ZodType` once narrowed only by `instanceof`; every real wrapper in
    // this codebase wraps a classic `z.ZodType`, so this cast reflects that rather than working
    // around it.
    current = current.unwrap() as z.ZodType;
  }
  return current;
};

/**
 * The leaf types `enveloped()` knows how to wrap. Matches design §3's decision table exactly —
 * this is an allowlist, not a denylist, so a zod type this table doesn't name (array, record,
 * union, or anything added to zod after this was written) falls through to the throw below rather
 * than being silently accepted.
 *
 * Known edge, not fixed here because design §3's table names KINDS, not constraint-free kinds:
 * `z.number().min(0)` is still `instanceof z.ZodNumber`, and `z.string().regex(...)` is still
 * `instanceof z.ZodString`, so both pass this allowlist and get wrapped — but both still emit
 * `minimum` / `pattern` into the JSON Schema, which `provenance.ts`'s rule 2 says OpenAI strict
 * mode rejects. This is the honest answer to "is any unsupported shape indistinguishable from a
 * supported one": the indistinguishable case is not across kinds (array vs. object vs. union are
 * all cleanly separable by `instanceof`) but *within* an allowed kind — a constrained `ZodString`/
 * `ZodNumber` cannot be told apart from an unconstrained one through the public surface used here.
 * `ribo-adapter-snuggpro/src/extraction-shape.test.ts`'s `assertStrictModeCompatible` is what
 * actually catches this today, downstream, on the real Snugg Pro field set.
 */
const isSupportedLeaf = (field: z.ZodType): boolean =>
  field instanceof z.ZodEnum ||
  field instanceof z.ZodLiteral ||
  field instanceof z.ZodString ||
  field instanceof z.ZodNumber ||
  field instanceof z.ZodBoolean;

/** Build the dotted path used in both nested traversal and the unsupported-shape error. */
const childPath = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

/** Envelope one field: a nested object recurses, a supported leaf is wrapped, anything else throws. */
const envelopeField = (field: z.ZodType, path: string): z.ZodType => {
  const stripped = stripOptionalNullable(field);

  if (stripped instanceof z.ZodObject) {
    return envelopeObject(stripped, path);
  }

  if (isSupportedLeaf(stripped)) {
    return extractedSchema(stripped);
  }

  throw new Error(
    `enveloped(): unsupported shape at "${path}" (${stripped.constructor.name}). ` +
      "Only enum, literal, string, number, boolean and nested objects can be enveloped — " +
      "arrays, records and unions (including a union of objects) cannot be expressed in " +
      "OpenAI strict structured-output mode.",
  );
};

/**
 * Envelope every field of an object, and close the object regardless of whether the source was
 * open. `z.strictObject` is applied fresh to the newly-built shape rather than inherited from
 * `obj` — rebuilding a zod object from a shape does NOT preserve the source's strictness (see
 * `enveloped.test.ts` / the task report for how this was confirmed), so every level must
 * re-declare `strict` explicitly or a patch's openness would leak into the extraction schema.
 */
const envelopeObject = (obj: z.ZodObject, path: string): z.ZodObject => {
  const shape = obj.shape;
  const enveloped: RawShape = {};
  for (const key of Object.keys(shape)) {
    enveloped[key] = envelopeField(shape[key], childPath(path, key));
  }
  return z.strictObject(enveloped);
};

/**
 * Strip zod's optional/nullable wrapper off a raw-shape field type, matching
 * {@link stripOptionalNullable} at the type level.
 */
type StripWrapper<X extends z.ZodType> =
  X extends z.ZodOptional<infer Inner extends z.ZodType>
    ? StripWrapper<Inner>
    : X extends z.ZodNullable<infer Inner extends z.ZodType>
      ? StripWrapper<Inner>
      : X;

/**
 * The type-level mirror of {@link envelopeObject} / {@link envelopeField}: given a patch's raw
 * shape, compute the raw shape of the derived extraction schema, recursing into nested objects
 * and wrapping every other field with `extractedSchema`'s inferred return type. This is what
 * makes `enveloped()`'s return type shape-preserving — see the file header and the task report's
 * discrimination probe for why a bare `z.ZodObject` return would silently stop type-checking every
 * field.
 */
type EnvelopedShape<S extends RawShape> = {
  [K in keyof S]: StripWrapper<S[K]> extends z.ZodObject<infer Inner extends RawShape>
    ? z.ZodObject<EnvelopedShape<Inner>, z.core.$strict>
    : ReturnType<typeof extractedSchema<StripWrapper<S[K]>>>;
};

/**
 * Derive the extraction schema from a patch schema: every leaf wrapped in `extractedSchema`
 * (after stripping the `.optional()`/`.nullable()` that make it a patch leaf), every nested object
 * recursed rather than swallowed into one envelope, and the whole thing closed and fully required
 * at every level. See the file header for the full walk and rationale.
 *
 * Additive as of R1.5 Task 2: nothing calls this yet. Task 3 switches `ToolAdapter` to declare a
 * patch and derive its extraction schema through this function.
 */
export const enveloped = <T extends z.ZodObject>(
  values: T,
): z.ZodObject<EnvelopedShape<T["shape"]>, z.core.$strict> =>
  envelopeObject(values, "") as z.ZodObject<EnvelopedShape<T["shape"]>, z.core.$strict>;

/**
 * The plain-value-space counterpart to {@link enveloped}: given the inferred type of a patch
 * (optional/nullable leaves included), compute the inferred type of its derived extraction
 * schema. `NonNullable` strips the leaf's `| null | undefined` before deciding whether it is a
 * nested object or a leaf, mirroring {@link stripOptionalNullable} at the type level — without it,
 * a leaf's `| undefined` would distribute across the conditional and produce a stray extra branch
 * rather than the single `Extracted<X>` the runtime actually produces.
 *
 * This is `ToolAdapter<V, C>`'s `extractionSchema: ZodType<Enveloped<V>>` from Task 3's design
 * (`r1.5-field-shape-contracts-design.md` §2.3) — kept here because it is defined in terms of
 * `Extracted`, which this file already imports, and because it is the type Task 3 needs at the
 * `ToolAdapter` boundary, not a type internal to `enveloped()` itself. It is deliberately a
 * separate mechanism from {@link EnvelopedShape}: that type operates in zod-schema space to keep
 * `enveloped()`'s own return type shape-preserving, while `Enveloped<V>` operates on the plain
 * inferred value shape. Testing `Enveloped<V>` alone does not exercise `EnvelopedShape`, or vice
 * versa — see `enveloped.test.ts`'s type-level test, which goes through
 * `z.infer<ReturnType<typeof enveloped<...>>>` specifically because this alias would not catch a
 * shape-losing return type on its own.
 *
 * `-?` on the mapped key is required, not decorative. `[K in keyof V]` over a bare type parameter
 * is a *homomorphic* mapped type, which by default copies the `?` (and `readonly`) modifiers from
 * `V` verbatim onto the result. `V` is a patch by construction (design §2.1), so every one of its
 * keys — including every nested key — already carries `?`; without `-?` here, `Enveloped<V>` would
 * silently inherit that optionality and every key of the "closed and required at every level"
 * extraction schema (design §2.2) would type as possibly-`undefined`. `ExtractedFields<F>` in
 * `review.ts` uses the same homomorphic-mapped-type shape with no `-?` and that is fine there —
 * `F` there is already envelope-shaped with no optional keys, so there is nothing for it to
 * inherit. It is `V` being a patch specifically that makes the omission dangerous here.
 *
 * No `readonly` here either, for the same homomorphic reason but the opposite direction: this type
 * is meant to equal `z.infer<ReturnType<typeof enveloped<...>>>` exactly (that equality is what
 * `enveloped.test.ts`'s `Enveloped<V> matches the function's actual return type` test asserts), and
 * `z.infer` of a plain `z.ZodObject` never marks its properties `readonly` — nothing in
 * `enveloped()`'s implementation ever calls `.readonly()`. Keeping `readonly` here (as the design
 * doc's pseudocode literally shows, and as `ExtractedFields`/`ReviewFields`/etc. all do) makes this
 * alias a strict subtype of the real return type rather than equal to it, which
 * `expectTypeOf(...).toEqualTypeOf(...)` treats as a mismatch even though plain structural
 * `extends` in both directions holds. Confirmed by removing `readonly` and watching the
 * `toEqualTypeOf` assertion's TS2554 ("Expected 1 arguments, but got 0" — `expect-type`'s way of
 * surfacing a mismatch at the call site) disappear.
 */
export type Enveloped<V> = {
  [K in keyof V]-?: [NonNullable<V[K]>] extends [object]
    ? Enveloped<NonNullable<V[K]>>
    : Extracted<NonNullable<V[K]>>;
};
