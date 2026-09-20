import { z } from "zod";
import { describe, expect, test } from "vitest";
import {
  classifyPhase,
  enveloped,
  extractGroups,
  phasedExtractor,
  presencePhase,
  spanPhase,
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
 * The transport is a bare `CapableChatClient` fake: construction and validation
 * make no calls, and any host-wired transport must do. The groups come from
 * `extractGroups`, also public — `presencePhase` takes `groups: readonly Group[]`
 * and `extractGroups` is the only thing that produces them. Walking a REAL schema
 * here rather than passing `[]` is what makes this the composition test — it is
 * the whole path a host would take.
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
  // A bare `CapableChatClient` double — construction and validation make no calls.
  const chat: CapableChatClient = {
    engine: "fake-chat",
    capability: () => {
      throw new Error("capability() is not exercised by construction and validation");
    },
    complete: async () => {
      throw new Error("complete() is not exercised by construction and validation");
    },
  };
  // The walk, from the barrel — the property this file exists to pin.
  const groups = extractGroups(z.toJSONSchema(target.extractionSchema));
  return { chat, model: chat.engine, groups };
}

describe("a phase list composed through the public entry point", () => {
  test("constructs and validates through phasedExtractor", () => {
    const { chat, model, groups } = composeOptions();
    // Non-empty: the walk found the schema's groups.
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

  test("the id chain the list depends on is the factories' own defaults", () => {
    // Pinned through the BARREL: the default `requires` each factory applies
    // names the shipped provider's default id, so the composed list above is
    // ordered by construction (ADR 0008). The notes themselves are the runtime
    // channel — their round-trip is pinned by the phase merge suites.
    const { chat, model } = composeOptions();
    const span = spanPhase<Values>({ groups: [], chat, model });
    const classify = classifyPhase<Values>({ groups: [], chat, model });
    expect(span.requires).toEqual(["presence"]);
    expect(classify.requires).toEqual(["span"]);
  });
});
