import { DEFAULT_CAPABILITY_TTL_MS } from "./first-capable.js";
import type { Extractor } from "./extractor.js";
import { createSequentialExtractor } from "./arbitration.js";
import type {
  ArbiterInput,
  ArbiterVerdict,
  ErrorOutcome,
  ExtractionOutcome,
  ResultOutcome,
} from "./arbitration.js";

/**
 * The capability shape this combinator selects on.
 *
 * Deliberately structural and minimal rather than an import of any one engine's capability type.
 * The composite reads three things — whether it is `ready`, and a reason plus detail for the
 * "nothing was selectable" error — and needs nothing else. `ChatCapability` in
 * `ribo-extractor-openai` satisfies this without declaring that it does, which is what keeps this
 * file free of any transport concept.
 *
 * `reason` is `string` rather than a closed union on purpose: each engine family names its own
 * reasons (`ChatUnavailableReason`, `TranscriberUnavailableReason`), and a combinator that only
 * formats them into an error message has no business constraining that vocabulary.
 */
export type SelectableCapability =
  | { readonly status: "ready" }
  | { readonly status: "needs-download"; readonly detail?: string }
  | { readonly status: "unavailable"; readonly reason: string; readonly detail: string };

/**
 * What the composite needs from an engine: an id to attribute the result to, and a cheap probe.
 *
 * **Not a `ChatClient`.** The composite never sends a request — it picks an extractor and gets
 * out of the way. Requiring a transport would couple a core combinator to an LLM concept it does
 * not use, which is exactly how this file ended up in the wrong package to begin with.
 */
export interface CapabilitySource {
  readonly engine: string;
  capability(): Promise<SelectableCapability>;
}

/**
 * @file `compositeExtractor` — the extraction sibling of `firstCapable`.
 *
 * The shape is the same: an ordered list of engines, first one that is `ready` wins,
 * capability answers are cached on a TTL, and `invalidate()` drops the cache. But the
 * preference order is **inverted** relative to the transcriber on purpose. See
 * `docs/roadmap/design/ondevice-extraction-design.md` §3.4.
 *
 * For transcription, on-device is preferred: it is free, private, and fast enough when
 * it fits. The managed path is the fallback. For extraction, on-device is a ~3B
 * parameter model against a frontier managed model, so it is accepted only when the
 * managed path cannot run at all — in practice, when the network is gone. The same
 * combinator, opposite direction: managed-first rescues the offline path, instead of
 * device-first rescuing the online one.
 *
 * Selection is per **extraction**, not per call. The winning delegate's extractor
 * runs the whole extraction (all seven group calls for the per-group strategy). That
 * keeps the timing budget the delegate was configured for intact; switching transports
 * mid-extraction would invalidate that budget.
 *
 * The implementation is now a thin adapter over the shared
 * {@link createSequentialExtractor} engine: the capability probe is the admission
 * hook, the arbiter accepts the first result and propagates the first error, and the
 * engine's `"engine"` stamp reproduces the previous provenance. The TTL cache and
 * `invalidate()` stay in this file because the engine has no clock.
 */

/** One entry in the composite roster: a capability source and the extractor built over it. */
export interface CompositeExtractorEntry<F> {
  readonly source: CapabilitySource;
  readonly extractor: Extractor<F>;
}

/** What {@link compositeExtractor} returns: an `Extractor` plus cache control. */
export interface CompositeExtractor<F> extends Extractor<F> {
  /** Drop cached capabilities and re-probe on the next `extract()`. */
  invalidate(): void;
}

/** One cached capability answer, keyed by engine id. */
interface CachedCapability {
  readonly capability: SelectableCapability;
  readonly expiresAt: number;
}

/** Options for {@link compositeExtractor}. */
export interface CompositeExtractorOptions {
  /** Capability cache lifetime. Defaults to {@link DEFAULT_CAPABILITY_TTL_MS}. */
  ttlMs?: number;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Try each engine in order and run the extractor built over the first one that is
 * `ready`.
 *
 * Selection rules, all of them:
 *
 * 1. `ready` is selectable. Nothing else is.
 * 2. `needs-download` is **never** selected. That fetch needs a user gesture and a
 *    human's consent, and a background queue drain can obtain neither. It is reported in
 *    the "no entry ready" error so a UI can ask; it is not acted on here.
 * 3. `unavailable` is skipped.
 * 4. A thrown probe is treated as `unavailable` — a probe is not permitted to take the
 *    caller down.
 * 5. Once an entry is selected, its extractor runs to completion. Any error from that
 *    extractor propagates untouched; the composite does not fall back mid-extraction.
 *
 * The winning entry's `source.engine` is stamped onto `result.usage.engine` so provenance
 * survives the boundary.
 */
export function compositeExtractor<F>(
  entries: readonly CompositeExtractorEntry<F>[],
  options: CompositeExtractorOptions = {},
): CompositeExtractor<F> {
  const ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CachedCapability>();

  const engine = createSequentialExtractor<F>({
    candidates: entries.map((entry) => ({
      id: entry.source.engine,
      extractor: entry.extractor,
      probe: async () => {
        const capability = await capabilityOf(entry.source, cache, now, ttlMs);
        if (capability.status === "ready") {
          return { admitted: true };
        }
        return { admitted: false, detail: capability };
      },
    })),
    arbiter: compositeArbiter,
    stampKey: "engine",
    buildNoAdmissionError: (rejected) =>
      new Error(
        `no extractor is ready — ${rejected
          .map((entry) => describe(entry.id, entry.detail as SelectableCapability))
          .join("; ")}`,
      ),
  });

  return {
    ...engine,
    invalidate: () => {
      cache.clear();
    },
  };
}

/** The arbiter for a composite: accept the first result, or give up with the first error. */
function compositeArbiter<F>(input: ArbiterInput<F>): ArbiterVerdict<F> {
  const firstResult = input.outcomes.find(isResultOutcome);
  if (firstResult) {
    return { accept: firstResult.result };
  }

  const firstError = input.outcomes.find(isErrorOutcome);
  if (firstError) {
    return { giveUp: firstError.error };
  }

  return { continue: true };
}

function isResultOutcome<F>(outcome: ExtractionOutcome<F>): outcome is ResultOutcome<F> {
  return outcome.result !== undefined;
}

function isErrorOutcome<F>(outcome: ExtractionOutcome<F>): outcome is ErrorOutcome<F> {
  return outcome.result === undefined;
}

/** Fetch a capability from the cache or probe and cache the answer. */
async function capabilityOf(
  source: CapabilitySource,
  cache: Map<string, CachedCapability>,
  now: () => number,
  ttlMs: number,
): Promise<SelectableCapability> {
  const cached = cache.get(source.engine);
  if (cached && now() < cached.expiresAt) return cached.capability;

  const capability = await probe(source);
  cache.set(source.engine, {
    capability,
    expiresAt: now() + ttlMs,
  });
  return capability;
}

/** A probe is not permitted to take the caller down; a thrown probe is an unavailable engine. */
async function probe(source: CapabilitySource): Promise<SelectableCapability> {
  try {
    return await source.capability();
  } catch (error) {
    return {
      status: "unavailable",
      reason: "unknown",
      detail: `capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function describe(id: string, capability: SelectableCapability): string {
  if (capability.status === "needs-download") {
    return `${id}: needs-download${capability.detail ? ` — ${capability.detail}` : ""}`;
  }
  if (capability.status === "unavailable") {
    return `${id}: unavailable (${capability.reason}) — ${capability.detail}`;
  }
  return `${id}: ready`;
}
