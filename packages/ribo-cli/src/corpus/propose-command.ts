/**
 * @file The `ribo corpus propose` command: a corpus's unanswered leaves in,
 * pending expected-answer proposals written into each case.json, additively
 * and atomically (ADR 0049).
 *
 * The runner is injectable in the style of `schema-init/command.ts`: every
 * external effect — corpus loading, backend preparation, the spend estimate,
 * the ceiling, confirmation, retry delay, clock, streams and the write
 * filesystem — is a dependency, and the Commander shell only parses and maps
 * faults to exit 2.
 *
 * The order is the priced one: flag checks, corpus load, case selection
 * BEFORE document transcription (as `corpus/text.ts` does), unanswered-leaf
 * computation honouring `--only`, per-case estimates summed and printed,
 * the ceiling, backend preparation, then one proposal round per case, each
 * written as soon as it validates. No request is made before the ceiling
 * passes; a run with no work at all prepares no backend and makes no call.
 */
import process from "node:process";
import { resolve as resolvePath } from "node:path";

import { InvalidArgumentError, Option } from "commander";
import type { Command } from "commander";

import { retryAsync } from "@azx/ribo-core";
import type { ChatClient, ChatRequest } from "@azx/ribo-core";

import { colorsFor } from "../colors.js";
import { cliBackendSupportsMaxTokens } from "../cli-chat.js";
import { caseInputsOf, caseTextOf } from "../eval/case-text.js";
import type { CaseInputText } from "../eval/case-text.js";
import { transcribeDocumentCases } from "../eval/documents.js";
import { terminalConfirmation } from "../eval/spend-prompt.js";
import {
  AUTHORING_CLI_SHAPE_ATTEMPTS,
  OPERATOR_BACKENDS,
  cliBackendNameFor,
  isOperatorCliBackend,
  prepareOperatorBackend,
} from "../operator/backend.js";
import type { OperatorBackendName } from "../operator/backend.js";
import { OperatorError } from "../operator/error.js";
import {
  DEFAULT_COMPLETION_TOKENS,
  DEFAULT_MAX_SPEND_USD,
  enforceOperatorSpendCeiling,
  estimateFixedCallSpend,
  formatFixedCallSpendTotal,
  sumFixedCallSpendEstimates,
} from "../operator/spend.js";
import type { SpendConfirmation } from "../operator/spend.js";
import { writeCaseExpected } from "./case-write.js";
import type { CaseWriteFs } from "./case-write.js";
import { CorpusError } from "./error.js";
import { resolveExpectation, scopeCovers } from "./expectations.js";
import { loadCorpus } from "./loader.js";
import type { LoadedCase, LoadedCorpus } from "./loader.js";
import { proposeCase, proposePromptLeaves, PROPOSE_REPAIRS } from "./propose.js";
import {
  PROPOSE_REPAIR_PROBLEM_CHARS,
  PROPOSE_REPAIR_PROBLEMS_MAX,
  initialProposePrompt,
  repairProposePrompt,
} from "./propose-prompt.js";

const COMMAND = "ribo corpus propose";
const NETWORK_RETRIES = 2;

/**
 * The version of the stdout document the command emits: a `contractVersion`
 * literal the CLI owns, bumped when a field's name or meaning changes — the
 * discipline `ribo corpus text`'s contract sets.
 */
export const CORPUS_PROPOSE_CONTRACT_VERSION = 1;

/** One asked leaf the run could not or did not answer, with the reason why. */
export interface ProposeReportUnproposed {
  readonly path: string;
  readonly reason: string;
}

/** One case's outcome in the versioned stdout report. */
export interface ProposeCaseReport {
  readonly caseId: string;
  /** `proposed` (a parsed round completed), `nothing-to-propose`, or `failed`. */
  readonly outcome: "proposed" | "nothing-to-propose" | "failed";
  /** The leaf paths whose pending entries THIS run wrote, in engine order. */
  readonly proposed: readonly string[];
  /** The asked leaves left unanswered, each with its reason. */
  readonly unproposed: readonly ProposeReportUnproposed[];
  /** Present only for a failed case: why no parsed round completed. */
  readonly reason?: string;
}

/** The versioned stdout document: one entry per selected case, in corpus order. */
export interface ProposeReport {
  readonly contractVersion: typeof CORPUS_PROPOSE_CONTRACT_VERSION;
  readonly corpus: string;
  readonly cases: readonly ProposeCaseReport[];
}

/** A report entry while the run is still filling it in. */
type MutableCaseReport = {
  -readonly [K in keyof ProposeCaseReport]: ProposeCaseReport[K];
};

export interface ProposeFlags {
  readonly backend: OperatorBackendName;
  readonly model: string;
  /** Repeatable: the asked leaves are those at least one scope covers. */
  readonly only?: readonly string[];
  readonly responseCap?: number;
  readonly timeout?: number;
  readonly maxSpend?: number;
  readonly yes?: boolean;
}

interface CommandOutputStream extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface ProposeRunDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: CommandOutputStream;
  readonly stderr?: CommandOutputStream;
  readonly loadCorpus?: typeof loadCorpus;
  readonly prepareBackend?: typeof prepareOperatorBackend;
  readonly estimateSpend?: typeof estimateFixedCallSpend;
  readonly sumSpend?: typeof sumFixedCallSpendEstimates;
  readonly enforceCeiling?: typeof enforceOperatorSpendCeiling;
  /** Null disables terminal prompting; absence derives it from the injected streams. */
  readonly confirmation?: SpendConfirmation | null;
  readonly retryDelay?: (ms: number) => Promise<void>;
  readonly clock?: () => Date;
  readonly writeFs?: CaseWriteFs;
}

const parseResponseCap = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError(`expected a positive integer, but got "${value}"`);
  }
  return Number(value);
};

const parseTimeout = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError(
      `expected a positive integer number of seconds, but got "${value}"`,
    );
  }
  return Number(value);
};

const parseSpend = (value: string): number => {
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new InvalidArgumentError(`expected a non-negative dollar amount, but got "${value}"`);
  }
  return Number(value);
};

/** `--only` is repeatable: each occurrence adds one scope, in order. */
const collectOnly = (value: string, previous: readonly string[]): readonly string[] => [
  ...previous,
  value,
];

function writeDiagnostic(stream: CommandOutputStream, text: string): void {
  for (const line of text.split("\n")) {
    if (line.length > 0) stream.write(`${COMMAND}: ${line}\n`);
  }
}

/** The same flag refusals schema init makes, worded the same way. */
const validateFlags = (flags: ProposeFlags): void => {
  if (flags.responseCap !== undefined && isOperatorCliBackend(flags.backend)) {
    if (!cliBackendSupportsMaxTokens(cliBackendNameFor(flags.backend))) {
      throw new OperatorError(
        `--response-cap is not supported on the ${flags.backend} backend — a CLI cannot cap ` +
          "generated tokens (fix: drop --response-cap, or use --backend openai-compatible)",
      );
    }
  }
  if (flags.timeout !== undefined && !isOperatorCliBackend(flags.backend)) {
    throw new OperatorError(
      `--timeout is not supported on the ${flags.backend} backend — the HTTP transport has no ` +
        "per-call timeout (fix: drop --timeout, or use --backend claude-cli or codex-cli)",
    );
  }
};

/**
 * Select cases: every case without ids; each named case once, in the loaded
 * corpus's order, with repeats collapsed. An unknown id is refused naming the
 * cases the corpus holds — the wording `corpus/text.ts` sets.
 */
const selectCases = (corpus: LoadedCorpus, caseIds: readonly string[]): readonly LoadedCase[] => {
  if (caseIds.length === 0) return corpus.cases;
  const byId = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  const selected: LoadedCase[] = [];
  for (const id of caseIds) {
    const found = byId.get(id);
    if (found === undefined) {
      throw new CorpusError(
        `the corpus "${corpus.manifest.name}" holds no case "${id}" — the cases it holds ` +
          `are: ${corpus.cases.map((entry) => entry.id).join(", ")} (fix: pass one of those ` +
          "ids, or no id to propose every case)",
      );
    }
    if (!selected.includes(found)) selected.push(found);
  }
  return selected;
};

/** The case's unanswered leaves, in inventory order, narrowed by the `--only` scopes. */
const askedLeavesOf = (
  corpus: LoadedCorpus,
  selected: LoadedCase,
  only: readonly string[],
): readonly string[] =>
  corpus.leafInventory
    .map((entry) => entry.path)
    .filter(
      (path, index, paths) =>
        // Inventory paths are unique; the guard keeps the filter honest if that changes.
        paths.indexOf(path) === index &&
        resolveExpectation(selected, path).origin === "none" &&
        (only.length === 0 || only.some((scope) => scopeCovers(scope, path))),
    );

function requestChars(request: ChatRequest): number {
  const messageChars = request.messages.reduce(
    (total, message) => total + message.content.length + 8,
    0,
  );
  return messageChars + JSON.stringify(request.responseFormat.json_schema.schema).length;
}

/**
 * The most one repair attempt's prompt can grow over the base, measured by
 * building the real repair request with the maximum number of problems, each
 * long enough to exercise the problem-characters truncation. The prior reply
 * is not an input — the repair prompt never quotes it — so the growth is
 * independent of the priced completion cap.
 */
function repairGrowthChars(base: ChatRequest): number {
  const problems = Array.from({ length: PROPOSE_REPAIR_PROBLEMS_MAX }, () =>
    `x`.repeat(PROPOSE_REPAIR_PROBLEM_CHARS + 1),
  );
  const repaired = repairProposePrompt(base, problems, 1);
  return Math.max(0, requestChars(repaired) - requestChars(base));
}

/** The transport policy schema init runs: two retries, and the priced reply cap wherever the transport can carry one. */
function withCallPolicy(
  chat: ChatClient,
  maxTokens: number | undefined,
  retryDelay: ((ms: number) => Promise<void>) | undefined,
): ChatClient {
  return {
    complete: (request, callOptions) =>
      retryAsync(
        () =>
          chat.complete(maxTokens === undefined ? request : { ...request, maxTokens }, callOptions),
        {
          maxRetries: NETWORK_RETRIES,
          ...(retryDelay === undefined ? {} : { delay: retryDelay }),
          ...(callOptions?.signal === undefined ? {} : { signal: callOptions.signal }),
        },
      ),
  };
}

/** One work case's prepared inputs: everything one proposal round needs. */
interface WorkCase {
  readonly selected: LoadedCase;
  readonly asked: readonly string[];
  readonly inputs: readonly CaseInputText[];
  readonly caseText: string;
}

/** The cheaper-fix advice the ceiling refusal names, selected by the backend. */
const cheaperFixFor = (backend: OperatorBackendName): string =>
  isOperatorCliBackend(backend)
    ? // A CLI cannot cap generated tokens, so the advice never names --response-cap.
      "name fewer case ids, or narrow the asked leaves with --only"
    : "name fewer case ids, narrow the asked leaves with --only, or lower --response-cap";

/** Run corpus proposing with transcription, spend, backend and write dependencies injectable. */
export async function runCorpusProposeCommand(
  corpusDir: string,
  caseIds: readonly string[],
  flags: ProposeFlags,
  dependencies: ProposeRunDependencies = {},
): Promise<ProposeReport> {
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  validateFlags(flags);

  const load = dependencies.loadCorpus ?? loadCorpus;
  const corpus = load(resolvePath(cwd, corpusDir));

  // Selection precedes transcription: an unknown id never spends pdf.js, and
  // a broken document in an unselected case never refuses a selected one.
  const selectedCases = selectCases(corpus, caseIds);
  const documents = await transcribeDocumentCases({ ...corpus, cases: selectedCases });

  const only = flags.only ?? [];
  const workCases: WorkCase[] = [];
  for (const selected of selectedCases) {
    const asked = askedLeavesOf(corpus, selected, only);
    if (asked.length === 0) continue;
    const inputs = caseInputsOf(selected, documents);
    workCases.push({
      selected,
      asked,
      inputs,
      caseText: caseTextOf(corpus, selected, documents),
    });
  }

  const completionTokens = flags.responseCap ?? DEFAULT_COMPLETION_TOKENS;
  const estimateSpend = dependencies.estimateSpend ?? estimateFixedCallSpend;
  const sumSpend = dependencies.sumSpend ?? sumFixedCallSpendEstimates;
  const estimates = workCases.map((work) => {
    const base = initialProposePrompt({
      model: flags.model,
      schemaDocument: corpus.schemaDocument,
      leaves: proposePromptLeaves(corpus.schema, corpus.leafInventory, work.asked),
      caseText: work.caseText,
    });
    return estimateSpend({
      backend: flags.backend,
      model: flags.model,
      budget: {
        initialCalls: 1,
        semanticRepairs: PROPOSE_REPAIRS,
        transportRetries: NETWORK_RETRIES,
        cliShapeAttempts: AUTHORING_CLI_SHAPE_ATTEMPTS,
      },
      promptChars: requestChars(base),
      promptGrowthCharsPerAttempt: repairGrowthChars(base),
      completionTokensPerCall: completionTokens,
    });
  });
  const total = sumSpend(estimates);
  writeDiagnostic(stderr, formatFixedCallSpendTotal(total, colorsFor(stderr)).join("\n"));

  const confirmation =
    dependencies.confirmation === null
      ? undefined
      : (dependencies.confirmation ??
        terminalConfirmation({
          input: dependencies.stdin ?? process.stdin,
          output: stderr,
        }));
  const enforceCeiling = dependencies.enforceCeiling ?? enforceOperatorSpendCeiling;
  await enforceCeiling({
    estimate: total,
    maxSpendUsd: flags.maxSpend ?? DEFAULT_MAX_SPEND_USD,
    yes: flags.yes === true,
    ...(confirmation === undefined ? {} : { confirmation }),
    ...(total.caseCount > 0 ? { cheaperFix: cheaperFixFor(flags.backend) } : {}),
  });

  const report: { cases: MutableCaseReport[] } = {
    cases: selectedCases.map((selected) => ({
      caseId: selected.id,
      outcome: "nothing-to-propose" as const,
      proposed: [],
      unproposed: [],
    })),
  };

  if (workCases.length > 0) {
    const prepare = dependencies.prepareBackend ?? prepareOperatorBackend;
    const prepared = await prepare({
      backend: flags.backend,
      requiredCalls: workCases.length,
      cwd,
      ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      ...(flags.timeout === undefined ? {} : { timeoutMs: flags.timeout * 1000 }),
    });
    if (prepared === undefined) {
      throw new OperatorError(
        "the corpus-propose backend returned no chat client for required work",
      );
    }
    // Every request carries the reply cap the estimate priced, wherever the
    // transport can carry one — the initial, the repair and every retry alike.
    const capsReplies =
      !isOperatorCliBackend(flags.backend) ||
      cliBackendSupportsMaxTokens(cliBackendNameFor(flags.backend));
    const chat = withCallPolicy(
      prepared,
      capsReplies ? completionTokens : undefined,
      dependencies.retryDelay,
    );

    const byId = new Map(report.cases.map((entry) => [entry.caseId, entry]));
    for (const work of workCases) {
      const outcome = byId.get(work.selected.id);
      if (outcome === undefined) {
        throw new OperatorError(
          `the case "${work.selected.id}" was selected but has no report entry to fill`,
        );
      }
      let result;
      try {
        result = await proposeCase({
          schema: corpus.schema,
          leafInventory: corpus.leafInventory,
          unanswered: work.asked,
          inputs: work.inputs,
          caseText: work.caseText,
          schemaDocument: corpus.schemaDocument,
          options: {
            chat,
            model: flags.model,
            backend: flags.backend,
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
          },
        });
      } catch (error) {
        // The case's model/transport round threw — that case failed; the
        // run reports it and carries on with the remaining cases.
        const message = error instanceof Error ? error.message : String(error);
        outcome.outcome = "failed";
        outcome.reason = message;
        outcome.unproposed = work.asked.map((path) => ({ path, reason: message }));
        continue;
      }
      if (!result.success) {
        outcome.outcome = "failed";
        outcome.reason = result.reason;
        outcome.unproposed = work.asked.map((path) => ({ path, reason: result.reason }));
        continue;
      }
      const proposed = Object.keys(result.entries);
      // A parsed round that validated to zero entries does not rewrite the
      // file: a meaningless byte change to a hand-built case buys nothing.
      if (proposed.length > 0) {
        writeCaseExpected(
          work.selected.caseFile,
          (expected) => ({ ...expected, ...result.entries }),
          {
            addOnly: true,
            ...(dependencies.writeFs === undefined ? {} : { fs: dependencies.writeFs }),
          },
        );
      }
      outcome.outcome = "proposed";
      outcome.proposed = proposed;
      outcome.unproposed = result.unproposed;
    }
  }

  const document: ProposeReport = {
    contractVersion: CORPUS_PROPOSE_CONTRACT_VERSION,
    corpus: corpus.manifest.name,
    cases: report.cases,
  };
  stdout.write(`${JSON.stringify(document, null, 2)}\n`);

  writeDiagnostic(
    stderr,
    `review handoff: the proposals in "${corpus.root}" are pending, not reviewed expectations — ` +
      `run ribo corpus review "${corpus.root}" to accept or correct them before measuring.`,
  );
  return document;
}

const help = [
  "Exit codes:",
  "  0  the run completed — every selected case was proposed, had nothing to propose, or",
  "     failed as a reported outcome (a failed case is a report entry, not an exit code)",
  "  2  the command could not run: usage, an unreadable corpus, an unknown case id,",
  "  transcription, spend, backend, or a case file that could not be written",
  "",
  "What it does:",
  "  For each selected case, every schema leaf with no explicit entry and no covering default",
  "  gets a pending proposal: a value with evidence grounded in one of the case's inputs, or a",
  "  proposed absence. The case text is exactly what `ribo eval` and `ribo corpus text` send —",
  "  document inputs transcribed through the same path — and every quote is verified by code",
  "  against the per-input texts under each input's own rule; the earliest matching input is",
  "  recorded as the evidence's input, never taken from the model. A value that fails",
  "  validation leaves its leaf unanswered and named in the report's `unproposed` list.",
  "  One initial call per case that needs one; at most one bounded repair round; an upper-",
  "  bound estimate, summed per case, goes to stderr before any backend is prepared, and",
  "  --max-spend and --yes behave as on schema init.",
  "",
  "Writes:",
  "  case.json is edited in place, additively and atomically: only `expected` gains keys —",
  "  every existing entry, default, input and member is untouched — and each case is written",
  "  as soon as its proposal round validates, so a later failure keeps paid work. Every new",
  "  entry is pending review; run `ribo corpus review` to accept or correct them.",
  "  Repeatable --only <scope> narrows the leaves asked (a path prefix, `*` for all), so a",
  "  schema too large for one reply is proposed a group at a time.",
  "",
  "Examples:",
  "  ribo corpus propose ./corpora/workshop --backend openai-compatible --model gpt-4o",
  "  ribo corpus propose ./corpora/workshop service-sheet --backend claude-cli --model claude-haiku-5-5",
  "  ribo corpus propose ./corpora/workshop --only service --only frame.serial --backend openai-compatible --model gpt-4o --max-spend 1.00",
  "",
  "Docs: node_modules/@azx/ribo-cli/docs/cli/corpus.md — the corpus format, propose and the " +
    "review handoff (online: https://ribo-docs.azx.helix.azxlabs.io/cli/corpus.html).",
].join("\n");

/** Register the thin Commander shell; the runner owns all testable behavior. */
export function registerCorpusProposeCommand(corpus: Command): Command {
  const command = corpus
    .command("propose")
    .description(
      "Propose pending expected answers for a corpus's unanswered leaves, writing each " +
        "case.json in place, additively and pending review",
    )
    .argument("<corpus-dir>", "the corpus directory to propose into")
    .argument("[case-id...]", "propose only these cases (default: every case)")
    .addOption(
      new Option("--backend <name>", "the proposing transport")
        .choices([...OPERATOR_BACKENDS])
        .makeOptionMandatory(),
    )
    .addOption(
      new Option("--model <id>", "the model id every proposal call carries").makeOptionMandatory(),
    )
    .option(
      "--only <scope>",
      "ask only the leaves at least one scope covers, matched at segment boundaries (repeatable)",
      collectOnly,
      [],
    )
    .option("--response-cap <n>", "cap generated tokens per HTTP call", parseResponseCap)
    .option("--timeout <seconds>", "per-call timeout for a CLI backend, in seconds", parseTimeout)
    .option(
      "--max-spend <usd>",
      `ceiling on the estimated spend (default: USD ${DEFAULT_MAX_SPEND_USD.toFixed(2)})`,
      parseSpend,
    )
    .option("--yes", "proceed even when the estimate is above the ceiling")
    .addHelpText("after", help)
    .showHelpAfterError(`run '${COMMAND} --help' for the command's flags and exit codes.`)
    .configureOutput({ writeErr: (text) => writeDiagnostic(process.stderr, text) });

  command.action(async (corpusDir: string, caseIds: readonly string[], flags: ProposeFlags) => {
    try {
      await runCorpusProposeCommand(corpusDir, caseIds, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeDiagnostic(process.stderr, colorsFor(process.stderr).red(message));
      process.exit(2);
    }
  });
  return command;
}
