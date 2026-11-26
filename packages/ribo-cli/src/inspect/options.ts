import type { SchemaPlan } from "@azx/ribo-core";

/**
 * Options of `inspectSchema`. The threshold options (`maxDepth`,
 * `maxPieceChars`) are comparisons the CLI makes on the report's own numbers —
 * never fed into the split (design §1). The split options
 * (`maxNullableUnionsPerGroup`, `maxSerializedCharsPerGroup`) forward to
 * `describeExtraction` and `perGroupPlan` under their own defaulting: absent,
 * the split packs against `MAX_NULLABLE_UNIONS_PER_CALL` and the byte cap is
 * off. All optional, defaulting to absent.
 */
export interface SchemaInspectOptions {
  /**
   * A parsed schema plan. The asynchronous planned inspect entry measures its semantic pieces and
   * actual packed calls; the synchronous no-plan entry deliberately does not accept it.
   */
  readonly plan?: SchemaPlan;
  /**
   * Threshold on the whole schema's measured nesting depth. A comparison the
   * caller makes on the reported number — supplying it can never change the
   * reported partitioning, because the split does not pack against depth.
   */
  readonly maxDepth?: number;
  /**
   * Threshold on serialized characters in the worst rule-based piece without a plan, or the worst
   * actual planned packed call with one. A comparison on the reported number — supplying it can
   * never change the reported partitioning.
   */
  readonly maxPieceChars?: number;
  /**
   * Forwarded to the split's union cap: a group over it is partitioned across
   * multiple calls. Absent, `MAX_NULLABLE_UNIONS_PER_CALL` stands — the same
   * defaulting the presets apply.
   */
  readonly maxNullableUnionsPerGroup?: number;
  /**
   * Forwarded to the split's byte cap. Absent, the byte cap is off — the
   * library carries no provider's number (ADR 0015).
   */
  readonly maxSerializedCharsPerGroup?: number;
}
