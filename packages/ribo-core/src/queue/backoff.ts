/** Window for the first retry, in milliseconds. Doubles per attempt from here. */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;

/**
 * Longest the window is allowed to grow to.
 *
 * Five minutes rather than the hours a server-side queue might use: on iOS the
 * relay only runs while the tab is in the foreground (`09 §"Foreground relay"`),
 * so a long window mostly means "never retried this session".
 */
export const DEFAULT_BACKOFF_CAP_MS = 5 * 60_000;

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** Injectable for tests. Defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Full jitter, exactly as `09 §"Idempotency, backoff, ordering"` writes it:
 *
 * ```
 * delay = min(cap, base · 2^attempts) · random()
 * ```
 *
 * `attempts` is the failure count **before** the failure being scheduled, so the
 * first retry draws from `[0, base]`.
 *
 * Full jitter rather than exponential-with-a-fixed-fraction because the whole
 * point is decorrelation: several devices that lost the same flaky uplink come
 * back at the same instant, and a deterministic curve has them all retry in
 * lockstep. Drawing uniformly over the entire window spreads them out.
 */
export function fullJitterDelay(attempts: number, options: BackoffOptions = {}): number {
  if (!Number.isFinite(attempts) || attempts < 0) {
    throw new RangeError(
      `fullJitterDelay: attempts must be a non-negative number, got ${attempts}`,
    );
  }
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const cap = options.capMs ?? DEFAULT_BACKOFF_CAP_MS;
  const random = options.random ?? Math.random;
  // `2 ** attempts` overflows to Infinity well before attempts gets silly, and
  // `Infinity * random()` is NaN — which would serialize into an unparseable
  // `nextAttemptAt` and wedge the item permanently. Clamping the exponent first
  // keeps the arithmetic finite no matter what.
  const window = Math.min(cap, base * 2 ** Math.min(attempts, 32));
  return Math.floor(window * random());
}

/**
 * A failure that must never be retried, whatever it otherwise looks like.
 *
 * For the cases the HTTP status heuristic below cannot see: audio missing from
 * the attachment store, a transcript that will never parse, a step that has
 * declared the item unprocessable.
 */
export class TerminalQueueError extends Error {
  override readonly name = "TerminalQueueError";
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  for (const value of [candidate.status, candidate.statusCode]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

/**
 * Should this failure be retried?
 *
 * The rule from `09`: retry 5xx, 429 and network errors; treat 4xx as `dead`,
 * excepting 408 (request timeout) and 429 (rate limited).
 *
 * **The default for an unrecognised error is `true`.** That is deliberate and it
 * is the asymmetry that matters here: a wrongly-retried terminal failure costs a
 * few pointless requests and ends at `dead` once attempts run out, while a
 * wrongly-`dead` transient failure silently loses a field recording that someone
 * drove to a house to make. `fetch` rejecting with a bare `TypeError` when the
 * uplink drops is the single most likely error this queue will ever see.
 */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof TerminalQueueError) return false;
  const status = statusOf(error);
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}
