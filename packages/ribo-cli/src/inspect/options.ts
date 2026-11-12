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
   * Threshold on the whole schema's measured nesting depth. A comparison the
   * caller makes on the reported number — supplying it can never change the
   * reported partitioning, because the split does not pack against depth.
   */
  readonly maxDepth?: number;
  /**
   * Threshold on the worst piece's serialized character count. A comparison on
   * the reported number — supplying it can never change the reported
   * partitioning.
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
