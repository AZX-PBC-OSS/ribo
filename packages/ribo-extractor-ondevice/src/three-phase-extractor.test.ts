import { z } from "zod";
import { describe, expect, test, vi } from "vitest";
import { ChatError } from "@azx/ribo-extractor-openai";
import {
  enveloped,
  isCancellation,
  phasedExtractor,
  type ExtractionTarget,
  type PhaseUnit,
} from "@azx/ribo-core";
import type { RetryBudget } from "@azx/ribo-core";

import { OnDeviceChat, DEFAULT_DEVICE_PROMPT_DEADLINE_MS } from "./ondevice-chat.js";
import { threePhaseExtractor } from "./index.js";
import { classifyPhase, classifyWrappedPhase } from "./phases/classify-phase.js";
import { extractGroups, presencePhase } from "./phases/presence-phase.js";
import { spanPhase } from "./phases/span-phase.js";
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

// The walked groups, for the engine-wiring tests that compose the phases by
// hand (the ones that need an onRetryBudget observer, which the preset's
// signature deliberately does not carry).
const groups = extractGroups(z.toJSONSchema(extractionSchema, { target: "draft-2020-12" }));

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
    // Category 1 — the run is phase-major, not group-major: every group's
    // presence call happens before any span call, so the scripted sequence
    // orders by phase.
    model.sequence = [
      // hvac presence: only fuel is discussed.
      [json({ fuel: true, efficiency: false, notes: false })],
      // site presence: nothing discussed.
      [json({ yearBuilt: false, access: false })],
      // hvac span: only the true leaves are asked for verbatim quotes.
      [json({ fuel: "the system is gas" })],
      // hvac classify: classify the fuel quote.
      [json("Gas")],
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

    // 2 presence + 1 span + 1 classify = 4. If the false leaves had also been
    // run through the later phases, the count would be higher.
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
    // Category 1 — phase-major ordering: both presence calls first.
    model.sequence = [
      [json({ fuel: true, efficiency: false, notes: false })],
      [json({ yearBuilt: false, access: false })],
      [json({ fuel: "the boiler is oil-fired" })],
      [json("Oil")],
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
    // Category 1 — phase-major ordering: both presence calls first.
    model.sequence = [
      [json({ fuel: true, efficiency: false, notes: false })],
      [json({ yearBuilt: false, access: false })],
      [json({ fuel: "the system is gas" })],
      [json("Gas")],
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
      // Category 1 — phase-major ordering: both presence calls first.
      model.sequence = [
        // hvac presence: fuel is discussed.
        [json({ fuel: true })],
        // site presence: nothing discussed.
        [json({ yearBuilt: false })],
        // hvac span: verbatim quote.
        [json({ fuel: "the system is gas" })],
        // hvac classify.
        [json("Gas")],
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
    // Category 3 — usage.calls counts successful ITEMS, not attempts: the
    // span item that failed once and succeeded on retry contributes one call,
    // not two. presence + span + classify = 3.
    expect(result.usage.calls).toBe(3);
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
      // Category 1 — phase-major ordering: every group's presence call, then
      // every group's span call, then every classify.
      model.sequence = [
        [json({ fuel: true, efficiency: true, notes: true })],
        [json({ yearBuilt: true, access: true })],
        [
          json({
            fuel: "the system is gas",
            efficiency: "efficiency is 82 percent",
            notes: "notes need replacement",
          }),
        ],
        [json({ yearBuilt: "built in 1950", access: "easy access" })],
        [json("Gas")],
        [json(82)],
        [json("notes need replacement")],
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

    test("each pass's events carry its phase identity — presence, span, classify", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      const transcript =
        "the system is gas efficiency is 82 percent notes need replacement built in 1950 easy access";
      // Category 1 — phase-major ordering: every group's presence call, then
      // every group's span call, then every classify.
      model.sequence = [
        [json({ fuel: true, efficiency: true, notes: true })],
        [json({ yearBuilt: true, access: true })],
        [
          json({
            fuel: "the system is gas",
            efficiency: "efficiency is 82 percent",
            notes: "notes need replacement",
          }),
        ],
        [json({ yearBuilt: "built in 1950", access: "easy access" })],
        [json("Gas")],
        [json(82)],
        [json("notes need replacement")],
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

      // Non-vacuous by construction: both groups run all three passes, so every
      // pass bucket is populated before the identity is asserted on it.
      const pass0 = events.filter((e) => e.pass === 0);
      const pass1 = events.filter((e) => e.pass === 1);
      const pass2 = events.filter((e) => e.pass === 2);
      expect(pass0.length).toBeGreaterThan(0);
      expect(pass1.length).toBeGreaterThan(0);
      expect(pass2.length).toBeGreaterThan(0);
      for (const e of pass0) expect(e.phaseId).toBe("presence");
      for (const e of pass1) expect(e.phaseId).toBe("span");
      for (const e of pass2) expect(e.phaseId).toBe("classify");
    });

    test("the wrapped fallback is its own phase — its own id, its own pass, distinct identity", async () => {
      // Category 2 — the wrapped fallback is a separate phase now, not an
      // error-driven rewrite inside the classify retry loop. The pre-port pin
      // (one unit id shared by both request shapes) is the assertion this port
      // exists to change.
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
        name: "unsupported-phaseid-test",
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
      const phase3 = events.filter((e) => e.pass === 3);
      expect(phase2.length).toBeGreaterThan(0);
      expect(phase3.length).toBeGreaterThan(0);
      for (const e of phase2) expect(e.phaseId).toBe("classify");
      for (const e of phase3) expect(e.phaseId).toBe("classify-wrapped");
      // The wrapped call is its own item with its own id.
      const classifyIds = new Set(phase2.map((e) => e.id));
      const wrappedIds = new Set(phase3.map((e) => e.id));
      expect(classifyIds.size).toBe(1);
      expect(wrappedIds.size).toBe(1);
      expect([...wrappedIds][0]).not.toBe([...classifyIds][0]);
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

    test("a bare classify that hits unsupported settles as done, and the wrapped retry is a new item at pass 3", async () => {
      // Categories 2 + 5. Category 2: the wrapped fallback is its own phase —
      // its own item, its own id, its own attempt numbering starting at 1; the
      // pre-port pin (one id, continuing attempts) is the assertion this port
      // exists to change. Category 5: the unsupported attempt's event moves
      // from `error` to `done` — the call succeeded, and the unsupported fact
      // stops being visible in the event stream, travelling only in notes.
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
      const result = await extractor.extract({ text: "the system is gas", annotations: {} });

      // The value still lands — the wrapped pass classified it.
      expect(result.fields.hvac.fuel.value).toBe("Gas");

      const phase2 = events.filter((e) => e.pass === 2);
      const phase3 = events.filter((e) => e.pass === 3);
      // Each request shape is one item with one id.
      const classifyIds = new Set(phase2.map((e) => e.id));
      const wrappedIds = new Set(phase3.map((e) => e.id));
      expect(classifyIds.size).toBe(1);
      expect(wrappedIds.size).toBe(1);
      expect([...wrappedIds][0]).not.toBe([...classifyIds][0]);
      // Each item's attempt numbering starts at 1 — no continuing numbers.
      expect(phase2.filter((e) => e.phase === "start").map((e) => e.attempt)).toEqual([1]);
      expect(phase3.filter((e) => e.phase === "start").map((e) => e.attempt)).toEqual([1]);
      // The unsupported attempt settles as DONE, not error — no error event in
      // either pass.
      expect(phase2.map((e) => e.phase)).toEqual(["start", "done"]);
      expect(phase3.map((e) => e.phase)).toEqual(["start", "done"]);
      expect(events.filter((e) => e.phase === "error")).toHaveLength(0);
    });

    test("usage.calls equals the number of start events", async () => {
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      const transcript =
        "the system is gas efficiency is 82 percent notes need replacement built in 1950 easy access";
      // Category 1 — phase-major ordering: every group's presence call, then
      // every group's span call, then every classify. The assertion itself
      // survives this fixture because nothing fails in it — under the port the
      // equality holds only when no attempt failed (category 3: calls counts
      // successful items, attempts count starts).
      model.sequence = [
        [json({ fuel: true, efficiency: true, notes: true })],
        [json({ yearBuilt: true, access: true })],
        [
          json({
            fuel: "the system is gas",
            efficiency: "efficiency is 82 percent",
            notes: "notes need replacement",
          }),
        ],
        [json({ yearBuilt: "built in 1950", access: "easy access" })],
        [json("Gas")],
        [json(82)],
        [json("notes need replacement")],
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
          (cause: unknown) => cause,
        );

      // Category 4 — the rejection type on caller-abort paths changes: the
      // pre-port code threw ChatError.aborted from its own pre-attempt check;
      // ported, retryAsync's pre-attempt check throws core's CancellationError
      // before the transport is reached — and an abort arriving between
      // attempts AFTER a real failure rethrows that failure instead, so the
      // concrete class is timing-dependent. Assert through isCancellation.
      expect(isCancellation(error)).toBe(true);
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
        (cause: unknown) => cause,
      );

      // Category 4 — see the already-aborted test above: the concrete class of
      // the rejection on an abort path is no longer pinned (it is timing-
      // dependent), so assert through isCancellation.
      expect(isCancellation(error)).toBe(true);
      // usage.calls is derived from start events (pinned elsewhere in this
      // file), so this is the "retries that never ran are not counted"
      // assertion: only the one attempt that actually started, no phantom
      // retries fired at an already-aborted signal.
      expect(events.filter((e) => e.phase === "start")).toHaveLength(1);
    });

    test("a caller abort DURING a classify call rejects — it does not resolve with nulled leaves", async () => {
      // Added in Wave 6 — the live bug this port fixes: the pre-port classify
      // path had NO cancellation check at all, so a transport abort arriving
      // before the caller's signal flips became a null leaf with its span
      // retained. The abort must land MID-call: a between-attempts abort
      // rejects through retryAsync whether or not `run` forwards `ctx.signal`
      // at all — so that version of the test passes against an implementation
      // that drops the signal entirely, which is the regression worth catching.
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      // Phase-major: both presence calls, then the span, then classify — whose
      // response streams slowly so the abort lands MID-call.
      model.sequence = [
        [json({ fuel: true, efficiency: false, notes: false })],
        [json({ yearBuilt: false, access: false })],
        [json({ fuel: "the system is gas" })],
        ['"Gas', '" ', "again ", "still "],
      ];
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
      // The classify call is the fourth: wait until it is IN FLIGHT.
      await vi.waitFor(() => expect(model.promptCallCount).toBe(4));
      controller.abort();

      const error: unknown = await run.then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(isCancellation(error)).toBe(true);
      // Only the four attempts that started — no phantom retries past the abort.
      expect(events.filter((e) => e.phase === "start")).toHaveLength(4);
    });

    test("a transport aborted error during classify rejects even with the caller's signal un-fired", async () => {
      // Added in Wave 6 — the other half of the live bug: a DOMException
      // AbortError from the model itself is classified by OnDeviceChat as
      // ChatError.aborted — the branded cancellation — while the caller's
      // signal never fires. The pre-port classify path caught it, retried it
      // to exhaustion, and resolved with a nulled leaf whose span was
      // retained; ported, the narrow catch rethrows it, retryAsync stops on
      // the brand, and the run rejects.
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
        name: "transport-abort-test",
        extractionSchema: singleLeafSchema,
        instructions: "Extract hvac fields.",
        examples: [],
      };

      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      model.sequence = [
        [json({ fuel: true })],
        [json({ fuel: "the system is gas" })],
        new DOMException("the prompt was aborted", "AbortError"),
      ];
      const chat = new OnDeviceChat({ languageModel: model });
      const extractor = threePhaseExtractor({ target: singleLeafTarget, chat, maxRetries: 3 });

      const error: unknown = await extractor
        .extract({ text: "the system is gas", annotations: {} })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );

      expect(isCancellation(error)).toBe(true);
      // Three good calls plus the aborted one — no retry burned on an abort.
      expect(model.promptCallCount).toBe(3);
    });
  });

  describe("the on-device preset's tuning (Wave 6)", () => {
    test("no backoff delay is taken between attempts — the preset retries immediately", async () => {
      // Task 4's delay pin. ondevice-extraction-design.md records that backing
      // off is wrong for a degenerate loop — "it should retry immediately" —
      // and the engine's default is fullJitterDelay. The preset wires an
      // immediately-resolving delay, so the ONLY timers a retrying run
      // schedules are the transport's own (its 15 s per-call deadline, and the
      // session holder's 30 s idle timer). A backoff creeping back in would
      // schedule a timer below that deadline — base 1 s, first three windows
      // all under 4 s — and fail this assertion.
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      // Phase-major: both presence calls, then the span — which degenerates
      // once and succeeds on retry — then classify.
      model.sequence = [
        [json({ fuel: true, efficiency: false, notes: false })],
        [json({ yearBuilt: false, access: false })],
        ChatError.transport("span degenerated"),
        [json({ fuel: "the system is gas" })],
        [json("Gas")],
      ];
      const chat = new OnDeviceChat({ languageModel: model });

      const delays: number[] = [];
      const spy = vi.spyOn(globalThis, "setTimeout");
      try {
        const extractor = threePhaseExtractor({ target, chat, maxRetries: 3 });
        const result = await extractor.extract({ text: "the system is gas", annotations: {} });
        expect(result.fields.hvac.fuel.value).toBe("Gas");
        // Read BEFORE mockRestore — restoring also resets the recorded calls.
        for (const call of spy.mock.calls) {
          const ms = call[1];
          if (typeof ms === "number") delays.push(ms);
        }
      } finally {
        spy.mockRestore();
      }
      // The retry really happened: 2 presence + span attempt 1 + span retry +
      // classify = 5 transport calls.
      expect(model.promptCallCount).toBe(5);
      for (const ms of delays) {
        expect(ms).toBeGreaterThanOrEqual(DEFAULT_DEVICE_PROMPT_DEADLINE_MS);
      }
      // Non-vacuous: at least the transport's deadline timers were scheduled.
      expect(delays.length).toBeGreaterThanOrEqual(5);
    });

    test("the derived retry budget is the requested three at the fixture's scale", async () => {
      // Task 4's ceiling pin, and it holds at THIS fixture's scale — two
      // groups, one grounded leaf. The per-phase share is the remaining time
      // divided by the phases left, so a dozen-plus grounded leaves would cut
      // the classify phase's budget even with the 15 s device ceiling; the
      // many-leaf test below pins that the starvation is then OBSERVABLE.
      // Four attempts on one span call can only happen if the budget still
      // derives to the requested 3 with the device-sized ceiling. The preset's
      // signature does not carry onRetryBudget (it keeps target, chat,
      // maxRetries, onUnit), so this drives the ENGINE with the same wiring
      // the preset builds and observes the derivation there.
      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      model.sequence = [
        [json({ fuel: true, efficiency: false, notes: false })],
        [json({ yearBuilt: false, access: false })],
        ChatError.transport("span failure"),
        ChatError.transport("span failure"),
        ChatError.transport("span failure"),
        [json({ fuel: "the system is gas" })],
        [json("Gas")],
      ];
      const chat = new OnDeviceChat({ languageModel: model });

      const budgetEvents: RetryBudget[] = [];
      const extractor = phasedExtractor<Values>({
        target,
        phases: [
          presencePhase<Values>({ groups, chat, model: chat.engine }),
          spanPhase<Values>({ groups, chat, model: chat.engine }),
          classifyPhase<Values>({ groups, chat, model: chat.engine }),
          classifyWrappedPhase<Values>({ groups, chat, model: chat.engine }),
        ],
        concurrency: 1,
        maxRetries: 3,
        perCallCeilingMs: DEFAULT_DEVICE_PROMPT_DEADLINE_MS,
        delay: () => Promise.resolve(),
        onRetryBudget: (event) => budgetEvents.push(event),
      });
      const result = await extractor.extract({ text: "the system is gas", annotations: {} });

      // The fourth attempt succeeded — the budget was not cut.
      expect(result.fields.hvac?.fuel?.value).toBe("Gas");
      expect(model.promptCallCount).toBe(7);
      // onRetryBudget fires only when a budget was REDUCED: silence here means
      // every phase derived to the requested 3.
      expect(budgetEvents).toEqual([]);
    });

    test("a classify phase of many grounded leaves starves VISIBLY — onRetryBudget fires naming it", async () => {
      // The deadline-slicing weakness the design names: the per-phase share is
      // the remaining time divided by the phases left, so at a dozen-plus
      // grounded leaves the share cuts the budget even with the 15 s ceiling.
      // That is survivable, but it must not be silent — onRetryBudget is the
      // evidence channel. The preset's signature does not carry onRetryBudget
      // (it keeps target, chat, maxRetries, onUnit), so this drives the ENGINE
      // with the same wiring the preset builds — the same four phases, the
      // same device-sized ceiling — and observes the event there. The event
      // carries no phase id; `batches` is what identifies the phase here,
      // because only classify plans thirteen items (presence and span plan one
      // each).
      const manyPatch = z.strictObject({
        house: z
          .strictObject({
            f0: z.string().nullable().optional(),
            f1: z.string().nullable().optional(),
            f2: z.string().nullable().optional(),
            f3: z.string().nullable().optional(),
            f4: z.string().nullable().optional(),
            f5: z.string().nullable().optional(),
            f6: z.string().nullable().optional(),
            f7: z.string().nullable().optional(),
            f8: z.string().nullable().optional(),
            f9: z.string().nullable().optional(),
            f10: z.string().nullable().optional(),
            f11: z.string().nullable().optional(),
            f12: z.string().nullable().optional(),
          })
          .optional(),
      });
      const manySchema = enveloped(manyPatch);
      type ManyValues = z.infer<typeof manyPatch>;
      const manyTarget: ExtractionTarget<ManyValues> = {
        name: "many-leaf-test",
        extractionSchema: manySchema,
        instructions: "Extract the fields from the transcript.",
        examples: [],
      };

      const model = new FakeLanguageModel();
      model.availabilityValue = "available";
      const transcript = Array.from({ length: 13 }, (_, i) => `q${i}`).join(" ");
      model.sequence = [
        [json(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, true])))],
        [json(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, `q${i}`])))],
        ...Array.from({ length: 13 }, (_, i) => [json(`v${i}`)]),
      ];
      const chat = new OnDeviceChat({ languageModel: model });
      const groups = extractGroups(z.toJSONSchema(manySchema, { target: "draft-2020-12" }));

      const budgetEvents: RetryBudget[] = [];
      const extractor = phasedExtractor<ManyValues>({
        target: manyTarget,
        phases: [
          presencePhase<ManyValues>({ groups, chat, model: chat.engine }),
          spanPhase<ManyValues>({ groups, chat, model: chat.engine }),
          classifyPhase<ManyValues>({ groups, chat, model: chat.engine }),
          classifyWrappedPhase<ManyValues>({ groups, chat, model: chat.engine }),
        ],
        concurrency: 1,
        maxRetries: 3,
        perCallCeilingMs: DEFAULT_DEVICE_PROMPT_DEADLINE_MS,
        delay: () => Promise.resolve(),
        onRetryBudget: (event) => budgetEvents.push(event),
      });
      const result = await extractor.extract({ text: transcript, annotations: {} });

      expect(result.fields.house?.f0?.value).toBe("v0");
      expect(result.fields.house?.f12?.value).toBe("v12");

      expect(budgetEvents).toHaveLength(1);
      const event = budgetEvents[0]!;
      // Thirteen batches is the classify phase — no other phase plans 13 items.
      expect(event.batches).toBe(13);
      // The share the engine derives for classify is the remaining 900 s over
      // the TWO phases left (classify and wrapped) = 450 s; thirteen batches
      // fit one retry each (13 × 31 s = 403 s) but not two (13 × 48 s =
      // 624 s), so the requested 3 derives to 1 — a real cut, now observable.
      expect(event.derived).toBe(1);
      expect(event.requested).toBe(3);
      expect(event.perCallCeilingMs).toBe(DEFAULT_DEVICE_PROMPT_DEADLINE_MS);
    });
  });
});
