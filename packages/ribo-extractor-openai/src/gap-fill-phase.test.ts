import {
  draftSeededNoteKey,
  emptyDraft,
  enveloped,
  extractorPhase,
  FakeExtractor,
  validatePhases,
} from "@azx/ribo-core";
import type {
  ChatClient,
  ChatRequest,
  DeepPartial,
  Enveloped,
  ExtractionTarget,
  PhaseContext,
  PhaseDraft,
} from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { gapFillPhase } from "./gap-fill-phase.js";
import type { AbstainedLeaf } from "./gap-fill.js";

/**
 * Phase-level tests for the gap-fill follow-up phase, against hand-built drafts —
 * the engine is not involved here, so `plan`/`run`/`merge` are driven directly
 * through the phase's `with` (the same fold `extractor-phase.test.ts` in core
 * uses). A fake {@link ChatClient} captures the follow-up request and replays a
 * canned response. Nothing touches the network.
 */

const gapValuesSchema = z
  .object({
    envelope: z
      .object({
        roof: z.enum(["asphalt_shingle", "metal", "tile"]).nullable().optional(),
        wall: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type GapValues = z.infer<typeof gapValuesSchema>;
type GapExtraction = Enveloped<GapValues>;

const gapTarget: ExtractionTarget<GapValues> = {
  name: "gap-demo",
  extractionSchema: enveloped(gapValuesSchema),
  instructions:
    "Extract the roof covering and the wall material. Emit null for anything you cannot ground.",
};

/** The transcript every test scores ungrounded spans against. */
const transcriptText = "The roof is asphalt shingles; the walls are brick.";

const ctx: PhaseContext<GapValues> = {
  transcript: { text: transcriptText, annotations: {} },
  target: gapTarget,
};

/** Every leaf committed or plainly abstained — no candidates for the follow-up. */
const committedFields: GapExtraction = {
  envelope: {
    roof: { value: "asphalt_shingle", confidence: 0.9, sourceSpan: "asphalt shingles" },
    wall: { value: "brick", confidence: 0.9, sourceSpan: "brick walls" },
  },
};

/** The audited bug: found the quote, did not commit. */
const abstainingFields: GapExtraction = {
  envelope: {
    roof: { value: null, confidence: 0.4, sourceSpan: "asphalt shingles" },
    wall: { value: "brick", confidence: 0.9, sourceSpan: "brick walls" },
  },
};

/** A committed value citing text that is NOT in the transcript. */
const fabricatedFields: GapExtraction = {
  envelope: {
    roof: { value: "asphalt_shingle", confidence: 0.9, sourceSpan: "asphalt shingles" },
    wall: { value: "brick", confidence: 0.9, sourceSpan: "Wall material: brick" },
  },
};

/** One abstained candidate plus one ungrounded candidate. */
const mixedFields: GapExtraction = {
  envelope: {
    roof: { value: null, confidence: 0.4, sourceSpan: "asphalt shingles" },
    wall: { value: "brick", confidence: 0.9, sourceSpan: "Wall material: brick" },
  },
};

/** The draft a base phase would have left behind: complete fields, no notes. */
const draftWith = (fields: DeepPartial<Enveloped<GapValues>>): PhaseDraft<GapValues> => ({
  ...emptyDraft<GapValues>(),
  fields,
});

/** A ChatClient that records every request and replays a fixed completion. */
function fakeChat(
  content: string,
  options: { usage?: { promptTokens: number; completionTokens: number } } = {},
): { chat: ChatClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve({
        content,
        finishReason: "stop",
        usage: options.usage,
      });
    },
  };
  return { chat, requests };
}

const roofAnswer = {
  "envelope.roof": { value: "asphalt_shingle", confidence: 0.93, sourceSpan: "asphalt shingles" },
};

// Distinctive fragments of the two private directives — enough to tell which
// directives the system prompt carried without exporting the constants for tests.
const GAP_FILL_FRAGMENT = "Reaffirming null is a fully valid answer";
const UNGROUNDED_FRAGMENT = "Do not reformat, re-space, or stitch together a quote";

// The phase's item type is hidden existentially behind `with`; the item is the
// phase's own candidate record by construction, so this helper recovers what the
// encoding hides rather than asserting anything untested.
const candidatesOf = (item: unknown): readonly AbstainedLeaf[] =>
  (item as { candidates: readonly AbstainedLeaf[] }).candidates;

describe("gapFillPhase — plan", () => {
  test("returns one item when abstained candidates exist and none when they do not", () => {
    const phase = gapFillPhase<GapValues>({
      target: gapTarget,
      chat: {} as ChatClient,
      model: "m",
    });
    phase.with((def) => {
      expect(def.plan(draftWith(abstainingFields), ctx)).toHaveLength(1);
      expect(def.plan(draftWith(committedFields), ctx)).toHaveLength(0);
    });
  });

  test("respects targets — the default ignores ungrounded-only drafts", () => {
    const phase = gapFillPhase<GapValues>({
      target: gapTarget,
      chat: {} as ChatClient,
      model: "m",
    });
    phase.with((def) => {
      expect(def.plan(draftWith(fabricatedFields), ctx)).toHaveLength(0);
    });
  });

  test("respects targets — both enabled yields one item carrying both kinds", () => {
    const phase = gapFillPhase<GapValues>({
      target: gapTarget,
      chat: {} as ChatClient,
      model: "m",
      targets: ["abstained", "ungrounded"],
    });
    phase.with((def) => {
      const items = def.plan(draftWith(mixedFields), ctx);
      expect(items).toHaveLength(1);
      expect(candidatesOf(items[0]).map((c) => c.kind)).toEqual(["abstained", "ungrounded"]);
    });
  });

  test("a leaf whose value key is absent entirely is not collected — absent is not null", () => {
    // `isExtractedLeaf` requires `"value" in record`, so a partially-present leaf is
    // skipped rather than collected; the finders' `=== null` checks keep undefined
    // and null apart. This is the absent-versus-null pin.
    const partial = {
      envelope: { roof: { confidence: 0.5, sourceSpan: "asphalt shingles" } },
    };
    const phase = gapFillPhase<GapValues>({
      target: gapTarget,
      chat: {} as ChatClient,
      model: "m",
      targets: ["abstained", "ungrounded"],
    });
    phase.with((def) => {
      expect(def.plan(draftWith(partial), ctx)).toHaveLength(0);
    });
  });
});

describe("gapFillPhase — run", () => {
  test("makes exactly one chat call and reports it on the PhaseOutput usage", async () => {
    const { chat, requests } = fakeChat(JSON.stringify(roofAnswer), {
      usage: { promptTokens: 40, completionTokens: 10 },
    });
    const phase = gapFillPhase<GapValues>({ target: gapTarget, chat, model: "gpt-test" });
    const draft = draftWith(abstainingFields);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      const output = await def.run(item!, draft, ctx);
      expect(requests).toHaveLength(1);
      expect(output.usage).toEqual({ calls: 1, promptTokens: 40, completionTokens: 10 });
    });
  });

  test("the system prompt carries the gap-fill directive but not the ungrounded one, for abstained-only candidates", async () => {
    const { chat, requests } = fakeChat(JSON.stringify(roofAnswer));
    const phase = gapFillPhase<GapValues>({ target: gapTarget, chat, model: "m" });
    const draft = draftWith(abstainingFields);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      await def.run(item!, draft, ctx);
    });
    const system = requests[0]!.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toContain(GAP_FILL_FRAGMENT);
    expect(system.content).not.toContain(UNGROUNDED_FRAGMENT);
  });

  test("the system prompt carries the ungrounded directive only when the item holds an ungrounded candidate", async () => {
    // The scoped schema requires an entry for every candidate leaf, so the canned
    // response answers both the abstained roof and the ungrounded wall.
    const bothAnswer = {
      "envelope.roof": {
        value: "asphalt_shingle",
        confidence: 0.93,
        sourceSpan: "asphalt shingles",
      },
      "envelope.wall": { value: "brick", confidence: 0.9, sourceSpan: "the walls are brick" },
    };
    const { chat, requests } = fakeChat(JSON.stringify(bothAnswer));
    const phase = gapFillPhase<GapValues>({
      target: gapTarget,
      chat,
      model: "m",
      targets: ["abstained", "ungrounded"],
    });
    const draft = draftWith(mixedFields);
    await phase.with(async (def) => {
      const [item] = def.plan(draft, ctx);
      await def.run(item!, draft, ctx);
    });
    const system = requests[0]!.messages[0]!;
    expect(system.content).toContain(GAP_FILL_FRAGMENT);
    expect(system.content).toContain(UNGROUNDED_FRAGMENT);
  });
});

describe("gapFillPhase — merge", () => {
  const phaseOptions = { target: gapTarget, chat: {} as ChatClient, model: "m" };

  /** Plan, run every item against the canned response, and fold through merge. */
  async function fold(
    chatResponse: string,
    draft: PhaseDraft<GapValues>,
    overrides: Partial<Parameters<typeof gapFillPhase<GapValues>>[0]> = {},
  ): Promise<PhaseDraft<GapValues>> {
    const { chat } = fakeChat(chatResponse);
    return gapFillPhase<GapValues>({ ...phaseOptions, chat, ...overrides }).with(async (def) => {
      const outcomes = [];
      for (const item of def.plan(draft, ctx)) {
        outcomes.push({
          outcome: "result" as const,
          item,
          output: await def.run(item, draft, ctx),
        });
      }
      return def.merge(draft, outcomes);
    });
  }

  test("installs only the improved leaves and leaves the others untouched", async () => {
    const draft = draftWith(abstainingFields);
    const merged = await fold(JSON.stringify(roofAnswer), draft);

    expect(merged.fields.envelope?.roof).toEqual(roofAnswer["envelope.roof"]);
    // The committed wall is untouched — deep-equal to the base's own leaf.
    expect(merged.fields.envelope?.wall).toEqual(abstainingFields.envelope.wall);
    // The base draft was not mutated.
    expect(abstainingFields.envelope.roof.value).toBeNull();
  });

  test("sets raw to the merged fields", async () => {
    const draft = draftWith(abstainingFields);
    const merged = await fold(JSON.stringify(roofAnswer), draft);

    // `raw` is the assembled whole the normalize ran over — the base's answers with
    // the follow-up's accepted ones spliced in — not the base's raw model output
    // and not the normalized copy.
    expect(merged.raw).toEqual({
      envelope: {
        roof: roofAnswer["envelope.roof"],
        wall: abstainingFields.envelope.wall,
      },
    });
  });

  test("applies normalize to fields but not to raw", async () => {
    const clamp = (n: number): number => Math.max(0, Math.min(1, n));
    const normalize = (fields: GapExtraction): GapExtraction => ({
      ...fields,
      envelope: {
        ...fields.envelope,
        roof: {
          ...fields.envelope.roof,
          confidence: clamp(fields.envelope.roof.confidence),
        },
      },
    });
    const wild = {
      "envelope.roof": {
        value: "asphalt_shingle",
        confidence: 1.7,
        sourceSpan: "asphalt shingles",
      },
    };
    const draft = draftWith(abstainingFields);
    const merged = await fold(JSON.stringify(wild), draft, { normalize });

    // The clamp applied to the fields the run will parse...
    expect(merged.fields.envelope?.roof).toEqual({
      value: "asphalt_shingle",
      confidence: 1,
      sourceSpan: "asphalt shingles",
    });
    // ...and never to `raw`, which is the pre-normalize merged whole.
    expect(merged.raw).toEqual({
      envelope: {
        roof: { value: "asphalt_shingle", confidence: 1.7, sourceSpan: "asphalt shingles" },
        wall: abstainingFields.envelope.wall,
      },
    });
  });
});

describe("gapFillPhase — metadata", () => {
  test("requires the draft-seeded marker — its plan re-asks about leaves another phase left abstained", () => {
    const chat: ChatClient = {
      complete: () => Promise.resolve({ content: "{}", finishReason: "stop" }),
    };
    const phase = gapFillPhase<GapValues>({ target: gapTarget, chat, model: "m" });
    expect(phase.requires).toContain(draftSeededNoteKey);
  });
});

describe("gapFillPhase — requires", () => {
  const chat: ChatClient = {
    complete: () => Promise.resolve({ content: "{}", finishReason: "stop" }),
  };

  test("requires the draft-seeded marker and nothing else when the option is absent", () => {
    const phase = gapFillPhase<GapValues>({ target: gapTarget, chat, model: "m" });
    expect(phase.requires).toEqual([draftSeededNoteKey]);
  });

  test("a caller's requires is unioned with the phase's own, which stays present", () => {
    const phase = gapFillPhase<GapValues>({
      target: gapTarget,
      chat,
      model: "m",
      requires: ["mine"],
    });
    expect(phase.requires).toEqual([draftSeededNoteKey, "mine"]);
  });
});

describe("gapFillPhase — id", () => {
  test('defaults to "gapfill" and honours an explicit id', () => {
    const chat: ChatClient = {
      complete: () => Promise.resolve({ content: "{}", finishReason: "stop" }),
    };
    const defaults = gapFillPhase<GapValues>({ target: gapTarget, chat, model: "m" });
    expect(defaults.id).toBe("gapfill");
    const renamed = gapFillPhase<GapValues>({
      target: gapTarget,
      chat,
      model: "m",
      id: "gapfill-second-pass",
    });
    expect(renamed.id).toBe("gapfill-second-pass");
  });

  test("two gapFillPhases with different ids validate together — the thing the option exists to unblock", () => {
    // `validatePhases` rejects duplicate ids, so a phase list that wants two
    // follow-ups — one per kind of gap, say — needs one of them renamed. The
    // base phase is the lifted extractor producing the draft-seeded marker the
    // follow-ups' requires declaration needs.
    const base = new FakeExtractor<GapExtraction>(committedFields);
    const first = gapFillPhase<GapValues>({
      target: gapTarget,
      chat: {} as ChatClient,
      model: "m",
    });
    const second = gapFillPhase<GapValues>({
      target: gapTarget,
      chat: {} as ChatClient,
      model: "m",
      id: "gapfill-ungrounded",
    });
    expect(() =>
      validatePhases<GapValues>([extractorPhase("base", base), first, second]),
    ).not.toThrow();
  });
});
