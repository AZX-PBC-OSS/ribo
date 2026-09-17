import { z } from "zod";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type { NoProvenance } from "./enveloped.js";
import type {
  ExtractOptions,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  ExtractionUsage,
} from "./extractor.js";

/**
 * @file `cachedExtractor` — memoisation over the `Extractor` seam
 * (`sp2-judging-combinators-design.md` §4.4, wave-3 plan Task 2). It wraps any
 * {@link Extractor}, derives a key from the transcript and the WHOLE extraction
 * target, and serves a repeat call from the injected store instead of the model.
 *
 * The decisions most worth restating here:
 *
 * - **The key covers the whole prompt, not just the schema.** `ExtractionTarget`
 *   is `{ name, extractionSchema, instructions, examples }`, and instructions
 *   and examples ARE the prompt — two targets identical in name and schema but
 *   differing in examples produce different output. A key omitting them serves
 *   one's result for the other: the same silent-wrong-data failure the key
 *   exists to prevent, introduced by the key itself.
 * - **Failures are never cached**, and **neither a read nor a write may fail the
 *   extraction**. A read that throws degrades to a miss. A write that throws — a
 *   quota, a structured-clone failure — is swallowed after the result is already
 *   in hand: failing there would discard a result the inner extractor has
 *   already been paid for. A cache that can take down extraction is worse than
 *   no cache.
 * - **A hit reports `calls: 0`.** The stored result's usage describes the run
 *   that produced it, and this run made no model calls — returning the stored
 *   count books a spend that did not happen. That usage is exactly what
 *   `budgetExtractor` reads and what `toSessionExtractStep` forwards to the
 *   session, so an unrewritten hit would make a ceiling fire on a free run.
 *   `engine` and `strategy` survive the rewrite — they describe what produced
 *   the fields, which is still true — and the token members are dropped with
 *   the count.
 * - **The store is injected, in-memory `Map` by default.** `PluginStorage` looks
 *   like the obvious backing and is the wrong lifetime — its scope is documented
 *   as entries dying with the capture, so it cannot serve the
 *   re-run-the-same-transcript case a cache exists for. Do not reach for it.
 * - **The default key carries a `v1:` prefix.** The in-memory default dies with
 *   the process, but an injected store may be persistent, and a later change to
 *   the serialisation or the digest would then serve keys computed under the old
 *   recipe. One line of insurance against a class of bug that is invisible when
 *   it happens.
 */

/** The store {@link cachedExtractor} memoises through. Injected, not constructed. */
export interface ExtractionCache {
  /** The stored result under `key`, or `undefined` on a miss. */
  get: (key: string) => Promise<ExtractionResult<unknown> | undefined>;
  /** Store `result` under `key`. A throw is swallowed by the combinator, not surfaced. */
  set: (key: string, result: ExtractionResult<unknown>) => Promise<void>;
}

/** What a caller supplies to {@link cachedExtractor}. */
export interface CachedExtractorOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /**
   * The whole extraction target the inner extractor was built against — read for
   * the key on every call. `instructions` and `examples` are part of the prompt,
   * so they are part of the key: see the file header for the failure a cheaper
   * key invites.
   */
  readonly target: ExtractionTarget<V, P>;
  /**
   * The store to memoise through. Defaults to a private in-memory `Map` that
   * dies with the combinator — pass a persistent implementation only if the
   * `v1:` key prefix's recipe-versioning is understood. `PluginStorage` is the
   * wrong lifetime: its entries die with the capture, which cannot serve the
   * re-run-the-same-transcript case a cache exists for.
   */
  readonly cache?: ExtractionCache;
  /**
   * A caller-supplied key, replacing the default digest — for a host that
   * already holds a cheaper identity (a content hash, say) and should not pay
   * for `z.toJSONSchema` plus a `crypto.subtle` round trip. Receives the same
   * two inputs the default derives from; what it does with them is its own
   * contract with its own store. May return a string or a promise of one.
   */
  readonly keyFor?: (
    transcript: AnnotatedTranscript,
    target: ExtractionTarget<V, P>,
  ) => Promise<string> | string;
}

/**
 * A stable serialisation: object keys SORTED, array elements in POSITIONAL
 * order. Two structurally identical objects built in different key order
 * produce the same string — otherwise the cache misses at random and the bug
 * presents as a performance problem rather than a correctness one. Array order
 * is meaningful and preserved — `examples` is an array and few-shot order is
 * part of the prompt; a serialiser that "stabilised" arrays too would make two
 * targets differing only in example order collide, reintroducing by the fix the
 * exact silent-wrong-data failure the key exists to prevent.
 *
 * `undefined` object members are skipped and undefined array elements render as
 * `null`, matching `JSON.stringify`'s own semantics.
 */
const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((element) => stableStringify(element)).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`)
    .join(",")}}`;
};

/** SHA-256 over `input`, hex-encoded — `crypto.subtle`, because core is browser-side. */
const sha256Hex = async (input: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * The default key: a digest over the transcript text, `target.name`,
 * `target.instructions`, a stable serialisation of `target.examples`, and a
 * stable serialisation of `z.toJSONSchema(target.extractionSchema, { target:
 * "draft-2020-12" })` — the serialisation this repo already uses to send a
 * schema to a model. The parts are `JSON.stringify`-joined as an array, so no
 * concatenation ambiguity can fuse one part's suffix into another's prefix.
 */
const defaultKeyFor = async <V extends Record<string, unknown>, P>(
  transcript: AnnotatedTranscript,
  target: ExtractionTarget<V, P>,
): Promise<string> => {
  const material = JSON.stringify([
    transcript.text,
    target.name,
    target.instructions,
    stableStringify(target.examples ?? []),
    stableStringify(z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" })),
  ]);
  return `v1:${await sha256Hex(material)}`;
};

/** The default {@link ExtractionCache}: a private in-memory `Map`, per combinator. */
const mapCache = (): ExtractionCache => {
  const map = new Map<string, ExtractionResult<unknown>>();
  return {
    get: async (key) => map.get(key),
    set: async (key, result) => {
      map.set(key, result);
    },
  };
};

/**
 * Wrap an {@link Extractor} so a repeat call over the same transcript and the
 * same target is served from the cache instead of the model.
 *
 * On each `extract` call the key is computed (awaited — the default digest is
 * async, and `extract` is already async), the cache is read, and on a miss the
 * inner extractor runs with the caller's options bag forwarded whole; the
 * result is stored and returned **by identity**. On a hit the stored result is
 * served with its usage rewritten — `calls: 0`, `engine` and `strategy` kept,
 * token members dropped — because this run made no model calls (see the file
 * header for why that rewrite is load-bearing). The stored result itself is
 * never mutated: the hit is a shallow copy carrying the rewritten usage.
 *
 * A rejecting inner call throws before any write, so failures are never cached
 * and the next call retries. A cache `get` that throws is a miss; a cache `set`
 * that throws is swallowed — the result is already in hand and paid for.
 */
export function cachedExtractor<F, V extends Record<string, unknown>, P = NoProvenance>(
  extractor: Extractor<F>,
  options: CachedExtractorOptions<V, P>,
): Extractor<F> {
  const cache = options.cache ?? mapCache();
  const keyFor = options.keyFor ?? defaultKeyFor<V, P>;

  return {
    extract: async (
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<F>> => {
      const key = await keyFor(transcript, options.target);

      // A read that throws degrades to a miss — the cache must never take the
      // extraction down, and a miss costs only the model call that was coming.
      let stored: ExtractionResult<unknown> | undefined;
      try {
        stored = await cache.get(key);
      } catch {
        stored = undefined;
      }

      if (stored !== undefined) {
        const storedUsage = stored.usage;
        const usage: ExtractionUsage = {
          calls: 0,
          ...(storedUsage.engine === undefined ? {} : { engine: storedUsage.engine }),
          ...(storedUsage.strategy === undefined ? {} : { strategy: storedUsage.strategy }),
        };
        // Sound within this combinator's own discipline — only results the
        // inner extractor produced, typed `F`, ever enter the default cache.
        // An injected cache is the host's store and the host's discipline,
        // which is the same trust-boundary story every cache tells.
        return { ...stored, usage } as ExtractionResult<F>;
      }

      // No try/catch around the inner call: a failure propagates unchanged and
      // reaches NO cache write — a cached rejection would turn one bad minute
      // into a permanent one.
      const result = await extractor.extract(transcript, callerOptions);

      try {
        await cache.set(key, result);
      } catch {
        // Swallowed: the result is already in hand and paid for. Failing here
        // would discard it — the same principle the read rule states.
      }
      return result;
    },
  };
}
