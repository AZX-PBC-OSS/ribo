#!/usr/bin/env node
/**
 * The `ribo` bin — a thin shell over `inspectSchema` (ADR 0037) and over the
 * eval runner (`ribo eval`). The command path is `ribo schema inspect [path]`
 * (design §1); the document is read from
 * the file at `path`, or from stdin when `path` is exactly `-` or is absent
 * and stdin is piped (never a prompt, never a blocking read on a terminal).
 *
 * The second command, `ribo eval`, runs a corpus through the eval runner
 * (design §6): the flags build the run's settings object, the corpus enters
 * only through the loader, and the report goes to stdout. It owns the same
 * two exit codes the design fixes — 0 success, 2 could-not-run — and no
 * third.
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

import { Command, InvalidArgumentError, Option } from "commander";

import { colorsFor } from "./colors.js";
import { loadCorpus } from "./corpus.js";
import { createOpenAiCompatibleChat } from "./eval/backend.js";
import { runEval } from "./eval/run.js";
import type {
  EvalCaseResult,
  EvalConsensusArbiter,
  EvalSettings,
  EvalStrategyId,
} from "./eval/types.js";
import { inspectSchema, SchemaInspectError } from "./inspect-schema.js";
import type { ThresholdRow } from "./inspect/report-schema.js";
import { InputFault, readDocumentSource } from "./read-input.js";
import { renderHumanReport } from "./render-human.js";

/** Reports a could-not-run fault under a command's name and exits 2. Stdout stays empty. */
function failWith(command: string, message: string): never {
  process.stderr.write(`${command}: ${colorsFor(process.stderr).red(message)}\n`);
  process.exit(2);
}

/** Reports a could-not-run fault and exits 2. Stdout stays empty. */
function fail(message: string): never {
  failWith("ribo schema inspect", message);
}

/** Reports a could-not-run fault of the eval command and exits 2. Stdout stays empty. */
function failEval(message: string): never {
  failWith("ribo eval", message);
}

/**
 * Write a diagnostic of the eval command under its name.
 *
 * Commander's own usage errors go to stderr through its output configuration,
 * so the eval command's configuration writes them here too: every diagnostic
 * line a run of `ribo eval` produces names the command, whichever layer
 * produced it.
 */
function writeEvalErr(text: string): void {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    process.stderr.write(`ribo eval: ${line}\n`);
  }
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
    flags.json === true
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderHumanReport(report, colorsFor(process.stdout)),
  );
  const breached = report.thresholds?.filter((row) => row.breached) ?? [];
  if (breached.length > 0) {
    // The full report is already on stdout; the stderr lines make a CI log
    // self-explanatory when stdout was captured elsewhere (Decision D3).
    for (const row of breached)
      process.stderr.write(
        `ribo schema inspect: ${colorsFor(process.stderr).red(thresholdBreachLine(row))}\n`,
      );
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

// --- `ribo eval` ---------------------------------------------------------------------

/** The environment variable the endpoint's base URL comes from. */
const BASE_URL_VARIABLE = "OPENAI_BASE_URL";
/** The environment variable the bearer credential comes from. */
const API_KEY_VARIABLE = "OPENAI_API_KEY";
/** The endpoint used when the base-URL variable is unset. */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** The backends this build can run against (the CLI backends arrive with their own ticket). */
const EVAL_BACKENDS = ["openai-compatible"] as const;

/**
 * The eval command's flags, as commander parsed them.
 *
 * The optional members are present exactly when their flag was passed: an
 * absent flag means the strategies' own default stands, so the bin never
 * copies a table of defaults into the settings it builds.
 */
interface EvalFlags {
  readonly corpus: string;
  readonly backend: string;
  readonly model: string;
  readonly strategy: readonly string[];
  readonly out?: string;
  readonly consensus?: string;
  readonly consensusArbiter?: string;
  readonly maxRetries?: number;
  readonly responseCap?: number;
  readonly maxNullableUnionsPerGroup?: number;
  readonly maxSerializedCharsPerGroup?: number;
}

/** One arm's report: the settings it ran under, and one result per case. */
interface EvalArmReport {
  readonly settings: EvalSettings;
  readonly results: readonly EvalCaseResult[];
}

/**
 * One `--strategy` occurrence's ladder.
 *
 * A plain value names one strategy; a comma-separated value names the arm's
 * ordered fallback ladder. The ids themselves are checked by the runner's own
 * settings validation, which names the offending id.
 */
function splitLadder(value: string): readonly string[] {
  return value.split(",").map((entry) => entry.trim());
}

/** Collect the repeatable `--strategy` flag: one occurrence is one arm. */
function collectStrategy(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

/**
 * Build one arm's settings from the flags.
 *
 * Only the flags that were passed are carried: an absent flag is not
 * forwarded, so the strategies' own defaults stand rather than a copied
 * table.
 */
function buildEvalSettings(ladder: readonly string[], flags: EvalFlags): EvalSettings {
  const splitCaps =
    flags.maxNullableUnionsPerGroup === undefined && flags.maxSerializedCharsPerGroup === undefined
      ? undefined
      : {
          ...(flags.maxNullableUnionsPerGroup === undefined
            ? {}
            : { maxNullableUnionsPerGroup: flags.maxNullableUnionsPerGroup }),
          ...(flags.maxSerializedCharsPerGroup === undefined
            ? {}
            : { maxSerializedCharsPerGroup: flags.maxSerializedCharsPerGroup }),
        };
  return {
    strategies: ladder as readonly EvalStrategyId[],
    model: flags.model,
    ...(flags.consensus === undefined ? {} : { consensusCandidates: Number(flags.consensus) }),
    ...(flags.consensusArbiter === undefined
      ? {}
      : { consensusArbiter: flags.consensusArbiter as EvalConsensusArbiter }),
    ...(flags.maxRetries === undefined ? {} : { maxRetries: flags.maxRetries }),
    ...(flags.responseCap === undefined ? {} : { responseCap: flags.responseCap }),
    ...(splitCaps === undefined ? {} : { splitCaps }),
  };
}

/**
 * Run the eval command: load the corpus, build the backend, and run every
 * arm the `--strategy` occurrences named.
 *
 * The corpus enters only through the loader, and every refusal the loader,
 * the runner and the settings validation raise is a `SchemaInspectError` — the
 * could-not-run class — so one catch maps them all to exit 2 with the
 * diagnostic naming the cause. The report is written only once every arm has
 * finished, so a refusal on the last arm leaves stdout empty.
 */
async function runEvalCommand(flags: EvalFlags): Promise<void> {
  if (flags.strategy.length === 0) {
    failEval(
      "the run needs at least one --strategy: name the strategy, or the ladder, the arm should try " +
        "(fix: pass --strategy single-shot, or --strategy single-shot,per-group for a ladder)",
    );
  }
  let corpus;
  try {
    corpus = loadCorpus(flags.corpus);
  } catch (error) {
    if (error instanceof SchemaInspectError) failEval(error.message);
    throw error;
  }
  const apiKey = process.env[API_KEY_VARIABLE];
  if (apiKey === undefined || apiKey.length === 0) {
    failEval(
      `the environment variable ${API_KEY_VARIABLE} is not set — the backend needs a credential, ` +
        "and secrets never ride flags (fix: export the credential before running the command)",
    );
  }
  const baseUrl = process.env[BASE_URL_VARIABLE] ?? DEFAULT_BASE_URL;
  const chat = createOpenAiCompatibleChat({ baseUrl, apiKey });
  const arms: EvalArmReport[] = [];
  for (const ladder of flags.strategy.map(splitLadder)) {
    const settings = buildEvalSettings(ladder, flags);
    let results: readonly EvalCaseResult[];
    try {
      results = await runEval(corpus, chat, settings);
    } catch (error) {
      if (error instanceof SchemaInspectError) failEval(error.message);
      throw error;
    }
    arms.push({ settings, results });
  }
  const report = {
    name: corpus.manifest.name,
    backend: flags.backend,
    model: flags.model,
    arms,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const evalHelp = [
  "Exit codes:",
  "  0  the run finished and its report is on stdout (a case that failed is a measurement, not a fault)",
  "  2  the command could not run: a usage error, an unreadable corpus, an invalid setting, or a missing credential",
  "",
  "Environment (secrets never ride flags):",
  `  ${BASE_URL_VARIABLE}   the endpoint's base URL, without the trailing /chat/completions`,
  `                     (default: ${DEFAULT_BASE_URL})`,
  `  ${API_KEY_VARIABLE}    the bearer credential — required`,
  "",
  "Arms:",
  "  --strategy names one arm; repeat it to measure more arms. A comma-separated value is that arm's",
  "  ordered fallback ladder: --strategy single-shot,per-group runs per-group only when single-shot",
  "  fails terminally.",
  "",
  "Settings:",
  "  Every flag below is optional, and an absent flag means the strategies' own default stands.",
  "  --consensus runs the whole arm as N candidates on the same backend and model.",
  "",
  "Examples:",
  "  ribo eval --corpus ./corpora/workshop --backend openai-compatible --model gpt-4o --strategy single-shot",
  "  ribo eval --corpus ./corpora/workshop --backend openai-compatible --model gpt-4o \\",
  "      --strategy single-shot,per-group --consensus 3 --out ./runs",
  "",
  "The report's shape is provisional: the scored contract lands with the run records.",
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

const evalCommand = program
  .command("eval")
  .description("Run a corpus through the eval runner and report what every case produced")
  .addOption(new Option("--corpus <dir>", "the corpus directory to run over").makeOptionMandatory())
  .addOption(
    new Option("--backend <name>", "the backend to run against")
      .choices([...EVAL_BACKENDS])
      .makeOptionMandatory(),
  )
  .addOption(new Option("--model <id>", "the model id every call carries").makeOptionMandatory())
  .option(
    "--strategy <ids>",
    "the strategy, or the comma-separated ladder, one arm measures; repeat it for more arms",
    collectStrategy,
    [],
  )
  .option(
    "--out <dir>",
    "the records directory the run record will be written to (this build writes nothing yet)",
  )
  .option(
    "--consensus <n>",
    "the consensus modifier's candidate count (an integer of at least two)",
  )
  .option(
    "--consensus-arbiter <policy>",
    "the consensus policy: unanimous (the default) or majority",
  )
  .option(
    "--max-retries <n>",
    "the retry budget per call, for the strategies that have one",
    parseThreshold,
  )
  .option("--response-cap <n>", "the cap on generated tokens per call", parseCap)
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
  .addHelpText("after", evalHelp)
  .action(runEvalCommand);

// Every diagnostic this command writes — its own refusals and commander's
// usage errors alike — names the command.
evalCommand.showHelpAfterError("run 'ribo eval --help' for the command's flags and exit codes.");
evalCommand.configureOutput({ writeErr: writeEvalErr });

// Commander's parse() reads process.argv by default. Exit codes are the
// command's own: 0 from run(), 1 from the threshold-breach path, 2 from
// fail() and from the exitOverride remap of every usage error. The eval
// command's action is asynchronous, so the program is parsed asynchronously —
// an unhandled rejection would exit 1 and break the two-code discipline.
await program.parseAsync();
