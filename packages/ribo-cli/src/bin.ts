#!/usr/bin/env node
/**
 * The `ribo` bin — a thin shell over `inspectSchema` (ADR 0037). The command
 * path is `ribo schema inspect [path]` (design §1); the document is read from
 * the file at `path`, or from stdin when `path` is exactly `-` or is absent
 * and stdin is piped (never a prompt, never a blocking read on a terminal).
 *
 * Output discipline (design §4): results on stdout, diagnostics on stderr.
 * The report is rendered for humans by default; `--json` emits the versioned
 * JSON contract instead (design §7), byte-stable regardless of TTY or colour
 * environment.
 *
 * Exit codes (design §4, never shared):
 *   0  success — the report was computed and no supplied threshold breached
 *      (a `describeExtraction` refusal is a finding in the report, not a
 *      failure);
 *   1  ran and failed threshold — the full report is still on stdout, and a
 *      one-line diagnostic per breached threshold goes to stderr;
 *   2  could-not-run — unreadable file, empty input, malformed JSON, not a
 *      JSON Schema document, unconvertible document, a refused draft-2020-12
 *      document, or a usage error (unknown flag, surplus argument, invalid
 *      threshold or split-cap value): stdout empty, diagnostic on stderr.
 *
 * No credential-bearing option exists on this surface, and none may: secrets
 * never ride flags.
 */
import process from "node:process";

import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";

import { inspectSchema, SchemaInspectError } from "./inspect-schema.js";
import type { ThresholdRow } from "./inspect/report-schema.js";
import { InputFault, readDocumentSource } from "./read-input.js";
import { renderHumanReport } from "./render-human.js";

/** Reports a could-not-run fault and exits 2. Stdout stays empty. */
function fail(message: string): never {
  process.stderr.write(`ribo schema inspect: ${pc.red(message)}\n`);
  process.exit(2);
}

/** The one-line stderr diagnostic for a breached threshold (design §4, Decision D3). */
function thresholdBreachLine(row: ThresholdRow): string {
  const piece = row.piece === undefined ? "" : ` (piece ${row.piece})`;
  return (
    `ribo schema inspect: threshold breach — ${row.measure}: measured ${row.measured} ` +
    `exceeds the limit ${row.limit}${piece}`
  );
}

/** Threshold values are non-negative integers; anything else is a usage error (Decision D5). */
const parseThreshold = (value: string): number => {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new InvalidArgumentError(`expected a non-negative integer, but got "${value}"`);
  }
  return Number(value);
};

/**
 * Split-cap values are positive integers; anything else — zero, negative,
 * fractional, non-numeric — is a usage error (Decision D5). A cap of zero can
 * never fit a piece, so it is refused as the misuse it is rather than honored
 * into a guaranteed split refusal.
 */
const parseCap = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError(`expected a positive integer, but got "${value}"`);
  }
  return Number(value);
};

interface InspectFlags {
  readonly json?: boolean;
  readonly maxDepth?: number;
  readonly maxPieceChars?: number;
  readonly maxNullableUnionsPerGroup?: number;
  readonly maxSerializedCharsPerGroup?: number;
}

function run(path: string | undefined, flags: InspectFlags): void {
  let raw: string;
  try {
    raw = readDocumentSource(path, process.stdin.isTTY === true);
  } catch (error) {
    if (error instanceof InputFault) fail(error.message);
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    fail(`the input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  let report: ReturnType<typeof inspectSchema>;
  try {
    report = inspectSchema(document, {
      ...(flags.maxDepth === undefined ? {} : { maxDepth: flags.maxDepth }),
      ...(flags.maxPieceChars === undefined ? {} : { maxPieceChars: flags.maxPieceChars }),
      ...(flags.maxNullableUnionsPerGroup === undefined
        ? {}
        : { maxNullableUnionsPerGroup: flags.maxNullableUnionsPerGroup }),
      ...(flags.maxSerializedCharsPerGroup === undefined
        ? {}
        : { maxSerializedCharsPerGroup: flags.maxSerializedCharsPerGroup }),
    });
  } catch (error) {
    if (error instanceof SchemaInspectError) fail(error.message);
    throw error;
  }
  process.stdout.write(
    flags.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderHumanReport(report),
  );
  const breached = report.thresholds?.filter((row) => row.breached) ?? [];
  if (breached.length > 0) {
    // The full report is already on stdout; the stderr lines make a CI log
    // self-explanatory when stdout was captured elsewhere (Decision D3).
    for (const row of breached)
      process.stderr.write(`ribo schema inspect: ${pc.red(thresholdBreachLine(row))}\n`);
    process.exit(1);
  }
}

const inspectHelp = [
  "Exit codes:",
  "  0  the report was computed and no supplied threshold was breached (a refusal is a finding, not a failure)",
  "  1  the report was computed, and a supplied threshold was breached — the full report is still on stdout",
  "  2  the command could not run: unreadable file, empty input, malformed JSON, not a JSON Schema document,",
  "     an unconvertible document, a refused draft-2020-12-form document, or a usage error",
  "",
  "Split caps (unlike the thresholds above, these ARE fed into the split):",
  "  --max-serialized-chars-per-group <n>       pack pieces against this serialized-character cap",
  "  --max-nullable-unions-per-group <n>        pack pieces against this nullable-union cap",
  "  Absent, the split packs against the library's own union default with the byte cap off.",
  "",
  "Examples:",
  "  ribo schema inspect ./snugg.schema.json",
  "  ribo schema inspect - < ./snugg.schema.json",
  "  cat ./snugg.schema.json | ribo schema inspect --json --max-depth 24 --max-piece-chars 12000",
  "  ribo schema inspect --json --max-serialized-chars-per-group 32768 ./snugg.schema.json",
].join("\n");

const program = new Command()
  .name("ribo")
  .description("Ribo's command-line tools (ADR 0037)")
  .showHelpAfterError()
  // Commander's default usage-error exit is 1, which is the
  // ran-and-failed-threshold code — never shared (design §4). Remap every
  // override: help and version are not faults (exit 0, output already
  // written); every other override is a usage error, a could-not-run fault
  // (exit 2; commander has already written the diagnostic to stderr).
  .exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    process.exit(2);
  });

const schema = program.command("schema").description("Sizing checks over a JSON Schema document");

schema
  .command("inspect")
  .description(
    "Size a JSON Schema document in OpenAPI 3.0 form before the first call. Reads the file at " +
      "<path>, or stdin when <path> is exactly - or is absent and stdin is piped.",
  )
  .argument("[path]", "path to the JSON Schema document file, or - for stdin")
  .option("--json", "emit the versioned JSON contract instead of the human rendering")
  .option(
    "--max-depth <n>",
    "threshold on the whole schema's nesting depth; a breach exits 1 with the report still on stdout",
    parseThreshold,
  )
  .option(
    "--max-piece-chars <n>",
    "threshold on the worst piece's serialized character count; a breach exits 1 with the report still on stdout",
    parseThreshold,
  )
  .option(
    "--max-nullable-unions-per-group <n>",
    "split cap: the nullable unions a piece may carry — a group over it is partitioned across calls (absent, the library's own default stands)",
    parseCap,
  )
  .option(
    "--max-serialized-chars-per-group <n>",
    "split cap: the serialized characters a piece may carry — a group over it is partitioned across calls (absent, the byte cap is off)",
    parseCap,
  )
  .addHelpText("after", inspectHelp)
  .action(run);

// Commander's parse() reads process.argv by default. Exit codes are the
// command's own: 0 from run(), 1 from the threshold-breach path, 2 from
// fail() and from the exitOverride remap of every usage error.
program.parse();
