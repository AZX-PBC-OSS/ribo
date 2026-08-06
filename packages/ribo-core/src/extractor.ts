import type { ToolAdapter } from "./adapter.js";
import type { ExtractStep, ExtractedFieldMap } from "./queue/relay.js";

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
export interface ExtractionResult<F> {
  /** The structured fields, already parsed to `F` at the trust boundary. */
  readonly fields: F;
  /** The raw model/endpoint output, kept for provenance and debugging. Optional. */
  readonly raw?: unknown;
  /** What the run cost — today just how many model calls it took. */
  readonly usage: { readonly calls: number };
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
export type ExtractionTarget<V> = Pick<
  ToolAdapter<V, unknown>,
  "name" | "extractionSchema" | "instructions" | "examples"
>;

/**
 * Collapse any {@link Extractor} onto the relay's injected `ExtractStep`.
 *
 * The relay owns `RelayOptions.extract` and speaks in `ExtractedFieldMap`; an `Extractor` speaks
 * in `ExtractionResult<F>`. This is the one-line adapter between them, so wiring a strategy into
 * the queue is `createRelay({ ..., extract: toExtractStep(myExtractor) })` with **no** relay
 * change. Only `.fields` reaches the outbox; `raw` and `usage` stay with the extractor.
 */
export function toExtractStep<F>(extractor: Extractor<F>): ExtractStep {
  return async ({ transcript }) => {
    const result = await extractor.extract(transcript.text);
    return result.fields as ExtractedFieldMap;
  };
}

/** Options for a {@link FakeExtractor} beyond its fixed fields. */
export interface FakeExtractorOptions {
  /** Raw payload to echo back on the result. Omitted from the result when unset. */
  readonly raw?: unknown;
  /** Usage to report. Defaults to `{ calls: 0 }` — a fake makes no model calls. */
  readonly usage?: { readonly calls: number };
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
  readonly #usage: { readonly calls: number };
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
