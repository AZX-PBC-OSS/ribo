import { z } from "zod";
import { describe, expect, test } from "vitest";
import { enveloped } from "@azx/ribo-core";

import * as api from "./index.js";
import {
  classifyPhase as classifyPhaseModule,
  classifyWrappedPhase as classifyWrappedPhaseModule,
} from "./phases/classify-phase.js";
import { extractGroups, presencePhase as presencePhaseModule } from "./phases/presence-phase.js";
import { spanPhase as spanPhaseModule } from "./phases/span-phase.js";
import { fakeChat } from "./test-support/fake-chat.js";

/**
 * The barrel is the contract of what consumers may depend on, and since SP4a
 * wave 3 that contract includes the four on-device phases `threePhaseExtractor`
 * composes. This pins each factory as the very value its defining module
 * exports (identity, not just presence) and each note key as the same key the
 * two phases that share it actually declare — a barrel that exported a fresh
 * key with a different string id would pass a presence-only check and still be
 * a key no shipped phase produces or requires.
 */

/** A two-group flat extraction target, the same shape the preset suite uses. */
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

const groups = extractGroups(z.toJSONSchema(extractionSchema, { target: "draft-2020-12" }));

describe("the barrel's phase exports", () => {
  test("each factory is the value its defining module exports, not a re-creation", () => {
    expect(api.presencePhase).toBe(presencePhaseModule);
    expect(api.spanPhase).toBe(spanPhaseModule);
    expect(api.classifyPhase).toBe(classifyPhaseModule);
    expect(api.classifyWrappedPhase).toBe(classifyWrappedPhaseModule);
  });

  test("presenceNoteKey is the key presence produces and span requires", () => {
    const { chat } = fakeChat(() => "{}");
    const presence = api.presencePhase<Values>({ groups, chat, model: chat.engine });
    const span = api.spanPhase<Values>({ groups, chat, model: chat.engine });
    expect(presence.produces).toContain(api.presenceNoteKey);
    expect(span.requires).toContain(api.presenceNoteKey);
  });

  test("spansNoteKey is the key span produces and classify requires", () => {
    const { chat } = fakeChat(() => "{}");
    const span = api.spanPhase<Values>({ groups, chat, model: chat.engine });
    const classify = api.classifyPhase<Values>({ groups, chat, model: chat.engine });
    expect(span.produces).toContain(api.spansNoteKey);
    expect(classify.requires).toContain(api.spansNoteKey);
  });

  test("unsupportedNoteKey is the key classify produces and the wrapped pass requires", () => {
    const { chat } = fakeChat(() => "{}");
    const classify = api.classifyPhase<Values>({ groups, chat, model: chat.engine });
    const wrapped = api.classifyWrappedPhase<Values>({ groups, chat, model: chat.engine });
    expect(classify.produces).toContain(api.unsupportedNoteKey);
    expect(wrapped.requires).toContain(api.unsupportedNoteKey);
  });

  test("each factory's options type is exported, and the wrapped pass shares classify's", () => {
    // Annotating with the barrel-exported option types is the pin that they are
    // exported at all: a dropped type re-export fails the compile, not just a
    // consumer's editor. The same classify options constant feeding BOTH
    // classify factories pins that `classifyWrappedPhase` has no options type
    // of its own — it shares `ClassifyPhaseOptions`.
    const { chat } = fakeChat(() => "{}");
    const presenceOptions: api.PresencePhaseOptions = { groups, chat, model: chat.engine };
    const spanOptions: api.SpanPhaseOptions = { groups, chat, model: chat.engine };
    const classifyOptions: api.ClassifyPhaseOptions = { groups, chat, model: chat.engine };
    expect(api.presencePhase<Values>(presenceOptions).id).toBe("presence");
    expect(api.spanPhase<Values>(spanOptions).id).toBe("span");
    expect(api.classifyPhase<Values>(classifyOptions).id).toBe("classify");
    expect(api.classifyWrappedPhase<Values>(classifyOptions).id).toBe("classify-wrapped");
  });
});
