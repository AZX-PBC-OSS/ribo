import process from "node:process";
import { statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { InvalidArgumentError, Option } from "commander";
import type { Command } from "commander";

import { retryAsync } from "@azx/ribo-core";
import type { ChatClient, ChatRequest } from "@azx/ribo-core";

import { colorsFor } from "../colors.js";
import { cliBackendSupportsMaxTokens } from "../cli-chat.js";
import type { CorpusProvenance } from "../corpus/manifest.js";
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
  assertOperatorOutputIsNew,
  assertOperatorOutputParentExists,
  defaultOperatorDirectoryFileSystem,
  writeOperatorOutput,
} from "../operator/output.js";
import type {
  OperatorDirectoryFileSystem,
  OperatorDirectoryOutputResult,
  OperatorOutputFileSystem,
  OperatorOutputResult,
} from "../operator/output.js";
import {
  DEFAULT_COMPLETION_TOKENS,
  DEFAULT_MAX_SPEND_USD,
  enforceOperatorSpendCeiling,
  estimateFixedCallSpend,
  formatFixedCallSpend,
} from "../operator/spend.js";
import type { FixedCallSpendEstimate, SpendConfirmation } from "../operator/spend.js";
import { initSchema, SCHEMA_INIT_REPAIRS } from "../schema-init.js";
import type { SchemaInitDraft } from "../schema-init.js";
import { initialSchemaInitPrompt, repairSchemaInitPrompt } from "./prompt.js";
import {
  schemaInitCorpusEntries,
  serializeSchemaInitDocument,
  writeSchemaInitCorpus,
} from "./scaffold.js";
import type { SchemaInitCorpusMetadata } from "./scaffold.js";
import { loadSchemaInitSamples } from "./samples.js";
import type { SchemaInitSample } from "./samples.js";
import { indexSchemaInitSamples } from "./validate.js";

const COMMAND = "ribo schema init";
const NETWORK_RETRIES = 2;
// Repair turns quote the prior response; reserve for content at the completion cap.
const COMPLETION_CHARS_PER_TOKEN = 16;

export interface SchemaInitFlags {
  readonly backend: OperatorBackendName;
  readonly model: string;
  readonly out?: string;
  readonly corpus?: string;
  readonly corpusName?: string;
  readonly corpusProvenance?: CorpusProvenance;
  readonly capturedAt?: string;
  readonly timeout?: number;
  readonly responseCap?: number;
  readonly maxSpend?: number;
  readonly yes?: boolean;
}

interface CommandOutputStream extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface SchemaInitRunDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: CommandOutputStream;
  readonly stderr?: CommandOutputStream;
  readonly loadSamples?: (
    sources: readonly string[],
    options: { readonly capturedAt: string },
  ) => Promise<readonly SchemaInitSample[]>;
  readonly prepareBackend?: typeof prepareOperatorBackend;
  readonly estimateSpend?: typeof estimateFixedCallSpend;
  readonly enforceCeiling?: typeof enforceOperatorSpendCeiling;
  /** Null disables terminal prompting; absence derives it from the injected streams. */
  readonly confirmation?: SpendConfirmation | null;
  readonly retryDelay?: (ms: number) => Promise<void>;
  readonly clock?: () => Date;
  readonly draftSchema?: typeof initSchema;
  readonly outputFs?: OperatorOutputFileSystem;
  readonly directoryFs?: OperatorDirectoryFileSystem;
}

export interface SchemaInitRunResult {
  readonly draft: SchemaInitDraft;
  readonly estimate: FixedCallSpendEstimate;
  readonly output: OperatorOutputResult;
  readonly corpusOutput?: OperatorDirectoryOutputResult;
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

// An ISO 8601 datetime, not a bare date and not a lax Date.parse accept: the
// instant is persisted into capture records, so its shape is part of the format.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const parseCapturedAt = (value: string): string => {
  if (!ISO_DATETIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InvalidArgumentError(
      `expected an ISO 8601 datetime such as 2026-06-01T09:00:00Z, but got "${value}" ` +
        "(fix: pass --captured-at as an ISO 8601 datetime, or drop it to stamp the run instant)",
    );
  }
  return value;
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
  const repaired = repairSchemaInitPrompt(base, previousReply, [feedback], SCHEMA_INIT_REPAIRS);
  return Math.max(0, requestChars(repaired) - requestChars(base));
}

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

function validateFlags(flags: SchemaInitFlags, cwd: string): SchemaInitCorpusMetadata | undefined {
  if (flags.capturedAt !== undefined) parseCapturedAt(flags.capturedAt);
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
  if (flags.corpus === undefined) {
    if (flags.corpusName !== undefined || flags.corpusProvenance !== undefined) {
      throw new OperatorError(
        "--corpus-name and --corpus-provenance require --corpus (fix: name a new corpus directory, " +
          "or drop its metadata flags)",
      );
    }
    return undefined;
  }
  if (flags.corpusName === undefined || flags.corpusName.trim().length === 0) {
    throw new OperatorError(
      "--corpus requires an explicit non-empty --corpus-name; drafting never invents corpus identity",
    );
  }
  if (flags.corpusProvenance !== "real" && flags.corpusProvenance !== "synthetic") {
    throw new OperatorError(
      "--corpus requires --corpus-provenance real or synthetic; drafting never guesses provenance",
    );
  }
  if (flags.out !== undefined) {
    const output = resolve(cwd, flags.out);
    const corpus = resolve(cwd, flags.corpus);
    const outputWithinCorpus = relative(corpus, output);
    const corpusWithinOutput = relative(output, corpus);
    const contained = (path: string): boolean =>
      path.length === 0 || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
    if (contained(outputWithinCorpus) || contained(corpusWithinOutput)) {
      throw new OperatorError(
        "--out and --corpus must not overlap — the schema file and corpus directory are distinct " +
          "new destinations (fix: choose separate paths)",
      );
    }
  }
  return { name: flags.corpusName, provenance: flags.corpusProvenance };
}

function handoffText(flags: SchemaInitFlags): string {
  const schema = flags.out === undefined ? "<saved-schema.json>" : flags.out;
  const corpus = flags.corpus ?? "<corpus-dir>";
  const lines = [
    "draft review: this is an evidence-linked starting point, not a completeness claim; inspect every declaration before use.",
    `inspect handoff: save the drafted schema if needed, then run ribo schema inspect ${schema}.`,
    `plan handoff: after review, run ribo schema plan ${schema} --backend <name> --model <id>.`,
    `corpus-text handoff: after scaffolding, inspect the exact case text with ribo corpus text ${corpus}.`,
    "expectation-authoring handoff: case expected maps and prompt instructions are empty and defaults are omitted; author them explicitly before measuring.",
    `eval handoff: after expectation authoring, run ribo eval --corpus ${corpus} --backend <name> --model <id> --strategy single-shot.`,
  ];
  return `${lines.map((line) => `${COMMAND}: ${line}`).join("\n")}\n`;
}

/** Run schema drafting with transcription, spend, backend and output dependencies injectable. */
export async function runSchemaInitCommand(
  sources: readonly string[],
  flags: SchemaInitFlags,
  dependencies: SchemaInitRunDependencies = {},
): Promise<SchemaInitRunResult> {
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const corpusMetadata = validateFlags(flags, cwd);

  if (flags.out !== undefined) {
    await assertOperatorOutputIsNew(flags.out, {
      cwd,
      ...(dependencies.outputFs === undefined ? {} : { fs: dependencies.outputFs }),
    });
  }
  if (flags.corpus !== undefined) {
    await assertOperatorOutputIsNew(flags.corpus, {
      cwd,
      ...(dependencies.directoryFs === undefined ? {} : { fs: dependencies.directoryFs }),
    });
  }
  // A missing parent would fail only at publication, after the model calls were paid for.
  if (flags.out !== undefined) {
    await assertOperatorOutputParentExists(flags.out, {
      cwd,
      ...(dependencies.outputFs === undefined ? {} : { fs: dependencies.outputFs }),
    });
  }
  if (flags.corpus !== undefined) {
    await assertOperatorOutputParentExists(flags.corpus, {
      cwd,
      ...(dependencies.directoryFs === undefined ? {} : { fs: dependencies.directoryFs }),
    });
  }

  const loadSamples = dependencies.loadSamples ?? loadSchemaInitSamples;
  // A bare PDF is a direct file with a .pdf extension; only those get a stamped
  // capture block, so the flag is refused when nothing would carry it.
  const barePdfSources = sources.filter((source) => {
    const resolved = resolve(cwd, source);
    try {
      return statSync(resolved).isFile() && extname(resolved).toLowerCase() === ".pdf";
    } catch {
      return false;
    }
  });
  if (flags.capturedAt !== undefined && barePdfSources.length === 0) {
    throw new OperatorError(
      "--captured-at stamps bare PDFs' capture blocks, and no sample is a bare PDF (fix: pass a " +
        "bare PDF, or drop --captured-at — a case folder's declared capture block is never touched)",
    );
  }
  // The command clock, read once per run: every bare PDF in this run shares it.
  const capturedAt = flags.capturedAt ?? (dependencies.clock ?? (() => new Date()))().toISOString();
  const samples = await loadSamples(sources, { capturedAt });
  indexSchemaInitSamples(samples);
  // One stderr line per plain-folder sample: the order it loaded in is the
  // draft's evidence order, and the scaffolded case.json is where to change it.
  for (const sample of samples) {
    if (sample.orderInferred === true) {
      writeDiagnostic(
        stderr,
        `plain folder "${sample.name}" loads its inputs in byte-wise file-name order: ` +
          `${sample.inputs.map((input) => input.file).join(", ")} — to change the order, edit ` +
          '"inputs" in the scaffolded case.json',
      );
    }
  }
  // Build the scaffold's entries once with placeholder schema bytes, so every
  // name, capture and manifest refusal happens before any spend.
  if (corpusMetadata !== undefined) schemaInitCorpusEntries("", samples, corpusMetadata);
  if (corpusMetadata !== undefined && barePdfSources.length > 0) {
    const files = barePdfSources
      .map((source) => `${basename(resolve(cwd, source))} (bare PDF)`)
      .join(", ");
    writeDiagnostic(
      stderr,
      `stamped ${files} with capturedAt ${capturedAt} — ${
        flags.capturedAt === undefined
          ? "the run instant, overridable with --captured-at"
          : "from --captured-at"
      }`,
    );
  }
  const base = initialSchemaInitPrompt(samples, flags.model);
  const completionTokens = flags.responseCap ?? DEFAULT_COMPLETION_TOKENS;
  const estimateSpend = dependencies.estimateSpend ?? estimateFixedCallSpend;
  const estimate = estimateSpend({
    backend: flags.backend,
    model: flags.model,
    budget: {
      initialCalls: 1,
      semanticRepairs: SCHEMA_INIT_REPAIRS,
      transportRetries: NETWORK_RETRIES,
      cliShapeAttempts: AUTHORING_CLI_SHAPE_ATTEMPTS,
    },
    promptChars: requestChars(base),
    promptGrowthCharsPerAttempt: repairGrowthChars(base, completionTokens),
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

  const prepare = dependencies.prepareBackend ?? prepareOperatorBackend;
  const prepared = await prepare({
    backend: flags.backend,
    requiredCalls: 1,
    cwd,
    ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
    ...(flags.timeout === undefined ? {} : { timeoutMs: flags.timeout * 1000 }),
  });
  if (prepared === undefined) {
    throw new OperatorError("the schema-init backend returned no chat client for required work");
  }
  // Every request carries the reply cap the estimate priced, wherever the transport can carry one.
  const capsReplies =
    !isOperatorCliBackend(flags.backend) ||
    cliBackendSupportsMaxTokens(cliBackendNameFor(flags.backend));
  const chat = withCallPolicy(
    prepared,
    capsReplies ? completionTokens : undefined,
    dependencies.retryDelay,
  );
  const draftSchema = dependencies.draftSchema ?? initSchema;
  const draft = await draftSchema(samples, {
    chat,
    model: flags.model,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const artifact = serializeSchemaInitDocument(draft.document);

  let corpusOutput: OperatorDirectoryOutputResult | undefined;
  if (flags.corpus !== undefined && corpusMetadata !== undefined) {
    corpusOutput = await writeSchemaInitCorpus(flags.corpus, artifact, samples, corpusMetadata, {
      cwd,
      stderr,
      ...(dependencies.directoryFs === undefined ? {} : { fs: dependencies.directoryFs }),
    });
  }
  let output: Awaited<ReturnType<typeof writeOperatorOutput>>;
  try {
    output = await writeOperatorOutput(
      {
        kind: "create",
        artifact,
        ...(flags.out === undefined ? {} : { out: flags.out }),
        review: handoffText(flags),
      },
      {
        cwd,
        stdout,
        stderr,
        ...(dependencies.outputFs === undefined ? {} : { fs: dependencies.outputFs }),
      },
    );
  } catch (error) {
    if (corpusOutput === undefined) throw error;
    // The corpus was published by one rename into a path that did not exist, so
    // this command owns all of it; removing it keeps the two outputs all-or-nothing.
    await (dependencies.directoryFs ?? defaultOperatorDirectoryFileSystem).rm(corpusOutput.path);
    throw new OperatorError(
      `${error instanceof Error ? error.message : String(error)}; the corpus directory ` +
        `"${corpusOutput.path}" was removed so no partial scaffold remains`,
    );
  }
  return {
    draft,
    estimate,
    output,
    ...(corpusOutput === undefined ? {} : { corpusOutput }),
  };
}

const help = [
  "Exit codes:",
  "  0  the schema was drafted and every selected output reached its new destination",
  "  2  the command could not run: usage, input, transcription, backend, model, spend or output refused the run",
  "",
  "Inputs and output:",
  "  Each sample is a direct text file or bare PDF, a plain folder of input files, or an existing",
  "  case folder with any number of declared inputs. A bare PDF is measured for its page count and",
  "  stamped capturedAt — the run instant, or --captured-at; no file date or PDF metadata date is",
  "  ever read. A plain folder without case.json loads as one sample named after the directory:",
  "  its .pdf, .txt and .md files in byte-wise file-name order, dotfiles skipped, any other",
  "  extension refused by name; one stderr line states the order, and 'inputs' in the scaffolded",
  "  case.json is where to change it. A case folder's declared capture block is kept untouched.",
  "  Without --out, stdout is the complete OpenAPI schema alone. Spend and handoffs use stderr.",
  "  --out and --corpus name distinct new destinations; neither ever overwrites an existing path.",
  "  --corpus requires explicit --corpus-name and --corpus-provenance. Cases keep every declared",
  "  input in order; expectations and instructions stay empty, and no defaults or provenance are invented.",
  "",
  "Examples:",
  "  ribo schema init ./notes.txt ./spoken-case --backend openai-compatible --model gpt-4o",
  "  ribo schema init ./notes.txt --backend claude-cli --model claude-haiku-5-5 --out ./schema.json",
  "  ribo schema init ./intake-form.pdf ./notes.txt --backend openai-compatible --model gpt-4o --captured-at 2026-06-01T09:00:00Z",
  "  ribo schema init ./notes.txt --backend openai-compatible --model gpt-4o --corpus ./draft-corpus --corpus-name workshop --corpus-provenance real",
  "",
  "Docs: node_modules/@azx/ribo-cli/docs/cli/planning.md — authoring a schema and reviewing its plan " +
    "(online: https://ribo-docs.azx.helix.azxlabs.io/cli/planning.html).",
].join("\n");

/** Register the thin Commander shell; the runner owns all testable behavior. */
export function registerSchemaInitCommand(schema: Command): Command {
  const command = schema
    .command("init")
    .description("Draft an evidence-linked OpenAPI schema and optionally scaffold a corpus")
    .argument("<samples...>", "direct text files, plain folders or existing case folders")
    .addOption(
      new Option("--backend <name>", "the drafting transport")
        .choices([...OPERATOR_BACKENDS])
        .makeOptionMandatory(),
    )
    .addOption(
      new Option("--model <id>", "the model id every drafting call carries").makeOptionMandatory(),
    )
    .option("--out <file>", "write the schema to a distinct new file instead of stdout")
    .option("--corpus <dir>", "also create an all-or-nothing corpus scaffold at a new directory")
    .option("--corpus-name <name>", "the explicit corpus manifest name; required with --corpus")
    .option(
      "--captured-at <iso>",
      "the capture instant stamped onto bare PDFs (default: the run instant)",
      parseCapturedAt,
    )
    .addOption(
      new Option("--corpus-provenance <kind>", "the declared corpus provenance")
        .choices(["real", "synthetic"])
        .makeOptionMandatory(false),
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

  command.action(async (samples: readonly string[], flags: SchemaInitFlags) => {
    try {
      await runSchemaInitCommand(samples, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeDiagnostic(process.stderr, colorsFor(process.stderr).red(message));
      process.exit(2);
    }
  });
  return command;
}
