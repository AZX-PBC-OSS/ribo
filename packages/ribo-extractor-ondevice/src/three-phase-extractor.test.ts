import { z } from "zod";
import { describe, expect, test } from "vitest";
import { ChatError } from "@azx/ribo-extractor-openai";
import { enveloped, type ExtractionTarget } from "@azx/ribo-core";

import { OnDeviceChat } from "./ondevice-chat.js";
import { threePhaseExtractor } from "./index.js";
import { FakeLanguageModel } from "./test-support/fake-language-model.js";

/**
 * A two-group extraction target used by most tests. It is intentionally small and
 * adapter-free: proving the extractor works against a generic grouped schema.
 */
const patchSchema = z.strictObject({
  hvac: z
    .strictObject({
      fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
      efficiency: z.number().nullable().optional(),
      notes: z.string().nullable().optional(),
    })
    .optional(),
  site: z
    .strictObject({
      yearBuilt: z.number().nullable().optional(),
      access: z.enum(["Easy", "Hard"]).nullable().optional(),
    })
    .optional(),
});

const extractionSchema = enveloped(patchSchema);
type Values = z.infer<typeof patchSchema>;

const target: ExtractionTarget<Values> = {
  name: "three-phase-test",
  extractionSchema,
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

function makeExtractor(model: FakeLanguageModel) {
  const chat = new OnDeviceChat({ languageModel: model });
  return threePhaseExtractor({ target, chat, maxRetries: 3 });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("threePhaseExtractor", () => {
  test("a phase-0 false leaf produces a null envelope and avoids phase 1 and 2", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.sequence = [
      // hvac phase 0: only fuel is discussed.
      [json({ fuel: true, efficiency: false, notes: false })],
      // hvac phase 1: only the true leaves are asked for verbatim quotes.
      [json({ fuel: "the system is gas" })],
      // hvac phase 2: classify the fuel quote.
      [json("Gas")],
      // site phase 0: nothing discussed.
      [json({ yearBuilt: false, access: false })],
    ];

    const result = await makeExtractor(model).extract("the system is gas");

    expect(result.fields.hvac.fuel.value).toBe("Gas");
    expect(result.fields.hvac.fuel.sourceSpan).toBe("the system is gas");
    expect(result.fields.hvac.fuel.confidence).toBe(1);

    expect(result.fields.hvac.efficiency.value).toBeNull();
    expect(result.fields.hvac.efficiency.sourceSpan).toBeNull();
    expect(result.fields.hvac.notes.value).toBeNull();
    expect(result.fields.hvac.notes.sourceSpan).toBeNull();

    expect(result.fields.site.yearBuilt.value).toBeNull();
    expect(result.fields.site.access.value).toBeNull();

    // 1 phase-0 + 1 phase-1 + 1 phase-2 + 1 phase-0 = 4. If the false leaves had
    // also been run through phases 1 and 2, the count would be higher.
    expect(result.usage.calls).toBe(4);
    expect(result.usage.engine).toBe("ondevice-chat");
  });

  test("a group where every leaf is false makes no phase-1 call", async () => {
    const siteOnlyPatch = z.strictObject({
      site: z
        .strictObject({
          yearBuilt: z.number().nullable().optional(),
          access: z.enum(["Easy", "Hard"]).nullable().optional(),
        })
        .optional(),
    });
    const siteOnlySchema = enveloped(siteOnlyPatch);
    type SiteOnlyValues = z.infer<typeof siteOnlyPatch>;
    const siteOnlyTarget: ExtractionTarget<SiteOnlyValues> = {
      name: "site-only-test",
      extractionSchema: siteOnlySchema,
      instructions: "Extract site fields.",
      examples: [],
    };

    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.sequence = [[json({ yearBuilt: false, access: false })]];

    const chat = new OnDeviceChat({ languageModel: model });
    const extractor = threePhaseExtractor({ target: siteOnlyTarget, chat, maxRetries: 3 });
    const result = await extractor.extract("nothing about the site was said");

    expect(result.fields.site.yearBuilt.value).toBeNull();
    expect(result.fields.site.access.value).toBeNull();
    expect(result.usage.calls).toBe(1);
    expect(model.promptCallCount).toBe(1);
  });

  test("a leaf with a grounded span classifies into a confident envelope", async () => {
    const singleLeafPatch = z.strictObject({
      hvac: z
        .strictObject({
          fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
        })
        .optional(),
    });
    const singleLeafSchema = enveloped(singleLeafPatch);
    type SingleLeafValues = z.infer<typeof singleLeafPatch>;
    const singleLeafTarget: ExtractionTarget<SingleLeafValues> = {
      name: "single-leaf-test",
      extractionSchema: singleLeafSchema,
      instructions: "Extract hvac fields.",
      examples: [],
    };

    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.sequence = [
      [json({ fuel: true })],
      [json({ fuel: "the boiler is oil-fired" })],
      [json("Oil")],
    ];

    const chat = new OnDeviceChat({ languageModel: model });
    const extractor = threePhaseExtractor({ target: singleLeafTarget, chat, maxRetries: 3 });
    const result = await extractor.extract("the boiler is oil-fired");

    expect(result.fields.hvac.fuel.value).toBe("Oil");
    expect(result.fields.hvac.fuel.sourceSpan).toBe("the boiler is oil-fired");
    expect(result.fields.hvac.fuel.confidence).toBe(1);
    expect(result.usage.calls).toBe(3);
  });

  test("an ungrounded span drops both value and sourceSpan", async () => {
    const singleLeafPatch = z.strictObject({
      hvac: z
        .strictObject({
          fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
        })
        .optional(),
    });
    const singleLeafSchema = enveloped(singleLeafPatch);
    type SingleLeafValues = z.infer<typeof singleLeafPatch>;
    const singleLeafTarget: ExtractionTarget<SingleLeafValues> = {
      name: "ungrounded-test",
      extractionSchema: singleLeafSchema,
      instructions: "Extract hvac fields.",
      examples: [],
    };

    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.sequence = [
      [json({ fuel: true })],
      // The quote is not a verbatim substring of the transcript.
      [json({ fuel: "this invented quote never appears" })],
    ];

    const chat = new OnDeviceChat({ languageModel: model });
    const extractor = threePhaseExtractor({ target: singleLeafTarget, chat, maxRetries: 3 });
    const result = await extractor.extract("the system is gas");

    expect(result.fields.hvac.fuel.value).toBeNull();
    expect(result.fields.hvac.fuel.sourceSpan).toBeNull();
    // No phase-2 call is made for an ungrounded span.
    expect(result.usage.calls).toBe(2);
  });

  test("every leaf in the schema appears in the output, even when never discussed", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.sequence = [
      [json({ fuel: true, efficiency: false, notes: false })],
      [json({ fuel: "the boiler is oil-fired" })],
      [json("Oil")],
      [json({ yearBuilt: false, access: false })],
    ];

    const result = await makeExtractor(model).extract("the boiler is oil-fired");

    expect(Object.keys(result.fields.hvac)).toEqual(["fuel", "efficiency", "notes"]);
    expect(Object.keys(result.fields.site)).toEqual(["yearBuilt", "access"]);
    expect(result.fields.hvac.efficiency).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: null,
    });
    expect(result.fields.site.yearBuilt).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: null,
    });
  });

  test("usage.calls reflects the real call count and usage.engine is the on-device id", async () => {
    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.sequence = [
      [json({ fuel: true, efficiency: false, notes: false })],
      [json({ fuel: "the system is gas" })],
      [json("Gas")],
      [json({ yearBuilt: false, access: false })],
    ];

    const result = await makeExtractor(model).extract("the system is gas");

    expect(result.usage.calls).toBe(4);
    expect(result.usage.engine).toBe("ondevice-chat");
  });

  test("a degenerate phase-1 call is retried and can still succeed", async () => {
    const singleLeafPatch = z.strictObject({
      hvac: z
        .strictObject({
          fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
        })
        .optional(),
    });
    const singleLeafSchema = enveloped(singleLeafPatch);
    type SingleLeafValues = z.infer<typeof singleLeafPatch>;
    const singleLeafTarget: ExtractionTarget<SingleLeafValues> = {
      name: "degenerate-test",
      extractionSchema: singleLeafSchema,
      instructions: "Extract hvac fields.",
      examples: [],
    };

    const model = new FakeLanguageModel();
    model.availabilityValue = "available";
    model.sequence = [
      [json({ fuel: true })],
      ChatError.transport(
        "OnDeviceChat: the model output degenerated into a trailing whitespace loop",
      ),
      [json({ fuel: "the boiler is oil-fired" })],
      [json("Oil")],
    ];

    const chat = new OnDeviceChat({ languageModel: model });
    const extractor = threePhaseExtractor({ target: singleLeafTarget, chat, maxRetries: 3 });
    const result = await extractor.extract("the boiler is oil-fired");

    expect(result.fields.hvac.fuel.value).toBe("Oil");
    expect(result.fields.hvac.fuel.sourceSpan).toBe("the boiler is oil-fired");
    expect(result.fields.hvac.fuel.confidence).toBe(1);
    // phase-0 + phase-1 attempt 1 + phase-1 retry + phase-2 = 4.
    expect(result.usage.calls).toBe(4);
  });
});
