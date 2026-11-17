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
 * only through the loader, and the report goes to stdout. Each arm's run is
 * scored and persisted as a run record — under `./ribo-eval-runs/` beside the
 * working directory, or the directory `--out` names — and the report is
 * written only once every arm's record has landed. A multi-arm run emits a
 * cross-arm comparison summary on stderr, built from the same in-memory
 * records the run persisted and rendered by the same code `ribo compare`
 * renders with. It owns the same two exit codes the design fixes — 0
 * success, 2 could-not-run — and no third.
 *
 * The third command, `ribo compare`, lines two persisted run records up
 * (design §7): it reads exactly the two record files it is named — records
 * `ribo eval` wrote — compares them through the exported comparison, and
 * renders for humans by default or as the versioned `--json` contract. A difference is a finding,
 * never a failure; the refusals — differing corpora without the override,
 * no shared leaf, no shared case — are could-not-run faults. It owns the
 * two exit codes, and no third.
 *
 * The fourth command, `ribo corpus text`, prints the text each case's
 * prompt carries — transcript and text cases verbatim, document cases
 * transcribed through the same `transcribeDocumentCases` path `ribo eval`
 * uses — so a corpus writer can see what a model would see, with no model
 * call and no credential. It owns the same two exit codes: 0 success, 2
 * could-not-run (an unreadable corpus, an unknown case id, a document that
 * cannot be transcribed), and no third.
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
import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";

import type { CapableChatClient, ChatClient } from "@azx/ribo-core";

import { colorsFor } from "./colors.js";
import { loadCorpus } from "./corpus.js";
import { CORPUS_TEXT_CONTRACT_VERSION, collectCorpusText } from "./corpus/text.js";
import { cliBackendSupportsMaxTokens } from "./cli-chat.js";
import { preflightCliBackend } from "./cli-preflight.js";
import { asCapableChat } from "./eval/chat.js";
import {
  EVAL_BACKENDS,
  cliBackendNameFor,
  createCliBackendChat,
  createOpenAiCompatibleChat,
} from "./eval/backend.js";
import { transcribeDocumentCases } from "./eval/documents.js";
import { runEval } from "./eval/run.js";
import { scoreEvalRun } from "./eval/score.js";
import { buildEvalRunRecord } from "./eval/record-build.js";
import { compareEvalRunRecords } from "./eval/compare.js";
import { renderCompareReport } from "./eval/render-compare.js";
import type { EvalRunRecord, EvalRunRecordDraft } from "./eval/record-schema.js";
import { EvalRunRecordSchema } from "./eval/record-schema.js";
import { EVAL_RUN_RECORDS_DEFAULT_DIR, writeEvalRunRecord } from "./eval/record-store.js";
import { enforceSpendCeiling } from "./eval/spend-ceiling.js";
import { formatSpendEstimate } from "./eval/spend-display.js";
import { terminalConfirmation } from "./eval/spend-prompt.js";
import { DEFAULT_MAX_SPEND_USD, estimateSpend } from "./eval/spend-guard.js";
import { lookupSecret } from "./eval/secrets.js";
import { validateEvalSettings } from "./eval/settings.js";
import type { EvalCliBackend, EvalBackendName } from "./eval/backend.js";
import type {
  EvalCaseResult,
  EvalConsensusArbiter,
  EvalSettings,
  EvalStrategyId,
} from "./eval/types.js";
import type { EvalScoreTotals } from "./eval/score-types.js";
import { inspectSchema, SchemaInspectError } from "./inspect-schema.js";
import type { ThresholdRow } from "./inspect/report-schema.js";
import { InputFault, readDocumentSource } from "./read-input.js";
import { renderHumanReport } from "./render-human.js";

/**
 * The docs site's CLI section — the pointer every command's help ends with,
 * for the formats the help does not spell out. The package's README covers
 * the same ground for a reader with only the installed tarball.
 */
const DOCS_URL = "https://ribo-docs.azx.helix.azxlabs.io/cli";

/** The root help's docs pointer. */
const rootDocsPointer =
  `Docs: ${DOCS_URL}/index.html — the CLI's overview, install and the ` +
  "documents-to-scores walkthrough; the package's README covers the same ground.";

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

/** Reports a could-not-run fault of the compare command and exits 2. Stdout stays empty. */
function failCompare(message: string): never {
  failWith("ribo compare", message);
}

/** Reports a could-not-run fault of the corpus text command and exits 2. Stdout stays empty. */
function failCorpusText(message: string): never {
  failWith("ribo corpus text", message);
}

/**
 * Write a diagnostic of the corpus text command under its name — every
 * diagnostic line a run of `ribo corpus text` produces names the command,
 * whichever layer produced it, the pattern the eval command's
 * `writeEvalErr` sets.
 */
function writeCorpusTextErr(text: string): void {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    process.stderr.write(`ribo corpus text: ${line}\n`);
  }
}

/**
 * Write a diagnostic of the compare command under its name, the pattern the
 * eval command's `writeEvalErr` sets: every diagnostic line a run of `ribo
 * compare` produces names the command, whichever layer produced it.
 */
function writeCompareErr(text: string): void {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    process.stderr.write(`ribo compare: ${line}\n`);
  }
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

/**
 * A spend ceiling is a non-negative dollar amount: digits, optionally with a
 * decimal part. Anything else — a negative amount, an exponent, a currency
 * symbol, a word — is a usage error, named after the flag.
 */
const parseSpend = (value: string): number => {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new InvalidArgumentError(`expected a non-negative dollar amount, but got "${value}"`);
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

/** Is this flag value one of the CLI backends — the ones that need no credential? */
function isCliBackend(backend: string): backend is EvalCliBackend {
  return backend === "claude-cli" || backend === "codex-cli";
}

/**
 * The backend the flag names.
 *
 * Commander's own choices validation has already refused anything else; this
 * narrows the flag's string to the three accepted values, so a backend is
 * never silently narrowed to a default.
 */
function evalBackendOf(value: string): EvalBackendName {
  if ((EVAL_BACKENDS as readonly string[]).includes(value)) return value as EvalBackendName;
  failEval(
    `unknown backend "${value}" — the accepted backends are ${EVAL_BACKENDS.join(", ")} ` +
      "(fix: pass --backend openai-compatible, --backend claude-cli or --backend codex-cli)",
  );
}

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
  readonly maxSpend?: number;
  readonly yes?: boolean;
}

/** One arm's report: the settings it ran under, and one result per case. */
interface EvalArmReport {
  readonly settings: EvalSettings;
  readonly results: readonly EvalCaseResult[];
  /** The run fingerprint — over the schema and the prompt, never the settings. */
  readonly fingerprint: string;
  /** The arm's scored totals. */
  readonly totals: EvalScoreTotals;
  /** The path of the record the arm's run was written to. */
  readonly record: string;
  /** The arm's record draft, kept for the cross-arm summary. Not in the stdout report. */
  readonly draft: EvalRunRecordDraft;
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
 * Run the eval command: load the corpus, build the backend, price the run,
 * and run every arm the `--strategy` occurrences named.
 *
 * The corpus enters only through the loader, and every refusal the loader,
 * the runner, the settings validation and the spend guard raise is a
 * `SchemaInspectError` — the could-not-run class — so one catch maps them
 * all to exit 2 with the diagnostic naming the cause. The report is written
 * only once every arm has finished, so a refusal on the last arm leaves
 * stdout empty.
 *
 * The order is fixed: the preflight (a missing binary is a missing binary,
 * never a spend refusal), then the corpus, then the settings, then the
 * document cases' transcription (free and local, once per run, shared by
 * every arm — a document that cannot be transcribed refuses the run here,
 * before any model call), then the credential, then the estimate — printed
 * before any model call and priced over the transcribed text — and only
 * then the run.
 */
async function runEvalCommand(flags: EvalFlags): Promise<void> {
  if (flags.strategy.length === 0) {
    failEval(
      "the run needs at least one --strategy: name the strategy, or the ladder, the arm should try " +
        "(fix: pass --strategy single-shot, or --strategy single-shot,per-group for a ladder)",
    );
  }
  const backend = evalBackendOf(flags.backend);
  // A cap the backend cannot honour is a usage error knowable before
  // anything runs, so it is refused FIRST — before the preflight, the
  // corpus load and any model call. The capability is the transport
  // descriptor's own field, the same one cliChat's refusal of a maxTokens
  // request reads, never a second hard-coded list.
  if (flags.responseCap !== undefined && isCliBackend(backend)) {
    if (!cliBackendSupportsMaxTokens(cliBackendNameFor(backend))) {
      failEval(
        `--response-cap is not supported on the ${backend} backend — a CLI cannot cap ` +
          "generated tokens (fix: drop --response-cap, or run against --backend " +
          "openai-compatible, which honours the cap)",
      );
    }
  }
  // The preflight runs BEFORE planning: a missing binary is reported as a
  // missing binary, never as a corpus fault or a spend refusal. The
  // openai-compatible backend has no binary to check, so it skips this.
  if (isCliBackend(backend)) {
    try {
      await preflightCliBackend(cliBackendNameFor(backend));
    } catch (error) {
      if (error instanceof SchemaInspectError) failEval(error.message);
      throw error;
    }
  }
  let corpus;
  try {
    corpus = loadCorpus(flags.corpus);
  } catch (error) {
    if (error instanceof SchemaInspectError) failEval(error.message);
    throw error;
  }
  // Every arm's settings are built up front: the guard prices the whole run,
  // and an invalid setting is refused before anything is priced.
  const settings = flags.strategy.map((ladder) => buildEvalSettings(splitLadder(ladder), flags));
  for (const arm of settings) {
    try {
      validateEvalSettings(arm);
    } catch (error) {
      if (error instanceof SchemaInspectError) failEval(error.message);
      throw error;
    }
  }
  // The document cases' transcription: once per run, before the estimate and
  // before any model call, shared by every arm. A document with no text
  // layer, or one pdf.js cannot open, refuses the whole run here — exit 2,
  // naming the case and the reason.
  let documents;
  try {
    documents = await transcribeDocumentCases(corpus);
  } catch (error) {
    if (error instanceof SchemaInspectError) failEval(error.message);
    throw error;
  }
  // The CLI backends carry no credential and no endpoint: they spawn the
  // operator's own installed binary. The engine id is the flag's own value,
  // so every case's usage names the transport that produced it.
  let chat: ChatClient | CapableChatClient;
  if (isCliBackend(backend)) {
    chat = asCapableChat(createCliBackendChat(backend), backend);
  } else {
    // The credential comes from the environment, or from the working
    // directory's gitignored `.env.local`; the environment wins. The refusal
    // names the key and both places the CLI looked.
    const secret = lookupSecret(API_KEY_VARIABLE);
    if (secret.value === undefined) {
      failEval(
        `the ${API_KEY_VARIABLE} credential is not set — the backend needs one, and secrets never ` +
          `ride flags. The CLI looked in the environment and in the file ${secret.filePath} ` +
          `(fix: export ${API_KEY_VARIABLE}, or put ${API_KEY_VARIABLE}=<key> in that file)`,
      );
    }
    const baseUrl = process.env[BASE_URL_VARIABLE] ?? DEFAULT_BASE_URL;
    chat = createOpenAiCompatibleChat({ baseUrl, apiKey: secret.value });
  }
  // The spend guard: the estimate is printed before any model call, and a run
  // over the ceiling is refused before any model call. A bound the call model
  // cannot state refuses here too, and no flag overrides that one.
  let estimate;
  try {
    estimate = estimateSpend({ corpus, arms: settings, backend, model: flags.model, documents });
  } catch (error) {
    if (error instanceof SchemaInspectError) failEval(error.message);
    throw error;
  }
  writeEvalErr(formatSpendEstimate(estimate, colorsFor(process.stderr)).join("\n"));
  const confirmation = terminalConfirmation({ input: process.stdin, output: process.stderr });
  try {
    await enforceSpendCeiling({
      estimate,
      maxSpendUsd: flags.maxSpend ?? DEFAULT_MAX_SPEND_USD,
      yes: flags.yes === true,
      ...(confirmation === undefined ? {} : { confirmation }),
    });
  } catch (error) {
    if (error instanceof SchemaInspectError) failEval(error.message);
    throw error;
  }
  const arms: EvalArmReport[] = [];
  // The records directory is the one the run writes to and every freshness
  // read looks in: the `--out` directory, or the run's own under the cwd.
  const recordsDir = flags.out ?? EVAL_RUN_RECORDS_DEFAULT_DIR;
  for (const arm of settings) {
    let results: readonly EvalCaseResult[];
    try {
      results = await runEval(corpus, chat, arm, { documents });
    } catch (error) {
      if (error instanceof SchemaInspectError) failEval(error.message);
      throw error;
    }
    // The record is the source of truth every view renders: the score is
    // persisted before the report is written, and a record that cannot be
    // written is a could-not-run fault, not a report with a hole in it.
    let record: string;
    let fingerprint: string;
    let totals: EvalScoreTotals;
    let draft: EvalRunRecordDraft;
    try {
      const score = scoreEvalRun(corpus, results);
      draft = buildEvalRunRecord({
        corpus,
        backend,
        settings: arm,
        results,
        score,
      });
      record = writeEvalRunRecord(draft, recordsDir);
      fingerprint = draft.fingerprint;
      totals = draft.totals;
    } catch (error) {
      if (error instanceof SchemaInspectError) failEval(error.message);
      throw error;
    }
    arms.push({ settings: arm, results, fingerprint, totals, record, draft });
  }
  if (arms.length > 1) writeCrossArmSummary(arms);
  // The stdout report keeps the shape T9b shipped — the draft travels to the
  // summary only, never into the JSON a reader consumes as data.
  const report = {
    name: corpus.manifest.name,
    backend: flags.backend,
    model: flags.model,
    arms: arms.map((entry) => ({
      settings: entry.settings,
      results: entry.results,
      fingerprint: entry.fingerprint,
      totals: entry.totals,
      record: entry.record,
    })),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Write the multi-arm run's cross-arm comparison summary to stderr.
 *
 * The summary is computed from the in-memory per-arm record drafts the run
 * already built — never by re-reading the records directory, never by
 * re-scoring — through the same exported comparison `ribo compare` uses.
 * Every arm of one run shares the corpus fingerprint, the run fingerprint,
 * the backend and the model, so the comparison's refusal paths cannot fire
 * here, and none is handled defensively. The stdout report stays the JSON
 * the readers consume; stderr is where the command already addresses a
 * human mid-run.
 *
 * N arms are summarised as the first arm (the baseline) compared against
 * each subsequent arm, in one block per pair — the common two-arm case is
 * exactly one comparison, and no pair repeats.
 * @param arms - The run's arms, in flag order.
 */
function writeCrossArmSummary(arms: readonly EvalArmReport[]): void {
  const pc = colorsFor(process.stderr);
  const lines = ["ribo eval: cross-arm comparison — arm 1 against each later arm"];
  for (let i = 1; i < arms.length; i++) {
    const baseline = arms[0]!;
    const challenger = arms[i]!;
    const comparison = compareEvalRunRecords(baseline.draft, challenger.draft);
    lines.push("");
    lines.push(
      `arm 1 (${baseline.settings.strategies.join(",")}) vs arm ${i + 1} ` +
        `(${challenger.settings.strategies.join(",")})`,
    );
    lines.push(renderCompareReport(comparison, pc));
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

const evalHelp = [
  "Exit codes:",
  "  0  the run finished and its report is on stdout (a case that failed is a measurement, not a fault)",
  "  2  the command could not run: a usage error, an unreadable corpus, an invalid setting, a missing",
  "     credential (openai-compatible only), a missing or non-answering CLI binary, or a refused spend",
  "",
  "Backends:",
  "  --backend names the transport the run measures against:",
  "    openai-compatible  an OpenAI-compatible /chat/completions endpoint (needs a credential)",
  "    claude-cli         the installed claude CLI, under your own login (no key needed)",
  "    codex-cli          the installed codex CLI, under your own login (no key needed)",
  "  The two CLI backends spawn the binary you have installed and preflight it with",
  "  `<binary> --version` before the run starts, so a missing binary is reported up front.",
  "",
  "Environment (secrets never ride flags):",
  `  ${BASE_URL_VARIABLE}   the endpoint's base URL, without the trailing /chat/completions`,
  `                     (default: ${DEFAULT_BASE_URL})`,
  `  ${API_KEY_VARIABLE}    the bearer credential — required by openai-compatible only. Read from`,
  "                     the environment first, then from .env.local in the working directory",
  "                     (the environment wins; the file is gitignored and never created).",
  "",
  "Arms:",
  "  --strategy names one arm; repeat it to measure more arms. A comma-separated value is that arm's",
  "  ordered fallback ladder: --strategy single-shot,per-group runs per-group only when single-shot",
  "  fails terminally. A run with more than one arm prints a cross-arm comparison summary to stderr,",
  "  the first arm against each later arm; the stdout report is unchanged.",
  "",
  "Spend:",
  "  Every run prints an upper-bound cost estimate to stderr before the first model call, and",
  "  refuses the run — exit 2 — when the estimate is above the ceiling.",
  `  --max-spend <usd>   the ceiling on the estimated spend (default: USD ${DEFAULT_MAX_SPEND_USD.toFixed(2)})`,
  "  --yes               proceed even when the estimate is above the ceiling",
  "  The estimate prices the run's --model: a model with its own dated row in the price table is",
  "  priced on that row, and the estimate names it; any other model is priced on the backend's",
  "  reference row, and the estimate says it fell back and names the reference it used. Rows",
  "  exist for the models the examples and docs mention (gpt-4o, claude-sonnet-5-5, claude-haiku-5-5).",
  "",
  "Settings:",
  "  Every flag below is optional, and an absent flag means the strategies' own default stands.",
  "  --consensus runs the whole arm as N candidates on the same backend and model.",
  "  --response-cap caps the tokens a call may generate. The CLI backends cannot cap generated",
  "  tokens — a CLI has no wire-level keyword for it — so --response-cap with --backend claude-cli",
  "  or --backend codex-cli is refused up front, before the preflight: drop the flag, or run",
  "  against --backend openai-compatible, which honours it.",
  "",
  "Examples:",
  "  ribo eval --corpus ./corpora/workshop --backend openai-compatible --model gpt-4o --strategy single-shot",
  "  ribo eval --corpus ./corpora/workshop --backend openai-compatible --model gpt-4o \\",
  "      --strategy single-shot,per-group --consensus 3 --out ./runs",
  "  ribo eval --corpus ./corpora/workshop --backend claude-cli --model claude-haiku-5-5 --strategy per-group",
].join("\n");

const program = new Command()
  .name("ribo")
  .description("Ribo's command-line tools (ADR 0037)")
  .addHelpText("after", rootDocsPointer)
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

const schema = program
  .command("schema")
  .description("Sizing checks over a JSON Schema document")
  .addHelpText(
    "after",
    `Docs: ${DOCS_URL}/schema.html — the schema dialect the subcommand reads, and what each report line means.`,
  );

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
  .addHelpText(
    "after",
    `Docs: ${DOCS_URL}/schema.html — the schema dialect this command reads, and what each report line means.`,
  )
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
    `the records directory the run records will be written to (default: ./${EVAL_RUN_RECORDS_DEFAULT_DIR} under the current directory)`,
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
  .option(
    "--max-spend <usd>",
    `the ceiling on the estimated spend, in US dollars (default: USD ${DEFAULT_MAX_SPEND_USD.toFixed(2)})`,
    parseSpend,
  )
  .option("--yes", "proceed even when the estimate is above the ceiling")
  .addHelpText("after", evalHelp)
  .addHelpText(
    "after",
    [
      `Docs: the corpus format — ${DOCS_URL}/corpus.html`,
      `      the verdicts and the run record — ${DOCS_URL}/scoring.html`,
      `      the estimate and --max-spend — ${DOCS_URL}/spend.html`,
    ].join("\n"),
  )
  .action(runEvalCommand);

// Every diagnostic this command writes — its own refusals and commander's
// usage errors alike — names the command.
evalCommand.showHelpAfterError("run 'ribo eval --help' for the command's flags and exit codes.");
evalCommand.configureOutput({ writeErr: writeEvalErr });

// --- `ribo compare` ------------------------------------------------------------------

/** The flags the compare command parses. */
interface CompareFlags {
  readonly json?: boolean;
  readonly allowCorpusMismatch?: boolean;
}

/**
 * Read and parse one run record file.
 *
 * The files are read left to right and the first fault is the one reported:
 * the caller reads the left record before the right. A missing path, a
 * directory and a non-JSON file are all "could not be read"; a file holding
 * valid JSON that fails the record schema names the schema issues, the
 * pattern the store's malformed-record message sets. Every refusal exits 2
 * with stdout empty.
 * @param file - The path of the record file.
 * @returns The parsed record.
 */
function readRecord(file: string): EvalRunRecord {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    failCompare(
      `the run record "${file}" could not be read: ${error instanceof Error ? error.message : String(error)} ` +
        "(fix: pass the path of a record `ribo eval` wrote — a .json file, not a directory)",
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch (error) {
    failCompare(
      `the run record "${file}" could not be read: it is not valid JSON — ` +
        `${error instanceof Error ? error.message : String(error)} ` +
        "(fix: pass the path of a record `ribo eval` wrote)",
    );
  }
  const parsed = EvalRunRecordSchema.safeParse(document);
  if (!parsed.success) {
    failCompare(
      `the run record "${file}" is not a valid run record: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")} (fix: pass the path of a record ` +
        "`ribo eval` wrote, or delete or repair this one)",
    );
  }
  return parsed.data;
}

/**
 * Run the compare command: read the two records, compare them, render.
 *
 * The comparison itself touches nothing but the two parsed records — no
 * corpus, no schema, no re-walk of the field inventory — so a difference is
 * a finding and the exit is 0; only the comparison's own refusals (differing
 * corpora without the override, no shared leaf, no shared case) exit 2.
 * @param a - The left record's path.
 * @param b - The right record's path.
 * @param flags - The parsed flags.
 */
function runCompare(a: string, b: string, flags: CompareFlags): void {
  const left = readRecord(a);
  const right = readRecord(b);
  let report;
  try {
    report = compareEvalRunRecords(left, right, {
      allowCorpusMismatch: flags.allowCorpusMismatch === true,
    });
  } catch (error) {
    if (error instanceof SchemaInspectError) failCompare(error.message);
    throw error;
  }
  process.stdout.write(
    flags.json === true
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderCompareReport(report, colorsFor(process.stdout)),
  );
}

const compareHelp = [
  "Exit codes:",
  "  0  the comparison was computed — a difference is a finding, not a failure",
  "  2  the command could not run: a usage error; an unreadable or malformed record file; differing",
  "     corpus fingerprints without the override flag; no shared leaf — and, under the override, no",
  "     shared case",
  "",
  "What is compared:",
  "  The two records' identities (backend, model, settings, run fingerprint) are reported as axes,",
  "  never refused and never silently equated. Leaves align on the intersection, with each side's",
  "  exclusion counts printed, so a reader sees how much of each side the comparison did not cover.",
  "",
  "Examples:",
  "  ribo compare ./ribo-eval-runs/20261114T1000-ab12cd34ef56.json ./ribo-eval-runs/20261114T1010-ab12cd34ef56.json",
  "  ribo compare --json a.json b.json",
  "  ribo compare --allow-corpus-mismatch old-corpus-record.json new-corpus-record.json",
].join("\n");

const compareCommand = program
  .command("compare")
  .description("Compare two persisted eval run records and report their axes and differences")
  .argument("<a>", "path to the left run record file")
  .argument("<b>", "path to the right run record file")
  .option("--json", "emit the versioned JSON contract instead of the human rendering")
  .option(
    "--allow-corpus-mismatch",
    "allow comparing records whose corpus fingerprints differ, and record that the override was passed",
  )
  .addHelpText("after", compareHelp)
  .addHelpText(
    "after",
    `Docs: ${DOCS_URL}/scoring.html — the run record, the axes and the intersection rule.`,
  )
  .action(runCompare);

// Every diagnostic this command writes — its own refusals and commander's
// usage errors alike — names the command.
compareCommand
  .showHelpAfterError("run 'ribo compare --help' for the command's flags and exit codes.")
  .configureOutput({ writeErr: writeCompareErr });

// --- `ribo corpus` -------------------------------------------------------------------

/** The flags the corpus text command parses. */
interface CorpusTextFlags {
  readonly json?: boolean;
}

/** The text with exactly one trailing newline, for printing. */
const printable = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);

/**
 * Run the corpus text command: load the corpus, collect each selected case's
 * text, print.
 *
 * Every refusal the loader, the selection and the transcription raise is the
 * package's could-not-run class, so one catch maps them all to exit 2 with
 * the diagnostic naming the cause. No model call is made and no credential
 * is read — the document path is pdf.js, local and free.
 * @param corpusDir - The corpus directory to read.
 * @param caseId - The one case to print, or every case when absent.
 * @param flags - The parsed flags.
 */
async function runCorpusText(
  corpusDir: string,
  caseId: string | undefined,
  flags: CorpusTextFlags,
): Promise<void> {
  let corpus;
  try {
    corpus = loadCorpus(corpusDir);
  } catch (error) {
    if (error instanceof SchemaInspectError) failCorpusText(error.message);
    throw error;
  }
  let text;
  try {
    text = await collectCorpusText(corpus, caseId);
  } catch (error) {
    if (error instanceof SchemaInspectError) failCorpusText(error.message);
    throw error;
  }
  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          contractVersion: CORPUS_TEXT_CONTRACT_VERSION,
          corpus: text.corpus,
          cases: text.cases,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  // One case reads as its text alone — pipeable, no header. Many cases read
  // under a per-case header naming the case and its kind.
  const only = text.cases.length === 1 ? text.cases[0] : undefined;
  if (only !== undefined) {
    process.stdout.write(printable(only.text));
    return;
  }
  const blocks = text.cases.map(
    (entry) => `== ${entry.caseId} (${entry.kind}) ==\n${printable(entry.text)}`,
  );
  process.stdout.write(blocks.join("\n"));
}

const corpusTextHelp = [
  "Exit codes:",
  "  0  the text was printed",
  "  2  the command could not run: a usage error, an unreadable corpus, an unknown case id,",
  "     or a document that cannot be transcribed (no text layer, or bytes pdf.js cannot open)",
  "",
  "What it prints:",
  "  The text each case's prompt carries: transcript and text cases verbatim, document cases",
  "  transcribed through the same path `ribo eval` uses. With a case id, that case alone,",
  "  without a header; without one, every case under a per-case header. No model call is made",
  "  and no credential is needed — transcription is local.",
  "",
  "Examples:",
  "  ribo corpus text ./corpora/workshop",
  "  ribo corpus text ./corpora/workshop service-sheet",
  "  ribo corpus text --json ./corpora/workshop",
].join("\n");

const corpusCommand = program
  .command("corpus")
  .description("Read a corpus directory without spending: see what a run would send")
  .addHelpText("after", `Docs: ${DOCS_URL}/corpus.html — the corpus format the subcommand reads.`);

const corpusTextCommand = corpusCommand
  .command("text")
  .description(
    "Print the text each case's prompt carries — transcript and text cases verbatim, document " +
      "cases transcribed exactly as `ribo eval` transcribes them",
  )
  .argument("<corpus-dir>", "the corpus directory to read")
  .argument("[case-id]", "print this case alone, without a header")
  .option("--json", "emit the versioned JSON document of {caseId, kind, text} entries")
  .addHelpText("after", corpusTextHelp)
  .addHelpText("after", `Docs: ${DOCS_URL}/corpus.html — the corpus format this command reads.`)
  .action(runCorpusText);

// Every diagnostic this command writes — its own refusals and commander's
// usage errors alike — names the command.
corpusTextCommand
  .showHelpAfterError("run 'ribo corpus text --help' for the command's arguments and exit codes.")
  .configureOutput({ writeErr: writeCorpusTextErr });

// Commander's parse() reads process.argv by default. Exit codes are the
// command's own: 0 from run(), 1 from the threshold-breach path, 2 from
// fail() and from the exitOverride remap of every usage error. The eval
// command's action is asynchronous, so the program is parsed asynchronously —
// an unhandled rejection would exit 1 and break the two-code discipline.
await program.parseAsync();
