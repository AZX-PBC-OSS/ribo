/**
 * @file Command-neutral backend construction and preparation.
 *
 * The flag names, transport names and executable mapping live here once.
 * Authoring preparation adds preflight and environment/`.env.local` credential
 * lookup without becoming an eval corpus run. CLI authoring gets one shape
 * attempt; eval's adapter keeps its own timeout and transport retry defaults.
 */
import type { spawn } from "node:child_process";

import { openAiChat } from "@azx/ribo-chat-openai";
import type { ChatClient } from "@azx/ribo-core";

import { cliChat } from "../cli-chat.js";
import type { CliBackendName, CliShapeResult } from "../cli-chat.js";
import { preflightCliBackend } from "../cli-preflight.js";
import type { CliPreflightOptions } from "../cli-preflight.js";
import { lookupSecret } from "../eval/secrets.js";
import type { SecretLookupOptions } from "../eval/secrets.js";
import { OperatorError } from "./error.js";

/** The CLI backend flag values. */
export type OperatorCliBackend = "claude-cli" | "codex-cli";

/** Every backend an operator command can select. */
export type OperatorBackendName = "openai-compatible" | OperatorCliBackend;

/** The accepted backend names, in command-help order. */
export const OPERATOR_BACKENDS: readonly OperatorBackendName[] = [
  "openai-compatible",
  "claude-cli",
  "codex-cli",
];

/** Authoring does not spend extra CLI invocations correcting output shape. */
export const AUTHORING_CLI_SHAPE_ATTEMPTS = 1;

const API_KEY_VARIABLE = "OPENAI_API_KEY";
const BASE_URL_VARIABLE = "OPENAI_BASE_URL";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** The one flag-value → transport/executable mapping. */
const CLI_BACKEND_NAMES: Record<OperatorCliBackend, CliBackendName> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
};

/** Whether a backend spawns an installed CLI. */
export function isOperatorCliBackend(backend: OperatorBackendName): backend is OperatorCliBackend {
  return backend !== "openai-compatible";
}

/** Resolve a CLI flag value to the transport name, which is also its executable. */
export function cliBackendNameFor(backend: OperatorCliBackend): CliBackendName {
  return CLI_BACKEND_NAMES[backend];
}

/** The OpenAI-compatible transport's injected configuration. */
export interface OpenAiCompatibleChatOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

/** Build the OpenAI-compatible transport; authentication stays injected. */
export function createOpenAiCompatibleChat(options: OpenAiCompatibleChatOptions): ChatClient {
  return openAiChat({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

/** CLI transport knobs shared by authoring and the eval adapter. */
export interface CreateCliBackendChatOptions {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly onShapeResult?: (result: CliShapeResult) => void;
  readonly spawnImpl?: typeof spawn;
}

/** Build a CLI transport without adding an SDK or credential. */
export function createCliBackendChat(
  backend: OperatorCliBackend,
  options: CreateCliBackendChatOptions = {},
): ChatClient {
  return cliChat({
    backend: cliBackendNameFor(backend),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.onShapeResult === undefined ? {} : { onShapeResult: options.onShapeResult }),
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
  });
}

/** Injectable preflight seam, still addressed by transport/executable name. */
export type OperatorPreflight = (
  backend: CliBackendName,
  options?: CliPreflightOptions,
) => Promise<void>;

/** Configuration for preparing an authoring command's backend. */
export interface PrepareOperatorBackendOptions {
  readonly backend: OperatorBackendName;
  /** Calls the planned work may require. Zero performs no backend access. */
  readonly requiredCalls: number;
  /** An endpoint override; otherwise `OPENAI_BASE_URL` and then the default apply. */
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly readFileImpl?: SecretLookupOptions["readFileImpl"];
  readonly lookupSecretImpl?: typeof lookupSecret;
  readonly preflightImpl?: OperatorPreflight;
  readonly fetchImpl?: typeof fetch;
  readonly spawnImpl?: typeof spawn;
  readonly timeoutMs?: number;
  readonly onShapeResult?: (result: CliShapeResult) => void;
}

/**
 * Prepare the transport only when planned authoring work requires a call.
 * CLI preflight and secret lookup are skipped for zero-call updates. No option
 * accepts a credential: HTTP secrets come only from the existing secret reader.
 */
export async function prepareOperatorBackend(
  options: PrepareOperatorBackendOptions,
): Promise<ChatClient | undefined> {
  if (!Number.isInteger(options.requiredCalls) || options.requiredCalls < 0) {
    throw new OperatorError(
      `requiredCalls must be a non-negative integer, got ${String(options.requiredCalls)} ` +
        "(fix: pass the planned work's fixed call count)",
    );
  }
  if (options.requiredCalls === 0) return undefined;

  if (isOperatorCliBackend(options.backend)) {
    const preflight = options.preflightImpl ?? preflightCliBackend;
    await preflight(cliBackendNameFor(options.backend), {
      ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
      createError: (message) => new OperatorError(message),
    });
    return createCliBackendChat(options.backend, {
      maxAttempts: AUTHORING_CLI_SHAPE_ATTEMPTS,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.onShapeResult === undefined ? {} : { onShapeResult: options.onShapeResult }),
      ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
    });
  }

  const env = options.env ?? process.env;
  const lookup = options.lookupSecretImpl ?? lookupSecret;
  const secret = lookup(API_KEY_VARIABLE, {
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.readFileImpl === undefined ? {} : { readFileImpl: options.readFileImpl }),
  });
  if (secret.value === undefined) {
    throw new OperatorError(
      `the ${API_KEY_VARIABLE} credential is not set — the backend needs one, and secrets never ` +
        `ride flags. The CLI looked in the environment and in the file ${secret.filePath} ` +
        `(fix: export ${API_KEY_VARIABLE}, or put ${API_KEY_VARIABLE}=<key> in that file)`,
    );
  }
  return createOpenAiCompatibleChat({
    baseUrl: options.baseUrl ?? env[BASE_URL_VARIABLE] ?? DEFAULT_BASE_URL,
    apiKey: secret.value,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}
