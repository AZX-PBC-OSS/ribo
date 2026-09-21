import { CapabilityCache } from "./capability-cache.js";
import type { CompositeTranscriber, EngineCapability } from "./first-capable.js";
import { TerminalError } from "../storage/backoff.js";
import type { Recording } from "../capture/recording.js";
import type { Transcript } from "../capture/transcript.js";
import {
  isPermanentlyUnavailable,
  TranscriberUnavailableError,
  type Transcriber,
  type TranscriberCapability,
  type TranscriberUnavailableReason,
  type TranscribeOptions,
} from "./transcriber.js";
import {
  applyTranscriptionVerdict,
  unsupportedFallsThrough,
  type TranscriptionArbiter,
  type TranscriptionArbiterInput,
  type TranscriptionOutcome,
} from "./transcription-arbitration.js";

/**
 * @file `raceTranscriber` — start every capable transcriber at once and let an
 * arbiter decide which transcript to take.
 *
 * The concurrent sibling of `fallbackTranscriber` and the transcription-side
 * counterpart of `raceExtractor`. The policy vocabulary is NOT new: it reuses
 * `transcription-arbitration.ts` — whose `outcomes` contract is settlement
 * order precisely so a concurrent combinator would not need to change it — and
 * adds three things the sequential ladder does not have: concurrent scheduling,
 * capability gating before dispatch, and loser cancellation. The default
 * arbiter stays `unsupportedFallsThrough`; `preferEngineOrder` is the
 * alternative a race usually wants, because a race breaks the ladder's
 * settlement-order-is-preference-order identity.
 *
 * **Every capable engine is dispatched.** That is the point — and the cost: a
 * race that includes a managed engine uploads the audio every time, which is
 * exactly what `firstCapable`'s design avoids. A deployment that will not pay
 * for that simply does not call this; the default composition stays
 * privacy-preserving.
 *
 * **No deadline option.** `TranscribeOptions` has no such member, so offering
 * one would be an option no transport honours. The caller's `signal` reaches
 * every lane.
 *
 * The capability cache is Task 1's extracted module — the third copy of the
 * shape would have been one too many (`capability-cache.ts`'s header records
 * the migration's state).
 */

export interface RaceTranscriberOptions {
  /** `Transcriber.engine` for the composite itself. Defaults to `"race"`. */
  readonly engine?: string;
  /** Defaults to {@link unsupportedFallsThrough}. */
  readonly arbiter?: TranscriptionArbiter;
  /** Capability cache lifetime. Defaults to `DEFAULT_CAPABILITY_TTL_MS`. */
  readonly ttlMs?: number;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Start every capable transcriber at once, feeding the arbiter each outcome as
 * it settles.
 *
 * **Capability gating happens before the race.** An `unavailable` transcriber
 * is excluded rather than raced to a rejection — and so is `needs-download`,
 * on `firstCapable`'s rule: a queue drain can obtain neither the network nor
 * the consent that fetch needs. This matters beyond cost: dispatching to a
 * managed engine uploads the audio, and an engine that cannot serve the item
 * should not receive it. If every engine is gated out, the failure is exactly
 * `firstCapable`'s — a `TerminalError` when every verdict is permanent, a
 * retryable `TranscriberUnavailableError` otherwise.
 *
 * **Scheduling.** Every surviving lane starts at once. Outcomes reach the
 * arbiter in **settlement order** after each settles, with `exhausted` true
 * only once every lane has settled — the contract `TranscriptionArbiterInput`
 * already documents. The verdict is applied by `applyTranscriptionVerdict`,
 * which owns accept / giveUp / continue-at-exhaustion and the
 * "transcript no candidate produced" guard; none of that is reimplemented
 * here.
 *
 * **Losers are cancelled.** Each lane gets its own `AbortController`, composed
 * with the caller's signal via `AbortSignal.any` — never `??`, which would
 * substitute one reason to stop for the other (the trap `grouped-extractor.ts`
 * documents and `timeout-extractor.ts` names). When the arbiter accepts — or
 * gives up, which is the same "race over, no lane may keep spending" decision —
 * every other lane is aborted. **Every lane promise has a rejection handler
 * attached**, or a losing failure surfaces as an unhandled rejection (the
 * discipline `hedged.ts` states).
 *
 * **A loser's abort must never surface as the run's outcome.** `isCancellation`
 * answers true for anything named `AbortError` even while the caller's signal
 * is intact, so a leaked loser rejection would report a successful run as
 * cancelled. A cancelled loser contributes no outcome to the arbiter; a caller
 * abort, by contrast, propagates as the run's own rejection and is never shown
 * to the arbiter at all.
 *
 * Returns a {@link CompositeTranscriber} so it is drop-in interchangeable with
 * `firstCapable` and `hedged`: a host's download screen renders from
 * `capabilities()`.
 */
export function raceTranscriber(
  transcribers: readonly Transcriber[],
  options: RaceTranscriberOptions = {},
): CompositeTranscriber {
  return new RaceTranscriberComposite(transcribers, options);
}

class RaceTranscriberComposite implements CompositeTranscriber {
  readonly engine: string;

  readonly #transcribers: readonly Transcriber[];
  readonly #arbiter: TranscriptionArbiter;
  readonly #cache: CapabilityCache;

  constructor(transcribers: readonly Transcriber[], options: RaceTranscriberOptions) {
    if (transcribers.length === 0) {
      throw new TypeError("raceTranscriber requires at least one transcriber");
    }
    for (const transcriber of transcribers) {
      const duplicate = transcribers.filter((other) => other.engine === transcriber.engine);
      if (duplicate.length > 1) {
        // The capability cache is keyed by engine id, so duplicates would share
        // one entry and gate each other. Cheaper to refuse than to debug.
        throw new TypeError(`raceTranscriber: duplicate engine id "${transcriber.engine}"`);
      }
    }

    this.#transcribers = transcribers;
    this.engine = options.engine ?? "race";
    this.#arbiter = options.arbiter ?? unsupportedFallsThrough;
    this.#cache = new CapabilityCache({ ttlMs: options.ttlMs, now: options.now });
  }

  async capabilities(): Promise<readonly EngineCapability[]> {
    const reports: EngineCapability[] = [];
    for (const transcriber of this.#transcribers) {
      reports.push({
        engine: transcriber.engine,
        capability: await this.#cache.capabilityOf(transcriber),
      });
    }
    return reports;
  }

  /**
   * The best any delegate can currently do — `firstCapable`'s precedence
   * (`ready` beats `needs-download` beats `unavailable`, first in roster order
   * within a tier), so a host renders one composite answer from the race.
   */
  async capability(): Promise<TranscriberCapability> {
    const reports = await this.capabilities();
    for (const status of ["ready", "needs-download"] as const) {
      const match = reports.find((report) => report.capability.status === status);
      if (match) return match.capability;
    }
    return reports[0]!.capability;
  }

  invalidate(engine?: string): void {
    this.#cache.invalidate(engine);
  }

  async transcribe(
    recording: Recording,
    audio: Blob,
    options?: TranscribeOptions,
  ): Promise<Transcript> {
    const callerSignal = options?.signal;

    // Gate every engine through the cache before anything is dispatched. The
    // probes run concurrently — they are independent, and the race should not
    // wait on them serialising — but the roster order is preserved below, which
    // is the order the failure report and capabilities() speak in.
    const probed = await Promise.all(
      this.#transcribers.map((transcriber) => this.#cache.capabilityOf(transcriber)),
    );
    const lanes: Transcriber[] = [];
    const skipped: EngineCapability[] = [];
    this.#transcribers.forEach((transcriber, index) => {
      const capability = probed[index]!;
      if (capability.status === "ready") lanes.push(transcriber);
      else skipped.push({ engine: transcriber.engine, capability });
    });

    if (lanes.length === 0) throw noneCapable(this.engine, skipped);
    if (callerSignal?.aborted) {
      // Already cancelled — no lane receives the audio at all. Without this
      // check the dispatch below would hand the upload to every lane and rely
      // on each transport noticing a signal that was dead on arrival.
      throw callerSignal.reason;
    }

    return new Promise<Transcript>((resolve, reject) => {
      const outcomes: TranscriptionOutcome[] = [];
      const controllers = lanes.map(() => new AbortController());
      let settledCount = 0;
      let runSettled = false;

      const abortLanes = (except: number | undefined) => {
        for (const [index, controller] of controllers.entries()) {
          if (index !== except) controller.abort();
        }
      };

      const settleRun = (except: number | undefined, finish: () => void) => {
        if (runSettled) return;
        runSettled = true;
        abortLanes(except);
        finish();
      };

      if (callerSignal) {
        // The caller's cancel is the run's own outcome, not an arbiter input —
        // an aborted run must reject as a cancellation, never as a give-up.
        // The event fires synchronously during abort(), so every lane
        // rejection that follows lands on a settled run and is dropped.
        const onCallerAbort = () => {
          // `reason` is typed `any` but is whatever the caller passed to
          // `abort()` — an Error in every normal case, and forwarded as-is
          // regardless: rewrapping the caller's own cancel would break identity
          // for a value the caller chose.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          settleRun(undefined, () => reject(callerSignal.reason));
          callerSignal.removeEventListener("abort", onCallerAbort);
        };
        if (callerSignal.aborted) onCallerAbort();
        else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }

      const consult = (laneIndex: number) => {
        if (runSettled) return;
        const input: TranscriptionArbiterInput = {
          outcomes,
          exhausted: settledCount === lanes.length,
        };
        try {
          const result = applyTranscriptionVerdict(this.#arbiter(input), input, this.#arbiter);
          if (result !== "continue") {
            // The race is over: settle with the winner and cancel the rest.
            settleRun(laneIndex, () => resolve(result));
          }
        } catch (error) {
          // giveUp, or a misbehaving arbiter — either way the race is over.
          // The thrown value is the arbiter's `giveUp` payload, deliberately
          // forwarded unchanged (the same throw `fallbackTranscriber` makes);
          // wrapping it in an Error would break the identity its own tests pin.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          settleRun(laneIndex, () => reject(error));
        }
      };

      for (const [index, lane] of lanes.entries()) {
        // The caller's signal and this lane's loser-abort controller are two
        // independent reasons to stop. Compose them with AbortSignal.any — `??`
        // would substitute one for the other, silently disabling loser
        // cancellation whenever a caller supplied a signal.
        const laneSignal = callerSignal
          ? AbortSignal.any([callerSignal, controllers[index]!.signal])
          : controllers[index]!.signal;

        // Forwarded whole, with the signal swapped for this lane's composed
        // one — the same hand-through rule `toSessionExtractStep` states for
        // the extractor side. Both branches are attached immediately, so a
        // late rejection is never unhandled even if the run settles first.
        lane.transcribe(recording, audio, { ...options, signal: laneSignal }).then(
          (transcript) => {
            if (runSettled) return; // a loser's late success — the race is over
            settledCount += 1;
            outcomes.push({ candidate: lane.engine, result: transcript });
            consult(index);
          },
          (error) => {
            if (runSettled) return; // a cancelled loser contributes no outcome
            settledCount += 1;
            outcomes.push({ candidate: lane.engine, error });
            consult(index);
          },
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers — duplicated from first-capable.ts because firstCapable and hedged
// keep their own copies (capability-cache.ts's header records why), and these
// are small, stable utilities.
// ---------------------------------------------------------------------------

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
 * Nothing was ready. Which error this is, is the whole retry decision — the
 * same one `firstCapable` makes, because a race with no capable lanes is the
 * same situation, not a new failure class:
 *
 * - every engine **permanently** unavailable → `TerminalError`; the item lands
 *   in `dead` on the first try instead of burning backed-off attempts.
 * - anything else — a download that has not happened, an uplink that is down —
 *   → `TranscriberUnavailableError`, which `isTransientFailure` already reads
 *   as retryable. The next drain re-probes and may find an engine.
 */
function noneCapable(engine: string, skipped: readonly EngineCapability[]): Error {
  const summary = `no transcriber is ready — ${skipped.map(describe).join("; ")}`;

  if (skipped.every((report) => isPermanentlyUnavailable(report.capability))) {
    return new TerminalError(summary);
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
  // Everything left is `needs-download`: capable, just not fetched yet.
  return "model-unavailable";
}
