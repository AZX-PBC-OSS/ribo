/**
 * @file The System One HTTP client — one client for hosted TypeSafe ("Jev"), a
 * self-hosted `kev` server and a fine-tune, which all speak the same contract.
 *
 * **The package has no capacity to authenticate.** It takes the endpoint and an
 * injected `fetch` and adds no credential — no `Authorization` header, no key
 * option. Whatever auth the call needs is the host transport's business.
 *
 * ## Failure classification — the point of this file
 *
 * The arbitration ladders treat the two kinds of failure in OPPOSITE ways
 * (`terminalFallsThrough` continues past a terminal error and gives up on a
 * transient one, because the next rung shares the same dead transport):
 *
 * - **401 / 422 → terminal.** The request itself is wrong — invalid credential,
 *   validation failed — so another rung would help. Thrown as
 *   {@link SystemOneError}, which extends core's `TerminalError`.
 * - **429 / 529 / any other non-2xx / network failure → transient.** Thrown as
 *   a plain `Error` with `status` attached (or no status for a fetch rejection)
 *   — the shape `isTransientFailure`'s heuristic reads as retryable, and
 *   deliberately NOT a `TerminalError`. Getting this backwards turns a detector
 *   into a full-price retry loop; see `validate-extractor.ts`'s file header.
 * - **The caller's signal aborted → cancellation, terminal.** The caller
 *   withdrew the work; a retry would restart it. Matching the managed
 *   transcriber's doctrine.
 * - **A deadline expiry → transient.** A spent time budget is a property of the
 *   transport, not of the request — another attempt may be faster.
 */
import { TerminalError } from "@azx/ribo-core";

import { SystemOneError } from "./errors.js";

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_BATCH_SIZE = 30;

/** A typed yes/no question about the state text. */
export interface NoulQuestion {
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
}

/** Per-call options for {@link SystemOneClient.ask}. */
export interface SystemOneAskOptions {
  /**
   * Forwards into the fetch request — an abort tears down the in-flight HTTP
   * request — and is checked before the request is sent, so an already-aborted
   * signal never reaches the network at all. A cancellation rejects with
   * `TerminalError`; see the classification table in the file header.
   */
  readonly signal?: AbortSignal;
  /**
   * Epoch ms. Turned into a timeout signal for the remaining budget and raced
   * with `signal`, so an expiry tears down the in-flight request. An expiry
   * rejects with a plain transient error — see the classification table.
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
  ask: (
    state: string,
    questions: Readonly<Record<string, NoulQuestion>>,
    options?: SystemOneAskOptions,
  ) => Promise<Readonly<Record<string, number>>>;
}

/** Options for {@link systemOneClient}. */
export interface SystemOneClientOptions {
  /** The API endpoint — the host's own proxy when the host is a browser (the hosted endpoint sends no CORS headers). */
  readonly endpoint: string;
  /** The injected `fetch` — the host's transport, credential-attaching or not. */
  readonly fetch: typeof fetch;
  readonly model?: string;
  readonly batchSize?: number;
}

/** The wire form of a question — `criteria` is omitted entirely when absent. */
function questionBody(question: NoulQuestion): {
  type: "noul";
  instructions: string;
  criteria?: NoulQuestion["criteria"];
} {
  if (question.criteria === undefined) {
    return { type: "noul", instructions: question.instructions };
  }
  return { type: "noul", instructions: question.instructions, criteria: question.criteria };
}

/**
 * A transient HTTP failure — a plain `Error` with `status` attached. Exactly the
 * shape `isTransientFailure`'s status heuristic reads, and deliberately not a
 * `TerminalError`: 429 and 529 mean the transport is busy or overloaded, and a
 * terminal classification there would stop the ladder instead of waiting it out.
 */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Pull one question's noul out of a response body. A miss is an attempt
 * failure — a plain `Error`, transient under the queue's default asymmetry
 * (a wrongly-retried deterministic failure ends at `dead` once attempts run
 * out; the opposite classification silently loses real work).
 */
function noulOf(endpoint: string, body: unknown, id: string): number {
  const answers =
    typeof body === "object" && body !== null ? (body as { answers?: unknown }).answers : undefined;
  const answer =
    typeof answers === "object" && answers !== null
      ? (answers as Record<string, unknown>)[id]
      : undefined;
  const noul =
    typeof answer === "object" && answer !== null ? (answer as { noul?: unknown }).noul : undefined;
  if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    throw new Error(
      `systemOneClient: response from ${endpoint} had no noul in [0,1] for question ${id}`,
    );
  }
  return noul;
}

/**
 * The signal handed to fetch: the caller's signal plus, when a deadline is set,
 * a timeout signal for the remaining budget. `AbortSignal.timeout` with a
 * non-positive remainder fires immediately, so an already-spent deadline needs
 * no separate pre-check on the send path.
 */
function askSignal(askOptions: SystemOneAskOptions | undefined): AbortSignal | undefined {
  const signal = askOptions?.signal;
  const deadline = askOptions?.deadline;
  if (deadline === undefined) return signal;
  const timeout = AbortSignal.timeout(deadline - Date.now());
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * A fetch rejection: cancellation if the caller's own signal fired (terminal —
 * the caller withdrew the work), a spent deadline (transient), otherwise a
 * transport failure — plain `Error`, no `status`, which `isTransientFailure`
 * reads as retryable.
 */
function transportError(
  endpoint: string,
  cause: unknown,
  askOptions: SystemOneAskOptions | undefined,
): Error {
  if (askOptions?.signal?.aborted) {
    return new TerminalError(
      `systemOneClient: the ask to ${endpoint} was cancelled by the caller's AbortSignal — ` +
        `a cancelled ask is never retried.`,
      { cause },
    );
  }
  if (askOptions?.deadline !== undefined && Date.now() >= askOptions.deadline) {
    return new Error(`systemOneClient: the ask to ${endpoint} exceeded its deadline.`, { cause });
  }
  return new Error(
    `systemOneClient: request to ${endpoint} failed: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}

/** One batched request: send a chunk, classify the response, pull the chunk's answers out. */
async function askChunk(
  endpoint: string,
  doFetch: typeof fetch,
  model: string,
  state: string,
  chunk: ReadonlyArray<readonly [string, NoulQuestion]>,
  askOptions: SystemOneAskOptions | undefined,
): Promise<ReadonlyArray<readonly [string, number]>> {
  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state,
        model,
        questions: Object.fromEntries(chunk.map(([id, question]) => [id, questionBody(question)])),
      }),
      signal: askSignal(askOptions),
    });
  } catch (cause) {
    throw transportError(endpoint, cause, askOptions);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message =
      `systemOneClient: ${response.status} ${response.statusText} from ${endpoint}` +
      (detail ? `: ${detail.slice(0, 200)}` : "");
    // 401/422 — the request itself is wrong, another rung would help: terminal.
    if (response.status === 401 || response.status === 422) {
      throw new SystemOneError(response.status, message);
    }
    // 429, 529 and every other status — transient. The default for an
    // unrecognised status is the safe one: see `isTransientFailure`'s
    // asymmetry note in `backoff.ts`.
    throw httpError(response.status, message);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new Error(`systemOneClient: response from ${endpoint} was not valid JSON`, { cause });
  }

  return chunk.map(([id]) => [id, noulOf(endpoint, body, id)] as const);
}

/** Build a {@link SystemOneClient} over the host's endpoint and transport. */
export function systemOneClient(options: SystemOneClientOptions): SystemOneClient {
  const {
    endpoint,
    fetch: doFetch,
    model = DEFAULT_MODEL,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options;

  const ask: SystemOneClient["ask"] = async (state, questions, askOptions) => {
    // An already-aborted signal means the caller withdrew before this call —
    // start nothing, touch no network.
    if (askOptions?.signal?.aborted) {
      throw new TerminalError(
        "systemOneClient: the ask was not sent — the caller's AbortSignal was already aborted.",
      );
    }

    const verdicts: Record<string, number> = {};
    // Sequential, not concurrent: the API rate-limits (429 is in its
    // vocabulary), so a burst of parallel batches is the one thing guaranteed
    // to make the transport slower.
    const entries = Object.entries(questions);
    for (let start = 0; start < entries.length; start += batchSize) {
      const chunk = entries.slice(start, start + batchSize);
      for (const [id, noul] of await askChunk(endpoint, doFetch, model, state, chunk, askOptions)) {
        verdicts[id] = noul;
      }
    }
    return verdicts;
  };

  return { ask };
}
