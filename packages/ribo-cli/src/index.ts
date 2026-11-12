/**
 * @module @azx/ribo-cli
 *
 * @file The public surface of `@azx/ribo-cli` — the CLI tier's single package
 * (ADR 0037): one bin, `ribo`, over one importable entry with the same input
 * contract. The entry takes the JSON Schema document the bin takes — never a
 * zod object (ADR 0038) — and returns the versioned report of design §7.
 */
export { CONTRACT_VERSION, SchemaInspectError, inspectSchema } from "./inspect-schema.js";
export type { SchemaInspectOptions, SchemaInspectReport } from "./inspect-schema.js";
export { cliVersion, coreVersion } from "./versions.js";
