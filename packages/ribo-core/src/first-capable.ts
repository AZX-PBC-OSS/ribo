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
 * @file `firstCapable` — the one composition combinator.
 *
 * It lives in `ribo-core`, next to the interface, because it is dependency-free and because the
 * alternative is every consumer writing their own selection loop and getting the
 * capability-versus-attempt distinction subtly wrong in a different way each time.
 *
 * **It is not a policy engine, and it must not grow into one.** Fallback is narrower than it
 * looks: the managed transcriber needs the network, so when the auditor is offline — the primary
 * scenario, and the entire reason on-device exists — the fallback cannot run either. Fallback
 * rescues the *online* path, which was already the easy case. So: ordered list, first one ready
 * wins, no scoring, no health windows, no hysteresis.
 */

/**
 * How long a capability answer is reused before re-probing. 30 s.
 *
 * The number is a compromise between two real costs. Probing is not free — a WebGPU adapter
 * request plus a model-file stat, per item, across a forty-recording drain, is a visible stall.
 * And availability genuinely changes: an uplink drops mid-drain and the managed path should stop
 * being chosen within seconds, not minutes. 30 s keeps a drain to roughly one probe per engine
 * while bounding how long a stale `ready` can be believed.
 *
 * It is a backstop, not the mechanism. The events that actually matter — a finished model
 * download, an `online` event — are expected to call {@link CompositeTranscriber.invalidate}
 * rather than wait this out.
 */
export const DEFAULT_CAPABILITY_TTL_MS = 30_000;

/** One engine's answer, tagged with whose answer it is. */
export interface EngineCapability {
  readonly engine: string;
  readonly capability: TranscriberCapability;
}

/**
 * A preferred engine was passed over and a later one ran.
 *
 * Emitted only when something was actually skipped, so a handler that logs unconditionally is
 * still quiet on the happy path — and loud on exactly the failure that is otherwise invisible:
 * every recording silently going to cloud STT while everyone believes the fleet is
 * offline-capable.
 */
export interface TranscriberFallback {
  /** The recording being transcribed when the fallback happened. */
  readonly recordingId: string;
  /** Every engine passed over, in preference order, and why. */
  readonly skipped: readonly EngineCapability[];
  /** The engine that ran. */
  readonly selected: string;
}

export interface FirstCapableOptions {
  /** `Transcriber.engine` for the composite itself. Defaults to `"first-capable"`. */
  engine?: string;
  /** Capability cache lifetime. Defaults to {@link DEFAULT_CAPABILITY_TTL_MS}. */
  ttlMs?: number;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Called whenever a preferred engine was skipped. Must not throw. */
  onFallback?: (event: TranscriberFallback) => void;
}

/** What {@link firstCapable} returns: a `Transcriber` plus the roster it is made of. */
export interface CompositeTranscriber extends Transcriber {
  /**
   * Every delegate's current capability, in preference order — the roster a download screen
   * renders from. Reads through the same cache `transcribe` uses, so asking is cheap and the
   * answer cannot disagree with what selection would do.
   */
  capabilities(): Promise<readonly EngineCapability[]>;
  /**
   * Drop cached capabilities and re-probe on next use: one engine by id, or all of them.
   *
   * This is how "the model finished downloading" and "the device came back online" are
   * announced. Cheaper and far more responsive than shortening the TTL.
   */
  invalidate(engine?: string): void;
}

interface CacheEntry {
  capability: TranscriberCapability;
  /** Epoch ms after which this must be re-probed. `Infinity` for permanent verdicts. */
  expiresAt: number;
}

/**
 * Try each transcriber in order and use the first one that is **ready**.
 *
 * Selection rules, all of them:
 *
 * 1. `ready` is selectable. Nothing else is.
 * 2. `needs-download` is **never** selected. That fetch needs network and a human's consent, and
 *    a background queue drain can obtain neither. It is reported through {@link
 *    CompositeTranscriber.capabilities} so a UI can ask; it is not acted on here.
 * 3. `unavailable` is skipped.
 * 4. A {@link TranscriberUnavailableError} thrown from `transcribe` demotes that engine — its
 *    cached capability is replaced with the one the error implies — and the next engine is tried
 *    within the same call.
 * 5. **Any other error propagates untouched.** That is an attempt failure and the queue already
 *    owns it. Falling through on it would let one OOMed clip permanently demote a device to the
 *    cloud, which is the exact bug this contract exists to prevent.
 */
export function firstCapable(
  transcribers: readonly Transcriber[],
  options: FirstCapableOptions = {},
): CompositeTranscriber {
  return new FirstCapableTranscriber(transcribers, options);
}

class FirstCapableTranscriber implements CompositeTranscriber {
  readonly engine: string;

  readonly #transcribers: readonly Transcriber[];
  readonly #cache = new Map<string, CacheEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #onFallback: ((event: TranscriberFallback) => void) | undefined;

  constructor(transcribers: readonly Transcriber[], options: FirstCapableOptions) {
    if (transcribers.length === 0) {
      throw new TypeError("firstCapable requires at least one transcriber");
    }
    for (const transcriber of transcribers) {
      const duplicate = transcribers.filter((other) => other.engine === transcriber.engine);
      if (duplicate.length > 1) {
        // The capability cache is keyed by engine id, so duplicates would share
        // one entry and demote each other. Cheaper to refuse than to debug.
        throw new TypeError(`firstCapable: duplicate engine id "${transcriber.engine}"`);
      }
    }

    this.#transcribers = transcribers;
    this.engine = options.engine ?? "first-capable";
    this.#ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#onFallback = options.onFallback;
  }

  async capabilities(): Promise<readonly EngineCapability[]> {
    const reports: EngineCapability[] = [];
    for (const transcriber of this.#transcribers) {
      reports.push({
        engine: transcriber.engine,
        capability: await this.#capabilityOf(transcriber),
      });
    }
    return reports;
  }

  /**
   * The best any delegate can currently do.
   *
   * `ready` beats `needs-download` beats `unavailable`, and within a tier the first in preference
   * order wins. So a device with no network and no downloaded model reports `needs-download`,
   * not `unavailable` — which is the difference between offering the auditor a download and
   * telling them their tablet cannot do this.
   */
  async capability(): Promise<TranscriberCapability> {
    const reports = await this.capabilities();
    for (const status of ["ready", "needs-download"] as const) {
      const match = reports.find((report) => report.capability.status === status);
      if (match) return match.capability;
    }
    return reports[0]!.capability;
  }

  async transcribe(recording: Recording, audio: Blob): Promise<Transcript> {
    const skipped: EngineCapability[] = [];

    for (const transcriber of this.#transcribers) {
      const capability = await this.#capabilityOf(transcriber);
      if (capability.status !== "ready") {
        skipped.push({ engine: transcriber.engine, capability });
        continue;
      }

      try {
        const transcript = await transcriber.transcribe(recording, audio);
        if (skipped.length > 0) {
          this.#onFallback?.({
            recordingId: recording.id,
            skipped: [...skipped],
            selected: transcriber.engine,
          });
        }
        // Returned as-is. The transcript's `engine` is the engine that actually
        // ran, never this wrapper — that is what makes provenance survive
        // nesting, and what makes the queue's engine mix mean anything.
        return transcript;
      } catch (error) {
        if (!(error instanceof TranscriberUnavailableError)) throw error;
        this.#demote(transcriber.engine, error.capability);
        skipped.push({ engine: transcriber.engine, capability: error.capability });
      }
    }

    throw noneCapable(this.engine, skipped);
  }

  invalidate(engine?: string): void {
    if (engine === undefined) this.#cache.clear();
    else this.#cache.delete(engine);
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
      // A permanent verdict is a fact about this device, so it is cached for the
      // life of the page: WebGPU does not appear mid-session and re-probing for
      // it is pure cost. Everything else — ready, needs-download, offline, a
      // missing model — is a situation, and gets the TTL.
      expiresAt: isPermanentlyUnavailable(capability) ? Infinity : this.#now() + this.#ttlMs,
    });
  }
}

/** A probe is not permitted to take the caller down; a thrown probe is an unavailable engine. */
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
 * Nothing was ready. Which error that is, is the whole retry decision:
 *
 * - every engine **permanently** unavailable → `TerminalQueueError`. This device will never do
 *   it, so burning eight backed-off attempts to prove that is waste, and the item should land in
 *   `dead` with a message saying why on the first try.
 * - anything else — a download that has not happened, an uplink that is down — →
 *   `TranscriberUnavailableError`, which `isTransientFailure` already reads as retryable. The
 *   next drain re-probes and may find an engine.
 */
function noneCapable(engine: string, skipped: readonly EngineCapability[]): Error {
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
  // Everything left is `needs-download`: capable, just not fetched yet.
  return "model-unavailable";
}
