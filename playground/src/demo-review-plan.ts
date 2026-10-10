import { deriveExtractionShape, type ShapeOperation } from "@azx/ribo-core";
import { snuggValuesSchema } from "@azx/ribo-adapter-snuggpro";

/**
 * @file The playground's demo review plan — the plan the review card lays its
 * tree out by.
 *
 * Derived with the shape derivation from declared operations over the real
 * Snugg Pro values schema, never a hand-written mapping: the derivation is the
 * same public surface an extraction run uses, and it fails loudly here at
 * module scope if an operation names a field the schema lacks — a stale demo
 * cannot boot quietly. A partition is presentation-only for review (it moves no
 * leaf and touches no other shape member), so the patch the review walks stays
 * `snuggValuesSchema`-shaped.
 *
 * The part field lists are deliberately declared out of schema-declaration
 * order — the schema puts `hvacCoolingCapacity` before
 * `hvacCoolingSystemManufacturer`, and heating's model before its manufacturer —
 * so the rendered card proves it follows the plan's order rather than the
 * schema's.
 *
 * **Hold it still.** This is a module-level constant because `useReview`'s
 * `reviewPlan` option is a `useMemo` dependency: an inline plan object in JSX
 * rebuilds the whole review request every render.
 */
const operations: readonly ShapeOperation[] = [
  {
    op: "partition",
    group: "hvac",
    parts: {
      cooling: ["hvacCoolingSystemManufacturer", "hvacCoolingCapacity", "hvacCoolingSystemModel"],
      heating: [
        "hvacHeatingEnergySource",
        "hvacHeatingSystemModel",
        "hvacHeatingSystemManufacturer",
      ],
    },
  },
];

export const demoReviewPlan = deriveExtractionShape(snuggValuesSchema, { operations });
