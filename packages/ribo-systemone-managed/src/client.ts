/**
 * @file The System One client — one client for hosted TypeSafe ("Jev"), a
 * self-hosted `kev` server and a fine-tune, which all speak the same contract —
 * carried by the official `@typesafe-ai/sdk` rather than hand-rolled wire
 * handling. The SDK shapes the request body, parses the response and classifies
 * HTTP failures into its own typed errors; this file maps those onto Ribo's
 * terminal/transient split and owns batching.
 *
 * **The package has no capacity to authenticate.** It takes the endpoint and an
 * injected `fetch` and adds no credential. The SDK requires an `apiKey` (and
 * would fall back to `process.env.TYPESAFE_API_KEY` if one were omitted) — a
 * documented placeholder is passed instead, so the environment is never read
 * and no secret ever enters this package. Whatever auth the call needs is the
 * host transport's business.
 *
 * ## Failure classification — the point of this file
 *
 * The arbitration ladders treat the two kinds of failure in OPPOSITE ways
 * (`terminalFallsThrough` continues past a terminal error and gives up on a
 * transient one, because the next rung shares the same dead transport). The
 * SDK's typed errors map onto that:
 *
 * - **`AuthenticationError` (401), `BadRequestError` (400),
 *   `UnprocessableEntityError` (422), `PermissionDeniedError` (403),
 *   `NotFoundError` (404) → terminal.** The request itself is wrong — invalid
 *   credential, validation failed, no such route — so another rung would help.
 *   Thrown as {@link SystemOneError}, which extends core's `TerminalError`.
 * - **`RateLimitError` (429), `InternalServerError` (5xx), any other `APIError`,
 *   `APIConnectionError`, `APITimeoutError` → transient.** Thrown as a plain
 *   `Error` with `status` attached where the wire supplied one (or no status
 *   for a connection failure) — the shape `isTransientFailure`'s heuristic
 *   reads as retryable, and deliberately NOT a `TerminalError`. Getting this
 *   backwards turns a detector into a full-price retry loop; see
 *   `validate-extractor.ts`'s file header.
 * - **The caller's signal aborted → cancellation, terminal.** The caller
 *   withdrew the work; a retry would restart it. Matching the managed
 *   transcriber's doctrine.
 * - **A deadline expiry → transient.** A spent time budget is a property of the
 *   transport, not of the request — another attempt may be faster.
 */
import { TerminalError } from "@azx/ribo-core";
import {
  APIError,
  APIUserAbortError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  TypeSafeClient,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import type {
  ChoiceQuestion,
  ChoiceResponse,
  NoulQuestion,
  NoulResponse,
  ResultFor,
} from "@typesafe-ai/sdk";

import { SystemOneError } from "./errors.js";

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_BATCH_SIZE = 30;

/**
 * The `apiKey` handed to the SDK. A placeholder, deliberately: the SDK refuses
 * to construct without one and would otherwise read `TYPESAFE_API_KEY` from the
 * environment — neither is acceptable for a package with no capacity to
 * authenticate. The string reaches the wire as `Authorization: Bearer …` and
 * means nothing; the host's injected `fetch` attaches the real credential.
 */
const PLACEHOLDER_API_KEY = "no-secret-the-host-fetch-authenticates";

/**
 * The per-attempt timeout handed to the SDK when the caller set no deadline.
 * The SDK defaults to 10s, which a full batch of questions can legitimately
 * exceed — a slow-but-healthy call must not surface as a transient failure. There
 * is no way to unset the SDK's timeout, so this is the largest delay every
 * runtime's `setTimeout` honours without clamping or immediate fire (~24.8 days).
 */
const NO_DEADLINE_TIMEOUT_MS = 2 ** 31 - 1;

/** A question this package can ask — yes/no or named-choice; the SDK's score questions are not supported. */
export type SystemOneQuestion = NoulQuestion | ChoiceQuestion;

/** An answer the wire returns for a {@link SystemOneQuestion}, discriminated on `type`. */
export type SystemOneAnswer = NoulResponse | ChoiceResponse;

/** Questions keyed by id. */
export type SystemOneQuestions = { readonly [id: string]: SystemOneQuestion };

/**
 * Answers keyed by the question ids, each typed by its question — noul answers
 * carry `noul`, choice answers carry `choice`, `confidence` and `probabilities`.
 */
export type SystemOneAnswers<Q extends SystemOneQuestions> = {
  readonly [K in keyof Q]: ResultFor<Q[K]>;
};

/** Per-call options for {@link SystemOneClient.ask}. */
export interface SystemOneAskOptions {
  /**
   * Forwards into the request — an abort tears down the in-flight HTTP request
   * — and is checked before the request is sent, so an already-aborted signal
   * never reaches the network at all. A cancellation rejects with
   * `TerminalError`; see the classification table in the file header.
   */
  readonly signal?: AbortSignal;
  /**
   * Epoch ms. Becomes the SDK request's per-attempt timeout for the remaining
   * budget. An expiry rejects with a plain transient error — see the
   * classification table.
   */
  readonly deadline?: number;
}

/**
 * The client seam. `ask` is a function-typed property, not a method: method
 * syntax is checked bivariantly even under `strict`, so a too-narrow
 * implementation would satisfy the interface; a property is checked
 * contravariantly and rejects it.
 */
export interface SystemOneClient {
  ask: <Q extends SystemOneQuestions>(
    state: string,
    questions: Q,
    options?: SystemOneAskOptions,
  ) => Promise<SystemOneAnswers<Q>>;
}

/** Options for {@link systemOneClient}. */
export interface SystemOneClientOptions {
  /**
   * The API root the SDK appends `/v1/systemone` to — the host's own proxy when
   * the host is a browser (the hosted endpoint sends no CORS headers).
   */
  readonly endpoint: string;
  /** The injected `fetch` — the host's transport, credential-attaching or not. */
  readonly fetch: typeof fetch;
  readonly model?: string;
  readonly batchSize?: number;
}

/**
 * A transient HTTP failure — a plain `Error` with `status` attached. Exactly the
 * shape `isTransientFailure`'s status heuristic reads, and deliberately not a
 * `TerminalError`: 429 and 5xx mean the transport is busy or overloaded, and a
 * terminal classification there would stop the ladder instead of waiting it out.
 */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Map the SDK's typed errors onto the terminal/transient split — see the table
 * in the file header. Always throws; the return type is `never`.
 */
function classifySdkError(endpoint: string, error: unknown): never {
  if (error instanceof APIUserAbortError) {
    throw new TerminalError(
      `systemOneClient: the ask to ${endpoint} was cancelled by the caller's AbortSignal — ` +
        `a cancelled ask is never retried.`,
      { cause: error },
    );
  }
  if (error instanceof APIError) {
    const message = `systemOneClient: ${error.message} from ${endpoint}`;
    // 400/401/403/404/422 — the request itself is wrong, another rung would
    // help: terminal.
    if (
      error instanceof AuthenticationError ||
      error instanceof BadRequestError ||
      error instanceof UnprocessableEntityError ||
      error instanceof PermissionDeniedError ||
      error instanceof NotFoundError
    ) {
      throw new SystemOneError(error.status, message);
    }
    // 429, 5xx and every other status — transient. The default for an
    // unrecognised status is the safe one: see `isTransientFailure`'s
    // asymmetry note in `backoff.ts`.
    throw httpError(error.status, message);
  }
  // A spent deadline arrives as an APITimeoutError (the SDK aborts the attempt
  // at the timeout) — transient, with the deadline vocabulary kept.
  if (error instanceof APITimeoutError) {
    throw new Error(`systemOneClient: the ask to ${endpoint} exceeded its deadline.`, {
      cause: error,
    });
  }
  // APIConnectionError and every other SDK error carry no status — the shape
  // `isTransientFailure` reads as retryable, which is also the safe default for
  // a failure kind this mapping does not recognise.
  throw new Error(
    `systemOneClient: request to ${endpoint} failed: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

/**
 * The per-attempt timeout for one batched request: the remaining deadline
 * budget, or the no-deadline sentinel. An already-spent deadline throws before
 * the request is sent — a spent time budget is transient, not terminal.
 */
function timeoutMs(askOptions: SystemOneAskOptions | undefined, endpoint: string): number {
  const deadline = askOptions?.deadline;
  if (deadline === undefined) return NO_DEADLINE_TIMEOUT_MS;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`systemOneClient: the ask to ${endpoint} exceeded its deadline.`);
  }
  return remaining;
}

/** Build a {@link SystemOneClient} over the host's endpoint and transport. */
export function systemOneClient(options: SystemOneClientOptions): SystemOneClient {
  const {
    endpoint,
    fetch: doFetch,
    model = DEFAULT_MODEL,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options;

  const client = new TypeSafeClient({
    // A placeholder, not a credential — see its own doc comment. Explicitly
    // set so the SDK never reads TYPESAFE_API_KEY.
    apiKey: PLACEHOLDER_API_KEY,
    baseURL: endpoint,
    defaultModel: model,
    // The host's transport — the only place a credential may live.
    fetch: doFetch,
    // Library code stays quiet; this package's errors carry the detail.
    logLevel: "off",
    // The SDK refuses to construct in a browser without this, to protect a real
    // key from page users. The key here is the placeholder above — no secret
    // can be exposed — and this package deploys in browsers by design.
    dangerouslyAllowBrowser: true,
    // Retry is owned by Ribo's relay and its arbitration ladders, never the
    // wire: the SDK's default (maxRetries: 2 with exponential backoff) would
    // triple the cost of every failing call and delay transient errors
    // reaching the arbiter that is supposed to act on them.
    retry: { maxRetries: 0 },
    // No implicit deadline — the caller's `deadline` option is the only time
    // bound (see NO_DEADLINE_TIMEOUT_MS for why this is not left unset).
    timeout: NO_DEADLINE_TIMEOUT_MS,
  });

  const ask = async <Q extends SystemOneQuestions>(
    state: string,
    questions: Q,
    askOptions?: SystemOneAskOptions,
  ): Promise<SystemOneAnswers<Q>> => {
    // An already-aborted signal means the caller withdrew before this call —
    // start nothing, touch no network.
    if (askOptions?.signal?.aborted) {
      throw new TerminalError(
        "systemOneClient: the ask was not sent — the caller's AbortSignal was already aborted.",
      );
    }

    const answers: Record<string, SystemOneAnswer> = {};
    // Sequential, not concurrent: the API rate-limits (429 is in its
    // vocabulary), so a burst of parallel batches is the one thing guaranteed
    // to make the transport slower.
    const entries = Object.entries(questions);
    for (let start = 0; start < entries.length; start += batchSize) {
      const chunk = entries.slice(start, start + batchSize);
      const result = await client
        .systemOne(
          {
            state,
            model,
            questions: Object.fromEntries(chunk),
          },
          {
            signal: askOptions?.signal,
            timeout: timeoutMs(askOptions, endpoint),
          },
        )
        .catch((cause: unknown) => classifySdkError(endpoint, cause));
      for (const [id] of chunk) {
        const answer = result.answers[id];
        if (answer === undefined) {
          // A sent question came back unanswered — an attempt failure, a plain
          // `Error`: transient under the queue's default asymmetry (a
          // wrongly-retried deterministic failure ends at `dead` once attempts
          // run out; the opposite classification silently loses real work).
          throw new Error(
            `systemOneClient: response from ${endpoint} had no answer for question ${id}`,
          );
        }
        answers[id] = answer;
      }
    }
    // The chunking is invisible to the wire: every question in `Q` was sent on
    // exactly one request and each answer merged under its id, so the merged
    // record is `SystemOneAnswers<Q>` even though the loop erased the key types.
    return answers as SystemOneAnswers<Q>;
  };

  return { ask };
}
