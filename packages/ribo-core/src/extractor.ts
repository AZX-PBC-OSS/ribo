import type { ToolAdapter } from "./adapter.js";
import type { SessionExtractStep, ExtractedFieldMap } from "./queue/relay.js";

/**
 * @file The extraction contract: how a transcript becomes structured host-tool fields.
 *
 * This is the seam extraction strategies plug into — the sibling of `transcriber.ts`. It is
 * **only** the seam: it defines the interface, its result envelope, the slice of a
 * {@link ToolAdapter} an extractor reads from, and the one function that collapses any
 * {@link Extractor} onto the relay's injected `ExtractStep`. No model is called here, and
 * `ribo-core` stays headless and LLM-agnostic — the real strategies (single-shot managed LLM,
 * plan-then-execute, a managed endpoint) live in adapter packages and share this seam.
 */
/**
 * What one extraction produced.
 *
 * @typeParam F - the fields this extractor yields. For an adapter-backed extractor that is the
 * ENVELOPED shape, `Enveloped<V>`, whose source of truth is the adapter's `extractionSchema`:
 * the extractor parses raw model output through it before the result becomes field data. It is
 * only after review that the plain-values `V` exists — see `ToolAdapter`'s two schemas.
 */
/**
 * What one extraction run cost and how it was produced.
 *
 * `calls` is the only required member: every extractor knows how many model calls
 * it made, including retries. Everything else is optional because an extractor
 * that cannot report it must not be forced to invent it — `FakeExtractor` makes
 * no calls, an on-device engine reports no tokens, and a single-strategy
 * extractor has no ladder to name.
 *
 * The token counts are summed across every call of the run. They exist so the
 * questions that were previously unanswerable from the field become answerable:
 * what the few-shot example really costs, and whether the provider's prefix cache
 * is being hit at all. The transports have reported them for a while;
 * `helixChat` parsed the cache counts and discarded them for want of somewhere
 * to put them, which is this type.
 */
export interface ExtractionUsage {
  /** Model calls made, including retries. */
  readonly calls: number;
  /** Which transport produced the result — `engine` is *which transport*. */
  readonly engine?: string;
  /** Which approach inside that transport — `strategy` is *which strategy*. */
  readonly strategy?: string;
  /** Prompt tokens summed across every call, when the transport reports them. */
  readonly promptTokens?: number;
  /** Completion tokens summed across every call, when reported. */
  readonly completionTokens?: number;
  /**
   * Prompt tokens served from the provider's prefix cache, summed across calls.
   *
   * Absent means no call reported it; `0` means calls reported it and none hit.
   * That distinction is the difference between "we cannot tell" and "the cache
   * is not working", so the two are never collapsed.
   */
  readonly cachedPromptTokens?: number;
  /** Prompt tokens written into the prefix cache, summed across calls. */
  readonly cacheCreationPromptTokens?: number;
}

export interface ExtractionResult<F> {
  /** The structured fields, already parsed to `F` at the trust boundary. */
  readonly fields: F;
  /** The raw model/endpoint output, kept for provenance and debugging. Optional. */
  readonly raw?: unknown;
  /**
   * What the run cost, and which engine/strategy produced it.
   *
   * `engine` is **optional**, and must stay that way: `FakeExtractor`, the single-shot extractor
   * and the per-group extractor all report `{ calls }` and nothing else, so requiring it would
   * break every existing implementation for the benefit of one. An extractor that composes over
   * several transports sets it; a single-transport extractor need not.
   *
   * It exists because a review card has to be able to say "this draft came from the on-device
   * beta model" — the reviewer's question is not which engine produced field 12, it is whether
   * to trust this card less than usual. Reaching the card takes more than this field: see
   * {@link toExtractStep} and the relay's extract step.
   *
   * `strategy` is the same idea for the *approach* axis: `engine` is *which transport*,
   * `strategy` is *which strategy* inside that transport. It is optional for the same reason
   * `engine` is — a single-strategy extractor has no ladder to name.
   */
  readonly usage: ExtractionUsage;
}

/**
 * Turns a transcript into structured host-tool fields.
 *
 * A plain builder, not a capability contract (the transcriber's `capability()` roster is for
 * runtime device variance; strategy choice here is configuration). One method: hand it the
 * transcript text, get back parsed fields plus provenance. Network-bound, which is why the relay
 * runs it as a queued step — see {@link toExtractStep}.
 */
export interface Extractor<F> {
  extract(transcript: string): Promise<ExtractionResult<F>>;
}

/**
 * The slice of a {@link ToolAdapter} an extractor needs to do its job: the field knowledge, minus
 * `write`.
 *
 * `C` is irrelevant to extraction — writing back is a separate concern — so it is fixed to
 * `unknown` here. An adapter's full `ToolAdapter<V, C>` satisfies this structurally, so a caller
 * hands the same adapter to the extractor and to the relay's write step.
 *
 * It picks **`extractionSchema`**, not `schema`, and carries that name across the boundary rather
 * than renaming it — one name for one thing. An extractor constrains the model, parses the
 * response and imitates the examples, and all three of those are the enveloped shape
 * (`Enveloped<V>`); the plain-values `schema` is the write side and is none of an extractor's
 * business. The type parameter is still `V`, the VALUES type, so a target and its adapter are
 * instantiated at the same argument.
 */
export type ExtractionTarget<V extends Record<string, unknown>> = Pick<
  ToolAdapter<V, unknown>,
  "name" | "extractionSchema" | "instructions" | "examples"
>;

/**
 * Collapse any {@link Extractor} onto the relay's injected `SessionExtractStep`.
 *
 * The relay owns `RelayOptions.sessionExtract` and speaks in `ExtractedFieldMap`; an `Extractor`
 * speaks in `ExtractionResult<F>`. This is the one-line adapter between them, so wiring a strategy
 * into the queue is `createRelay({ ..., sessionExtract: toSessionExtractStep(myExtractor) })` with
 * **no** relay change. `.fields`, the engine, the strategy and the usage totals reach the
 * session; `raw` stays with the extractor, because it is unbounded model output and the session
 * document is not a log.
 *
 * The session extract step receives the **joined transcript text** (all transcribed recordings
 * in capture order, excluding discarded), not a single `Transcript` object — that is the whole
 * point of session-level extraction.
 */
export function toSessionExtractStep<F>(extractor: Extractor<F>): SessionExtractStep {
  return async ({ transcript }) => {
    const result = await extractor.extract(transcript);
    return {
      fields: result.fields as ExtractedFieldMap,
      engine: result.usage.engine,
      usage: result.usage,
    };
  };
}

/** Options for a {@link FakeExtractor} beyond its fixed fields. */
export interface FakeExtractorOptions {
  /** Raw payload to echo back on the result. Omitted from the result when unset. */
  readonly raw?: unknown;
  /** Usage to report. Defaults to `{ calls: 0 }` — a fake makes no model calls. */
  readonly usage?: ExtractionResult<unknown>["usage"];
}

/**
 * An {@link Extractor} that returns fixed fields instead of calling a model.
 *
 * The parallel of `FakeTranscriber`: a shipped test double, not scaffolding. It lets the relay,
 * the tests and the playground drive capture → transcribe → **extract** → review → write with no
 * network and no key. Substitute it into the queue with `toExtractStep(new FakeExtractor(...))`.
 */
export class FakeExtractor<F> implements Extractor<F> {
  readonly #fields: F;
  readonly #raw: unknown;
  readonly #usage: ExtractionResult<unknown>["usage"];
  readonly #calls: string[] = [];

  constructor(fields: F, options: FakeExtractorOptions = {}) {
    this.#fields = fields;
    this.#raw = options.raw;
    this.#usage = options.usage ?? { calls: 0 };
  }

  /** The transcript text of every `extract()` call, in order — for asserting what was passed. */
  get calls(): readonly string[] {
    return this.#calls;
  }

  extract(transcript: string): Promise<ExtractionResult<F>> {
    this.#calls.push(transcript);
    const base = { fields: this.#fields, usage: this.#usage };
    return Promise.resolve(this.#raw === undefined ? base : { ...base, raw: this.#raw });
  }
}
