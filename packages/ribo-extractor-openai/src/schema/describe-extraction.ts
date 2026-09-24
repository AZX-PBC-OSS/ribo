/**
 * @file `describeExtraction` — a dry run of the schema split.
 *
 * A caller points ribo at their own zod schema, optionally reshapes it with
 * shape operations, and builds an extractor over the result. Whether that
 * extractor will construct, and how it will split the schema into calls,
 * depends on facts the caller cannot see without running it — and the failure
 * for not knowing arrives at the provider as an unreadable `400`. This helper
 * answers, synchronously and without a model: what the schema's top-level keys
 * are, which split path applies and why, how many pieces the caps produce and
 * what each measures, and whether construction would succeed — with the
 * refusal text when not.
 *
 * The design rule (describe-extraction-design.md §5) is absolute: the helper
 * reports facts read off values the real path produced, measured by functions
 * the real path also uses, and refusals raised by code the real path runs.
 * Concretely it is a composition, in construction order, of
 * `deriveExtractionShape` (the raw input shape's applier — there is no second
 * implementation of the operations to drift from), the shared
 * `topLevelKeyKinds` classifier the split reads its own gate from,
 * `splitExtractionSchema` itself under the presets' defaulting, the exported
 * measures the packers pack against, and the `wholeFits` selection
 * `schemaExtractor` makes — recomputed from the same two measures, before the
 * split, so a single-shot schema never reports a split refusal construction
 * would never reach. A throw anywhere on that path is CAUGHT and carried as
 * the report's `refusal`, verbatim — a diagnostic that paraphrases a refusal
 * can paraphrase it wrong.
 *
 * Depth is measured, never capped: the split does not pack against nesting
 * depth (the route names it in the same error and no partition fixes it), so
 * a depth cap is the caller's comparison to make against the reported number,
 * not an option here.
 */

import type { z } from "zod";

import type { ProvenanceGranularity } from "@azx/ribo-core";

import { assertWireSafeSchemaName } from "@azx/ribo-core";
import type { DerivedExtractionShape } from "../shape/derived-shape.js";
import type { ShapeOperation } from "../shape/shape-operation.js";
import { deriveExtractionShape } from "../shape/shape-operations.js";
import {
  MAX_NULLABLE_UNIONS_PER_CALL,
  nullableUnionCount,
  serializedCharCount,
  serializedNestingDepth,
  splitExtractionSchema,
  topLevelKeyKinds,
} from "./split-schema.js";
import type { TopLevelKey } from "./split-schema.js";

/**
 * The three measurements the report carries for the whole schema and for each
 * piece. The first two are the exact numbers `schemaExtractor`'s
 * single-shot-vs-per-group selection reads; depth rides beside them, measured
 * and never decided on (see the file header).
 */
export interface SchemaMeasures {
  /** Nullable unions in the serialized response schema — the union cap's unit. */
  readonly nullableUnions: number;
  /** Serialized JSON Schema characters — the byte cap's unit. */
  readonly serializedChars: number;
  /** Nesting depth of the serialized rendering, as raw JSON nesting — see `serializedNestingDepth`. */
  readonly depth: number;
}

/**
 * One piece the described schema would become: one chat call's share. `key`,
 * `part` and `parts` are read off the split's own `ExtractionGroup` entries —
 * `part`/`parts` are present exactly when the key was partitioned. On the
 * single-shot path there is one row: the whole schema under `key: ""`, no
 * part — one call is a split answer too.
 */
export interface ExtractionPieceDescription extends SchemaMeasures {
  readonly key: string;
  readonly part?: number;
  readonly parts?: number;
}

/**
 * Why the flat path applies — present exactly when `path` is `"flat"`. The
 * two pre-key fallbacks name themselves; otherwise no top-level key is a
 * group, so there is nothing to split by and the flat fallback carries the
 * schema — the loose keys are named (answered by the shared classifier, never
 * by a second walk). A loose key BESIDE a group is not here: the mixed split
 * carries it as the unwrapped portion on the grouped path (ADR 0023), so it
 * can no longer force the flat path at all.
 */
export type ExtractionFlatReason =
  | { readonly kind: "not-an-object" }
  | { readonly kind: "empty" }
  | { readonly kind: "loose-keys"; readonly keys: readonly string[] };

/** Which stage of the real construction path raised the refusal the report carries. */
export type ExtractionRefusalStage = "derive" | "name" | "split";

/**
 * The refusal construction would raise, carried rather than thrown: the stage
 * whose code raised it, and the real error's text verbatim. Present exactly
 * when construction over the same schema, caps and name would throw.
 */
export interface ExtractionRefusal {
  readonly stage: ExtractionRefusalStage;
  readonly message: string;
}

/**
 * What a schema will become before an extractor is constructed.
 *
 * Presence rules, so a caller can program on them:
 *
 *   - `refusal` is absent exactly when the real constructors would succeed
 *     over the same schema, caps and (when supplied) name. `pieces` is absent
 *     whenever `refusal` is present — construction never reached a split.
 *   - `shape` is present exactly when the raw input shape was used and its
 *     derivation succeeded — a describe-then-build caller wires it straight
 *     into `schemaExtractor`'s `extractionSchema` passthrough or
 *     `reshapedExtractor`, paying the derivation once.
 *   - `keys`, `path`, `flatReason`, `callShape` and `whole` are present
 *     whenever a schema survived to be described — absent only on a
 *     derive-stage refusal, where there is no schema to measure.
 */
export interface ExtractionDescription {
  readonly shape?: DerivedExtractionShape;
  readonly keys?: readonly TopLevelKey[];
  readonly path?: "grouped" | "flat";
  readonly flatReason?: ExtractionFlatReason;
  readonly callShape?: "single-shot" | "per-group";
  readonly whole?: SchemaMeasures;
  readonly pieces?: readonly ExtractionPieceDescription[];
  readonly refusal?: ExtractionRefusal;
}

/** The members both {@link DescribeExtractionOptions} shapes carry. */
interface DescribeSharedOptions {
  /**
   * Mirrors the presets' option and their defaulting: absent, the report's
   * split packs against {@link MAX_NULLABLE_UNIONS_PER_CALL}, exactly as
   * `perGroupExtractor`, `schemaExtractor` and `scopedInstanceExtractor`
   * default it.
   */
  readonly maxNullableUnionsPerGroup?: number;
  /**
   * Mirrors the presets' byte-cap option: pass-through, absent means off —
   * the library carries no provider's number (ADR 0015).
   */
  readonly maxSerializedCharsPerGroup?: number;
  /**
   * Optional. When supplied, the same `assertWireSafeSchemaName` the
   * constructors run is run here and a failure is reported as
   * `stage: "name"` — the guard is shared, so no drift; absent, the report
   * covers the schema-driven facts only. Checked in construction order: after
   * derivation, before the call-shape selection.
   */
  readonly name?: string;
}

/**
 * Describe the caller's PLAIN patch schema: the real applier
 * (`deriveExtractionShape`) runs first with these options, and the report
 * describes the derived extraction schema. Wire the carried `shape` into
 * `schemaExtractor`'s `extractionSchema` passthrough to build what was
 * described.
 */
export interface DescribeRawSchemaOptions extends DescribeSharedOptions {
  readonly schema: z.ZodObject;
  readonly extractionSchema?: never;
  /** Forwarded whole to `deriveExtractionShape`. */
  readonly operations?: readonly ShapeOperation[];
  readonly provenance?: Readonly<Record<string, ProvenanceGranularity>>;
  readonly requiredOnCreate?: Readonly<Record<string, readonly string[]>>;
  readonly identifyingFields?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Describe an already-derived extraction schema, used as-is — enveloping
 * twice double-wraps. The derivation options are refused on this shape, the
 * same way `schemaExtractor` refuses both-or-neither.
 */
export interface DescribeDerivedSchemaOptions extends DescribeSharedOptions {
  readonly extractionSchema: z.ZodType;
  readonly schema?: never;
  readonly operations?: never;
  readonly provenance?: never;
  readonly requiredOnCreate?: never;
  readonly identifyingFields?: never;
}

/**
 * Options for {@link describeExtraction}: `schema` XOR `extractionSchema` —
 * the two input shapes `schemaExtractor` takes. No `chat`, no `model`, no
 * timing knobs: the same cut `perGroupPlan` draws.
 */
export type DescribeExtractionOptions = DescribeRawSchemaOptions | DescribeDerivedSchemaOptions;

/** The derivation-only option keys, for the cross-shape refusal that names them. */
const DERIVATION_OPTION_KEYS = [
  "operations",
  "provenance",
  "requiredOnCreate",
  "identifyingFields",
] as const;

/** The message out of a thrown refusal — the split and the applier always throw `Error`. */
const refusalMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Report what a schema will become before an extractor is constructed:
 * the top-level keys and their group/loose kinds, the split path and — when
 * flat — why, the call shape `schemaExtractor` would select, the measured
 * size/union/depth of the whole and of each piece, and the refusal
 * construction would raise, carried verbatim rather than thrown.
 *
 * Synchronous and model-free. Misuse of the options themselves — both schema
 * keys, neither, or derivation options beside a passthrough schema — is a
 * programming error and THROWS, the same way `schemaExtractor` refuses
 * both-or-neither; a fact about the schema is reported, never thrown.
 */
export function describeExtraction(options: DescribeExtractionOptions): ExtractionDescription {
  if (options.schema !== undefined && options.extractionSchema !== undefined) {
    throw new TypeError(
      "describeExtraction: pass EITHER the plain patch schema (`schema`) OR an already-derived " +
        "extraction schema (`extractionSchema`) — not both.",
    );
  }
  if (options.schema === undefined && options.extractionSchema === undefined) {
    // Unreachable for a TS caller (the union requires one key); a JS caller
    // passing neither is a construction mistake, not a default.
    throw new TypeError(
      "describeExtraction: pass the plain patch schema under `schema` — or an " +
        "already-derived extraction schema under `extractionSchema`.",
    );
  }
  if (options.extractionSchema !== undefined) {
    const forwarded = DERIVATION_OPTION_KEYS.filter((key) => options[key] !== undefined);
    if (forwarded.length > 0) {
      throw new TypeError(
        `describeExtraction: ${forwarded.map((key) => `\`${key}\``).join(", ")} ride the raw ` +
          "`schema` shape's derivation — an `extractionSchema` is used as-is, so they cannot " +
          "be supplied with it.",
      );
    }
  }

  // 1 — Derivation (raw input only): the real applier, the real refusals.
  let shape: DerivedExtractionShape | undefined;
  let extractionSchema: z.ZodType;
  if (options.schema !== undefined) {
    try {
      shape = deriveExtractionShape(options.schema, {
        ...(options.operations === undefined ? {} : { operations: options.operations }),
        ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
        ...(options.requiredOnCreate === undefined
          ? {}
          : { requiredOnCreate: options.requiredOnCreate }),
        ...(options.identifyingFields === undefined
          ? {}
          : { identifyingFields: options.identifyingFields }),
      });
    } catch (error) {
      return { refusal: { stage: "derive", message: refusalMessage(error) } };
    }
    extractionSchema = shape.extractionSchema;
  } else {
    extractionSchema = options.extractionSchema;
  }

  // 2 — The name guard, in construction order (after derivation, before the
  // selection). The guard is the constructors' own; held aside so the
  // schema-driven facts still report beside the refusal.
  let refusal: ExtractionRefusal | undefined;
  if (options.name !== undefined) {
    try {
      assertWireSafeSchemaName(options.name, "describeExtraction");
    } catch (error) {
      refusal = { stage: "name", message: refusalMessage(error) };
    }
  }

  // 3 — Classification: the shared classifier the split reads its gate from.
  // The split's fallback gate is "no group keys at all" — a non-object, an
  // empty object, or an object whose keys are all loose takes the flat path;
  // one loose key BESIDE a group no longer collapses anything (the groups
  // split and the loose keys ride the trailing "" piece — mixed-schema-split
  // design §5, ADR 0023). The classifier's per-key kinds are the split's own
  // answer, so the path is read off them, never off a second walk.
  const classification = topLevelKeyKinds(extractionSchema);
  const keys: readonly TopLevelKey[] = classification.form === "keys" ? classification.keys : [];
  const path: "grouped" | "flat" =
    classification.form === "keys" && classification.keys.some((entry) => entry.kind === "group")
      ? "grouped"
      : "flat";
  const flatReason: ExtractionFlatReason | undefined =
    path === "grouped"
      ? undefined
      : classification.form === "not-an-object"
        ? { kind: "not-an-object" }
        : classification.form === "empty"
          ? { kind: "empty" }
          : {
              kind: "loose-keys",
              keys: classification.keys
                .filter((entry) => entry.kind === "loose")
                .map((entry) => entry.key),
            };

  // 4 — The whole-schema measures, and the call-shape selection recomputed
  // from the same two measures `schemaExtractor` reads — before the split, so
  // a single-shot schema never reports a split refusal construction would
  // never reach.
  const whole: SchemaMeasures = {
    nullableUnions: nullableUnionCount(extractionSchema),
    serializedChars: serializedCharCount(extractionSchema),
    depth: serializedNestingDepth(extractionSchema),
  };
  const unionCap = options.maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL;
  const wholeFits =
    whole.nullableUnions <= unionCap &&
    (options.maxSerializedCharsPerGroup === undefined ||
      whole.serializedChars <= options.maxSerializedCharsPerGroup);
  const callShape: "single-shot" | "per-group" = wholeFits ? "single-shot" : "per-group";

  // 5 — The split itself, under the presets' defaulting — but only where
  // construction would reach it. A refusal anywhere above stops the report
  // where construction would stop; a split throw is carried verbatim.
  let pieces: ExtractionPieceDescription[] | undefined;
  if (refusal === undefined) {
    if (callShape === "single-shot") {
      pieces = [{ key: "", ...whole }];
    } else {
      try {
        pieces = splitExtractionSchema(extractionSchema, {
          maxNullableUnionsPerGroup: unionCap,
          ...(options.maxSerializedCharsPerGroup === undefined
            ? {}
            : { maxSerializedCharsPerGroup: options.maxSerializedCharsPerGroup }),
        }).map((entry) => ({
          key: entry.key,
          ...(entry.part === undefined ? {} : { part: entry.part, parts: entry.parts }),
          nullableUnions: nullableUnionCount(entry.schema),
          serializedChars: serializedCharCount(entry.schema),
          depth: serializedNestingDepth(entry.schema),
        }));
      } catch (error) {
        refusal = { stage: "split", message: refusalMessage(error) };
      }
    }
  }

  return {
    ...(shape === undefined ? {} : { shape }),
    keys,
    path,
    ...(flatReason === undefined ? {} : { flatReason }),
    callShape,
    whole,
    ...(pieces === undefined ? {} : { pieces }),
    ...(refusal === undefined ? {} : { refusal }),
  };
}
