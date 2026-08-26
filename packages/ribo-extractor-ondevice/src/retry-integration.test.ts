import { z } from "zod";
import { describe, expect, test } from "vitest";
import { perGroupExtractor } from "@azx/ribo-extractor-openai";
import { enveloped, type ExtractionTarget } from "@azx/ribo-core";

import { OnDeviceChat } from "./ondevice-chat.js";
import {
  degenerateResponse,
  FakeLanguageModel,
  wellFormedResponse,
} from "./test-support/fake-language-model.js";

/**
 * Production on-device delegate timing, mirrored from
 * `playground/src/extractor-store.ts`. Do not import from the playground — a
 * package must not depend on the app.
 */
const ONDEVICE_PER_GROUP_TIMING = {
  concurrency: 1,
  perCallCeilingMs: 15_000,
  maxRetries: 4,
} as const;

const noopDelay = (): Promise<void> => Promise.resolve();

// A minimal grouped extraction target: one top-level group with two leaves.
// `enveloped()` wraps the leaves in the provenance envelope the model emits.
const patchSchema = z.strictObject({
  hvac: z
    .strictObject({
      fuel: z.string().nullable(),
      efficiency: z.number().nullable(),
    })
    .optional(),
});

const extractionSchema = enveloped(patchSchema);
type Values = z.infer<typeof patchSchema>;

const target: ExtractionTarget<Values> = {
  name: "retry-integration",
  extractionSchema,
  instructions: "Extract the hvac fields from the transcript.",
  examples: [],
};

function makeExtractor(model: FakeLanguageModel) {
  const chat = new OnDeviceChat({ languageModel: model });
  return perGroupExtractor({
    target,
    chat,
    model: "ondevice-model",
    concurrency: ONDEVICE_PER_GROUP_TIMING.concurrency,
    perCallCeilingMs: ONDEVICE_PER_GROUP_TIMING.perCallCeilingMs,
    maxRetries: ONDEVICE_PER_GROUP_TIMING.maxRetries,
    stepTimeoutMs: 120_000,
    delay: noopDelay,
  });
}

describe("retry-to-success through perGroupExtractor × OnDeviceChat", () => {
  test("a model that degenerates twice then succeeds produces a successful extraction", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunkDelayMs = 1;
    model.sequence = [degenerateResponse(), degenerateResponse(), [wellFormedResponse()]];

    const extractor = makeExtractor(model);
    const result = await extractor.extract("the boiler is oil-fired, eighty-two percent AFUE");

    expect(result.fields.hvac?.fuel?.value).toBe("Oil");
    expect(result.fields.hvac?.efficiency?.value).toBe(82);
    expect(result.usage.calls).toBe(3);
    expect(model.promptCallCount).toBe(3);
  });

  test("a model that degenerates every attempt fails cleanly without hanging", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunkDelayMs = 1;
    model.sequence = Array.from({ length: ONDEVICE_PER_GROUP_TIMING.maxRetries + 1 }, () =>
      degenerateResponse(),
    );

    const extractor = makeExtractor(model);

    await expect(
      extractor.extract("the boiler is oil-fired, eighty-two percent AFUE"),
    ).rejects.toSatisfy((error: unknown) => error instanceof Error);
  });

  test("the exhausted run makes exactly maxRetries + 1 attempts and no more", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.chunkDelayMs = 1;
    // Provide more scripted attempts than the budget allows — the extractor must
    // stop after maxRetries + 1 rather than consume the whole sequence.
    model.sequence = Array.from({ length: 10 }, () => degenerateResponse());

    const extractor = makeExtractor(model);

    await expect(
      extractor.extract("the boiler is oil-fired, eighty-two percent AFUE"),
    ).rejects.toSatisfy((error: unknown) => error instanceof Error);

    expect(model.promptCallCount).toBe(ONDEVICE_PER_GROUP_TIMING.maxRetries + 1);
  });
});
