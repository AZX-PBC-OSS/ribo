import type { ScheduleTimer } from "./connectivity.js";
import {
  DEFAULT_CAPABILITY_TTL_MS,
  type CompositeTranscriber,
  type EngineCapability,
} from "./first-capable.js";
import { TerminalQueueError } from "./queue/backoff.js";
import type { Recording } from "./recording.js";
import type { Transcript } from "./transcript.js";
import {
  isPermanentlyUnavailable,
  TranscriberUnavailableError,
  type Transcriber,
  type TranscriberCapability,
  type TranscriberUnavailableReason,
} from "./transcriber.js";

/**
 * @file `hedged` — the hedged-request combinator, a sibling of `firstCapable`.
 *
 * Where `firstCapable` is strictly sequential (pick one engine, run it to
 * completion), `hedged` races a preferred engine against a fallback on a
 * latency budget. Start the primary; if it has not finished within a delay,
 * start the hedge too and take whichever finishes first. This is the
 * "hedged request" pattern from Dean & Barroso's *The Tail at Scale*.
 *
 * It sits **beside** `firstCapable`, not inside it. `firstCapable`'s rule 5 —
 * that an ordinary error propagates untouched rather than falling through to
 * the next engine — stays untouched. A deployment that will not let audio
 * leave the device simply never calls `hedged`; the default composition stays
 * privacy-preserving.
 *
 * **`ribo-core` does not know what a real-time factor is.** The delay policy
 * receives a function returning milliseconds, supplied by the host from
 * whatever it measured. Knowledge of RTF stays in the on-device package that
 * measured it (§5.3 of the managed-transcription design).
 */

// ---------------------------------------------------------------------------
// Timer injection — so tests drive time without sleeping
// ---------------------------------------------------------------------------

/**
 * Injectable timer, reusing {@link ScheduleTimer} from `connectivity.ts`.
 *
 * The default is `setTimeout`/`clearTimeout`; tests inject a double that
 * stores the callback and fires it on demand. This is the only clock the
 * combinator uses for the delay — capability caching has its own `now`.
 */

const defaultScheduleTimer: ScheduleTimer = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs);
  return () => clearTimeout(id);
};

// ---------------------------------------------------------------------------
// The delay helper — its clamp is the substantive part of this design
// ---------------------------------------------------------------------------

/**
 * Host-supplied predicted primary transcription duration in milliseconds, or
 * `undefined` when no prediction is available (before calibration).
 *
 * The host computes this from whatever it measured — typically a real-time
 * factor multiplied by {@link Recording.durationMs}. `ribo-core` never sees
 * the RTF; it sees only the resulting number.
 */
export type PredictedDurationMs = (recording: Recording) => number | undefined;

/**
 * A delay policy: given a recording, how many milliseconds to wait before
 * firing the hedge. Built by {@link hedgeDelay} in the common case, but a
 * host can supply its own function instead.
 */
export type HedgeDelayPolicy = (recording: Recording) => number;

/**
 * Provisional default for {@link HedgeDelayOptions.factor}. 1.5 — the value
 * used in §5.3's worked example. Gives the primary a 50 % margin over its
 * predicted duration before the hedge fires.
 */
export const DEFAULT_HEDGE_FACTOR = 1.5;

/**
 * Provisional default for {@link HedgeDelayOptions.floorMs}. 2 seconds — do
 * not fire the hedge before the primary has had a chance to get going. Field
 * data from `onHedge` telemetry would refine this.
 */
export const DEFAULT_HEDGE_FLOOR_MS = 2_000;

/**
 * Provisional default for {@link HedgeDelayOptions.budgetMs}. 30 seconds — a
 * reasonable wait for a field auditor. This is the real control: the
 * prediction only pulls the hedge *earlier* on fast devices; the budget is
 * the ceiling on how long anyone waits. Field-uplink measurement is
 * deliberately deferred (§9 of the design).
 */
export const DEFAULT_HEDGE_BUDGET_MS = 30_000;

export interface HedgeDelayOptions {
  /** Host-supplied predicted primary duration in ms. `undefined` means "no
   * prediction" — the hedge fires at `budgetMs`, giving the primary the full
   * budget. */
  readonly predictedDurationMs: PredictedDurationMs;
  /**
   * Scale factor applied to the prediction. Defaults to
   * {@link DEFAULT_HEDGE_FACTOR}. A factor of 1.5 means "wait 1.5× the
   * predicted time before hedging" — the primary gets a margin.
   */
  readonly factor?: number;
  /**
   * Minimum delay before the hedge fires, regardless of how small the
   * prediction is. Defaults to {@link DEFAULT_HEDGE_FLOOR_MS}.
   */
  readonly floorMs?: number;
  /**
   * Maximum delay — the auditor's tolerance budget. The prediction only
   * pulls the hedge earlier; it can never push it past this. Defaults to
   * {@link DEFAULT_HEDGE_BUDGET_MS}.
   */
  readonly budgetMs?: number;
}

/**
 * Build a {@link HedgeDelayPolicy} from the common-case formula:
 *
 * > `delayMs = clamp(predictedMs × factor, floorMs, budgetMs)`
 *
 * The clamp is not defensive tidiness. The obvious formula — fire after the
 * primary's own predicted duration — is **wrong** because it scales the
 * deadline by the device's slowness: on a three-minute dictation an RTF of
 * 0.5 predicts 90 s and hedges at 135 s, but an RTF of 2.5 predicts 450 s
 * and would hedge at 675 s. The slower the device, the later the help.
 * `budgetMs` expresses how long the auditor will actually wait; the
 * prediction only pulls the hedge *earlier* on fast devices.
 *
 * When `predictedDurationMs` returns `undefined` (no calibration yet), the
 * delay is `budgetMs` — give the primary the full budget.
 */
export function hedgeDelay(options: HedgeDelayOptions): HedgeDelayPolicy {
  const {
    predictedDurationMs,
    factor = DEFAULT_HEDGE_FACTOR,
    floorMs = DEFAULT_HEDGE_FLOOR_MS,
    budgetMs = DEFAULT_HEDGE_BUDGET_MS,
  } = options;
  return (recording) => {
    const predicted = predictedDurationMs(recording);
    if (predicted === undefined) return budgetMs;
    const scaled = predicted * factor;
    return Math.min(budgetMs, Math.max(floorMs, scaled));
  };
}

// ---------------------------------------------------------------------------
// The onHedge event — mirrors onFallback from firstCapable
// ---------------------------------------------------------------------------

/**
 * The hedge was **dispatched** — the primary missed its budget and the audio
 * left the device.
 *
 * Emitted once per hedged attempt, whatever the outcome, because dispatch is
 * the event with consequences: the managed call is paid for and the audio has
 * been sent whether or not the hedge went on to win. A handler that logs
 * unconditionally stays quiet on the happy path (the primary beat the budget,
 * the hedge never ran) and speaks up on exactly the routing decision that is
 * otherwise invisible.
 *
 * Emitting only on a hedge *win* would be the tempting mistake. It hides every
 * fire-and-lose — the wasted calls — and it is the **fire rate**, not the win
 * rate, that tells you whether `budgetMs` is set correctly.
 */
export interface TranscriberHedgeEvent {
  /** The recording being transcribed when the hedge fired. */
  readonly recordingId: string;
  /** The preferred engine's id — the one that missed its budget. */
  readonly primary: string;
  /** The hedge engine's id — the one that fired late. */
  readonly hedge: string;
  /**
   * Which engine's transcript was used, or `undefined` when both failed and
   * there was no winner. Compare against {@link primary} and {@link hedge} to
   * separate the fire rate from the win rate.
   */
  readonly winner: string | undefined;
}

// ---------------------------------------------------------------------------
// The combinator
// ---------------------------------------------------------------------------

export interface HedgedOptions {
  /** `Transcriber.engine` for the composite itself. Defaults to `"hedged"`. */
  readonly engine?: string;
  /**
   * When to fire the hedge, as a function of the recording. Required — the
   * host owns the policy. Build it with {@link hedgeDelay} or supply your own.
   */
  readonly delay: HedgeDelayPolicy;
  /** Capability cache lifetime. Defaults to {@link DEFAULT_CAPABILITY_TTL_MS}. */
  readonly ttlMs?: number;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable timer. Defaults to `setTimeout`/`clearTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Called once whenever the hedge is dispatched, win or lose. Must not throw. */
  readonly onHedge?: (event: TranscriberHedgeEvent) => void;
}

/**
 * Race a preferred transcriber against a hedge on a latency budget.
 *
 * Resolution rules, all of them (from §5.3 of the design):
 *
 * 1. Primary resolves before the timer → **primary**. The hedge is never
 *    invoked — no audio leaves the device.
 * 2. Timer fired, primary still resolves first → **primary**; hedge result
 *    discarded.
 * 3. Timer fired, hedge resolves first → **hedge**; `onHedge` fires.
 * 4. Both already resolved → **primary** — privacy is the tie-break, absent
 *    a confidence signal.
 * 5. Primary throws `TranscriberUnavailableError` → hedge takes over
 *    immediately, without waiting for the delay. Same semantics as
 *    `firstCapable`: the primary is demoted and the hedge runs.
 * 6. Primary throws an ordinary error after the hedge succeeded → **hedge's
 *    transcript**.
 * 7. Both throw → **primary's error** propagates; it is the more actionable
 *    one.
 * 8. Primary not `ready` → no race; straight delegation to the hedge.
 *
 * Every discarded promise has a rejection handler attached, or a losing
 * failure surfaces as an unhandled rejection.
 *
 * Returns a {@link CompositeTranscriber} so it is drop-in interchangeable with
 * {@link firstCapable}: `capabilities()` and `invalidate()` keep working, and
 * the primary may itself be a `firstCapable` composite.
 */
export function hedged(
  primary: Transcriber,
  hedge: Transcriber,
  options: HedgedOptions,
): CompositeTranscriber {
  return new HedgedTranscriber(primary, hedge, options);
}

interface CacheEntry {
  capability: TranscriberCapability;
  /** Epoch ms after which this must be re-probed. `Infinity` for permanent verdicts. */
  expiresAt: number;
}

class HedgedTranscriber implements CompositeTranscriber {
  readonly engine: string;

  readonly #primary: Transcriber;
  readonly #hedge: Transcriber;
  readonly #delay: HedgeDelayPolicy;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #scheduleTimer: ScheduleTimer;
  readonly #onHedge: ((event: TranscriberHedgeEvent) => void) | undefined;

  constructor(primary: Transcriber, hedge: Transcriber, options: HedgedOptions) {
    this.#primary = primary;
    this.#hedge = hedge;
    this.engine = options.engine ?? "hedged";
    this.#delay = options.delay;
    this.#ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
    this.#onHedge = options.onHedge;
  }

  async capabilities(): Promise<readonly EngineCapability[]> {
    return [
      { engine: this.#primary.engine, capability: await this.#capabilityOf(this.#primary) },
      { engine: this.#hedge.engine, capability: await this.#capabilityOf(this.#hedge) },
    ];
  }

  async capability(): Promise<TranscriberCapability> {
    const reports = await this.capabilities();
    for (const status of ["ready", "needs-download"] as const) {
      const match = reports.find((report) => report.capability.status === status);
      if (match) return match.capability;
    }
    return reports[0]!.capability;
  }

  async transcribe(recording: Recording, audio: Blob): Promise<Transcript> {
    const primaryCapability = await this.#capabilityOf(this.#primary);
    if (primaryCapability.status !== "ready") {
      // Rule 8: no race — straight delegation to the hedge.
      return this.#delegate(recording, audio);
    }
    return this.#race(recording, audio);
  }

  invalidate(engine?: string): void {
    if (engine === undefined) this.#cache.clear();
    else this.#cache.delete(engine);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Run the hedge directly — no timer, no race. Used when the primary is not
   * ready (rule 8) or when it threw `TranscriberUnavailableError` before the
   * timer fired (rule 5).
   */
  async #delegate(recording: Recording, audio: Blob): Promise<Transcript> {
    const hedgeCapability = await this.#capabilityOf(this.#hedge);
    if (hedgeCapability.status !== "ready") {
      const primaryCapability = await this.#capabilityOf(this.#primary);
      throw noneReady(this.engine, [
        { engine: this.#primary.engine, capability: primaryCapability },
        { engine: this.#hedge.engine, capability: hedgeCapability },
      ]);
    }
    try {
      return await this.#hedge.transcribe(recording, audio);
    } catch (error) {
      if (error instanceof TranscriberUnavailableError) {
        this.#demote(this.#hedge.engine, error.capability);
      }
      throw error;
    }
  }

  /**
   * Start the primary, schedule the timer, and race them. The substantive
   * half of the combinator.
   */
  async #race(recording: Recording, audio: Blob): Promise<Transcript> {
    const primaryPromise = this.#primary.transcribe(recording, audio);

    // Attach a handler immediately so a late rejection is never unhandled.
    const taggedPrimary = primaryPromise.then(
      (transcript) => ({ kind: "primary-resolved" as const, transcript }),
      (error) => ({ kind: "primary-rejected" as const, error: error as Error }),
    );

    let cancelTimer: () => void = () => {};
    const timerPromise = new Promise<"timer">((resolve) => {
      cancelTimer = this.#scheduleTimer(() => resolve("timer"), this.#delay(recording));
    });

    try {
      const first = await Promise.race([taggedPrimary, timerPromise]);

      if (first === "timer") {
        // Timer fired — start the hedge and race them both.
        return await this.#raceAfterTimer(recording, audio, primaryPromise, taggedPrimary);
      }

      // Primary settled before the timer.
      if (first.kind === "primary-resolved") {
        return first.transcript;
      }

      // Rule 5: capability failure hands over to the hedge immediately.
      if (first.error instanceof TranscriberUnavailableError) {
        this.#demote(this.#primary.engine, first.error.capability);
        return this.#delegate(recording, audio);
      }

      // Ordinary attempt failure — the queue owns retries, not us.
      throw first.error;
    } finally {
      cancelTimer();
    }
  }

  /**
   * The timer has fired; the primary is still pending. Start the hedge and
   * race them, handling every resolution combination from the design table.
   */
  async #raceAfterTimer(
    recording: Recording,
    audio: Blob,
    primaryPromise: Promise<Transcript>,
    taggedPrimary: Promise<PrimaryTag>,
  ): Promise<Transcript> {
    const hedgePromise = this.#hedge.transcribe(recording, audio);

    // Attach a handler so a late hedge rejection is never unhandled.
    const taggedHedge = hedgePromise.then(
      (transcript) => ({ kind: "hedge-resolved" as const, transcript }),
      (error) => ({ kind: "hedge-rejected" as const, error: error as Error }),
    );

    // Reaching this method means the hedge was dispatched, which means the audio
    // left the device — whatever happens next. `onHedge` therefore fires exactly
    // once from here, in a `finally`, rather than only on the branches where the
    // hedge wins. Counting only wins would hide the two cases that matter most:
    // a hedge that fired and lost still cost a full managed call and still sent
    // the audio, and it is the *fire* rate, not the win rate, that tells you
    // whether `budgetMs` is set correctly.
    let winner: string | undefined;
    try {
      const first = await Promise.race([taggedPrimary, taggedHedge]);

      if (first.kind === "primary-resolved") {
        winner = this.#primary.engine;
        return first.transcript;
      }

      if (first.kind === "hedge-resolved") {
        winner = this.#hedge.engine;
        return first.transcript;
      }

      if (first.kind === "primary-rejected") {
        if (first.error instanceof TranscriberUnavailableError) {
          this.#demote(this.#primary.engine, first.error.capability);
        }
        // Primary rejected — wait for the hedge. If it succeeds, the hedge
        // wins (rules 5 and 6). If it also fails, the primary's error
        // propagates (rule 7).
        try {
          const transcript = await hedgePromise;
          winner = this.#hedge.engine;
          return transcript;
        } catch (hedgeError) {
          if (hedgeError instanceof TranscriberUnavailableError) {
            this.#demote(this.#hedge.engine, hedgeError.capability);
          }
          throw first.error;
        }
      }

      // first.kind === "hedge-rejected"
      if (first.error instanceof TranscriberUnavailableError) {
        this.#demote(this.#hedge.engine, first.error.capability);
      }
      // Hedge rejected — wait for the primary. If it succeeds, the primary
      // wins. If it also fails, the primary's error propagates (rule 7).
      try {
        const transcript = await primaryPromise;
        winner = this.#primary.engine;
        return transcript;
      } catch (primaryError) {
        if (primaryError instanceof TranscriberUnavailableError) {
          this.#demote(this.#primary.engine, primaryError.capability);
        }
        throw primaryError;
      }
    } finally {
      // `winner` stays undefined when both engines failed. That is a real event,
      // not a missing one: the hedge still ran and was still paid for.
      this.#onHedge?.({
        recordingId: recording.id,
        primary: this.#primary.engine,
        hedge: this.#hedge.engine,
        winner,
      });
    }
  }

  async #capabilityOf(transcriber: Transcriber): Promise<TranscriberCapability> {
    const cached = this.#cache.get(transcriber.engine);
    if (cached && this.#now() < cached.expiresAt) return cached.capability;
    const capability = await probe(transcriber);
    this.#demote(transcriber.engine, capability);
    return capability;
  }

  /** Write (or overwrite) one engine's cached verdict, with the right lifetime. */
  #demote(engine: string, capability: TranscriberCapability): void {
    this.#cache.set(engine, {
      capability,
      expiresAt: isPermanentlyUnavailable(capability) ? Infinity : this.#now() + this.#ttlMs,
    });
  }
}

type PrimaryTag =
  { kind: "primary-resolved"; transcript: Transcript } | { kind: "primary-rejected"; error: Error };

// ---------------------------------------------------------------------------
// Helpers — duplicated from first-capable.ts because the plan forbids
// modifying it, and these are small, stable utilities.
// ---------------------------------------------------------------------------

/** A probe is not permitted to take the caller down; a thrown probe is unavailable. */
async function probe(transcriber: Transcriber): Promise<TranscriberCapability> {
  try {
    return await transcriber.capability();
  } catch (error) {
    return {
      status: "unavailable",
      reason: "unknown",
      detail: `capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function describe({ engine, capability }: EngineCapability): string {
  if (capability.status === "needs-download") {
    return `${engine}: needs-download (${capability.downloadBytes} bytes)`;
  }
  if (capability.status === "unavailable") {
    return `${engine}: unavailable (${capability.reason}) — ${capability.detail}`;
  }
  return `${engine}: ready`;
}

/**
 * Nothing was ready. Same retry decision as `firstCapable`'s `noneCapable`:
 * every engine permanently unavailable → `TerminalQueueError` (stop
 * retrying); anything else → `TranscriberUnavailableError` (retry on next
 * drain).
 */
function noneReady(engine: string, skipped: readonly EngineCapability[]): Error {
  const summary = `no transcriber is ready — ${skipped.map(describe).join("; ")}`;
  if (skipped.every((report) => isPermanentlyUnavailable(report.capability))) {
    return new TerminalQueueError(summary);
  }
  return new TranscriberUnavailableError({
    engine,
    reason: recoverableReason(skipped),
    detail: summary,
  });
}

function recoverableReason(skipped: readonly EngineCapability[]): TranscriberUnavailableReason {
  for (const { capability } of skipped) {
    if (capability.status === "unavailable" && !isPermanentlyUnavailable(capability)) {
      return capability.reason;
    }
  }
  return "model-unavailable";
}
