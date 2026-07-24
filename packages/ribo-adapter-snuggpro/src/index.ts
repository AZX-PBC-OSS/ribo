/**
 * @file The public surface of `@azx/ribo-adapter-snuggpro`.
 *
 * The only tool-specific surface in the workspace: how Snugg Pro's bounded audit
 * pilot fields are shaped, how to describe them to an extractor, the deterministic
 * pass that runs after the model, and the write-back seam. Re-exports only —
 * everything is defined in the module that owns the concept.
 */

// The adapter: schema + instructions + examples + write, as a `ToolAdapter`.
export { SNUGGPRO_ADAPTER_NAME, snuggProAdapter } from "./adapter.js";

// The field schema (source of truth for `SnuggFields`) and its enums.
export {
  AtticInsulationDepthBand,
  AtticInsulationType,
  CombustionVentType,
  CoolingEquipmentType,
  DhwAgeBand,
  DhwFuel,
  DhwSystemType,
  DuctInsulation,
  DuctLocation,
  DuctSealing,
  HealthSafetyMatrix,
  HealthTestState,
  HeatingEquipmentType,
  HeatingFuel,
  SnuggFieldsSchema,
  WallConstruction,
  WallInsulated,
  WindowFrame,
  WindowGlazing,
} from "./schema.js";
export type { SnuggFields } from "./schema.js";

// The write context — the real `C` the adapter's `write` needs.
export type { SnuggWriteContext } from "./context.js";

// The extraction instructions (the normalization intent) and few-shot examples.
export { snuggProInstructions } from "./instructions.js";
export { snuggExamples } from "./examples.js";

// The deterministic, model-free normalization pass and its transforms.
export {
  clampConfidence,
  inchesToAtticDepthBand,
  normalizeFields,
  yearsToDhwAgeBand,
} from "./normalization.js";

// The single-shot managed-LLM extractor (`singleShotExtractor`), its OpenAI-compatible
// transport (`openAiChat`) and the `ChatClient` seam are tool-agnostic — they now live in
// `@azx/ribo-extractor-openai`. A consumer composes them with `snuggProAdapter` as the target.
