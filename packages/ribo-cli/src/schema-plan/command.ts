import process from "node:process";

import { InvalidArgumentError, Option } from "commander";
import type { Command } from "commander";

import { retryAsync } from "@azx/ribo-core";
import type { ChatClient, ChatRequest, SchemaPlan } from "@azx/ribo-core";

import { colorsFor } from "../colors.js";
import { cliBackendSupportsMaxTokens } from "../cli-chat.js";
import { terminalConfirmation } from "../eval/spend-prompt.js";
import { convertDocument } from "../inspect/convert.js";
import { walkFieldInventory } from "../inspect/field-inventory.js";
import {
  AUTHORING_CLI_SHAPE_ATTEMPTS,
  OPERATOR_BACKENDS,
  cliBackendNameFor,
  isOperatorCliBackend,
  prepareOperatorBackend,
} from "../operator/backend.js";
import type { OperatorBackendName } from "../operator/backend.js";
import { OperatorError } from "../operator/error.js";
import { assertOperatorOutputIsNew } from "../operator/output.js";
import type { OperatorOutputResult } from "../operator/output.js";
import {
  DEFAULT_COMPLETION_TOKENS,
  DEFAULT_MAX_SPEND_USD,
  enforceOperatorSpendCeiling,
  estimateFixedCallSpend,
  formatFixedCallSpend,
} from "../operator/spend.js";
import type { FixedCallSpendEstimate, SpendConfirmation } from "../operator/spend.js";
import { planSchema, schemaPlanFreshness } from "../schema-plan.js";
import type { SchemaPlanFreshness } from "../schema-plan.js";
import {
  assertSchemaPlanOutputIsNotUpdateInput,
  readSchemaPlanInputs,
  writeSchemaPlanArtifact,
} from "./io.js";
import {
  initialSchemaPlanPrompt,
  repairSchemaPlanPrompt,
  updateSchemaPlanPrompt,
} from "./prompt.js";

const COMMAND = "ribo schema plan";
const SEMANTIC_REPAIRS = 2;
const NETWORK_RETRIES = 2;
// Repair turns quote the previous reply. Reserve generously for its capped content.
const COMPLETION_CHARS_PER_TOKEN = 16;

export interface SchemaPlanFlags {
  readonly backend: OperatorBackendName;
  readonly model: string;
  readonly update?: string;
  readonly out?: string;
  readonly timeout?: number;
  readonly responseCap?: number;
  readonly maxSpend?: number;
  readonly yes?: boolean;
}

interface CommandOutputStream extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface SchemaPlanRunDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: CommandOutputStream;
  readonly stderr?: CommandOutputStream;
  readonly readFileImpl?: (path: string) => Promise<string>;
  readonly prepareBackend?: typeof prepareOperatorBackend;
  readonly estimateSpend?: typeof estimateFixedCallSpend;
  readonly enforceCeiling?: typeof enforceOperatorSpendCeiling;
  /** Null disables terminal prompting; absence derives it from the injected streams. */
  readonly confirmation?: SpendConfirmation | null;
  readonly retryDelay?: (ms: number) => Promise<void>;
  readonly clock?: () => Date;
}

export interface SchemaPlanRunResult {
  readonly plan: SchemaPlan;
  readonly freshness?: SchemaPlanFreshness;
  readonly estimate: FixedCallSpendEstimate;
  readonly output: OperatorOutputResult;
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

function writeDiagnostic(stream: CommandOutputStream, text: string): void {
  for (const line of text.split("\n")) {
    if (line.length > 0) stream.write(`${COMMAND}: ${line}\n`);
  }
}

function requestChars(request: ChatRequest): number {
  const messageChars = request.messages.reduce(
    (total, message) => total + message.content.length + 8,
    0,
  );
  return messageChars + JSON.stringify(request.responseFormat.json_schema.schema).length;
}

function repairGrowthChars(base: ChatRequest, completionTokens: number): number {
  const previousReply = "x".repeat(completionTokens * COMPLETION_CHARS_PER_TOKEN);
  const feedback = "x".repeat(completionTokens);
  const repaired = repairSchemaPlanPrompt(base, previousReply, [feedback], SEMANTIC_REPAIRS);
  return Math.max(0, requestChars(repaired) - requestChars(base));
}

function baseRequest(
  document: unknown,
  existingPlan: SchemaPlan | undefined,
  model: string,
): { readonly request?: ChatRequest; readonly requiredCalls: 0 | 1 } {
  const inventory = walkFieldInventory(convertDocument(document));
  if (existingPlan === undefined) {
    return { request: initialSchemaPlanPrompt({ document, inventory, model }), requiredCalls: 1 };
  }
  const currentPaths = new Set(inventory.map((entry) => entry.path));
  const storedPaths = new Set(existingPlan.fieldPaths);
  const additions = inventory.map((entry) => entry.path).filter((path) => !storedPaths.has(path));
  if (additions.length === 0) return { requiredCalls: 0 };
  const existingPieces = existingPlan.pieces
    .map((piece) => ({
      ...piece,
      paths: piece.paths.filter((path) => currentPaths.has(path)),
    }))
    .filter((piece) => piece.paths.length > 0);
  return {
    request: updateSchemaPlanPrompt({
      document,
      inventory,
      model,
      existingPieces,
      additions,
    }),
    requiredCalls: 1,
  };
}

function withCallPolicy(
  chat: ChatClient,
  responseCap: number | undefined,
  retryDelay: ((ms: number) => Promise<void>) | undefined,
): ChatClient {
  return {
    complete: (request, callOptions) =>
      retryAsync(
        () =>
          chat.complete(
            responseCap === undefined ? request : { ...request, maxTokens: responseCap },
            callOptions,
          ),
        {
          maxRetries: NETWORK_RETRIES,
          ...(retryDelay === undefined ? {} : { delay: retryDelay }),
          ...(callOptions?.signal === undefined ? {} : { signal: callOptions.signal }),
        },
      ),
  };
}

function reviewText(freshness: SchemaPlanFreshness | undefined, out: string | undefined): string {
  const lines: string[] = [];
  if (freshness === undefined) {
    lines.push(
      "create review: check the semantic piece names, descriptions and path assignments before using the plan.",
    );
  } else {
    lines.push(...freshness.notes);
    lines.push(
      "update review: surviving assignments stayed locked; review added paths and any emptied pieces.",
    );
    lines.push(
      out === undefined
        ? "the update input is unchanged; the complete updated plan is emitted on stdout."
        : `the update input is unchanged; the complete updated plan is written to the new file "${out}".`,
    );
  }
  return `${lines.map((line) => `${COMMAND}: ${line}`).join("\n")}\n`;
}

/** Run the command with every model, filesystem, stream, clock and retry dependency injectable. */
export async function runSchemaPlanCommand(
  schemaPath: string,
  flags: SchemaPlanFlags,
  dependencies: SchemaPlanRunDependencies = {},
): Promise<SchemaPlanRunResult> {
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  assertSchemaPlanOutputIsNotUpdateInput(flags.update, flags.out, cwd);
  if (flags.out !== undefined) await assertOperatorOutputIsNew(flags.out, { cwd });
  const inputs = await readSchemaPlanInputs(schemaPath, flags.update, {
    cwd,
    ...(dependencies.readFileImpl === undefined ? {} : { readFileImpl: dependencies.readFileImpl }),
  });
  const freshness =
    inputs.existingPlan === undefined
      ? undefined
      : schemaPlanFreshness(inputs.document, inputs.existingPlan);

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

  const work = baseRequest(inputs.document, inputs.existingPlan, flags.model);
  const completionTokens = flags.responseCap ?? DEFAULT_COMPLETION_TOKENS;
  const estimateSpend = dependencies.estimateSpend ?? estimateFixedCallSpend;
  const estimate = estimateSpend({
    backend: flags.backend,
    model: flags.model,
    budget: {
      initialCalls: work.requiredCalls,
      semanticRepairs: SEMANTIC_REPAIRS,
      transportRetries: NETWORK_RETRIES,
      cliShapeAttempts: AUTHORING_CLI_SHAPE_ATTEMPTS,
    },
    promptChars: work.request === undefined ? 0 : requestChars(work.request),
    promptGrowthCharsPerAttempt:
      work.request === undefined ? 0 : repairGrowthChars(work.request, completionTokens),
    completionTokensPerCall: completionTokens,
  });
  writeDiagnostic(stderr, formatFixedCallSpend(estimate, colorsFor(stderr)).join("\n"));

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
    estimate,
    maxSpendUsd: flags.maxSpend ?? DEFAULT_MAX_SPEND_USD,
    yes: flags.yes === true,
    ...(confirmation === undefined ? {} : { confirmation }),
  });

  let chat: ChatClient | undefined;
  if (work.requiredCalls > 0) {
    const prepare = dependencies.prepareBackend ?? prepareOperatorBackend;
    chat = await prepare({
      backend: flags.backend,
      requiredCalls: work.requiredCalls,
      cwd,
      ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      ...(flags.timeout === undefined ? {} : { timeoutMs: flags.timeout * 1000 }),
    });
    if (chat === undefined) {
      throw new OperatorError("the planning backend returned no chat client for required work");
    }
    chat = withCallPolicy(chat, flags.responseCap, dependencies.retryDelay);
  }

  const plan = await planSchema(inputs.document, {
    ...(chat === undefined ? {} : { chat }),
    model: flags.model,
    backend: flags.backend,
    ...(inputs.existingPlan === undefined ? {} : { existingPlan: inputs.existingPlan }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const output = await writeSchemaPlanArtifact(plan, {
    cwd,
    stdout,
    stderr,
    ...(flags.update === undefined ? {} : { update: flags.update }),
    ...(flags.out === undefined ? {} : { out: flags.out }),
    review: reviewText(freshness, flags.out),
  });
  return { plan, ...(freshness === undefined ? {} : { freshness }), estimate, output };
}

const help = [
  "Exit codes:",
  "  0  the plan was authored and the complete artifact reached stdout or the new --out file",
  "  2  the command could not run: usage, input, backend, model, spend or output refused the run",
  "",
  "Output:",
  "  Without --out, stdout is the complete JSON artifact alone. Review and spend text use stderr.",
  "  --out must name a distinct new file. Updates never modify the stored input plan.",
  "",
  "Examples:",
  "  ribo schema plan ./schema.json --backend openai-compatible --model gpt-4o",
  "  ribo schema plan ./schema.json --update ./plan.json --backend claude-cli --model claude-haiku-5-5",
  "  ribo schema plan ./schema.json --update ./plan.json --backend openai-compatible --model gpt-4o --out ./plan.next.json",
  "",
  "Docs: node_modules/@azx/ribo-cli/docs/cli/schema.md — schema input and plan review " +
    "(online: https://ribo-docs.azx.helix.azxlabs.io/cli/schema.html).",
].join("\n");

/** Register the thin Commander shell; the runner above owns all testable behavior. */
export function registerSchemaPlanCommand(schema: Command): Command {
  const command = schema
    .command("plan")
    .description("Author or incrementally update a reviewed semantic schema plan")
    .argument("<schema>", "path to the JSON Schema document")
    .addOption(
      new Option("--backend <name>", "the planning transport")
        .choices([...OPERATOR_BACKENDS])
        .makeOptionMandatory(),
    )
    .addOption(
      new Option("--model <id>", "the model id every planning call carries").makeOptionMandatory(),
    )
    .option("--update <plan>", "update a stored plan without modifying its input file")
    .option("--out <file>", "write the complete artifact to a distinct new file instead of stdout")
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

  command.action(async (schemaPath: string, flags: SchemaPlanFlags) => {
    try {
      await runSchemaPlanCommand(schemaPath, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeDiagnostic(process.stderr, colorsFor(process.stderr).red(message));
      process.exit(2);
    }
  });
  return command;
}
