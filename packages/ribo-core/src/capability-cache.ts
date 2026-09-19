import { DEFAULT_CAPABILITY_TTL_MS } from "./first-capable.js";
import {
  isPermanentlyUnavailable,
  type Transcriber,
  type TranscriberCapability,
} from "./transcriber.js";

/**
 * @file The TTL-keyed capability cache the transcription combinators share.
 *
 * Extracted from `first-capable.ts` when `raceTranscriber` became the third
 * copy of the same shape — `hedged` was already a second copy, because the plan
 * that added it forbade modifying `first-capable.ts`. Both copies are
 * line-for-line identical, so what is extracted here is exactly what they
 * share: a per-engine verdict keyed by `Transcriber.engine`, an injectable
 * clock, a TTL, permanent verdicts cached without expiry, and an
 * invalidate-one-or-all.
 *
 * **The migration is deliberate and unfinished.** `firstCapable` and `hedged`
 * still carry their own copies of this shape, which changes no shipped
 * behaviour; moving them onto this module is a follow-up, not an error to fix
 * in passing. Do not add a fourth copy — use this one.
 *
 * The default TTL is `first-capable.ts`'s `DEFAULT_CAPABILITY_TTL_MS` rather
 * than a second constant: the number is a compromise between probe cost and
 * staleness (see its doc), and two spellings of one compromise would drift.
 */

export interface CapabilityCacheOptions {
  /** Capability cache lifetime. Defaults to {@link DEFAULT_CAPABILITY_TTL_MS}. */
  readonly ttlMs?: number;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface CacheEntry {
  capability: TranscriberCapability;
  /** Epoch ms after which this must be re-probed. `Infinity` for permanent verdicts. */
  expiresAt: number;
}

/**
 * The per-engine capability cache behind every transcription combinator.
 *
 * Reads go through {@link CapabilityCache.capabilityOf}, which probes on a miss
 * (or past expiry) and stores the answer with the right lifetime. Writes go
 * through {@link CapabilityCache.remember}, so a combinator whose *attempt* (not
 * probe) discovers a capability failure can replace a stale answer mid-flight —
 * the demotion is the caller's judgement; the cache only owns the lifetime rule.
 */
export class CapabilityCache {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: CapabilityCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * The transcriber's current capability, from the cache when fresh.
   *
   * A rejecting probe is not permitted to take the caller down: it reads as
   * `unavailable` with reason `"unknown"`, which is not a permanent verdict, so
   * a transiently broken probe gets the TTL rather than the life of the page.
   */
  async capabilityOf(transcriber: Transcriber): Promise<TranscriberCapability> {
    const cached = this.#entries.get(transcriber.engine);
    if (cached && this.#now() < cached.expiresAt) return cached.capability;

    const capability = await probe(transcriber);
    this.remember(transcriber.engine, capability);
    return capability;
  }

  /** Write (or overwrite) one engine's cached verdict, with the right lifetime. */
  remember(engine: string, capability: TranscriberCapability): void {
    this.#entries.set(engine, {
      capability,
      // A permanent verdict is a fact about this device, so it is cached for the
      // life of the page: WebGPU does not appear mid-session and re-probing for
      // it is pure cost. Everything else — ready, needs-download, offline, a
      // missing model — is a situation, and gets the TTL.
      expiresAt: isPermanentlyUnavailable(capability) ? Infinity : this.#now() + this.#ttlMs,
    });
  }

  /**
   * Drop cached capabilities and re-probe on next use: one engine by id, or all
   * of them.
   *
   * This is how "the model finished downloading" and "the device came back
   * online" are announced. Cheaper and far more responsive than shortening the
   * TTL.
   */
  invalidate(engine?: string): void {
    if (engine === undefined) this.#entries.clear();
    else this.#entries.delete(engine);
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
