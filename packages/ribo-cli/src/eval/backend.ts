/**
 * @file Eval's backend adapters. The transports, accepted names and executable
 * mapping live in the shared operator layer; these wrappers retain eval's
 * public names and its longer CLI timeout.
 */
import type { spawn } from "node:child_process";

import type { ChatClient } from "@azx/ribo-core";

import type { CliShapeResult } from "../cli-chat.js";
import {
  OPERATOR_BACKENDS,
  cliBackendNameFor as operatorCliBackendNameFor,
  createCliBackendChat as createOperatorCliBackendChat,
  createOpenAiCompatibleChat as createOperatorOpenAiCompatibleChat,
} from "../operator/backend.js";
import type {
  OpenAiCompatibleChatOptions as OperatorOpenAiCompatibleChatOptions,
  OperatorBackendName,
  OperatorCliBackend,
} from "../operator/backend.js";
import type { CliBackendName } from "../cli-chat.js";

/** The OpenAI-compatible backend's injected endpoint, credential and fetch. */
export type OpenAiCompatibleChatOptions = OperatorOpenAiCompatibleChatOptions;

/** The CLI backend values eval accepts. */
export type EvalCliBackend = OperatorCliBackend;

/** Every backend eval accepts. */
export type EvalBackendName = OperatorBackendName;

/** The backends the `--backend` flag accepts, in help order. */
export const EVAL_BACKENDS: readonly EvalBackendName[] = OPERATOR_BACKENDS;

/** The flag's value → the transport's backend name → the binary it spawns. */
export function cliBackendNameFor(backend: EvalCliBackend): CliBackendName {
  return operatorCliBackendNameFor(backend);
}

/**
 * Build the openai-compatible backend client.
 * @param options - The endpoint, credential and optional fetch.
 * @returns The transport client.
 * @category Eval
 */
export function createOpenAiCompatibleChat(options: OpenAiCompatibleChatOptions): ChatClient {
  return createOperatorOpenAiCompatibleChat(options);
}

/** Eval's per-invocation CLI timeout, deliberately longer than the transport default. */
const EVAL_CLI_TIMEOUT_MS = 600_000;

/** Eval's CLI transport options. */
export interface CreateCliBackendChatOptions {
  /** Per-invocation timeout (ms). Defaults to eval's 600 s. */
  readonly timeoutMs?: number;
  /** Override `child_process.spawn` (tests). */
  readonly spawnImpl?: typeof spawn;
  /** Observe shape outcomes without changing eval's retry budget. */
  readonly onShapeResult?: (result: CliShapeResult) => void;
}

/** Build eval's CLI client, retaining its timeout and default shape retries. */
export function createCliBackendChat(
  backend: EvalCliBackend,
  options: CreateCliBackendChatOptions = {},
): ChatClient {
  return createOperatorCliBackendChat(backend, {
    timeoutMs: options.timeoutMs ?? EVAL_CLI_TIMEOUT_MS,
    ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
    ...(options.onShapeResult === undefined ? {} : { onShapeResult: options.onShapeResult }),
  });
}
