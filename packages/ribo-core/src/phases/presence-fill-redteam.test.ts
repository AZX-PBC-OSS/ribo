import { z } from "zod";
import { describe, expect, test } from "vitest";

import { emptyDraft } from "./phase-draft.js";
import type { PhaseDraft } from "./phase-draft.js";
import { emptyNotes } from "./phase-notes.js";
import { enveloped } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "../extraction/extractor.js";
import { extractGroups, nullEnvelope, presenceNoteKey, wrapGroupEntry } from "./presence-phase.js";
import type { PhaseContext } from "./phase.js";
import type { ChatClient } from "./chat-client.js";
import { presenceFillPhase } from "./presence-fill-phase.js";

const opts = (n: number) => Array.from({ length: n }, (_, i) => `opt${"x".repeat(i * 3)}${i}`);
const leafSizes = [1, 9, 3, 7, 2, 8, 5, 6];
const leafShape: Record<string, z.ZodType> = {};
leafSizes.forEach((n, i) => {
  leafShape[`l${i}`] = z
    .enum(opts(n) as [string, ...string[]])
    .nullable()
    .optional();
});
const schema = z.strictObject({ g: z.strictObject(leafShape).optional() });
type V = z.infer<typeof schema>;
const target: ExtractionTarget<V> = {
  name: "rt",
  extractionSchema: enveloped(schema),
  instructions: "x",
  examples: [],
};
const groups = extractGroups(z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }));
const ctx: PhaseContext<V> = { transcript: { text: "t", annotations: {} }, target };
const chat: ChatClient = { complete: async () => ({ content: "{}", finishReason: "stop" }) };

function draftFor(map: Record<string, boolean>): PhaseDraft<V> {
  const fields: Record<string, unknown> = {};
  const entry: Record<string, ReturnType<typeof nullEnvelope>> = {};
  for (const leaf of groups[0]!.leaves) entry[leaf.key] = nullEnvelope();
  fields[groups[0]!.key] = wrapGroupEntry(groups[0]!, entry);
  return {
    ...emptyDraft<V>(),
    fields,
    notes: emptyNotes().set(presenceNoteKey, { g: map }),
  };
}

describe("red team: all-present is the worst case", () => {
  for (const cap of Array.from({ length: 40 }, (_, i) => 1100 + i * 60)) {
    test(`no leaf subset needs more pieces than the full set at byte cap ${cap}`, () => {
      const phase = presenceFillPhase<V>({
        target,
        groups,
        chat,
        model: "m",
        maxSerializedCharsPerGroup: cap,
      });
      phase.with((def) => {
        const keys = groups[0]!.leaves.map((l) => l.key);
        const count = (m: Record<string, boolean>) => def.plan(draftFor(m), ctx).length;
        const full = count(Object.fromEntries(keys.map((k) => [k, true])));
        expect(full).toBeGreaterThan(0);
        for (let mask = 1; mask < 1 << keys.length; mask++) {
          const m = Object.fromEntries(keys.map((k, i) => [k, (mask & (1 << i)) !== 0]));
          expect(count(m), `mask ${mask.toString(2)}`).toBeLessThanOrEqual(full);
        }
      });
    });
  }
});

describe("red team: an unsplittable leaf under a cap", () => {
  test("the fill phase refuses at construction, not mid-run after presence calls are paid", () => {
    expect(() =>
      presenceFillPhase<V>({ target, groups, chat, model: "m", maxSerializedCharsPerGroup: 500 }),
    ).toThrow();
  });
});
