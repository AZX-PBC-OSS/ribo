import { z } from "zod";

/**
 * @file The two primitives shared by every walk over a values schema.
 *
 * Two walks exist over the same hand-written patch schema, and they must agree:
 * `enveloped()` derives the extraction schema from it, and `buildReviewRequest`
 * enumerates the leaves a human reviews. If they disagreed about what counts as a
 * wrapper, or about how a nested key becomes a path, review would present leaves
 * the extraction never produced (or miss ones it did) — and the symptom would be a
 * blank review card, not an error. So the two decisions both walks make are made
 * once, here.
 *
 * A third walk is coming: resolving a reviewed patch back into nested values. That
 * walk also needs to agree with the path encoding, so construction and parsing
 * are one grammar with two segment kinds rather than two separate string tricks.
 */

/**
 * Strip every `.optional()` / `.nullable()` wrapper off `field`, in whatever order
 * and however many of them there are.
 *
 * A patch leaf may be wrapped as `X.nullable().optional()` OR `X.optional().nullable()`
 * — both must reduce to bare `X`. `.unwrap()` is the public zod 4.4.3 API for peeling
 * off exactly one `ZodOptional` / `ZodNullable` layer; looping while either wrapper is
 * still present handles both orders (and, defensively, deeper stacks) uniformly.
 *
 * Callers use this to see *through* a patch's optionality — `enveloped()` to decide what
 * to wrap in a provenance envelope, `buildReviewRequest` to decide whether a field is a
 * nested object to recurse into or a leaf to present. Neither may look at the declared
 * type directly: `HealthFields.optional()` is a `ZodOptional`, not a `ZodObject`, and
 * treating it as a leaf would collapse a 14-test group into one review card.
 */
/**
 * A dotted path to one reviewable leaf: `"basedata.yearBuilt"` for a nested one — every
 * leaf of Snugg Pro's `snuggValuesSchema` is nested one level under its resource group,
 * so there is no bare top-level leaf in the real adapter today, though the type admits one.
 *
 * A bare `string` rather than a template-literal type computed from the schema.
 * Typed leaf paths would catch a typo at compile time, but they sit *on top of*
 * the runtime mechanism rather than replacing it — a UI still has to look the
 * path up in a `Record` at runtime, and completeness still has to be checked
 * there (`resolveReview`). Purely additive later.
 *
 * Lives here rather than in `review.ts` because `adapter.ts` needs it too
 * (`ToolAdapter.requiredOnCreate`), and the adapter contract sits *below* the
 * review contract — an adapter importing from review would invert that.
 */
export type FieldPath = string;

export const stripOptionalNullable = (field: z.ZodType): z.ZodType => {
  let current = field;
  // Carry the OUTERMOST description down. A patch leaf is `X.nullable().optional()`, so a
  // `.describe()` written the natural way lands on the wrapper — and unwrapping would drop
  // it silently, since an absent description is not a type error and nothing downstream
  // complains. That made description placement a trap: correct-looking code produced a
  // schema the model never saw. Preserving it here means either placement works.
  const outer = field.description;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    // `.unwrap()`'s declared return type is generic over the wrapped type, defaulting to the
    // core (not classic) `$ZodType` once narrowed only by `instanceof`; every real wrapper in
    // this codebase wraps a classic `z.ZodType`, so this cast reflects that rather than working
    // around it.
    current = current.unwrap() as z.ZodType;
  }
  // The OUTER wins when both exist: it was applied last, so it is the more considered
  // one. That matters where a leaf carries its own note and something later composes a
  // fuller description around it.
  return outer !== undefined ? current.describe(outer) : current;
};

/**
 * Keys that would silently break the dotted-path model. See {@link childPath}.
 *
 * An "integer-like" key is one `Object.keys` hoists to the front in ascending numeric
 * order regardless of declaration order — the array-index rule in the property-order
 * spec. `"0"`, `"7"` and `"2024"` qualify; `"01"`, `"1.5"` and `"r19"` do not.
 */
const INTEGER_LIKE_KEY = /^(?:0|[1-9]\d*)$/;

/**
 * One segment in a {@link FieldPath}. Object keys are joined with `.`; instance keys
 * are wrapped in `[...]`. Keeping the two kinds distinct at the type level is what
 * stops a parser from silently treating `hvac[k3]` as a single object key.
 */
export type FieldPathSegment =
  | { readonly kind: "objectKey"; readonly key: string }
  | { readonly kind: "instanceKey"; readonly key: string };

/**
 * Build a {@link FieldPath} from typed segments.
 *
 * This is the canonical emitter for the path grammar. `childPath` remains the
 * convenience for plain object-key paths, but every path this module produces —
 * dotted or bracketed — is ultimately built here so that parsing has exactly one
 * encoding to reverse.
 */
export const buildFieldPath = (segments: ReadonlyArray<FieldPathSegment>): string => {
  if (segments.length === 0) {
    return "";
  }

  const first = segments[0];
  if (first === undefined || first.kind !== "objectKey") {
    throw new Error(
      `field path must start with an object key, got ${first === undefined ? "nothing" : `instance key "${first.key}"`} first`,
    );
  }
  validateObjectKey(first.key, "");

  let path = first.key;
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) {
      continue;
    }
    if (segment.kind === "objectKey") {
      validateObjectKey(segment.key, path);
      path += `.${segment.key}`;
    } else {
      validateInstanceKey(segment.key, path);
      path += `[${segment.key}]`;
    }
  }
  return path;
};

/**
 * Parse a {@link FieldPath} into typed segments.
 *
 * This is the canonical reader for the grammar `buildFieldPath` emits. Using the
 * same implementation for both directions means a caller cannot construct a path
 * that the resolver would read differently — the silent shape mismatch that
 * `resolveReview`'s old `path.split(".")` would have produced for
 * `hvac[k3].hvacDuctLeakage`.
 */
export const parseFieldPath = (path: string): FieldPathSegment[] => {
  if (path === "") {
    return [];
  }

  const segments: FieldPathSegment[] = [];

  // The first segment is always an object key: read up to the first `.` or `[`.
  const firstDot = path.indexOf(".");
  const firstBracket = path.indexOf("[");
  const firstBoundary =
    firstDot === -1
      ? firstBracket
      : firstBracket === -1
        ? firstDot
        : Math.min(firstDot, firstBracket);
  const firstKey = firstBoundary === -1 ? path : path.slice(0, firstBoundary);
  validateObjectKey(firstKey, "");
  segments.push({ kind: "objectKey", key: firstKey });
  let pathSoFar = firstKey;
  let i = firstKey.length;

  while (i < path.length) {
    const char = path[i];
    if (char === ".") {
      i++;
      const nextDot = path.indexOf(".", i);
      const nextBracket = path.indexOf("[", i);
      let end: number;
      if (nextDot === -1 && nextBracket === -1) {
        end = path.length;
      } else if (nextDot === -1) {
        end = nextBracket;
      } else if (nextBracket === -1) {
        end = nextDot;
      } else {
        end = Math.min(nextDot, nextBracket);
      }
      const key = path.slice(i, end);
      validateObjectKey(key, pathSoFar);
      segments.push({ kind: "objectKey", key });
      pathSoFar += `.${key}`;
      i = end;
    } else if (char === "[") {
      i++;
      const close = path.indexOf("]", i);
      if (close === -1) {
        throw new Error(
          `field path "${path}" has an unclosed instance key: "[" is not matched by "]"`,
        );
      }
      const key = path.slice(i, close);
      validateInstanceKey(key, pathSoFar);
      segments.push({ kind: "instanceKey", key });
      pathSoFar += `[${key}]`;
      i = close + 1;
    } else {
      throw new Error(
        `field path "${path}" has unexpected character "${char}" at position ${i}: ` +
          "only `.` (object key) and `[...]` (instance key) are allowed after the first segment.",
      );
    }
  }

  return segments;
};

/**
 * Join a parent path and a field key into a dotted leaf path — and refuse the key
 * shapes that would make that path a lie.
 *
 * **All three throws are deliberate, and all guard a SILENT failure.** A dotted path
 * model only works if the separator and bracket opener are unambiguous and if key
 * order is the order the schema was written in. None of these is checkable after the
 * fact:
 *
 *   - A key containing `"."` produces a path that addresses a *different* leaf than the
 *     one it came from: a field named `"attic.rValue"` and a nested `attic: { rValue }`
 *     both flatten to `"attic.rValue"`, so review would show one card for two fields and
 *     `resolveReview` would reassemble the wrong shape. Nothing downstream can tell the
 *     two apart, so the refusal has to happen here, while the key is still in hand.
 *   - A key containing `"["` would be read as starting an instance-key segment, so a field
 *     named `"hvac[0]"` and an instance named `"0"` under group `hvac` would collapse to
 *     the same path. The bracket opener is reserved for the grammar; object keys may not
 *     use it.
 *   - An integer-like key breaks the documented iteration order. `review.ts` states that
 *     fields are presented in schema-declaration order and that `editedFields` /
 *     `rejectedFields` follow it; that holds because JavaScript preserves insertion order
 *     for string keys — *except* array-index-like ones, which are hoisted to the front in
 *     numeric order. One such key would reorder a 51-field review card with no error.
 *
 * Refusing is safe for the field sets this repo has: adapter schemas are bounded,
 * hand-written, and use identifier-shaped names. A tool that genuinely needs a `.` or `[`
 * in a field name needs a different path encoding, which is a design change, not a patch.
 */
export const childPath = (parent: string, key: string): string => {
  validateObjectKey(key, parent);
  return parent === "" ? key : `${parent}.${key}`;
};

const validateObjectKey = (key: string, parent: string): void => {
  rejectEmptyKey(key, "object", parent === "" ? "<root>" : parent);
  if (key.includes(".")) {
    throw new Error(
      `field name "${key}"${parent === "" ? "" : ` (under "${parent}")`} contains "." — ` +
        "review addresses leaves by dotted path, so a name containing the separator would " +
        "address the wrong leaf. Rename the field.",
    );
  }
  if (key.includes("[") || key.includes("]")) {
    throw new Error(
      `field name "${key}"${parent === "" ? "" : ` (under "${parent}")`} contains a bracket — ` +
        "review uses bracketed instance keys, so a field name containing `[` or `]` would " +
        "be read as part of an instance-key segment and address the wrong leaf. Rename the field.",
    );
  }
  if (INTEGER_LIKE_KEY.test(key)) {
    throw new Error(
      `field name "${key}"${parent === "" ? "" : ` (under "${parent}")`} is integer-like — ` +
        "JavaScript hoists array-index keys ahead of every other key, which would silently " +
        "reorder the review card away from schema-declaration order. Rename the field.",
    );
  }
};

const validateInstanceKey = (key: string, parent: string): void => {
  rejectEmptyKey(key, "instance", parent);
  if (key.includes("[")) {
    throw new Error(
      `instance key "${key}" (under "${parent}") contains "[" — ` +
        "bracket characters are reserved for the path syntax and cannot appear inside a key.",
    );
  }
  if (key.includes("]")) {
    throw new Error(
      `instance key "${key}" (under "${parent}") contains "]" — ` +
        "bracket characters are reserved for the path syntax and cannot appear inside a key.",
    );
  }
  if (INTEGER_LIKE_KEY.test(key)) {
    throw new Error(
      `instance key "${key}" (under "${parent}") is integer-like — ` +
        "stable instance keys must not look like array indices, or JavaScript would hoist them " +
        "ahead of every other key and silently reorder the review card.",
    );
  }
};

const rejectEmptyKey = (key: string, kind: "object" | "instance", context: string): void => {
  if (key === "") {
    throw new Error(
      `${kind === "object" ? "field" : "instance"} key cannot be empty ` +
        `(context: "${context}").`,
    );
  }
};
