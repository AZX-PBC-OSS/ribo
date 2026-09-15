import { z } from "zod";
import { describe, expect, test, vi } from "vitest";
import { ChatError } from "@azx/ribo-extractor-openai";
import { enveloped, type ExtractionTarget, type PhaseUnit } from "@azx/ribo-core";

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

    const result = await makeExtractor(model).extract({
      text: "the system is gas",
      annotations: {},
    });

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
    const result = await extractor.extract({
      text: "nothing about the site was said",
      annotations: {},
    });

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
    const result = await extractor.extract({ text: "the boiler is oil-fired", annotations: {} });

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
    const result = await extractor.extract({ text: "the system is gas", annotations: {} });

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

    const result = await makeExtractor(model).extract({
      text: "the boiler is oil-fired",
      annotations: {},
    });

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

    const result = await makeExtractor(model).extract({
      text: "the system is gas",
      annotations: {},
    });

    expect(result.usage.calls).toBe(4);
    expect(result.usage.engine).toBe("ondevice-chat");
  });

  describe("array-shaped groups (R1.6 instance modeling)", () => {
    // Since R1.6, a collection group (hvac/attic/wall/window/dhw in the real Snugg Pro
    // schema) is `z.array(...)`, not a flat object of enveloped leaves. `extractGroups`
    // must walk into the array's element schema to enumerate its leaves, and the
    // extraction loop must wrap its single filled-in instance back into a one-element
    // array so the result still validates against the (required, array-typed) group
    // key in the extraction schema.
    const instancePatchSchema = z.strictObject({
      hvac: z
        .array(
          z.strictObject({
            fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
          }),
        )
        .optional(),
      site: z
        .strictObject({
          yearBuilt: z.number().nullable().optional(),
        })
        .optional(),
    });
    const instanceExtractionSchema = enveloped(instancePatchSchema);
    type InstanceValues = z.infer<typeof instancePatchSchema>;
    const instanceTarget: ExtractionTarget<InstanceValues> = {
      name: "instance-test",
      extractionSchema: instanceExtractionSchema,
      instructions: "Extract the fields from the transcript.",
      examples: [],
    };

    test("a leaf discussed inside an array-shaped group is extracted, not dropped", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      model.sequence = [
        // hvac phase 0: fuel is discussed.
        [json({ fuel: true })],
        // hvac phase 1: verbatim quote.
        [json({ fuel: "the system is gas" })],
        // hvac phase 2: classify.
        [json("Gas")],
        // site phase 0: nothing discussed.
        [json({ yearBuilt: false })],
      ];

      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({ target: instanceTarget, chat, maxRetries: 3 });
      const result = await extractor.extract({ text: "the system is gas", annotations: {} });

      // Before the fix, `hvac` (an array-shaped group) is dropped entirely by the
      // schema walk, and `target.extractionSchema.parse()` throws on the missing
      // required `hvac` key instead of ever reaching these assertions.
      expect(result.fields.hvac).toHaveLength(1);
      expect(result.fields.hvac[0]!.fuel.value).toBe("Gas");
      expect(result.fields.hvac[0]!.fuel.sourceSpan).toBe("the system is gas");
      expect(result.fields.hvac[0]!.fuel.confidence).toBe(1);
      expect(result.fields.site.yearBuilt.value).toBeNull();
    });

    test("an array-shaped group with nothing discussed still yields one null-filled instance", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      model.sequence = [
        // hvac phase 0: nothing discussed, no phase-1 call follows.
        [json({ fuel: false })],
        // site phase 0: nothing discussed.
        [json({ yearBuilt: false })],
      ];

      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({ target: instanceTarget, chat, maxRetries: 3 });
      const result = await extractor.extract({
        text: "nothing relevant was said",
        annotations: {},
      });

      // Matches `perGroupSingletonExtractor`'s convention elsewhere in this codebase:
      // a collection group always comes back as a one-element array, never an empty
      // one — it just cannot represent a second instance.
      expect(result.fields.hvac).toHaveLength(1);
      expect(result.fields.hvac[0]!.fuel.value).toBeNull();
      expect(result.fields.hvac[0]!.fuel.sourceSpan).toBeNull();
      expect(result.usage.calls).toBe(2);
    });
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
    const result = await extractor.extract({ text: "the boiler is oil-fired", annotations: {} });

    expect(result.fields.hvac.fuel.value).toBe("Oil");
    expect(result.fields.hvac.fuel.sourceSpan).toBe("the boiler is oil-fired");
    expect(result.fields.hvac.fuel.confidence).toBe(1);
    // phase-0 + phase-1 attempt 1 + phase-1 retry + phase-2 = 4.
    expect(result.usage.calls).toBe(4);
  });

  describe("a group that declared coarser provenance is refused at construction", () => {
    /**
     * This strategy is per-leaf provenance all the way down: phase 1 asks for one verbatim span
     * PER LEAF, and phase 2 classifies that leaf's value out of that span. A group derived at
     * `"row"` or `"none"` granularity has no per-leaf envelope to read, so `extractGroups` finds
     * no leaves in it, asks the model about nothing, and emits an empty object for the group —
     * which the closing `extractionSchema.parse()` then rejects, after every other group's calls
     * have already been spent.
     *
     * Refusing at construction turns that into a wiring error a caller sees immediately. It is
     * deliberately a refusal rather than support: making phase 1 ask for one ROW span and phase 2
     * classify every leaf out of it is a real (and probably good) design, but it is a different
     * strategy, not a patch to this one.
     */
    const rowPatch = z.strictObject({
      rooms: z.array(z.strictObject({ name: z.string().nullable().optional() })).optional(),
    });
    const provenance = { rooms: "row" } as const;

    test('a "row" group throws, naming the group and the granularity', () => {
      const rowTarget: ExtractionTarget<z.infer<typeof rowPatch>, typeof provenance> = {
        name: "row-target",
        extractionSchema: enveloped(rowPatch, { provenance }),
        instructions: "",
        examples: [],
      };
      const chat = new OnDeviceChat({ languageModel: new FakeLanguageModel() });

      expect(() => threePhaseExtractor({ target: rowTarget, chat })).toThrow(/"rooms"/);
    });

    test('a "none" group throws too — there is no span for phase 1 to ask for', () => {
      const noneTarget: ExtractionTarget<z.infer<typeof rowPatch>, { rooms: "none" }> = {
        name: "none-target",
        extractionSchema: enveloped(rowPatch, { provenance: { rooms: "none" } }),
        instructions: "",
        examples: [],
      };
      const chat = new OnDeviceChat({ languageModel: new FakeLanguageModel() });

      expect(() => threePhaseExtractor({ target: noneTarget, chat })).toThrow(/"rooms"/);
    });

    test("the default leaf derivation is untouched — it still constructs", () => {
      const chat = new OnDeviceChat({ languageModel: new FakeLanguageModel() });

      expect(() => threePhaseExtractor({ target, chat })).not.toThrow();
    });
  });

  describe("extraction observer", () => {
    test("emits pass 0, pass 1, and pass 2 per active leaf when every leaf is present", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      const transcript =
        "the system is gas efficiency is 82 percent notes need replacement built in 1950 easy access";
      model.sequence = [
        [json({ fuel: true, efficiency: true, notes: true })],
        [
          json({
            fuel: "the system is gas",
            efficiency: "efficiency is 82 percent",
            notes: "notes need replacement",
          }),
        ],
        [json("Gas")],
        [json(82)],
        [json("notes need replacement")],
        [json({ yearBuilt: true, access: true })],
        [json({ yearBuilt: "built in 1950", access: "easy access" })],
        [json(1950)],
        [json("Easy")],
      ];

      const events: PhaseUnit[] = [];
      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({
        target,
        chat,
        maxRetries: 3,
        onUnit: (e) => events.push(e),
      });
      await extractor.extract({ text: transcript, annotations: {} });

      const starts = events.filter((e) => e.phase === "start");

      const hvacPass0 = starts.filter((e) => e.key === "hvac" && e.pass === 0);
      expect(hvacPass0).toHaveLength(1);
      const hvacPass1 = starts.filter((e) => e.key === "hvac" && e.pass === 1);
      expect(hvacPass1).toHaveLength(1);
      const hvacPass2 = starts.filter((e) => e.key === "hvac" && e.pass === 2);
      expect(hvacPass2).toHaveLength(3);
      expect(hvacPass2.map((e) => e.leaf).sort()).toEqual(["efficiency", "fuel", "notes"]);

      const sitePass0 = starts.filter((e) => e.key === "site" && e.pass === 0);
      expect(sitePass0).toHaveLength(1);
      const sitePass1 = starts.filter((e) => e.key === "site" && e.pass === 1);
      expect(sitePass1).toHaveLength(1);
      const sitePass2 = starts.filter((e) => e.key === "site" && e.pass === 2);
      expect(sitePass2).toHaveLength(2);
      expect(sitePass2.map((e) => e.leaf).sort()).toEqual(["access", "yearBuilt"]);
    });

    test("a pass-0 unit carries no leaf", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      model.sequence = [
        [json({ fuel: true, efficiency: false, notes: false })],
        [json({ fuel: "the system is gas" })],
        [json("Gas")],
        [json({ yearBuilt: false, access: false })],
      ];

      const events: PhaseUnit[] = [];
      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({
        target,
        chat,
        maxRetries: 3,
        onUnit: (e) => events.push(e),
      });
      await extractor.extract({ text: "the system is gas", annotations: {} });

      const pass0Events = events.filter((e) => e.pass === 0);
      expect(pass0Events.length).toBeGreaterThan(0);
      for (const e of pass0Events) {
        expect(e.leaf).toBeUndefined();
      }
    });

    test("a group whose presence call fails every attempt emits maxRetries+1 errors and extract still resolves", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      model.sequence = [
        ChatError.transport("phase 0 failure"),
        ChatError.transport("phase 0 failure"),
        ChatError.transport("phase 0 failure"),
        ChatError.transport("phase 0 failure"),
        [json({ yearBuilt: false, access: false })],
      ];

      const events: PhaseUnit[] = [];
      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({
        target,
        chat,
        maxRetries: 3,
        onUnit: (e) => events.push(e),
      });
      const result = await extractor.extract({ text: "nothing relevant", annotations: {} });

      const hvacErrors = events.filter((e) => e.key === "hvac" && e.phase === "error");
      expect(hvacErrors).toHaveLength(4);
      const hvacPass1or2 = events.filter((e) => e.key === "hvac" && (e.pass === 1 || e.pass === 2));
      expect(hvacPass1or2).toHaveLength(0);

      expect(result.fields.hvac.fuel.value).toBeNull();
      expect(result.fields.site.yearBuilt.value).toBeNull();
    });

    test("a leaf whose bare classify hits unsupported and succeeds wrapped emits under one id with continuing attempts", async () => {
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
        name: "unsupported-test",
        extractionSchema: singleLeafSchema,
        instructions: "Extract hvac fields.",
        examples: [],
      };

      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      model.sequence = [
        [json({ fuel: true })],
        [json({ fuel: "the system is gas" })],
        new DOMException("not supported", "NotSupportedError"),
        [json({ value: "Gas" })],
      ];

      const events: PhaseUnit[] = [];
      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({
        target: singleLeafTarget,
        chat,
        maxRetries: 3,
        onUnit: (e) => events.push(e),
      });
      await extractor.extract({ text: "the system is gas", annotations: {} });

      const phase2 = events.filter((e) => e.pass === 2);
      const ids = new Set(phase2.map((e) => e.id));
      expect(ids.size).toBe(1);

      const attempts = phase2.filter((e) => e.phase === "start").map((e) => e.attempt);
      expect(attempts).toEqual([1, 2]);
    });

    test("usage.calls equals the number of start events", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      const transcript =
        "the system is gas efficiency is 82 percent notes need replacement built in 1950 easy access";
      model.sequence = [
        [json({ fuel: true, efficiency: true, notes: true })],
        [
          json({
            fuel: "the system is gas",
            efficiency: "efficiency is 82 percent",
            notes: "notes need replacement",
          }),
        ],
        [json("Gas")],
        [json(82)],
        [json("notes need replacement")],
        [json({ yearBuilt: true, access: true })],
        [json({ yearBuilt: "built in 1950", access: "easy access" })],
        [json(1950)],
        [json("Easy")],
      ];

      const events: PhaseUnit[] = [];
      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({
        target,
        chat,
        maxRetries: 3,
        onUnit: (e) => events.push(e),
      });
      const result = await extractor.extract({ text: transcript, annotations: {} });

      const startCount = events.filter((e) => e.phase === "start").length;
      expect(result.usage.calls).toBe(startCount);
    });

    test("with onUnit absent, an identical run produces an identical result and usage.calls", async () => {
      const model1 = new FakeLanguageModel();
      model1.availabilityValue = "available";
      model1.sequence = [
        [json({ fuel: true, efficiency: false, notes: false })],
        [json({ fuel: "the system is gas" })],
        [json("Gas")],
        [json({ yearBuilt: false, access: false })],
      ];
      const chat1 = new OnDeviceChat({ languageModel: model1 });
      const extractor1 = threePhaseExtractor({ target, chat: chat1, maxRetries: 3 });
      const result1 = await extractor1.extract({ text: "the system is gas", annotations: {} });

      const model2 = new FakeLanguageModel();
      model2.availabilityValue = "available";
      model2.sequence = [
        [json({ fuel: true, efficiency: false, notes: false })],
        [json({ fuel: "the system is gas" })],
        [json("Gas")],
        [json({ yearBuilt: false, access: false })],
      ];
      const events: PhaseUnit[] = [];
      const chat2 = new OnDeviceChat({ languageModel: model2 });
      const extractor2 = threePhaseExtractor({
        target,
        chat: chat2,
        maxRetries: 3,
        onUnit: (e) => events.push(e),
      });
      const result2 = await extractor2.extract({ text: "the system is gas", annotations: {} });

      expect(result2.fields).toEqual(result1.fields);
      expect(result2.usage.calls).toBe(result1.usage.calls);
    });
  });

  describe("an aborted run rejects, it does not resolve empty", () => {
    // The group-level catch nulls a failed group's leaves and moves on — right
    // for an extraction failure, catastrophic for a cancellation: a caller who
    // aborted would get all-null fields indistinguishable from a document that
    // genuinely said nothing. So every test here asserts the REJECTION; a test
    // asserting only that fields are null would pass against the old behaviour.
    test("an already-aborted signal starts no calls and rejects immediately", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      model.sequence = [[json({ fuel: true, efficiency: false, notes: false })]];
      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({ target, chat, maxRetries: 3 });

      const controller = new AbortController();
      controller.abort();

      const error: unknown = await extractor
        .extract({ text: "the system is gas", annotations: {} }, { signal: controller.signal })
        .then(
          () => undefined,
          (cause) => cause,
        );

      expect(error).toBeInstanceOf(ChatError);
      expect((error as ChatError).kind).toBe("aborted");
      // No call was made, not even a doomed one: the abort short-circuits
      // before the transport is reached.
      expect(model.promptCallCount).toBe(0);
    });

    test("an abort during an in-flight phase call rejects, and retries that never ran are not counted", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      // A slow multi-chunk stream, so the abort lands MID-call rather than
      // between calls — the transport must observe the cancellation and the
      // retry loops must not phantom-retry past it.
      model.chunks = ['{"fuel":', " true,", ' "efficiency":', " false,", ' "notes":', " false}"];
      model.chunkDelayMs = 50;
      const chat = new OnDeviceChat({ languageModel: model });

      const events: PhaseUnit[] = [];
      const extractor = threePhaseExtractor({
        target,
        chat,
        maxRetries: 3,
        onUnit: (e) => events.push(e),
      });

      const controller = new AbortController();
      const run = extractor.extract(
        { text: "the system is gas", annotations: {} },
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(model.promptCallCount).toBe(1));
      controller.abort();

      const error: unknown = await run.then(
        () => undefined,
        (cause) => cause,
      );

      expect(error).toBeInstanceOf(ChatError);
      expect((error as ChatError).kind).toBe("aborted");
      // usage.calls is derived from start events (pinned elsewhere in this
      // file), so this is the "retries that never ran are not counted"
      // assertion: only the one attempt that actually started, no phantom
      // retries fired at an already-aborted signal.
      expect(events.filter((e) => e.phase === "start")).toHaveLength(1);
    });
  });
});
