import { enveloped, isTransientFailure } from "@azx/ribo-core";
import type { Enveloped, ExtractionTarget, ToolAdapterExample } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import type { ChatClient, ChatFinishReason, ChatRequest } from "./chat-client.js";
import { singleShotExtractor } from "./single-shot.js";

/**
 * Key-free CI tests for the single-shot extractor, exercised against a small,
 * SELF-CONTAINED generic target. This package is tool-agnostic and must not depend
 * on any adapter, so the fixture is a synthetic field set rather than a real
 * adapter's — the trust-boundary and JSON-Schema assertions bite exactly the same.
 * A FAKE {@link ChatClient} captures the request the extractor builds and returns
 * a canned response, so nothing here touches the network — no real key, no live
 * provider. Three things are proved: the request SHAPE (strict json_schema, the
 * exact JSON Schema, message order), the TRUST BOUNDARY (parse with the schema,
 * then normalize), and FAILURE CLASSIFICATION (a bad response fails as transient
 * so the queue retries).
 *
 * The fixture MIRRORS WHAT A REAL ADAPTER NOW DOES rather than hand-declaring an
 * envelope shape: a writable patch schema is written out, and the extraction shape
 * is DERIVED from it with `enveloped()` (design §2.1–§2.2). That matters here and
 * is not ceremony — everything this extractor does with fields is the enveloped
 * shape, so a hand-written envelope fixture would let the extractor's generics
 * claim `V` where they mean `Enveloped<V>` and no test would notice. The patch
 * below is optional at every level, exactly as a patch must be, which is what
 * makes the "no optionality survives into the request" assertion real work.
 */

/**
 * The PATCH: plain values, every leaf `.nullable().optional()`, nested object
 * `.optional()`. Nothing here is envelope-shaped — the envelopes appear only in
 * what `enveloped()` derives.
 */
const demoValuesSchema = z
  .object({
    equipment: z.string().nullable().optional(),
    safety: z.object({ pressure: z.string().nullable().optional() }).strict().optional(),
  })
  .strict();
type DemoValues = z.infer<typeof demoValuesSchema>;

/**
 * What the model is asked for: closed and fully required at every level, each leaf
 * a `{ value, confidence, sourceSpan }` envelope whose `confidence` is a BARE
 * `z.number()` — emitting no `minimum`/`maximum`, the two keywords strict
 * json_schema mode forbids.
 */
const demoExtractionSchema = enveloped(demoValuesSchema);
type DemoExtraction = Enveloped<DemoValues>;

const demoInstructions =
  "Extract the equipment and the safety pressure. Emit a null for anything you cannot ground.";
const demoExample: ToolAdapterExample<DemoExtraction> = {
  transcript: "The unit is a boiler; draft pressure reads fine.",
  fields: {
    equipment: { value: "boiler", confidence: 0.9, sourceSpan: "The unit is a boiler" },
    safety: {
      pressure: { value: "-0.02 inWC", confidence: 0.8, sourceSpan: "draft pressure reads fine" },
    },
  },
};

// The target names the VALUES type; `extractionSchema` is the `Enveloped<V>` side.
const demoTarget: ExtractionTarget<DemoValues> = {
  name: "demo-fields",
  extractionSchema: demoExtractionSchema,
  instructions: demoInstructions,
  examples: [demoExample],
};

/** Clamp every confidence into 0..1 — the deterministic pass run AFTER the schema parse. */
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
function normalizeDemo(fields: DemoExtraction): DemoExtraction {
  return {
    equipment: { ...fields.equipment, confidence: clamp(fields.equipment.confidence) },
    safety: {
      pressure: {
        ...fields.safety.pressure,
        confidence: clamp(fields.safety.pressure.confidence),
      },
    },
  };
}

/** A ChatClient that records every request and replays a fixed response body. */
function fakeChat(
  content: string,
  finishReason?: ChatFinishReason,
): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve({ content, finishReason });
    },
  };
  return { chat, requests };
}

/** The example's fields — a valid `DemoExtraction`, used as a well-formed response body. */
const wellFormed: DemoExtraction = demoExample.fields;

/** Deep clone so a test can tamper with one leaf without mutating the shared fixture. */
const clone = (fields: DemoExtraction): DemoExtraction => structuredClone(fields);

describe("singleShotExtractor — request shape", () => {
  test("sends one strict json_schema call with the schema, instructions, examples, then transcript", async () => {
    const { chat, requests } = fakeChat(JSON.stringify(wellFormed));
    const extractor = singleShotExtractor({
      target: demoTarget,
      chat,
      model: "gpt-test",
      normalize: normalizeDemo,
    });

    const transcript = "Furnace is a Carrier, natural gas, eighty thousand BTU.";
    await extractor.extract(transcript);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;

    // model passed through
    expect(req.model).toBe("gpt-test");

    // strict json_schema response_format, named after the target, carrying the
    // EXACT z.toJSONSchema output (draft-2020-12) of the EXTRACTION schema — not
    // the patch, and not a hand-rolled schema.
    expect(req.response_format.type).toBe("json_schema");
    expect(req.response_format.json_schema.strict).toBe(true);
    expect(req.response_format.json_schema.name).toBe(demoTarget.name);
    expect(req.response_format.json_schema.schema).toEqual(
      z.toJSONSchema(demoExtractionSchema, { target: "draft-2020-12" }),
    );

    // messages: system instructions, each example as user/assistant, then the live transcript.
    // The assistant turn is the ENVELOPED example — it is what the model imitates.
    expect(req.messages).toEqual([
      { role: "system", content: demoInstructions },
      { role: "user", content: demoExample.transcript },
      { role: "assistant", content: JSON.stringify(demoExample.fields) },
      { role: "user", content: transcript },
    ]);
  });

  test("the emitted JSON Schema carries no strict-mode-forbidden keywords", async () => {
    const { chat, requests } = fakeChat(JSON.stringify(wellFormed));
    await singleShotExtractor({ target: demoTarget, chat, model: "m" }).extract("hi");
    const asString = JSON.stringify(requests[0]!.response_format.json_schema.schema);
    // `.min()/.max()` would emit these — the reason `confidence` is a bare z.number().
    expect(asString).not.toContain('"minimum"');
    expect(asString).not.toContain('"maximum"');
    // closed objects: every level rejects extra keys.
    expect(asString).toContain('"additionalProperties":false');
  });

  test("the patch's optionality does not reach the model — every key is required", async () => {
    // `demoValuesSchema` is optional at every level; the request must not be. This
    // is `enveloped()`'s stripping step observed where it actually matters — in the
    // bytes sent — and it is the assertion that would catch the extractor being
    // pointed at a patch schema by mistake.
    const { chat, requests } = fakeChat(JSON.stringify(wellFormed));
    await singleShotExtractor({ target: demoTarget, chat, model: "m" }).extract("hi");
    const schema = requests[0]!.response_format.json_schema.schema as Record<string, unknown>;

    const requireEveryKey = (node: Record<string, unknown>, path: string): void => {
      if (node.type !== "object") return;
      const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
      expect([...((node.required ?? []) as string[])].sort(), `${path} required`).toEqual(
        Object.keys(properties).sort(),
      );
      for (const [key, child] of Object.entries(properties))
        requireEveryKey(child, `${path}.${key}`);
    };
    requireEveryKey(schema, "$");

    // And the leaves are envelopes, not the bare strings the patch declares.
    const equipment = (schema.properties as Record<string, Record<string, unknown>>).equipment!;
    expect(Object.keys(equipment.properties as object).sort()).toEqual([
      "confidence",
      "sourceSpan",
      "value",
    ]);
  });
});

describe("singleShotExtractor — trust boundary", () => {
  test("parses the response with the schema and applies normalize (out-of-range confidence clamped)", async () => {
    // A confidence the model has no business emitting: > 1 (top-level) and < 0
    // (nested safety). Rebuilt rather than mutated: `Enveloped<V>` is `readonly`
    // at every key, which is itself part of the contract.
    const base = clone(wellFormed);
    const tampered: DemoExtraction = {
      equipment: { ...base.equipment, confidence: 1.4 },
      safety: { pressure: { ...base.safety.pressure, confidence: -0.3 } },
    };

    const { chat } = fakeChat(JSON.stringify(tampered));
    const result = await singleShotExtractor({
      target: demoTarget,
      chat,
      model: "m",
      normalize: normalizeDemo,
    }).extract("t");

    // normalizeDemo clamped both envelopes into 0..1; values are untouched.
    expect(result.fields.equipment.confidence).toBe(1);
    expect(result.fields.equipment.value).toBe("boiler");
    expect(result.fields.safety.pressure.confidence).toBe(0);
    expect(result.usage).toEqual({ calls: 1 });
    // raw is the parsed model output, kept for provenance (pre-normalization).
    expect((result.raw as DemoExtraction).equipment.confidence).toBe(1.4);
  });

  test("a response with a key omitted is rejected — absence is not how the model says nothing", async () => {
    // The anti-hallucination rule at the extractor's own boundary: an omitted key
    // is indistinguishable from a field the model never considered, so the parse
    // must reject it even though the PATCH the schema was derived from allows it.
    const { safety: _safety, ...withoutSafety } = clone(wellFormed);
    const { chat } = fakeChat(JSON.stringify(withoutSafety));
    await expect(
      singleShotExtractor({ target: demoTarget, chat, model: "m" }).extract("t"),
    ).rejects.toThrow(/did not match the schema/);
  });
});

describe("singleShotExtractor — failure is transient (queue retries)", () => {
  test("a non-JSON response rejects, and the error is classified transient", async () => {
    const { chat } = fakeChat("Sorry, I can't help with that. {not json");
    const extractor = singleShotExtractor({ target: demoTarget, chat, model: "m" });

    let error: unknown;
    try {
      await extractor.extract("t");
      throw new Error("expected extract() to reject on a non-JSON response");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("was not valid JSON");
    // The queue's classifier must retry this, not mark the recording dead.
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a schema-invalid response rejects, and the error is classified transient", async () => {
    // Valid JSON, wrong shape: a bare string where an envelope object is required.
    const { chat } = fakeChat(JSON.stringify({ equipment: "boiler" }));
    const extractor = singleShotExtractor({ target: demoTarget, chat, model: "m" });

    let error: unknown;
    try {
      await extractor.extract("t");
      throw new Error("expected extract() to reject on a schema-invalid response");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("did not match the schema");
    expect(isTransientFailure(error)).toBe(true);
  });
});

describe("singleShotExtractor — pre-parse check (non-stop finishReason)", () => {
  test("a truncated response (finishReason 'length') is rejected before parsing, naming maxTokens", async () => {
    // Content that would ALSO fail the zod parse — if the extractor reached the
    // parse, the error would say "did not match the schema", not "maxTokens". So a
    // truncation error here proves the pre-parse check fired first, which is the
    // single most important assertion in the work: plumbing the field through
    // without this check adds a foot-gun and no safety.
    const { chat } = fakeChat(JSON.stringify({ equipment: "not an envelope" }), "length");
    const extractor = singleShotExtractor({ target: demoTarget, chat, model: "m" });

    let error: unknown;
    try {
      await extractor.extract("t");
      throw new Error("expected extract() to reject on a truncated response");
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toContain("maxTokens");
    expect((error as Error).message).not.toContain("did not match the schema");
  });

  test("a content-filtered response (finishReason 'content_filter') is rejected before parsing", async () => {
    // Same proof strategy as the truncation test: content that would also fail the
    // parse, so an error that is NOT the parse error proves the pre-parse check fired.
    const { chat } = fakeChat(JSON.stringify({ equipment: "not an envelope" }), "content_filter");
    const extractor = singleShotExtractor({ target: demoTarget, chat, model: "m" });

    let error: unknown;
    try {
      await extractor.extract("t");
      throw new Error("expected extract() to reject on a content-filtered response");
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toContain("content_filter");
    expect((error as Error).message).not.toContain("did not match the schema");
  });

  test("a response with finishReason 'stop' and valid content parses normally", async () => {
    const { chat } = fakeChat(JSON.stringify(wellFormed), "stop");
    const result = await singleShotExtractor({
      target: demoTarget,
      chat,
      model: "m",
      normalize: normalizeDemo,
    }).extract("t");

    expect(result.fields.equipment.value).toBe("boiler");
    expect(result.fields.equipment.confidence).toBe(0.9);
    expect(result.usage).toEqual({ calls: 1 });
  });

  test("an absent finishReason (a fake/CLI that cannot report one) still parses normally", async () => {
    // finishReason is optional on the type; an implementation that cannot report
    // one (cliChat, a test fake) omits it, and the pre-parse check must not fire.
    const { chat } = fakeChat(JSON.stringify(wellFormed));
    const result = await singleShotExtractor({
      target: demoTarget,
      chat,
      model: "m",
      normalize: normalizeDemo,
    }).extract("t");

    expect(result.fields.equipment.value).toBe("boiler");
  });
});
