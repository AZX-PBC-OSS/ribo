import { z } from "zod";
import { describe, expect, test } from "vitest";
import {
  classifyPhase,
  enveloped,
  extractGroups,
  phasedExtractor,
  presenceNoteKey,
  presencePhase,
  spanPhase,
  spansNoteKey,
  validatePhases,
} from "./index.js";
import type { CapableChatClient, ExtractionTarget } from "./index.js";

/**
 * A host assembles `[presence, span, classify]` through core's public entry
 * point ALONE and hands the list to core's engine. Every phase and note-key
 * import here comes from `./index.js` — a host cannot reach the individual
 * modules through the package's `exports` map, so this is exactly the
 * composition the barrel makes possible, and nothing else.
 *
 * The test moved here from `@azx/ribo-extractor-ondevice` (SP4a wave 5, with
 * the phases), and the move makes its point STRONGER: a host no longer composes
 * these phases from an extractor package — the transport-agnostic walk is core
 * surface, and the on-device package only tunes the preset. The transport here
 * is a bare `CapableChatClient` fake rather than any real engine: construction
 * and validation make no calls, and any host-wired transport must do.
 *
 * The groups come from `extractGroups`, also public: the first cut of the
 * earlier wave exported the phases but not the walk that feeds them, so a host
 * could build a list and never run one. `presencePhase` takes
 * `groups: readonly Group[]` and `extractGroups` is the only thing that
 * produces them. Walking a REAL schema here rather than passing `[]` is what
 * makes this the composition test — it is the whole path a host would take.
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
  // A bare `CapableChatClient` double — the seam the phases take, faked the
  // way a host's test would fake whatever transport it wires. Construction
  // and validation make no calls.
  const chat: CapableChatClient = {
    engine: "fake-chat",
    capability: () => {
      throw new Error("capability() is not exercised by construction and validation");
    },
    complete: async () => {
      throw new Error("complete() is not exercised by construction and validation");
    },
  };
  // The walk, from the barrel. A host with an extraction schema and nothing
  // else can get here, which is the property this file exists to pin.
  const groups = extractGroups(z.toJSONSchema(target.extractionSchema));
  return { chat, model: chat.engine, groups };
}

describe("a phase list composed through the public entry point", () => {
  test("constructs and validates through phasedExtractor", () => {
    const { chat, model, groups } = composeOptions();
    // Non-empty: the walk found the schema's groups, so these phases are
    // constructed the way a host would construct them.
    expect(groups.length).toBeGreaterThan(0);
    const phases = [
      presencePhase<Values>({ groups, chat, model }),
      spanPhase<Values>({ groups, chat, model }),
      classifyPhase<Values>({ groups, chat, model }),
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
    const { chat, model, groups } = composeOptions();
    const presence = presencePhase<Values>({ groups, chat, model });
    const span = spanPhase<Values>({ groups: [], chat, model });
    const classify = classifyPhase<Values>({ groups: [], chat, model });
    expect(presence.produces).toContain(presenceNoteKey);
    expect(span.requires).toContain(presenceNoteKey);
    expect(span.produces).toContain(spansNoteKey);
    expect(classify.requires).toContain(spansNoteKey);
  });
});
