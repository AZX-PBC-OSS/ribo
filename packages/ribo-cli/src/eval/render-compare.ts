/**
 * The human rendering of the comparison report: both sides' identities and
 * totals, the axes that differ, the intersection's size beside each side's
 * exclusion counts, and every differing cell pair with the two verdicts side
 * by side and the values behind them.
 *
 * Presentation is bin-side — the barrel gains nothing (the pattern
 * `render-human.ts` sets) — and the rendering is the one both `ribo compare`
 * and `ribo eval`'s cross-arm summary use, so a reader sees the same table
 * in either place.
 *
 * Colour is the caller's decision (`colorsFor` in colors.ts); without one the
 * rendering is plain, so piped output carries no escape bytes.
 */
import { createColors } from "picocolors";

import type { Colors } from "../colors.js";

import type { EvalCompareReport } from "./compare-report.js";
import type { EvalScoreTotals } from "./score-types.js";
import type { EvalRunRecordCell } from "./record-schema.js";

/** One cell, as a difference renders it: the verdict and the values behind it. */
const cellText = (cell: EvalRunRecordCell): string => {
  const reason = cell.reason === undefined ? "" : ` (${cell.reason})`;
  // A pending proposal is not an answer: never print its value as plain.
  const expected =
    cell.reason === "unreviewed-proposal"
      ? "(proposed, unreviewed)"
      : JSON.stringify(cell.expected);
  return `${cell.verdict} — expected ${expected}, ` + `got ${JSON.stringify(cell.got)}${reason}`;
};

/**
 * The totals, as `name=value` pairs — the record's own counters, in its own
 * names, so a reader can diff two arms' totals line against line.
 * @param totals - The run's totals.
 * @returns The one-line totals text.
 */
const totalsText = (totals: EvalScoreTotals): string =>
  [
    `cases=${totals.cases}`,
    `correct=${totals.correct}`,
    `wrong=${totals.wrong}`,
    `missed=${totals.missed}`,
    `hallucinated=${totals.hallucinated}`,
    `unscorable=${totals.unscorable}`,
    `judged=${totals.judged}`,
    `answered=${totals.answered}`,
  ].join(" ");

/**
 * Render the comparison report for a human.
 * @param report - The comparison report.
 * @param pc - The colours to dress the rendering in; plain when omitted.
 * @returns The rendering, newlines included.
 */
export function renderCompareReport(
  report: EvalCompareReport,
  pc: Colors = createColors(false),
): string {
  const line = (name: string, value: string): string =>
    `  ${pc.dim(name.padEnd(22, " "))}${value}\n`;
  const out: string[] = [];
  out.push(`${pc.bold("ribo compare — comparison report")}\n\n`);
  const corporaDiffer = report.left.corpus.fingerprint !== report.right.corpus.fingerprint;
  if (corporaDiffer) {
    out.push(
      line(
        "notice",
        pc.red(
          "the corpora differ — the comparison was allowed by --allow-corpus-mismatch, and the " +
            "differences below line up cases and leaves it cannot prove are the same",
        ),
      ),
    );
  }
  out.push(
    line(
      "axes",
      report.axes.length === 0
        ? "none — the two runs ran under the same conditions"
        : report.axes.join(", "),
    ),
  );
  for (const [label, side] of [
    ["left", report.left],
    ["right", report.right],
  ] as const) {
    out.push(
      line(`${label} corpus`, `${side.corpus.name} (fingerprint ${side.corpus.fingerprint})`),
    );
    out.push(
      line(
        `${label} identity`,
        `backend ${side.identity.backend}, model ${side.identity.model}, ` +
          `run fingerprint ${side.identity.fingerprint}`,
      ),
    );
    out.push(line(`${label} settings`, JSON.stringify(side.identity.settings)));
    out.push(line(`${label} totals`, totalsText(side.totals)));
    out.push(
      line(`${label} excluded`, `${side.excludedLeaves} leaf(s), ${side.excludedCases} case(s)`),
    );
  }
  out.push(line("leaves compared", `${report.leafPaths.length}`));
  out.push(line("differences", `${report.differences.length}`));
  for (const difference of report.differences) {
    out.push(`    ${difference.leafPath} / ${difference.caseId}\n`);
    out.push(`      left:  ${cellText(difference.left)}\n`);
    out.push(`      right: ${cellText(difference.right)}\n`);
  }
  return out.join("");
}
