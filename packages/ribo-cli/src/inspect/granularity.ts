import { assertLeafGranularity, isExtractedSchema, stripOptionalNullable } from "@azx/ribo-core";
import { z } from "zod";

/**
 * @file The leaf-granularity violation list, read off core's own
 * `assertLeafGranularity` — no reimplemented walk. Core's assert throws on the
 * FIRST offender, so collecting every offender means calling it once per group
 * on a one-property container holding just that group: the five-case predicate
 * and the `"row"`/`"none"` discrimination stay core's, and the CLI reads the
 * granularity out of core's own refusal message. What the CLI contributes is
 * only the container dispatch core's assert itself does — strip the root,
 * short-circuit on an envelope, iterate a group container's properties —
 * because collecting requires naming the groups the assert refuses one at a
 * time. The agreement test (`inspect-findings.test.ts`) holds the list against
 * a whole-schema run of the same assert.
 *
 * The walk runs over the converted document schema (Decision 3): a document
 * cannot carry provenance envelopes, so on every real document every group is
 * named with apparent granularity `"none"`. That is honest — it names exactly
 * the groups the judging combinators (`consensusExtractor`,
 * `validateExtractor`) would refuse without a leaf-granularity derivation —
 * and the report field's description says what deriving at `"leaf"`
 * granularity buys, so the list is not misread as an error count.
 */

/**
 * The combinator name core's refusal message carries. The CLI is not a
 * combinator, so it names itself; the message's group and granularity — the
 * parts the report reads — are unaffected.
 */
const COMBINATOR = "ribo-cli inspect";

/**
 * Read the `"row"`/`"none"` answer off core's own refusal message — the same
 * discrimination `refuseGroup` makes, without a second implementation of it.
 * If the message ever stops naming a granularity, the error is rethrown:
 * a changed core message must fail loudly, never silently become a guessed
 * value.
 */
const granularityFromMessage = (error: unknown): "row" | "none" => {
  const message = error instanceof Error ? error.message : String(error);
  const match = /derived at "(row|none)" provenance granularity/.exec(message);
  if (!match) throw error;
  return match[1]! as "row" | "none";
};

/**
 * One offending group: the group key, and which provenance granularity the
 * group APPEARS to have been derived at — the two failures have different
 * fixes, so the report discriminates `"row"` from `"none"` exactly as
 * `assertLeafGranularity`'s refusal does.
 */
export interface GranularityViolation {
  /** The offending group's key. */
  group: string;
  /** The granularity the group appears to have been derived at. */
  granularity: "row" | "none";
}

/**
 * Collect EVERY group of `schema` that is not derived at `"leaf"` granularity
 * — the full list, not first-only. Granularity is a property of a group, so
 * the schema's own properties are the groups and each is held to core's assert
 * alone; a root schema that is one leaf envelope has no group container and
 * reports no violations.
 */
export function collectGranularityViolations(schema: z.ZodType): GranularityViolation[] {
  const stripped = stripOptionalNullable(schema);
  if (isExtractedSchema(stripped)) return [];
  if (!(stripped instanceof z.ZodObject)) {
    // Not a group container and not an envelope: core's assert names the
    // refusal "<root>", since a refusal here has no group key.
    try {
      assertLeafGranularity(stripped, { combinator: COMBINATOR });
      return [];
    } catch (error) {
      return [{ group: "<root>", granularity: granularityFromMessage(error) }];
    }
  }
  const shape = stripped.shape as Record<string, z.ZodType>;
  const violations: GranularityViolation[] = [];
  for (const [key, group] of Object.entries(shape)) {
    // Core's assert, once per group, on a one-property container holding just
    // that group: the top level of that container is a group container whose
    // only property IS the group, so the refusal is exactly the one a
    // whole-schema walk would make for this group first.
    try {
      assertLeafGranularity(z.object({ [key]: group }), { combinator: COMBINATOR });
    } catch (error) {
      violations.push({ group: key, granularity: granularityFromMessage(error) });
    }
  }
  return violations;
}
