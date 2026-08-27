import { DEFAULT_CAPABILITY_TTL_MS } from "./first-capable.js";
import type { Extractor, ExtractionResult } from "./extractor.js";

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
  return new CompositeExtractorImpl(entries, options);
}

class CompositeExtractorImpl<F> implements CompositeExtractor<F> {
  readonly #entries: readonly CompositeExtractorEntry<F>[];
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedCapability>();

  constructor(entries: readonly CompositeExtractorEntry<F>[], options: CompositeExtractorOptions) {
    if (entries.length === 0) {
      throw new TypeError("compositeExtractor requires at least one entry");
    }
    for (const entry of entries) {
      const duplicates = entries.filter((other) => other.source.engine === entry.source.engine);
      if (duplicates.length > 1) {
        // The capability cache is keyed by engine id, so duplicates would share one
        // entry and demote each other. Cheaper to refuse than to debug.
        throw new TypeError(`compositeExtractor: duplicate engine id "${entry.source.engine}"`);
      }
    }

    this.#entries = entries;
    this.#ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  async extract(transcript: string): Promise<ExtractionResult<F>> {
    const skipped: { readonly engine: string; readonly capability: SelectableCapability }[] = [];

    for (const entry of this.#entries) {
      const capability = await this.#capabilityOf(entry.source);
      if (capability.status !== "ready") {
        skipped.push({ engine: entry.source.engine, capability });
        continue;
      }

      const result = await entry.extractor.extract(transcript);
      return {
        ...result,
        usage: { ...result.usage, engine: entry.source.engine },
      };
    }

    throw new Error(`no extractor is ready — ${skipped.map(describe).join("; ")}`);
  }

  invalidate(): void {
    this.#cache.clear();
  }

  async #capabilityOf(source: CapabilitySource): Promise<SelectableCapability> {
    const cached = this.#cache.get(source.engine);
    if (cached && this.#now() < cached.expiresAt) return cached.capability;

    const capability = await probe(source);
    this.#cache.set(source.engine, {
      capability,
      expiresAt: this.#now() + this.#ttlMs,
    });
    return capability;
  }
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

function describe(entry: { engine: string; capability: SelectableCapability }): string {
  const { engine, capability } = entry;
  if (capability.status === "needs-download") {
    return `${engine}: needs-download${capability.detail ? ` — ${capability.detail}` : ""}`;
  }
  if (capability.status === "unavailable") {
    return `${engine}: unavailable (${capability.reason}) — ${capability.detail}`;
  }
  return `${engine}: ready`;
}
