/**
 * One construct class the JSON Schema input cannot carry, named honestly
 * (design §5's honesty rule): a document never reveals whether the original
 * zod schema had one, so the report names the blind spot rather than
 * detecting instances — never guessed, never reconstructed, never silently
 * dropped without a word.
 */
export interface NotVisibleConstruct {
  /** The construct class's name, as the report's consumer reads it. */
  construct: string;
  /** A plain-words explanation that the document cannot carry the construct. */
  detail: string;
}

/**
 * The static, always-present enumeration (Decision 11). The input can never
 * reveal these — zod renders a refined leaf silently stripped, and a
 * transformed leaf only as an unrepresentable `any` — so every report names
 * both construct classes whether or not the original schema had them.
 */
export const NOT_VISIBLE_CONSTRUCTS: readonly NotVisibleConstruct[] = [
  {
    construct: "zod refinement",
    detail:
      "A .refine() or .superRefine() check on the original zod schema does not survive the JSON " +
      "Schema rendering — the document cannot carry it, so the schema this report describes has " +
      "no refinements. If the source schema refines any leaf, the check exists only in the " +
      "host's own zod copy and runs at its parse, never in what was sized here.",
  },
  {
    construct: "zod transform",
    detail:
      "A .transform() or .pipe() on the original zod schema does not survive the JSON Schema " +
      "rendering — the document cannot carry it, so the schema this report describes holds the " +
      "value's input shape and no transformation. If the source schema transforms any leaf, the " +
      "transform exists only in the host's own zod copy.",
  },
];
