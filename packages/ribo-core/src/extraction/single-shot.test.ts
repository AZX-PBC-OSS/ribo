import { z } from "zod";
import { describe, expect, test } from "vitest";

import { ChatError } from "../phases/chat-client.js";
import type {
  ChatClient,
  ChatFinishReason,
  ChatRequest,
  ChatUsage,
} from "../phases/chat-client.js";
import { enveloped } from "../provenance/enveloped.js";
import type { Enveloped } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "./extractor.js";
import { isTransientFailure } from "../storage/backoff.js";
import { SchemaParseError } from "./schema-parse-error.js";
import type { ToolAdapterExample } from "../write/adapter.js";
import type { WholeUnit } from "./extraction-observer.js";

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
  usage?: ChatUsage,
): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve({ content, finishReason, usage });
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
    await extractor.extract({ text: transcript, annotations: {} });

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
    await singleShotExtractor({ target: demoTarget, chat, model: "m" }).extract({
      text: "hi",
      annotations: {},
    });
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
    await singleShotExtractor({ target: demoTarget, chat, model: "m" }).extract({
      text: "hi",
      annotations: {},
    });
    const schema = requests[0]!.response_format.json_schema.schema;

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
    }).extract({ text: "t", annotations: {} });

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
      singleShotExtractor({ target: demoTarget, chat, model: "m" }).extract({
        text: "t",
        annotations: {},
      }),
    ).rejects.toThrow(/did not match the schema/);
  });
});

describe("singleShotExtractor — failure is transient (queue retries), and schema misses are recognisable", () => {
  test("a non-JSON response rejects, and the error is classified transient", async () => {
    const { chat } = fakeChat("Sorry, I can't help with that. {not json");
    const extractor = singleShotExtractor({ target: demoTarget, chat, model: "m" });

    let error: unknown;
    try {
      await extractor.extract({ text: "t", annotations: {} });
      throw new Error("expected extract() to reject on a non-JSON response");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("was not valid JSON");
    // The queue's classifier must retry this, not mark the recording dead.
    expect(isTransientFailure(error)).toBe(true);
    expect(error).not.toBeInstanceOf(SchemaParseError);
  });

  test("a schema-invalid response rejects with a sampled parse failure, which is transient and retried", async () => {
    // Valid JSON, wrong shape: a bare string where an envelope object is required.
    // The failure is a SchemaParseError (recognisable by a strategy ladder) and
    // is still transient (the queue retries). The chat returns invalid once, then
    // valid, simulating the retry that the queue will perform.
    let calls = 0;
    const requests: ChatRequest[] = [];
    const chat: ChatClient = {
      complete: (request) => {
        requests.push(request);
        calls++;
        if (calls === 1) {
          return Promise.resolve({ content: JSON.stringify({ equipment: "boiler" }) });
        }
        return Promise.resolve({ content: JSON.stringify(wellFormed) });
      },
    };
    const extractor = singleShotExtractor({ target: demoTarget, chat, model: "m" });

    let error: unknown;
    try {
      await extractor.extract({ text: "t", annotations: {} });
      throw new Error("expected extract() to reject on a schema-invalid response");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SchemaParseError);
    expect((error as Error).message).toContain("did not match the schema");
    expect((error as Error).message).toContain("equipment");
    expect(isTransientFailure(error)).toBe(true);
    expect(requests).toHaveLength(1);

    // A retry (simulating the queue) succeeds with a different sample.
    const result = await extractor.extract({ text: "t", annotations: {} });
    expect(result.fields.equipment.value).toBe("boiler");
    expect(requests).toHaveLength(2);
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
      await extractor.extract({ text: "t", annotations: {} });
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
      await extractor.extract({ text: "t", annotations: {} });
      throw new Error("expected extract() to reject on a content-filtered response");
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toContain("content_filter");
    expect((error as Error).message).not.toContain("did not match the schema");
  });

  test("a refusal and an unsupported request are TERMINAL — the queue must not retry them", async () => {
    // isTransientFailure reads any error with no numeric `status` as retryable, and a
    // bare ChatError has none. Without classification these would be re-sent until the
    // item reached `dead`: a refusal repeats on the same input, and `unsupported` is a
    // configuration error no amount of retrying fixes.
    for (const kind of ["refusal", "unsupported"] as const) {
      const chat: ChatClient = {
        complete: () =>
          Promise.reject(
            kind === "refusal" ? ChatError.refusal("declined") : ChatError.unsupported("no cap"),
          ),
      };
      const error = await singleShotExtractor({ target: demoTarget, chat, model: "m" })
        .extract({ text: "t", annotations: {} })
        .then(
          () => {
            throw new Error(`expected extract() to reject for ${kind}`);
          },
          (caught: unknown) => caught,
        );
      expect(isTransientFailure(error)).toBe(false);
    }
  });

  test("an abort stays RETRYABLE — it is caller-initiated, not a verdict", async () => {
    // Where this departs from grouping all three together: a host that cancels on a
    // deadline may succeed on a later attempt with a fresh one, so the queue should be
    // allowed to try again. A transport blip behaves the same way and always has.
    const chat: ChatClient = { complete: () => Promise.reject(ChatError.aborted("deadline")) };
    const error = await singleShotExtractor({ target: demoTarget, chat, model: "m" })
      .extract({ text: "t", annotations: {} })
      .then(
        () => {
          throw new Error("expected extract() to reject");
        },
        (caught: unknown) => caught,
      );
    expect(isTransientFailure(error)).toBe(true);
  });

  test("BOTH non-stop outcomes are TERMINAL, not transient — the queue must not retry them", async () => {
    // The counterpart to the "failure is transient" block above, and the reason
    // these throw TerminalError rather than a plain Error: isTransientFailure
    // treats any error without a numeric `status` as retryable, so a plain Error
    // would make the storage re-send an identical request. Truncation at a fixed
    // maxTokens is deterministic and a content filter fires again on the same
    // content, so every retry fails identically and the item reaches `dead` with
    // a configuration problem hidden behind a retry storm.
    for (const reason of ["length", "content_filter"] as const) {
      const { chat } = fakeChat(JSON.stringify(wellFormed), reason);
      const extractor = singleShotExtractor({ target: demoTarget, chat, model: "m" });

      const error = await extractor.extract({ text: "t", annotations: {} }).then(
        () => {
          throw new Error(`expected extract() to reject on finishReason "${reason}"`);
        },
        (caught: unknown) => caught,
      );

      expect(isTransientFailure(error)).toBe(false);
    }
  });

  test("a response with finishReason 'stop' and valid content parses normally", async () => {
    const { chat } = fakeChat(JSON.stringify(wellFormed), "stop");
    const result = await singleShotExtractor({
      target: demoTarget,
      chat,
      model: "m",
      normalize: normalizeDemo,
    }).extract({ text: "t", annotations: {} });

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
    }).extract({ text: "t", annotations: {} });

    expect(result.fields.equipment.value).toBe("boiler");
  });
});

describe("singleShotExtractor — progress units", () => {
  test("emits one start and one done, attempt 1 on both, same id, usage mapped from the completion", async () => {
    const { chat } = fakeChat(JSON.stringify(wellFormed), "stop", {
      promptTokens: 120,
      completionTokens: 45,
    });
    const events: WholeUnit[] = [];
    await singleShotExtractor({
      target: demoTarget,
      chat,
      model: "m",
      onUnit: (event) => events.push(event),
    }).extract({ text: "t", annotations: {} });

    expect(events).toHaveLength(2);
    const start = events[0]!;
    const done = events[1]!;
    expect(start.unit).toBe("whole");
    expect(start.phase).toBe("start");
    // No retry loop here, so 1 is the honest report on every event.
    expect(start.attempt).toBe(1);
    expect(done.phase).toBe("done");
    expect(done.attempt).toBe(1);
    // The id correlates the pair without consumer bookkeeping.
    expect(done.id).toBe(start.id);
    // usage is mapped from the completion's promptTokens/completionTokens.
    expect(done.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
  });

  test("done omits usage when the completion reports none", async () => {
    // Absent means "not reported" — never a fabricated zero.
    const { chat } = fakeChat(JSON.stringify(wellFormed));
    const events: WholeUnit[] = [];
    await singleShotExtractor({
      target: demoTarget,
      chat,
      model: "m",
      onUnit: (event) => events.push(event),
    }).extract({ text: "t", annotations: {} });

    expect(events).toHaveLength(2);
    expect(events[1]!.phase).toBe("done");
    expect(events[1]!.usage).toBeUndefined();
  });

  test("a call that throws emits start then error carrying the thrown value", async () => {
    const thrown = ChatError.transport("uplink gone");
    const chat: ChatClient = { complete: () => Promise.reject(thrown) };
    const events: WholeUnit[] = [];

    const error = await singleShotExtractor({
      target: demoTarget,
      chat,
      model: "m",
      onUnit: (event) => events.push(event),
    })
      .extract({ text: "t", annotations: {} })
      .then(
        () => {
          throw new Error("expected extract() to reject");
        },
        (caught: unknown) => caught,
      );

    expect(error).toBe(thrown);
    expect(events).toHaveLength(2);
    expect(events[0]!.phase).toBe("start");
    expect(events[1]!.phase).toBe("error");
    expect(events[1]!.id).toBe(events[0]!.id);
    expect(events[1]!.attempt).toBe(1);
    // The event carries the thrown value itself, not a rendering of it — and no
    // model output; identifiers and usage only.
    expect(events[1]!.error).toBe(thrown);
    expect(events[1]!.usage).toBeUndefined();
  });

  test("with onUnit absent, an identical run produces an identical result and call sequence", async () => {
    const transcript = "Furnace is a Carrier, natural gas, eighty thousand BTU.";

    const observed = fakeChat(JSON.stringify(wellFormed));
    const events: WholeUnit[] = [];
    const withObserver = await singleShotExtractor({
      target: demoTarget,
      chat: observed.chat,
      model: "m",
      normalize: normalizeDemo,
      onUnit: (event) => events.push(event),
    }).extract({ text: transcript, annotations: {} });

    const silent = fakeChat(JSON.stringify(wellFormed));
    const withoutObserver = await singleShotExtractor({
      target: demoTarget,
      chat: silent.chat,
      model: "m",
      normalize: normalizeDemo,
    }).extract({ text: transcript, annotations: {} });

    // The observed run really did observe — otherwise the comparison below proves
    // nothing. This is the half that fails before the hook exists.
    expect(events.map((event) => event.phase)).toEqual(["start", "done"]);
    // The observation point changed nothing: same result, same bytes on the wire.
    expect(withoutObserver).toEqual(withObserver);
    expect(silent.requests).toEqual(observed.requests);
  });
});

// --- Task 9: the abort signal must reach the transport -----------------------

test("an abort passed to extract() reaches the chat transport, not just the promise", async () => {
  // The failure this guards is an `ExtractOptions` that every implementation accepts and none
  // forwards: the promise rejects, the HTTP request keeps running, and a test asserting only
  // the rejection passes over a no-op. So the assertion is on what the TRANSPORT saw.
  let sawSignal: AbortSignal | undefined;
  let aborted = false;

  const chat: ChatClient = {
    complete: (_request, options) =>
      new Promise((_resolve, reject) => {
        sawSignal = options?.signal;
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
        // Never settles on its own — only the abort can end this call.
      }),
  };

  const controller = new AbortController();
  const extractor = singleShotExtractor({ target: demoTarget, chat, model: "m" });
  const pending = extractor.extract({ text: "t", annotations: {} }, { signal: controller.signal });

  // The transport received the caller's signal, not a fresh one.
  expect(sawSignal).toBe(controller.signal);

  controller.abort();
  await expect(pending).rejects.toThrow();

  // The discriminating assertion: the transport's own abort handler ran. Without forwarding,
  // `sawSignal` is undefined and this stays false while the promise above still rejects.
  expect(aborted).toBe(true);
});
