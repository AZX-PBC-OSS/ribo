import { z } from "zod";
import { describe, expect, test } from "vitest";
import { emptyDraft } from "./phase-draft.js";
import type { PhaseDraft } from "./phase-draft.js";
import { emptyNotes } from "./phase-notes.js";
import { enveloped } from "./enveloped.js";
import { ChatError } from "./chat-client.js";
import type { ExtractionTarget } from "./extractor.js";
import type { PhaseContext } from "./phase.js";

import { extractGroups, nullEnvelope, presenceNoteKey, wrapGroupEntry } from "./presence-phase.js";
import type { Group, Leaf, LeafEnvelope } from "./presence-phase.js";
import { spansNoteKey } from "./span-phase.js";
import type { SpanMaps } from "./span-phase.js";
import { classifyPhase, classifyWrappedPhase, unsupportedNoteKey } from "./classify-phase.js";
import type { UnsupportedLeaves } from "./classify-phase.js";
import { fakeChat } from "./test-support/fake-chat.js";

/**
 * Phase-level tests for the classify and wrapped-classify phases, against
 * hand-built drafts — the engine is not involved, so `plan`/`run`/`merge` are
 * driven directly through the phase's `with` (the same fold the presence and
 * span suites use).
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
    })
    .optional(),
});

const extractionSchema = enveloped(patchSchema);
type Values = z.infer<typeof patchSchema>;

const target: ExtractionTarget<Values> = {
  name: "classify-test",
  extractionSchema,
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

const groups = extractGroups(z.toJSONSchema(extractionSchema, { target: "draft-2020-12" }));

const ctx: PhaseContext<Values> = {
  transcript: { text: "the system is gas and the efficiency is 82 percent", annotations: {} },
  target,
};

const json = (value: unknown): string => JSON.stringify(value);

/** The draft the span phase's merge would have left: seed + grounded spans. */
function spannedDraft(spans: SpanMaps, unsupported: UnsupportedLeaves = []): PhaseDraft<Values> {
  const fields: Record<string, unknown> = {};
  for (const group of groups) {
    const entry: Record<string, LeafEnvelope> = {};
    for (const leaf of group.leaves) {
      const span = spans[group.key]?.[leaf.key];
      entry[leaf.key] =
        span !== undefined ? { value: null, confidence: 0, sourceSpan: span } : nullEnvelope();
    }
    fields[group.key] = wrapGroupEntry(group, entry);
  }
  return {
    ...emptyDraft<Values>(),
    fields: fields,
    notes: emptyNotes()
      .set(presenceNoteKey, {})
      .set(spansNoteKey, spans)
      .set(unsupportedNoteKey, unsupported),
  };
}

/** The item type is existentially hidden; recover what the encoding hides for assertions. */
const itemOf = (item: unknown) => item as { group: Group; leaf: Leaf; span: string };

const GROUNDED: SpanMaps = { hvac: { fuel: "the system is gas" } };

describe("classifyPhase — plan", () => {
  test("yields one item per grounded leaf and none for a leaf whose span was dropped", () => {
    const { chat } = fakeChat(() => json("Gas"));
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    phase.with((def) => {
      // fuel kept its span; efficiency and notes lost theirs (ungrounded), and
      // site has no spans at all.
      const draft = spannedDraft({
        hvac: { fuel: "the system is gas" },
        site: {},
      });
      const items = def.plan(draft, ctx);
      expect(items.map((item) => def.describeItem?.(item))).toEqual([
        { key: "hvac", leaf: "fuel" },
      ]);
      expect(itemOf(items[0]).span).toBe("the system is gas");
    });
  });
});

describe("classifyPhase — run", () => {
  test("returns a classified value for a normal answer", async () => {
    const { chat, requests } = fakeChat(() => json("Gas"));
    const phase = classifyPhase<Values>({ groups, chat, model: "fake-model" });
    const draft = spannedDraft(GROUNDED);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const output = await def.run(item!, draft, ctx);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.response_format.json_schema.name).toBe("classify-hvac-fuel");
      // The BARE schema: the leaf's own value schema, not a wrapper.
      expect(requests[0]!.response_format.json_schema.schema).toEqual({
        anyOf: [{ type: "string", enum: ["Oil", "Gas"] }, { type: "null" }],
      });
      expect(output.value).toEqual({ kind: "classified", value: "Gas" });
      expect(output.usage).toEqual({ calls: 1 });
    });
  });

  test("returns the unsupported marker WITHOUT rejecting, calling the chat exactly once", async () => {
    // The cost pin: the transport reported that it cannot constrain output to
    // this schema — a fact about the schema, not a transient failure. Throwing
    // would send it through the retry loop, where every unsupported leaf burns
    // its whole retry budget re-sending a request that cannot succeed.
    const { chat, requests } = fakeChat(() =>
      ChatError.unsupported(
        "OnDeviceChat: the response schema uses a feature this model does not support",
      ),
    );
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    const draft = spannedDraft(GROUNDED);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const output = await def.run(item!, draft, ctx);
      expect(output.value).toEqual({ kind: "unsupported" });
      // The call was made and is counted — a marker carrying no usage would
      // undercount every unsupported leaf.
      expect(output.usage).toEqual({ calls: 1 });
      expect(requests).toHaveLength(1);
    });
  });

  test("rethrows everything that is not unsupported — the catch is narrow", async () => {
    // A refusal and a malformed response are retried today and must stay
    // retried; a branded cancellation must propagate or the engine's
    // cancellation rule is defeated at the one place it matters most.
    const { chat } = fakeChat(() => ChatError.malformed("bad response"));
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    const draft = spannedDraft(GROUNDED);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      await expect(def.run(item!, draft, ctx)).rejects.toThrow(/bad response/);
    });
  });

  test("a branded cancellation propagates — it is not swallowed into a marker", async () => {
    const { chat } = fakeChat(() =>
      ChatError.aborted("OnDeviceChat: the call was aborted by the caller"),
    );
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    const draft = spannedDraft(GROUNDED);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      await expect(def.run(item!, draft, ctx)).rejects.toThrow();
    });
  });
});

describe("classifyPhase — merge", () => {
  test("sets a classified value with its span, and leaves the unsupported note empty", async () => {
    const { chat } = fakeChat(() => json("Gas"));
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    const draft = spannedDraft(GROUNDED);
    const merged = await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const outcomes = [
        { outcome: "result" as const, item: item!, output: await def.run(item!, draft, ctx) },
      ];
      return def.merge(draft, outcomes);
    });
    expect(merged.fields.hvac?.fuel).toEqual({
      value: "Gas",
      confidence: 1,
      sourceSpan: "the system is gas",
    });
    // The phase declares it produces this key: the note is written even when
    // empty, or the engine's produces check would throw.
    expect(merged.notes.get(unsupportedNoteKey)).toEqual([]);
  });

  test("a classified null keeps the span and drops confidence to 0", async () => {
    // The model legitimately answers null — "return null if the quote does not
    // support a value". That is a RESULT, not a failure: the span stays.
    const { chat } = fakeChat(() => json(null));
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    const draft = spannedDraft(GROUNDED);
    const merged = await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const outcomes = [
        { outcome: "result" as const, item: item!, output: await def.run(item!, draft, ctx) },
      ];
      return def.merge(draft, outcomes);
    });
    expect(merged.fields.hvac?.fuel).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: "the system is gas",
    });
  });

  test("records an unsupported leaf in the notes for the next phase", async () => {
    const { chat } = fakeChat(() =>
      ChatError.unsupported("the response schema uses a feature this model does not support"),
    );
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    const draft = spannedDraft(GROUNDED);
    const merged = await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const outcomes = [
        { outcome: "result" as const, item: item!, output: await def.run(item!, draft, ctx) },
      ];
      return def.merge(draft, outcomes);
    });
    const recorded = merged.notes.get(unsupportedNoteKey);
    expect(recorded).toHaveLength(1);
    expect(itemOf(recorded![0]).leaf.key).toBe("fuel");
    expect(itemOf(recorded![0]).span).toBe("the system is gas");
    // The leaf envelope is untouched: still the span phase's null-with-span.
    expect(merged.fields.hvac?.fuel).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: "the system is gas",
    });
  });

  test("a failed item nulls the value and KEEPS the span", async () => {
    // Unlike presence and span, a real failure keeps the citation: gap-fill's
    // candidates are leaves with a null value and a NON-null span, so nulling
    // the span here would starve the follow-up pass and strip the citation a
    // reviewer reads.
    const { chat } = fakeChat(() => json("Gas"));
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    const draft = spannedDraft(GROUNDED);
    const merged = await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const outcomes = [
        { outcome: "error" as const, item: item!, error: new Error("classify failed") },
      ];
      return def.merge(draft, outcomes);
    });
    expect(merged.fields.hvac?.fuel).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: "the system is gas",
    });
  });
});

describe("classifyWrappedPhase", () => {
  test("plan yields exactly the recorded leaves — and nothing when there are none", () => {
    const { chat } = fakeChat(() => json({ value: "Gas" }));
    const phase = classifyWrappedPhase<Values>({ groups, chat, model: chat.engine });
    phase.with((def) => {
      const unsupportedLeaf = {
        group: groups[0]!,
        leaf: groups[0]!.leaves[0]!,
        span: "the system is gas",
      };
      const draft = spannedDraft(GROUNDED, [unsupportedLeaf]);
      const items = def.plan(draft, ctx);
      expect(items.map((item) => def.describeItem?.(item))).toEqual([
        { key: "hvac", leaf: "fuel" },
      ]);

      // No unsupported leaves anywhere: no items, no call, no event — the
      // empty-plan case.
      expect(def.plan(spannedDraft(GROUNDED), ctx)).toHaveLength(0);
      expect(def.plan(emptyDraft<Values>(), ctx)).toHaveLength(0);
    });
  });

  test("run uses the wrapped schema and the suffixed name, and unwraps the value", async () => {
    const { chat, requests } = fakeChat(() => json({ value: "Gas" }));
    const phase = classifyWrappedPhase<Values>({ groups, chat, model: "fake-model" });
    const draft = spannedDraft(GROUNDED, [
      { group: groups[0]!, leaf: groups[0]!.leaves[0]!, span: "the system is gas" },
    ]);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const output = await def.run(item!, draft, ctx);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.response_format.json_schema.name).toBe("classify-hvac-fuel-wrapped");
      expect(requests[0]!.response_format.json_schema.schema).toEqual({
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string", enum: ["Oil", "Gas"] }, { type: "null" }] },
        },
        required: ["value"],
        additionalProperties: false,
      });
      expect(output.value).toEqual({ kind: "classified", value: "Gas" });
      expect(output.usage).toEqual({ calls: 1 });
    });
  });
});

describe("classifyPhase — id", () => {
  test('defaults to "classify" and honours an explicit id', () => {
    const { chat } = fakeChat(() => json("Gas"));
    const defaults = classifyPhase<Values>({ groups, chat, model: chat.engine });
    expect(defaults.id).toBe("classify");
    const renamed = classifyPhase<Values>({ groups, chat, model: chat.engine, id: "classify-2" });
    expect(renamed.id).toBe("classify-2");
  });
});

describe("classifyWrappedPhase — id", () => {
  test('defaults to "classify-wrapped" and honours an explicit id', () => {
    const { chat } = fakeChat(() => json({ value: "Gas" }));
    const defaults = classifyWrappedPhase<Values>({ groups, chat, model: chat.engine });
    expect(defaults.id).toBe("classify-wrapped");
    const renamed = classifyWrappedPhase<Values>({
      groups,
      chat,
      model: chat.engine,
      id: "classify-wrapped-2",
    });
    expect(renamed.id).toBe("classify-wrapped-2");
  });
});

describe("classifyPhase — requires", () => {
  test("requires the spans note and nothing else when the option is absent", () => {
    const { chat } = fakeChat(() => json("Gas"));
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine });
    expect(phase.requires).toEqual([spansNoteKey]);
  });

  test("a caller's requires is unioned with the phase's own, which stays present", () => {
    const { chat } = fakeChat(() => json("Gas"));
    const phase = classifyPhase<Values>({ groups, chat, model: chat.engine, requires: ["mine"] });
    expect(phase.requires).toEqual([spansNoteKey, "mine"]);
  });
});

describe("classifyWrappedPhase — requires", () => {
  test("requires the unsupported note and nothing else when the option is absent", () => {
    const { chat } = fakeChat(() => json({ value: "Gas" }));
    const phase = classifyWrappedPhase<Values>({ groups, chat, model: chat.engine });
    expect(phase.requires).toEqual([unsupportedNoteKey]);
  });

  test("a caller's requires is unioned with the phase's own, which stays present", () => {
    const { chat } = fakeChat(() => json({ value: "Gas" }));
    const phase = classifyWrappedPhase<Values>({
      groups,
      chat,
      model: chat.engine,
      requires: ["mine"],
    });
    expect(phase.requires).toEqual([unsupportedNoteKey, "mine"]);
  });
});
