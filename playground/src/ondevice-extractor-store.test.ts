import { expect, test, vi } from "vitest";
import type { ChatCapability, ChatClient, ChatCompletion } from "@azx/ribo-extractor-openai";
import type { Connectivity, Transcript } from "@azx/ribo-core";
import { snuggExamples } from "@azx/ribo-adapter-snuggpro";
import type {
  DownloadProgressEvent,
  LanguageModel,
  LanguageModelAvailability,
  LanguageModelCreateOptions,
  LanguageModelMonitor,
} from "@azx/ribo-extractor-ondevice";

import { buildExtractorWiring } from "./extractor-store.js";

// Derived from the public `LanguageModel` interface so the fakes can implement the
// same shape without importing private types from the on-device package.
type LanguageModelSession = Awaited<ReturnType<LanguageModel["create"]>>;
type LanguageModelPromptOptions = NonNullable<
  Parameters<LanguageModelSession["promptStreaming"]>[1]
>;
type LanguageModelPrompt = NonNullable<LanguageModelCreateOptions["initialPrompts"]>[number];
import {
  getOnDeviceExtractorState,
  primeOnDeviceExtractor,
  resetOnDeviceExtractorStoreForTests,
  startOnDeviceExtractor,
  subscribeToOnDeviceExtractor,
} from "./ondevice-extractor-store.js";

/**
 * @file Task 14 — playground on-device extraction wiring.
 *
 * Five rules, each a real bug if broken:
 *
 * 1. The store reports `needs-download` / `ready` from the Prompt API probe.
 * 2. Priming is reachable only through the explicit button action; constructing
 *    and probing the store must never call `create()`.
 * 3. The prime action forwards progress events so the UI can render them.
 * 4. An item extracted on-device is distinguishable: the composite stamps
 *    `usage.engine` as `ondevice-chat`, which reaches the outbox as
 *    `extractedBy`.
 * 5. A connectivity transition invalidates the composite's capability cache.
 *
 * All tests run through local fake `LanguageModel` objects — no real model, no
 * network.
 */

const transcript: Transcript = {
  recordingId: "rec-1",
  text: "A dictated audit transcript, contents irrelevant to the engine test.",
  engine: "fake",
};

test("the store reports needs-download when the model is downloadable, and ready when available", async () => {
  const downloadable = new SimpleFakeLanguageModel();
  downloadable.availabilityValue = "downloadable";
  const available = new SimpleFakeLanguageModel();
  available.availabilityValue = "available";

  resetOnDeviceExtractorStoreForTests(downloadable);
  startOnDeviceExtractor();
  await settle();
  expect(getOnDeviceExtractorState().phase).toBe("needs-download");

  resetOnDeviceExtractorStoreForTests(available);
  startOnDeviceExtractor();
  await settle();
  expect(getOnDeviceExtractorState().phase).toBe("ready");
});

test("constructing the store and probing never calls create()", async () => {
  const model = new SimpleFakeLanguageModel();
  model.availabilityValue = "downloadable";

  resetOnDeviceExtractorStoreForTests(model);
  startOnDeviceExtractor();
  await settle();

  expect(model.createCount).toBe(0);
  expect(getOnDeviceExtractorState().phase).toBe("needs-download");
});

test("the prime action forwards progress events", async () => {
  const model = new SimpleFakeLanguageModel();
  model.availabilityValue = "downloadable";
  model.progressSequence = [
    { loaded: 0, total: 1 },
    { loaded: 0.25, total: 1 },
    { loaded: 0.75, total: 1 },
    { loaded: 1, total: 1 },
  ];

  resetOnDeviceExtractorStoreForTests(model);
  const fractions: number[] = [];
  const unsubscribe = subscribeToOnDeviceExtractor(() => {
    const progress = getOnDeviceExtractorState().progress;
    if (progress !== undefined) fractions.push(progress.fraction);
  });

  primeOnDeviceExtractor();
  await settle();
  unsubscribe();

  expect(getOnDeviceExtractorState().phase).toBe("ready");
  expect(fractions).toContain(0.25);
  expect(fractions).toContain(0.75);
  expect(fractions).toContain(1);
});

test("an item extracted on-device is tagged so review can badge it", async () => {
  const fixture = snuggExamples[0]!.fields as Record<string, unknown>;
  const onDeviceModel = new PerGroupFakeLanguageModel(fixture);
  const unavailableManaged = makeUnavailableManagedChat();

  const { composite } = buildExtractorWiring({
    apiKey: "sk-test",
    baseUrl: "http://test",
    model: "test-model",
    chat: unavailableManaged,
    onDeviceLanguageModel: onDeviceModel,
  });

  const result = await composite.extract(transcript.text);

  expect(result.usage.engine).toBe("ondevice-chat");
});

test("a connectivity transition calls invalidate() on the composite", () => {
  const { connectivity, transition } = createFakeConnectivity("online");
  const { composite } = buildExtractorWiring({
    apiKey: "sk-test",
    baseUrl: "http://test",
    model: "test-model",
    chat: makeUnavailableManagedChat(),
    onDeviceLanguageModel: unavailableLanguageModel(),
    connectivity,
  });

  const invalidate = vi.spyOn(composite, "invalidate");
  transition("offline");

  expect(invalidate).toHaveBeenCalled();
});

// --- helpers -----------------------------------------------------------------

/** Wait for the store's async phase transitions to settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeUnavailableManagedChat(): ChatClient & {
  engine: string;
  capability: () => Promise<ChatCapability>;
} {
  return {
    engine: "openai",
    complete: async (): Promise<ChatCompletion> => {
      throw new Error("managed chat should not be selected");
    },
    capability: async (): Promise<ChatCapability> => ({
      status: "unavailable",
      reason: "not-configured",
      detail: "no managed endpoint in this test",
    }),
  };
}

function unavailableLanguageModel(): LanguageModel {
  return {
    availability: async () => "unavailable",
    create: async () => {
      throw new Error("On-device language model is not available");
    },
  };
}

function createFakeConnectivity(initial: "offline" | "probing" | "online"): {
  connectivity: Connectivity;
  transition: (status: "offline" | "probing" | "online") => void;
} {
  const listeners = new Set<(state: { status: "offline" | "probing" | "online" }) => void>();
  let state: { status: "offline" | "probing" | "online" } = { status: initial };
  return {
    connectivity: {
      get state() {
        return state;
      },
      subscribe(
        listener: (state: { status: "offline" | "probing" | "online" }) => void,
      ): () => void {
        listeners.add(listener);
        listener(state);
        return () => {
          listeners.delete(listener);
        };
      },
      start: () => {},
      stop: () => {},
    },
    transition(status: "offline" | "probing" | "online"): void {
      state = { status };
      for (const listener of listeners) listener(state);
    },
  };
}

function createMonitor(sequence: readonly DownloadProgressEvent[]): LanguageModelMonitor {
  return {
    addEventListener(type, listener) {
      if (type !== "downloadprogress") return;
      for (const event of sequence) listener(event);
    },
  };
}

function extractGroupKey(initialPrompts?: readonly LanguageModelPrompt[]): string {
  const system = initialPrompts?.find((prompt) => prompt.role === "system")?.content ?? "";
  const match = system.match(/exactly one top-level key: `([a-zA-Z0-9_]+)`/);
  return match?.[1] ?? "";
}

class SimpleFakeLanguageModel implements LanguageModel {
  availabilityValue: LanguageModelAvailability = "unavailable";
  createError?: Error;
  progressSequence: readonly DownloadProgressEvent[] = [];
  createCount = 0;
  readonly sessions: SimpleFakeLanguageModelSession[] = [];

  constructor(private readonly response: () => string = () => "") {}

  async availability(): Promise<LanguageModelAvailability> {
    return this.availabilityValue;
  }

  async create(options: LanguageModelCreateOptions = {}): Promise<LanguageModelSession> {
    this.createCount++;
    if (this.createError) throw this.createError;
    if (options.monitor) {
      options.monitor(createMonitor(this.progressSequence));
    }
    const session = new SimpleFakeLanguageModelSession(this.response);
    this.sessions.push(session);
    return session;
  }
}

class SimpleFakeLanguageModelSession implements LanguageModelSession {
  readonly contextWindow = 9216;
  readonly contextUsage = 31;
  destroyed = false;
  readonly prompts: { input: string; options?: LanguageModelPromptOptions }[] = [];

  constructor(private readonly response: () => string) {}

  async measureContextUsage(): Promise<number> {
    return 100;
  }

  async *promptStreaming(
    input: string,
    options: LanguageModelPromptOptions = {},
  ): AsyncIterable<string> {
    this.prompts.push({ input, options });
    yield this.response();
  }

  async clone(): Promise<LanguageModelSession> {
    return new SimpleFakeLanguageModelSession(this.response);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * A fake language model whose sessions yield one top-level group per prompt,
 * so the per-group extractor can merge seven valid group responses.
 */
class PerGroupFakeLanguageModel implements LanguageModel {
  availabilityValue: LanguageModelAvailability = "available";
  createCount = 0;

  constructor(private readonly fixture: Record<string, unknown>) {}

  async availability(): Promise<LanguageModelAvailability> {
    return this.availabilityValue;
  }

  async create(options: LanguageModelCreateOptions = {}): Promise<LanguageModelSession> {
    this.createCount++;
    const session = new PerGroupFakeLanguageModelSession(this.fixture);
    session.groupKey = extractGroupKey(options.initialPrompts);
    return session;
  }
}

class PerGroupFakeLanguageModelSession implements LanguageModelSession {
  readonly contextWindow = 9216;
  readonly contextUsage = 31;
  destroyed = false;
  groupKey = "";
  cloneCount = 0;
  readonly prompts: { input: string; options?: LanguageModelPromptOptions }[] = [];

  constructor(private readonly fixture: Record<string, unknown>) {}

  async measureContextUsage(): Promise<number> {
    return 100;
  }

  async *promptStreaming(
    input: string,
    options: LanguageModelPromptOptions = {},
  ): AsyncIterable<string> {
    this.prompts.push({ input, options });
    const response =
      this.groupKey in this.fixture ? { [this.groupKey]: this.fixture[this.groupKey] } : {};
    yield JSON.stringify(response);
  }

  async clone(): Promise<LanguageModelSession> {
    this.cloneCount++;
    const session = new PerGroupFakeLanguageModelSession(this.fixture);
    session.groupKey = this.groupKey;
    return session;
  }

  destroy(): void {
    this.destroyed = true;
  }
}
