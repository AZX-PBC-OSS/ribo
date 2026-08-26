import type {
  DownloadProgressEvent,
  LanguageModel,
  LanguageModelAvailability,
  LanguageModelCreateOptions,
  LanguageModelMonitor,
} from "../capability.js";

export class FakeLanguageModel implements LanguageModel {
  availabilityValue: LanguageModelAvailability = "unavailable";
  availabilityError?: Error;
  createError?: Error;
  progressSequence: readonly DownloadProgressEvent[] = [];
  chunks: readonly string[] = [];
  createCount = 0;

  async availability(): Promise<LanguageModelAvailability> {
    if (this.availabilityError) throw this.availabilityError;
    return this.availabilityValue;
  }

  async create(
    options: LanguageModelCreateOptions,
  ): Promise<FakeLanguageModelSession> {
    this.createCount++;
    if (this.createError) throw this.createError;

    const monitor = createMonitor(this.progressSequence);
    options.monitor(monitor);

    return new FakeLanguageModelSession(this.chunks);
  }
}

export class FakeLanguageModelSession {
  readonly #chunks: readonly string[];

  constructor(chunks: readonly string[]) {
    this.#chunks = chunks;
  }

  async *promptStreaming(
    input: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<string> {
    for (const chunk of this.#chunks) {
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      yield chunk;
    }
  }
}

function createMonitor(
  sequence: readonly DownloadProgressEvent[],
): LanguageModelMonitor {
  return {
    addEventListener(type, listener) {
      if (type !== "downloadprogress") return;
      for (const event of sequence) listener(event);
    },
  };
}
