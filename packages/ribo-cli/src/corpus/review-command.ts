/**
 * @file The `ribo corpus review` command: one command shows every pending
 * proposal with its evidence, and records a reviewer's decision (R6; ADR
 * 0049's D8).
 *
 * The read side is the free one: load the corpus, transcribe documents
 * through the shared path, build the sheet, print it — no model call, no
 * credential, no write. A decision (`--confirm`, `--mark-absent`,
 * `--reject`) needs a case id and exactly one action, and goes through the
 * guarded writer, so only `expected` changes and only atomically.
 *
 * The runner is injectable in the style of `propose-command.ts`: corpus
 * loading, streams and the write filesystem are dependencies, and the
 * Commander shell only parses and maps faults to exit 2.
 */
import process from "node:process";
import { resolve as resolvePath } from "node:path";

import type { Command } from "commander";

import { colorsFor } from "../colors.js";
import { caseInputsOf } from "../eval/case-text.js";
import type { CaseInputText } from "../eval/case-text.js";
import { transcribeDocumentCases } from "../eval/documents.js";
import { OperatorError } from "../operator/error.js";
import type { CaseWriteFs } from "./case-write.js";
import { CorpusError } from "./error.js";
import { loadCorpus } from "./loader.js";
import type { LoadedCorpus } from "./loader.js";
import { CORPUS_REVIEW_CONTRACT_VERSION, applyReviewDecision, reviewCaseSheet } from "./review.js";
import type { ReviewCaseSheet, ReviewDecisionOutcome, ReviewSheet } from "./review.js";

const COMMAND = "ribo corpus review";

export interface ReviewFlags {
  /** Emit the versioned JSON sheet (read-only) or decision report. */
  readonly json?: boolean;
  readonly confirm?: boolean;
  readonly markAbsent?: boolean;
  readonly reject?: boolean;
  /** Repeatable: the leaves a confirm is narrowed to, or the one leaf of mark-absent/reject. */
  readonly leaf?: readonly string[];
}

interface CommandOutputStream extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface ReviewRunDependencies {
  readonly cwd?: string;
  readonly stdout?: CommandOutputStream;
  readonly stderr?: CommandOutputStream;
  readonly loadCorpus?: typeof loadCorpus;
  readonly writeFs?: CaseWriteFs;
}

/** The versioned decision report: what one decision did to one case. */
export interface ReviewDecisionReport {
  readonly contractVersion: typeof CORPUS_REVIEW_CONTRACT_VERSION;
  readonly corpus: string;
  readonly caseId: string;
  readonly action: ReviewDecisionOutcome["action"];
  readonly decided: readonly string[];
  readonly leftPending: readonly { readonly path: string; readonly reason: string }[];
}

/** The refusals the flag combination itself answers, before the corpus is read. */
const validateFlags = (caseId: string | undefined, flags: ReviewFlags): void => {
  const actions = [flags.confirm === true, flags.markAbsent === true, flags.reject === true].filter(
    Boolean,
  ).length;
  if (actions > 1) {
    throw new OperatorError(
      "pass exactly one of --confirm, --mark-absent or --reject — a decision is one action " +
        "(fix: run one decision per invocation)",
    );
  }
  const leaves = flags.leaf ?? [];
  if (actions === 0) {
    if (leaves.length > 0) {
      throw new OperatorError(
        "--leaf names the targets of a decision — pass --confirm, --mark-absent or --reject " +
          "(fix: add the action flag, or drop --leaf to read the sheet)",
      );
    }
    return;
  }
  if (caseId === undefined) {
    throw new OperatorError(
      "a decision needs a case id — pass the case whose pending proposals to decide " +
        "(fix: run `ribo corpus review <corpus-dir> <case-id> …`)",
    );
  }
  if (flags.markAbsent === true || flags.reject === true) {
    if (leaves.length === 0) {
      throw new OperatorError(
        `--mark-absent and --reject decide exactly one leaf — pass --leaf <path> once ` +
          "(fix: name the leaf)",
      );
    }
    if (leaves.length > 1) {
      throw new OperatorError(
        `--mark-absent and --reject decide exactly one leaf, but ${leaves.length} were named ` +
          "(fix: run one decision per leaf)",
      );
    }
  }
};

/** The cases the command selected — all of them, or the one named id. */
const selectCases = (corpus: LoadedCorpus, caseId: string | undefined) => {
  if (caseId === undefined) return corpus.cases;
  const selected = corpus.cases.filter((entry) => entry.id === caseId);
  if (selected.length === 0) {
    throw new CorpusError(
      `the corpus "${corpus.manifest.name}" holds no case "${caseId}" — the cases it holds ` +
        `are: ${corpus.cases.map((entry) => entry.id).join(", ")} (fix: pass one of those ids, ` +
        "or no id to review every case)",
    );
  }
  return selected;
};

/** The cell's one human line: value, quote, input, and the two flags. */
const cellLine = (
  pc: ReturnType<typeof colorsFor>,
  value: unknown,
  quote: string,
  input: string,
  grounded: boolean,
  literal: boolean,
): string => {
  const flags = [
    grounded ? "grounded" : pc.red("NOT grounded"),
    literal ? "literal" : pc.yellow("not literal"),
  ].join(", ");
  return `value ${JSON.stringify(value)} · quote ${JSON.stringify(quote)} · ${input} · ${flags}`;
};

/** The human rendering of one case's sheet. */
const renderCaseSheet = (pc: ReturnType<typeof colorsFor>, sheet: ReviewCaseSheet): string => {
  const lines: string[] = [`== ${sheet.caseId} ==`];
  if (sheet.values.length === 0 && sheet.collections.length === 0 && sheet.absences.length === 0) {
    lines.push("no pending proposals");
    return lines.join("\n");
  }
  if (sheet.values.length > 0) {
    lines.push("Pending values:");
    for (const row of sheet.values) {
      lines.push(`  ${row.path}`);
      lines.push(`    ${cellLine(pc, row.value, row.quote, row.input, row.grounded, row.literal)}`);
    }
  }
  for (const collection of sheet.collections) {
    lines.push(`Pending collection ${collection.collectionPath}:`);
    for (const row of collection.rows) {
      lines.push(`  row ${row.ordinal}`);
      const paths = Object.keys(row.cells);
      if (paths.length === 0) lines.push("    (no cells)");
      for (const path of paths) {
        const cell = row.cells[path];
        if (cell === undefined) {
          lines.push(`    ${path} — missing from this row`);
          continue;
        }
        lines.push(
          `    ${path}: ${cellLine(pc, cell.value, cell.quote, cell.input, cell.grounded, cell.literal)}`,
        );
      }
    }
  }
  if (sheet.absences.length > 0) {
    lines.push("Proposed absences (a claim of silence has no evidence to show):");
    for (const absence of sheet.absences) lines.push(`  ${absence.path}`);
  }
  return lines.join("\n");
};

/** Run corpus reviewing with loading, transcription and write dependencies injectable. */
export async function runCorpusReviewCommand(
  corpusDir: string,
  caseId: string | undefined,
  flags: ReviewFlags,
  dependencies: ReviewRunDependencies = {},
): Promise<ReviewSheet | ReviewDecisionReport> {
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? process.stdout;
  const pc = colorsFor(stdout);

  validateFlags(caseId, flags);

  const load = dependencies.loadCorpus ?? loadCorpus;
  const corpus = load(resolvePath(cwd, corpusDir));
  const selected = selectCases(corpus, caseId);

  // Selection precedes transcription, as `corpus/text.ts` does: an unknown
  // id never spends pdf.js, and transcription is free and local.
  const documents = await transcribeDocumentCases({ ...corpus, cases: selected });
  const inputsByCase = new Map<string, readonly CaseInputText[]>(
    selected.map((entry) => [entry.id, caseInputsOf(entry, documents)]),
  );

  const action =
    flags.confirm === true
      ? ("confirm" as const)
      : flags.markAbsent === true
        ? ("mark-absent" as const)
        : flags.reject === true
          ? ("reject" as const)
          : undefined;

  if (action === undefined) {
    const sheet: ReviewSheet = {
      contractVersion: CORPUS_REVIEW_CONTRACT_VERSION,
      corpus: corpus.manifest.name,
      cases: selected.map((entry) =>
        reviewCaseSheet(entry, corpus.schema, inputsByCase.get(entry.id) ?? []),
      ),
    };
    if (flags.json === true) {
      stdout.write(`${JSON.stringify(sheet, null, 2)}\n`);
      return sheet;
    }
    stdout.write(`${sheet.cases.map((entry) => renderCaseSheet(pc, entry)).join("\n\n")}\n`);
    return sheet;
  }

  // A decision is one case, one action — validated above.
  const target = selected[0]!;
  const inputs = inputsByCase.get(target.id) ?? [];
  const decision =
    action === "confirm"
      ? flags.leaf !== undefined && flags.leaf.length > 0
        ? { action: "confirm" as const, leaves: flags.leaf }
        : { action: "confirm" as const }
      : action === "mark-absent"
        ? { action: "mark-absent" as const, leaf: flags.leaf![0]! }
        : { action: "reject" as const, leaf: flags.leaf![0]! };
  const outcome = applyReviewDecision(target, inputs, decision, {
    ...(dependencies.writeFs === undefined ? {} : { writeFs: dependencies.writeFs }),
  });
  const report: ReviewDecisionReport = {
    contractVersion: CORPUS_REVIEW_CONTRACT_VERSION,
    corpus: corpus.manifest.name,
    caseId: target.id,
    action,
    decided: outcome.decided,
    leftPending: outcome.leftPending,
  };
  if (flags.json === true) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  const verb =
    action === "confirm" ? "confirmed" : action === "mark-absent" ? "marked absent" : "rejected";
  if (outcome.decided.length > 0) {
    stdout.write(`${verb} in ${target.id}: ${outcome.decided.join(", ")}\n`);
  } else {
    stdout.write(`nothing confirmed in ${target.id} — every pending proposal was refused\n`);
  }
  if (outcome.leftPending.length > 0) {
    stdout.write("left pending:\n");
    for (const entry of outcome.leftPending) {
      stdout.write(`  ${entry.path} — ${entry.reason}\n`);
    }
  }
  return report;
}

const help = [
  "Exit codes:",
  "  0  the sheet was printed or the decision was recorded",
  "  2  the command could not run: a usage error (no or several actions, a decision without a",
  "     case id or without its leaf), an unreadable corpus, an unknown case id, a decision on a",
  "     leaf with no pending proposal, or a document input that cannot be transcribed. stdout",
  "     stays empty on a refusal.",
  "",
  "What it does:",
  "  With no action flags the command is read-only: it prints the pending sheet — every pending",
  "  proposal with its value, quote and input, collections row-major with one row per instance,",
  "  proposed absences in their own block — re-verifying each quote against the case's current",
  "  inputs (grounded) and marking each value literal when the value itself occurs in its quote.",
  "  No model call is made and nothing is written. --json emits the versioned sheet, the input",
  "  an agent reviewer reads; the docs tell an agent to check each absence against",
  "  `ribo corpus text`, and the run record's accepted-unchanged count is the backstop.",
  "",
  "The decisions (each needs a case id and exactly one action):",
  "  --confirm              confirm the case's pending entries — but only those whose every",
  "                         value is literal in a still-grounded quote; proposed absences and",
  "                         non-literal values stay pending, and the command prints them and",
  "                         why. Narrow it with repeatable --leaf <path> to confirm named",
  "                         entries whatever they are.",
  "  --mark-absent --leaf   set the named entry declared-absent and confirm it — the reviewer's",
  "                         own claim of silence.",
  "  --reject --leaf        remove the named pending entry: the leaf then resolves exactly as",
  "                         the corpus otherwise would — through a covering default if one",
  "                         exists, else unmentioned. Defaults are never edited, and no explicit",
  "                         unmentioned entry is ever written.",
  "  A correction is an edit to `value` in case.json, then --confirm --leaf <path> — a JSON value",
  "  on a command line is unwritable. The `proposal` block is never modified: it is the record",
  "  of what the model proposed, and removing it by hand defeats the record's honesty.",
  "",
  "Examples:",
  "  ribo corpus review ./corpora/workshop",
  "  ribo corpus review ./corpora/workshop service-sheet",
  "  ribo corpus review ./corpora/workshop service-sheet --confirm",
  "  ribo corpus review ./corpora/workshop service-sheet --confirm --leaf frame.material --json",
  "  ribo corpus review ./corpora/workshop service-sheet --mark-absent --leaf service.date",
  "",
  "Docs: node_modules/@azx/ribo-cli/docs/cli/corpus.md — reviewing proposals: the sheet, the " +
    "four decisions and the agent handoff (online: " +
    "https://ribo-docs.azx.helix.azxlabs.io/cli/corpus.html).",
].join("\n");

function writeDiagnostic(stream: CommandOutputStream, text: string): void {
  for (const line of text.split("\n")) {
    if (line.length > 0) stream.write(`${COMMAND}: ${line}\n`);
  }
}

/** Register the thin Commander shell; the runner owns all testable behavior. */
export function registerCorpusReviewCommand(corpus: Command): Command {
  const command = corpus
    .command("review")
    .description(
      "Show a corpus's pending proposals with their evidence, and record confirm, mark-absent " +
        "and reject decisions — read-only and free without action flags",
    )
    .argument("<corpus-dir>", "the corpus directory to review")
    .argument("[case-id]", "review or decide this case alone")
    .option("--json", "emit the versioned JSON sheet or decision report")
    .option("--confirm", "confirm the case's pending entries (narrow with --leaf)")
    .option("--mark-absent", "with --leaf: set the entry declared-absent and confirm it")
    .option("--reject", "with --leaf: remove the pending entry")
    .option(
      "--leaf <path>",
      "the leaf a decision names (repeatable to confirm several)",
      collectLeaf,
      [],
    )
    .addHelpText("after", help)
    .showHelpAfterError(`run '${COMMAND} --help' for the command's flags and exit codes.`)
    .configureOutput({ writeErr: (text) => writeDiagnostic(process.stderr, text) });

  command.action(async (corpusDir: string, caseId: string | undefined, flags: ReviewFlags) => {
    try {
      await runCorpusReviewCommand(corpusDir, caseId, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeDiagnostic(process.stderr, colorsFor(process.stderr).red(message));
      process.exit(2);
    }
  });
  return command;
}

/** `--leaf` is repeatable: each occurrence adds one leaf path, in order. */
const collectLeaf = (value: string, previous: readonly string[]): readonly string[] => [
  ...previous,
  value,
];
