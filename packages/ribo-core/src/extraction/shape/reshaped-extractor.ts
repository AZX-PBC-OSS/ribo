/**
 * @file `reshapedExtractor` — the reversal combinator: an inner extractor over
 * a derived extraction shape, and the mapping back, composed into an extractor
 * over the derived patch.
 *
 * This is the seam a derived extraction shape plugs through. `schemaExtractor`
 * already claims the derived-shape goal — its `extractionSchema` passthrough
 * uses a caller-provided schema as-is, no second derivation — and its
 * `normalize` option is shaped like reversal but cannot type it: it is
 * `Enveloped<V> → Enveloped<V>`, the same `V` both sides, while reversal goes
 * `V′ → V`. So reversal is an `Extractor` COMBINATOR — this library's native
 * idiom — wrapping the inner extractor:
 *
 * ```
 * const shape     = deriveExtractionShape(mySchema, { operations });
 * const inner     = schemaExtractor({ extractionSchema: shape.extractionSchema, chat, model });
 * const extractor = reshapedExtractor(inner, shape);
 * ```
 *
 * `schemaExtractor` is untouched; construction stays synchronous. The
 * combinator validates the mapping against BOTH schemas at construction — the
 * mapping may be hand-written, and a hand-written one that misses a leaf would
 * otherwise drop that leaf's data on the floor at reversal — and crosses the
 * trust boundary once more on its own output: the reversed fields are parsed
 * against the derived patch's enveloped shape before they become field data.
 * That parse is not redundant; it is the boundary for the patch space, and it
 * is what turns a mapping written against the wrong pair of schemas into a
 * retryable `SchemaParseError` instead of silently wrong review cards.
 *
 * No progress units of its own: a wrapper that delegates emits none (ADR 0004).
 * `usage`, `raw` and `statedEmptyGroups` pass through untouched — the
 * top-level keys the stated-empty map is keyed by are shared by both spaces.
 * `skippedItems` is the exception: a skipped item can name a nest group, which
 * the patch does not have, so it is reversed too (`shape-skipped.ts`).
 *
 * The cross-file invariant that safety rests on, with a nest in the vocabulary:
 * every `mapping.provenance` key is a top-level key of BOTH schemas, by a pair
 * of refusals in the derivation — it refuses provenance naming a nest group
 * (absent from the patch) and refuses provenance naming a moved-away source
 * (absent from the shaped schema). It REFUSES them; nothing is silently
 * dropped from the map. So `enveloped(patchSchema, { provenance })` below can
 * never meet a key the patch does not have, and `validateProvenance`'s own
 * throw is unreachable from a derived artifact.
 *
 * The `statedEmptyGroups` passthrough survives a nest for the same reason as
 * ever: only a COLLECTION group can be stated-empty —
 * `scoped-instance/inventory-phase.ts`'s merge skips every non-collection
 * group before writing an entry, and `review.ts` reads `statedEmptyGroups[key]`
 * only inside its array branch — and a nest never creates a collection (a leaf
 * is never a `ZodArray`, so a nest group is always a plain object of plain
 * leaves).
 */

import { enveloped } from "../../provenance/enveloped.js";
import type { Enveloped, NoProvenance } from "../../provenance/enveloped.js";
import type { ExtractionResult, Extractor, ExtractOptions } from "../extractor.js";

import { parseWithSchema } from "../parse-with-schema.js";
import { assertShapeMapping } from "./shape-mapping.js";
import { reverseShapedFields } from "./shape-reverse.js";
import { reverseSkippedItems } from "./shape-skipped.js";
import type { DerivedExtractionShape } from "./derived-shape.js";

/**
 * Wrap an inner extractor with the mapping back: its results, in the extraction
 * shape's space, become results in the derived patch's space.
 *
 * `VShape` is the extraction shape's values type — inferable from the inner
 * extractor, which `schemaExtractor`'s passthrough already typed. `VPatch` is
 * the derived patch's values type — the type the caller knows the mapping was
 * written against, named explicitly, because the mapping is data and no
 * compiler can check it: {@link assertShapeMapping} is that check, run at
 * construction against both schemas.
 */
export function reshapedExtractor<
  VShape extends Record<string, unknown> = Record<string, unknown>,
  VPatch extends Record<string, unknown> = Record<string, unknown>,
>(
  inner: Extractor<Enveloped<VShape, NoProvenance>>,
  shape: DerivedExtractionShape,
): Extractor<Enveloped<VPatch, NoProvenance>> {
  assertShapeMapping(shape.mapping, shape.extractionSchema, shape.patchSchema);

  // The codomain's own trust boundary: `Enveloped` over the derived patch at
  // the artifact's per-group provenance. Reversal's output must parse against
  // this or the mapping does not actually land back in the patch.
  const outputSchema = enveloped(shape.patchSchema, {
    provenance: shape.mapping.provenance,
  });

  return {
    async extract(
      transcript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<VPatch, NoProvenance>>> {
      const result = await inner.extract(transcript, options);
      const reversed = reverseShapedFields(result.fields, shape.mapping);
      const fields = parseWithSchema(outputSchema, reversed, "reshapedExtractor: reversed fields");
      return {
        fields: fields as Enveloped<VPatch, NoProvenance>,
        usage: result.usage,
        ...(result.raw === undefined ? {} : { raw: result.raw }),
        ...(result.statedEmptyGroups === undefined
          ? {}
          : { statedEmptyGroups: result.statedEmptyGroups }),
        ...(result.skippedItems === undefined
          ? {}
          : { skippedItems: reverseSkippedItems(result.skippedItems, shape.mapping) }),
      };
    },
  };
}
