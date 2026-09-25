import type { z } from "zod";

import type { ProvenanceGranularity } from "../../provenance/enveloped.js";

import type { ShapeMapping } from "./shape-mapping.js";

/**
 * @file The derived artifact: an extraction schema, and the mapping back.
 *
 * The goal this pair serves: someone hands Ribo a plain zod schema they wrote or
 * generated and gets a working extraction. The extraction schema does NOT have
 * to be the data shape — it has to extract well and map back — so the artifact
 * is a pair, and the mapping is a first-class half of it, not an implementation
 * detail of the derivation.
 *
 * The codomain is the **derived patch**, not the schema the caller handed in.
 * Review's sentinel acceptance requires leaves to be `X.nullable().optional()`;
 * a plain OpenAPI-derived schema is not that, and would reject the `null` an
 * unmentioned field reverses to. So the applier emits the patch — the caller's
 * schema normalized into patch form, with dropped leaves removed — and "you
 * land back" means back in that patch: `buildReviewRequest` walks it, the write
 * parses against it, and reversal produces its enveloped shape.
 */
export interface DerivedExtractionShape {
  /**
   * What the model is asked to produce — the shaped schema run through
   * `enveloped()` at the artifact's provenance: closed, required at every
   * level, every leaf enveloped (or plain under a coarser granularity).
   * Handed to `schemaExtractor`'s `extractionSchema` passthrough, which uses it
   * as-is — no second derivation runs.
   */
  readonly extractionSchema: z.ZodObject;
  /**
   * The derived patch — the caller's schema in patch form (every leaf
   * `X.nullable().optional()`, top-level keys optional, drops removed, the
   * caller's own grouping and kinds kept). Review walks it; the write parses
   * against it; reversal lands in its enveloped shape.
   */
  readonly patchSchema: z.ZodObject;
  /**
   * The mapping back, as data — see {@link ShapeMapping}. A runtime value a
   * host may cache, persist or diff.
   */
  readonly mapping: ShapeMapping;
  /**
   * The per-top-level-key provenance granularity the derivation chose — the
   * same map `buildReviewRequest` takes in its options, keyed by the top-level
   * keys both spaces share. A nest group, which exists only in the extraction
   * schema, is never one of them: the derivation refuses a granularity naming
   * one.
   */
  readonly provenance: Readonly<Record<string, ProvenanceGranularity>>;
  /**
   * Required-on-create declarations carried through from the derivation
   * options, validated against the derived patch: every named group exists and
   * every named leaf survived the operations. Review's sentinel acceptance and
   * the write's create both read these; a derivation that dropped a required
   * leaf would be refused, not silently shortened.
   */
  readonly requiredOnCreate: Readonly<Record<string, readonly string[]>>;
  /**
   * Identifying-fields declarations carried through from the derivation
   * options and validated the same way — the leaves that can make two
   * descriptions certainly different real-world things.
   */
  readonly identifyingFields: Readonly<Record<string, readonly string[]>>;
}
