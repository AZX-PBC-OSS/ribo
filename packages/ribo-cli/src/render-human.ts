/**
 * The human rendering of the inspect report (design §1/§8): the same content
 * as the `--json` contract, different dressing — the fingerprint, both
 * versions, the field and group counts, the split caps, the split path, the whole and
 * worst-piece measures, the per-strategy call counts, the guidance coverage,
 * every finding list, any refusal, and the threshold outcomes. Presentation
 * is bin-side — the library owns the computation (the inspect-schema.ts
 * split) — and stays package-internal (Decision D7: the public barrel gains
 * nothing).
 *
 * Every character of colour routes through picocolors, whose own detection
 * honours `NO_COLOR` and a non-TTY stream, so piped output carries no escape
 * bytes.
 */
import pc from "picocolors";

import type {
  FlatReasonReport,
  SchemaInspectReport,
  ThresholdRow,
  WorstPieceReport,
} from "./inspect/report-schema.js";

/** The worst piece's name, in the threshold vocabulary: `${key}` or `${key}-<part>`. */
const pieceLabel = (piece: WorstPieceReport): string =>
  piece.part === undefined ? piece.key : `${piece.key}-${piece.part}`;

const label = (text: string): string => pc.dim(text.padEnd(24, " "));

const line = (name: string, value: string): string => `  ${label(name)}${value}\n`;

const flatReasonText = (reason: FlatReasonReport): string => {
  if (reason.kind === "loose-keys") return `loose top-level keys: ${reason.keys.join(", ")}`;
  return reason.kind === "not-an-object" ? "the document root is not an object" : "no properties";
};

const callsText = (calls: NonNullable<SchemaInspectReport["calls"]>): [string, string][] => [
  [
    "single-shot",
    calls.singleShot === null ? "unavailable" : `${calls.singleShot} call(s) per attempt`,
  ],
  [
    "per-group",
    calls.perGroup === null
      ? (calls.perGroupReason ?? "unavailable")
      : `${calls.perGroup} call(s) per attempt`,
  ],
  [
    "presence-narrowed",
    calls.presenceNarrowedAtMost === null
      ? "unavailable"
      : `at most ${calls.presenceNarrowedAtMost} call(s) per attempt`,
  ],
  [
    "consensus",
    calls.consensusPerCandidate === null
      ? "unavailable"
      : `${calls.consensusPerCandidate} call(s) per candidate`,
  ],
  ["retry budget", `worst case 1 + ${calls.maxRetriesDefault} retries per call`],
];

const thresholdText = (row: ThresholdRow): string => {
  const measured =
    row.measured === null
      ? "unavailable — a refusal left the measure unmeasured"
      : `${row.measured}`;
  const verdict = row.breached
    ? pc.red(`BREACHED — exceeds the limit ${row.limit}`)
    : `within the limit ${row.limit}`;
  const piece = row.piece === undefined ? "" : `, piece ${row.piece}`;
  return `${measured}${piece} — ${verdict}`;
};

export function renderHumanReport(report: SchemaInspectReport): string {
  const out: string[] = [];
  // The title is a heading: it ends its own line (the empty-string spacer
  // below contributes nothing under the "" join).
  out.push(`${pc.bold("ribo schema inspect — sizing report")}\n`);
  out.push("");
  out.push(line("schema fingerprint", report.schemaFingerprint));
  out.push(line("cli version", report.cliVersion));
  out.push(line("core version", report.coreVersion));
  out.push(line("fields", `${report.leafCount}`));
  if (report.groupCount !== undefined) {
    out.push(
      line("groups", `${report.groupCount} group key(s), ${report.looseKeyCount} loose key(s)`),
    );
  }
  if (report.path !== undefined) {
    out.push(
      line(
        "split path",
        report.flatReason === undefined
          ? report.path
          : `${report.path} (${flatReasonText(report.flatReason)})`,
      ),
    );
  }
  if (report.callShape !== undefined) out.push(line("call shape", report.callShape));
  if (report.whole !== undefined) {
    out.push(line("whole depth", `${report.whole.depth}`));
    out.push(line("whole serialized chars", `${report.whole.serializedChars}`));
    out.push(line("whole nullable unions", `${report.whole.nullableUnions}`));
  }
  out.push(
    line(
      "worst piece",
      report.worstPiece === null
        ? "none — the split produced no pieces"
        : `${pieceLabel(report.worstPiece)} (${report.worstPiece.serializedChars} serialized chars)`,
    ),
  );
  if (report.pieces !== undefined) {
    out.push(line("pieces", `${report.pieces.length} (one per chat call)`));
  }
  out.push(
    line(
      "split caps",
      report.splitCaps.maxSerializedCharsPerGroup === null
        ? `nullable unions ${report.splitCaps.maxNullableUnionsPerGroup}, byte cap off`
        : `nullable unions ${report.splitCaps.maxNullableUnionsPerGroup}, serialized chars ${report.splitCaps.maxSerializedCharsPerGroup}`,
    ),
  );
  if (report.calls !== undefined) {
    for (const [name, value] of callsText(report.calls)) out.push(line(name, value));
  }
  const coverage = report.guidanceCoverage;
  const pct = Math.round(coverage.ratio * 100);
  out.push(
    line(
      "guidance coverage",
      `${coverage.described} of ${coverage.total} fields described (${pct}%)`,
    ),
  );

  out.push(line("reformat findings", `${report.reformatFindings.length}`));
  for (const finding of report.reformatFindings) {
    out.push(
      `    ${finding.path}: "${finding.description}" asks for ${finding.directive} reformatting\n`,
    );
  }
  out.push(line("granularity violations", `${report.granularityViolations.length}`));
  for (const violation of report.granularityViolations) {
    out.push(
      `    ${violation.group}: derived at "${violation.granularity}" provenance granularity\n`,
    );
  }
  out.push(line("not visible in the input", `${report.notVisible.length} construct class(es)`));
  for (const construct of report.notVisible) {
    out.push(`    ${construct.construct}: ${construct.detail}\n`);
  }
  if (report.refusal !== undefined) {
    out.push(line(`refusal (${report.refusal.stage})`, report.refusal.message));
  }
  if (report.thresholds !== undefined) {
    for (const row of report.thresholds) {
      out.push(line(`threshold ${row.measure}`, thresholdText(row)));
    }
  }
  return out.join("");
}
