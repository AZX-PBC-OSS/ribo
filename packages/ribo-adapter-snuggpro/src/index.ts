/**
 * @file The public surface of `@azx/ribo-adapter-snuggpro`.
 *
 * The only tool-specific surface in the workspace: how Snugg Pro's bounded audit
 * pilot fields are shaped, how to describe them to an extractor, the deterministic
 * pass that runs after the model, and the write-back seam. Re-exports only —
 * everything is defined in the module that owns the concept.
 */

// The adapter: both field schemas + the ctx schema + instructions + examples +
// write, as a `ToolAdapter`.
export { SNUGGPRO_ADAPTER_NAME, snuggProAdapter } from "./adapter.js";

// The two field schemas, the per-endpoint groups they nest, and the enums
// they are built from. `snuggValuesSchema` is the hand-written writable patch and
// the source of truth for `SnuggValues`; `snuggExtractionSchema` is DERIVED from it
// with `enveloped()` and is what the model is constrained to. See schema.ts for why
// one shape could not be both, and why every enum member is a verbatim wire string.
export {
  AshraeNumberOfBathrooms,
  AtticFields,
  AtticInsulationDepth,
  AtticInsulationType,
  AtticKneeWallContinuousInsulationType,
  AtticKneeWallInsulationType,
  AtticRoofColor,
  AtticRoofType,
  BasedataFields,
  BasementCavityInsulationType,
  BasementCeilingCavityInsulationType,
  BasementCeilingContinuousInsulationType,
  BasementContinuousInsulationType,
  BasementCooling,
  BasementHeating,
  BasementRimJoistInsulationType,
  BasementRimJoistTreatment,
  BasementWallInsulation,
  BlowerDoorTestPerformed,
  ClothesWasherManufacturer,
  ClothesWasherType,
  ConcernFields,
  CrawlCavityInsulationType,
  CrawlspaceInsulation,
  CrawlspaceRimJoistInsulationType,
  CrawlspaceRimJoistTreatment,
  CrawlspaceType,
  CrawlWallInsulationType,
  DhwAgeBand,
  DhwFields,
  DhwFuel,
  DhwLocation,
  DhwManufacturer,
  DhwType,
  DishwasherManufacturer,
  EvCalculationMethod,
  FloorBellyInsulationCondition,
  FloorCavityInsulationType,
  FloorContinuousInsulationType,
  FloorFrameFloorType,
  FloorInsulationLocation,
  FloorWingInsulationCondition,
  FrontOfBuildingOrientation,
  GarageSize,
  HealthCondition,
  HealthFields,
  HealthTestState,
  HvacDuctInsulation,
  HvacDuctLeakage,
  HvacFields,
  HvacHeatingEnergySource,
  HvacHeatingSystemManufacturer,
  HvacSystemEquipmentType,
  HvacUpgradeAction,
  IncentiveFields,
  PercentCflsOrLeds,
  PoolPumpHorsepower,
  PoolPumpManufacturer,
  PoolPumpType,
  SCHEMA_NESTING_DEPTH_CAP,
  SCHEMA_SERIALIZED_CHAR_CAP,
  Shielding,
  snuggExtractionSchema,
  snuggValuesSchema,
  StageFields,
  TypeOfHome,
  VaultCavityInsulationType,
  VaultContinuousInsulationType,
  VaultFields,
  VaultInsulationQuality,
  VentilationSchedule,
  VentilationType,
  WallCavityInsulationType,
  WallExteriorWallSiding,
  WallFields,
  WallsInsulated,
  WindowExteriorTreatment,
  WindowFields,
  WindowFrame,
  WindowType,
  WindZone,
} from "./schema.js";
export type { SnuggExtraction, SnuggValues } from "./schema.js";

// The write context — the real `C` the adapter's `write` needs, as the schema a
// persisted `Recording.ctx` is parsed through and the type inferred off it.
export { snuggCtxSchema } from "./context.js";
export type { SnuggWriteContext } from "./context.js";

// The extraction instructions (the normalization intent) and few-shot examples.
// `snuggProInstructions` is the full prompt (every rule, full output section)
// for the single-shot extractor. `snuggGroupInstructions(key)` produces
// a per-group prompt (universal rules + only that group's rules, one-key output
// section) for the per-group extractor (R3 Task 4). The rule data (`SNUGG_RULES`,
// `SNUGG_GROUP_KEYS`) is exported so tests can verify no rule is silently lost.
export {
  SNUGG_GROUP_KEYS,
  SNUGG_RULES,
  snuggGroupFillInstructions,
  snuggGroupInstructions,
  snuggProInstructions,
} from "./instructions.js";
export type { FillScope, SnuggRule } from "./instructions.js";
export { snuggExamples } from "./examples.js";

// The Task 9 inventory-pass roster: the schema that parses the house-wide
// instance list, and the instructions that constrain the inventory model.
export {
  RosterEligibility,
  rosterCandidateSchema,
  rosterSchema,
  snuggInventoryInstructions,
} from "./inventory.js";
export type { Roster, RosterCandidate } from "./inventory.js";

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
