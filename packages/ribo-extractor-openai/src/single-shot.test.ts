import { isTransientFailure } from "@azx/ribo-core";
import type { ExtractionTarget } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import type { ChatClient, ChatRequest } from "./chat-client.js";
import { singleShotExtractor } from "./single-shot.js";

/**
 * Key-free CI tests for the single-shot extractor, exercised against a small,
 * SELF-CONTAINED generic target. This package is tool-agnostic and must not depend
 * on any adapter, so the fixture is a synthetic confidence-bearing envelope schema
 * (top-level and nested) rather than a real adapter's fields — the trust-boundary
 * and JSON-Schema assertions bite exactly the same. A FAKE {@link ChatClient}
 * captures the request the extractor builds and returns a canned response, so
 * nothing here touches the network — no real key, no live provider. Three things
 * are proved: the request SHAPE (strict json_schema, the exact JSON Schema, message
 * order), the TRUST BOUNDARY (parse with the schema, then normalize), and FAILURE
 * CLASSIFICATION (a bad response fails as transient so the queue retries).
 */

/**
 * An envelope: a value plus a BARE (unbounded) confidence. `z.strictObject` closes
 * every level (`additionalProperties: false`) and a bare `z.number()` emits no
 * `minimum`/`maximum` — the two keywords strict json_schema mode forbids.
 */
const Envelope = z.strictObject({ value: z.string(), confidence: z.number() });
const DemoSchema = z.strictObject({
  equipment: Envelope,
  safety: z.strictObject({ pressure: Envelope }),
});
type DemoFields = z.infer<typeof DemoSchema>;

const demoInstructions =
  "Extract the equipment and the safety pressure. Emit a null for anything you cannot ground.";
const demoExample: { readonly transcript: string; readonly fields: DemoFields } = {
  transcript: "The unit is a boiler; draft pressure reads fine.",
  fields: {
    equipment: { value: "boiler", confidence: 0.9 },
    safety: { pressure: { value: "-0.02 inWC", confidence: 0.8 } },
  },
};

const demoTarget: ExtractionTarget<DemoFields> = {
  name: "demo-fields",
  schema: DemoSchema,
  instructions: demoInstructions,
  examples: [demoExample],
};

/** Clamp every confidence into 0..1 — the deterministic pass run AFTER the schema parse. */
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
function normalizeDemo(fields: DemoFields): DemoFields {
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
function fakeChat(content: string): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve({ content });
    },
  };
  return { chat, requests };
}

/** The example's fields — a valid `DemoFields`, used as a well-formed response body. */
const wellFormed: DemoFields = demoExample.fields;

/** Deep clone so a test can tamper with one leaf without mutating the shared fixture. */
const clone = (fields: DemoFields): DemoFields => structuredClone(fields);

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
    // EXACT z.toJSONSchema output (draft-2020-12) — not a hand-rolled schema.
    expect(req.response_format.type).toBe("json_schema");
    expect(req.response_format.json_schema.strict).toBe(true);
    expect(req.response_format.json_schema.name).toBe(demoTarget.name);
    expect(req.response_format.json_schema.schema).toEqual(
      z.toJSONSchema(DemoSchema, { target: "draft-2020-12" }),
    );

    // messages: system instructions, each example as user/assistant, then the live transcript.
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
});

describe("singleShotExtractor — trust boundary", () => {
  test("parses the response with the schema and applies normalize (out-of-range confidence clamped)", async () => {
    const tampered = clone(wellFormed);
    // A confidence the model has no business emitting: > 1 (top-level) and < 0 (nested safety).
    tampered.equipment = { ...tampered.equipment, confidence: 1.4 };
    tampered.safety = {
      ...tampered.safety,
      pressure: { ...tampered.safety.pressure, confidence: -0.3 },
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
    expect((result.raw as DemoFields).equipment.confidence).toBe(1.4);
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
