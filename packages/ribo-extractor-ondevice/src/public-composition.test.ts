import { z } from "zod";
import { describe, expect, test } from "vitest";
import { enveloped, phasedExtractor, validatePhases } from "@azx/ribo-core";
import type { ExtractionTarget } from "@azx/ribo-core";

import { classifyPhase, presenceNoteKey, presencePhase, spanPhase, spansNoteKey } from "./index.js";
import { OnDeviceChat } from "./ondevice-chat.js";
import { FakeLanguageModel } from "./test-support/fake-language-model.js";

/**
 * The wave's deliverable, as a test: a host assembles `[presence, span, classify]`
 * through the package's public entry point ALONE and hands the list to core's
 * engine. Every phase and note-key import here comes from `./index.js` — a host
 * cannot reach `./phases/*` through the package's `exports` map, so this is
 * exactly the composition the barrel makes possible, and nothing else.
 *
 * The list is validated but never run, and the options carry an empty `groups`:
 * the schema walk that turns an `extractionSchema` into the `groups` the three
 * options take is still package-private, so walked groups are not constructible
 * from public exports. Construction and validation exercise the phases'
 * metadata — ids, `requires`/`produces`, `seedsDraft` — which is what
 * `validatePhases` judges, without mimicking the walk's output by hand.
 */

const patchSchema = z.strictObject({
  hvac: z
    .strictObject({
      fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
    })
    .optional(),
});

const extractionSchema = enveloped(patchSchema);
type Values = z.infer<typeof patchSchema>;

const target: ExtractionTarget<Values> = {
  name: "public-composition-test",
  extractionSchema,
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

function composeOptions() {
  // `OnDeviceChat` is itself a public export, so the transport is host-wirable
  // too; the fake model behind it is package test-support, incidental here —
  // construction and validation make no calls.
  const chat = new OnDeviceChat({ languageModel: new FakeLanguageModel() });
  return { chat, model: chat.engine };
}

describe("a phase list composed through the public entry point", () => {
  test("constructs and validates through phasedExtractor", () => {
    const { chat, model } = composeOptions();
    const phases = [
      presencePhase<Values>({ groups: [], chat, model }),
      spanPhase<Values>({ groups: [], chat, model }),
      classifyPhase<Values>({ groups: [], chat, model }),
    ];
    expect(() => validatePhases<Values>(phases)).not.toThrow();
    // Construction validates again — a mis-wired list fails before extract.
    expect(() => phasedExtractor<Values>({ target, phases })).not.toThrow();
  });

  test("the note-key chain the list depends on is the barrel's own keys", () => {
    // The chain is what validatePhases judges, so pin it against the BARREL's
    // keys: if the barrel exported a different-but-equal key instead of the
    // phases' own, these fail and a host composing with those keys in hand
    // would be wiring a list the shipped phases do not speak.
    const { chat, model } = composeOptions();
    const presence = presencePhase<Values>({ groups: [], chat, model });
    const span = spanPhase<Values>({ groups: [], chat, model });
    const classify = classifyPhase<Values>({ groups: [], chat, model });
    expect(presence.produces).toContain(presenceNoteKey);
    expect(span.requires).toContain(presenceNoteKey);
    expect(span.produces).toContain(spansNoteKey);
    expect(classify.requires).toContain(spansNoteKey);
  });
});
