/**
 * The inspect entry (design §2): one importable function over the same JSON
 * Schema document the bin takes — never a zod object (ADR 0038). A zod object
 * cannot cross a process boundary, so the bin could only ever see a document;
 * an entry that accepted both would carry inputs with different honesty
 * properties. One input, one conversion path, one set of caveats.
 *
 * The library owns the loader (conversion, refusal, walk, split description);
 * the bin stays exactly as thin as it is today — it reads bytes, `JSON.parse`s
 * and maps `SchemaInspectError` to exit 2.
 */
import { convertDocument } from "./inspect/convert.js";
import { SchemaInspectError } from "./inspect/error.js";
import type { SchemaInspectOptions } from "./inspect/options.js";
import { assembleReport } from "./inspect/report.js";
import { SchemaInspectReportSchema } from "./inspect/report-schema.js";
import type { SchemaInspectReport } from "./inspect/report-schema.js";

/**
 * The version of the report's JSON contract (design §7). Owned by the CLI and
 * bumped when a field is added or its meaning changes — numbers computed by
 * unchanged core symbols do not bump it. v2 grows the v1 skeleton report
 * (contract, versions, `leafCount`) to the full sizing report.
 */
export const CONTRACT_VERSION = 2;

// An import exported under its own name — not a `export … from` re-export,
// which the single-file bundle's chunker answers with a shared runtime chunk
// the pack-and-consume gate (rightly) refuses.
export { SchemaInspectError };
export { SchemaInspectReportSchema };
export type { SchemaInspectOptions };
export type { SchemaInspectReport };

/**
 * Inspect a JSON Schema document in OpenAPI 3.0 form and return the versioned
 * report (design §3/§7/§9), every number read off `@azx/ribo-core` symbols the
 * real extraction path also reads — never a CLI-side re-derivation:
 *
 *   - `walkLeafInventory` for the leaf count and the guidance/lint inputs;
 *   - `describeExtraction` for the keys, split path, call shape, whole and
 *     per-piece measures and any carried refusal;
 *   - a real `perGroupPlan` entry map (built with a never-called stub chat)
 *     for the per-group call count;
 *   - the `callShape` classification for the single-shot and consensus
 *     counts, and the presence phase's one-item-per-group plan for the
 *     presence-narrowed upper bound.
 *
 * The leaf-granularity violation list is collected by calling core's own
 * `assertLeafGranularity` once per group — no reproduced predicate — and an
 * agreement test holds the list against a whole-schema run of the same assert.
 * The report is zod-parsed against the exported `SchemaInspectReportSchema`
 * before it is returned.
 *
 * Could-not-run faults raise `SchemaInspectError`, which the bin maps to exit
 * 2 with stderr only: empty or whitespace input, non-schema JSON, a
 * draft-2020-12-form document (refused loudly, never converted), an
 * unconvertible document, and a convertible-but-unwalkable one. A
 * `describeExtraction` refusal is a finding, not a failure: the report
 * carries it verbatim beside everything the walk could measure.
 */
export function inspectSchema(
  document: unknown,
  options: SchemaInspectOptions = {},
): SchemaInspectReport {
  const schema = convertDocument(document);
  const report = assembleReport(document, schema, options);
  // The contract's own trust boundary: the library parses its serialized
  // report shape before returning it, so a drift between the builder and the
  // exported schema fails here, loudly, rather than shipping a malformed
  // contract.
  const parsed: SchemaInspectReport = SchemaInspectReportSchema.parse(report);
  return parsed;
}
