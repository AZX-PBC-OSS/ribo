/**
 * @file The fake `LanguageModel` every unit test in this package drives.
 *
 * Chrome's Prompt API is a browser global backed by a multi-gigabyte model that needs a user
 * gesture to download, so no unit test can touch the real thing. This double stands in for it
 * and is deliberately built for the whole package rather than for one test: the session
 * lifecycle, the streaming loop-kill and the retry path all drive it, and three divergent fakes
 * would be three different ideas of what the API does.
 *
 * It models what was **measured** against real Chrome, not what the explainer documents — the
 * two differ. In particular `create()` throws `NotAllowedError` without a user gesture, which is
 * undocumented, and a degenerate response is an unbounded run of whitespace rather than an
 * error.
 */

import type {
  DownloadProgressEvent,
  LanguageModel,
  LanguageModelAvailability,
  LanguageModelCreateOptions,
  LanguageModelMonitor,
  LanguageModelPromptOptions,
  LanguageModelSession,
} from "../capability.js";

export class FakeLanguageModel implements LanguageModel {
  availabilityValue: LanguageModelAvailability = "unavailable";
  availabilityError?: Error;
  createError?: Error;
  progressSequence: readonly DownloadProgressEvent[] = [];

  /** Chunks each `promptStreaming` yields. Sessions created from here inherit it. */
  chunks: readonly string[] = [];
  /** Milliseconds to wait between yielded chunks, for tests that need a slow stream. */
  chunkDelayMs = 0;
  /** If set, every new session inherits this and throws it from `promptStreaming`. */
  promptError?: Error;

  /** How many times `create()` was called — the no-background-download assertion. */
  createCount = 0;
  /** Every session handed out, base and clone alike, in creation order. */
  readonly sessions: FakeLanguageModelSession[] = [];

  async availability(): Promise<LanguageModelAvailability> {
    if (this.availabilityError) throw this.availabilityError;
    return this.availabilityValue;
  }

  async create(options: LanguageModelCreateOptions = {}): Promise<LanguageModelSession> {
    this.createCount++;
    if (this.createError) throw this.createError;

    // `monitor` is optional in the real API and absent on the common path — only `prime()`
    // passes one. Calling it unconditionally would throw on every lazy session build.
    if (options.monitor) {
      options.monitor(createMonitor(this.progressSequence));
    }

    const session = new FakeLanguageModelSession(this);
    session.createOptions = options;
    session.promptError = this.promptError;
    this.sessions.push(session);
    return session;
  }
}

export class FakeLanguageModelSession implements LanguageModelSession {
  readonly #model: FakeLanguageModel;

  contextWindow = 9216;
  contextUsage = 31;
  /** Set to true by {@link destroy}, so a test can assert cleanup on every path. */
  destroyed = false;
  /** How many clones this session handed out. */
  cloneCount = 0;
  /** Every `promptStreaming` call's input and options, in order. */
  readonly prompts: { input: string; options?: LanguageModelPromptOptions }[] = [];
  /** True once a stream was abandoned by an abort — proof the abort actually cancelled it. */
  streamCancelled = false;
  /** The options this session was created with, so tests can inspect initialPrompts. */
  createOptions?: LanguageModelCreateOptions;
  /** If set, `promptStreaming` throws this instead of yielding chunks. */
  promptError?: Error;

  constructor(model: FakeLanguageModel) {
    this.#model = model;
  }

  measureContextUsage(input: string): Promise<number> {
    // Roughly the measured 0.26 tokens per byte. Deterministic, so a test asserting a
    // pre-flight rejection can pick an input length and know what it will price at.
    return Promise.resolve(Math.ceil(input.length * 0.26));
  }

  async *promptStreaming(
    input: string,
    options: LanguageModelPromptOptions = {},
  ): AsyncIterable<string> {
    this.prompts.push({ input, options });
    if (this.promptError) throw this.promptError;
    for (const chunk of this.#model.chunks) {
      if (options.signal?.aborted) {
        this.streamCancelled = true;
        throw new DOMException("The operation was aborted", "AbortError");
      }
      if (this.#model.chunkDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#model.chunkDelayMs));
      }
      yield chunk;
    }
  }

  async clone(): Promise<LanguageModelSession> {
    this.cloneCount++;
    const session = new FakeLanguageModelSession(this.#model);
    session.promptError = this.promptError;
    this.#model.sessions.push(session);
    return session;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function createMonitor(sequence: readonly DownloadProgressEvent[]): LanguageModelMonitor {
  return {
    addEventListener(type, listener) {
      if (type !== "downloadprogress") return;
      for (const event of sequence) listener(event);
    },
  };
}

/** A response shaped like a real successful extraction, for no-false-positive assertions. */
export function wellFormedResponse(): string {
  return JSON.stringify(
    {
      hvac: {
        fuel: { value: "Oil", confidence: 1, sourceSpan: "boiler is an oil-fired unit" },
        efficiency: { value: 82, confidence: 0.95, sourceSpan: "eighty-two percent AFUE" },
      },
    },
    null,
    2,
  );
}

/** Content, then the unbounded whitespace run that is the real degeneration. */
export function degenerateResponse(): string[] {
  return [
    '{"hvac": {"fuel": {"value": "Oil", "confidence": 1, "sourceSpan": "oil-fired"}',
    ...Array.from({ length: 40 }, () => "\n  "),
  ];
}
