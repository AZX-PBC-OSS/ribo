/**
 * The runnable example behind docs/api/presence-narrowing.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: core's presence phase drives
 * `scriptedChat`, and the System One phase drives a hand-built
 * `SystemOneClient` double.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  enveloped,
  extractGroups,
  presenceNarrowedExtractor,
  presencePhase,
  type ChatRequest,
  type ExtractionTarget,
  type ScriptedChatResponder,
  scriptedChat,
} from "@azx/ribo-core";
import { DEFAULT_PRESENCE_THRESHOLD, systemOnePresencePhase } from "@azx/ribo-extractor-systemone";
import type { SystemOneAnswers, SystemOneQuestions } from "@azx/ribo-systemone-managed";

const valuesSchema = z.object({
  hvac: z
    .array(
      z.object({
        fuel: z.enum(["Oil", "Gas"]).nullable().optional(),
        efficiency: z.number().nullable().optional(),
      }),
    )
    .optional(),
  site: z.object({ yearBuilt: z.number().nullable().optional() }).optional(),
});
type Values = z.infer<typeof valuesSchema>;

const target: ExtractionTarget<Values> = {
  name: "presence-demo",
  extractionSchema: enveloped(valuesSchema),
  instructions: "Extract the fields from the transcript.",
  examples: [],
};

const transcript = {
  text: "the system is gas and the efficiency is 82 percent",
  annotations: {},
} as const;

// One chat serves both phases, dispatching on the request name: presence calls
// are `<group>-presence` (a flat leaf-to-boolean map), fill calls are
// `<target.name>-<group>` (the group's enveloped value).
const answering: ScriptedChatResponder = (request: ChatRequest) => {
  const name = request.responseFormat.json_schema.name;
  if (name === "hvac-presence") return { content: { fuel: true, efficiency: true } };
  if (name === "site-presence") return { content: { yearBuilt: false } };
  if (name.includes("hvac")) {
    return {
      content: {
        hvac: [
          {
            fuel: { value: "Gas", confidence: 0.9, sourceSpan: "gas" },
            efficiency: { value: 82, confidence: 0.9, sourceSpan: "82 percent" },
          },
        ],
      },
    };
  }
  return { content: { site: { yearBuilt: { value: 1954, confidence: 0.9, sourceSpan: "1954" } } } };
};

export async function thePresetRunsPresenceThenFillsOnlyPresentGroups(): Promise<void> {
  // #region usage
  const groups = extractGroups(
    z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }),
  );
  const chat = scriptedChat(answering);
  const extractor = presenceNarrowedExtractor(
    presencePhase<Values>({ groups, chat, model: "fake-mini" }),
    { target, groups, chat, model: "fake-mini" },
  );
  const result = await extractor.extract(transcript);
  // #endregion usage

  // The fill ran only where presence marked leaves present: hvac's leaves
  // committed; site — every leaf absent — was never asked for values, and
  // reads as the nulled seed.
  assert.equal(result.fields.hvac?.[0]?.fuel.value, "Gas");
  assert.equal(result.fields.hvac?.[0]?.efficiency.value, 82);
  assert.equal(result.fields.site?.yearBuilt.value, null);
  // Two presence calls (one per group), one fill call (hvac only).
  assert.deepEqual(
    chat.calls.map((call) => call.responseFormat.json_schema.name),
    ["hvac-presence", "site-presence", "presence-demo-hvac"],
  );
}

export function thePresencePhaseIsAParameter(): void {
  // #region parameter
  // The same preset over the System One presence phase — one batched request
  // instead of one call per group. The fill half is unchanged: it reads the
  // presence note, never the engine that wrote it.
  const groups = extractGroups(
    z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }),
  );
  const systemOnePresence = systemOnePresencePhase<Values>({
    client: fakeSystemOne(() => 0.9),
    schema: target.extractionSchema,
  });
  const extractor = presenceNarrowedExtractor(systemOnePresence, {
    target,
    groups,
    chat: scriptedChat(answering),
    model: "fake-mini",
  });
  // #endregion parameter

  // Constructed, the two spellings are interchangeable — both are Phase lists
  // the same engine runs.
  assert.ok(extractor);
}

/** A hand-built SystemOneClient: answers every noul question with `probabilityOf`. */
function fakeSystemOne(probabilityOf: (id: string) => number) {
  return {
    ask: async <Q extends SystemOneQuestions>(
      _state: string,
      questions: Q,
    ): Promise<SystemOneAnswers<Q>> => {
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const id of Object.keys(questions)) {
        answers[id] = { type: "noul", noul: probabilityOf(id) };
      }
      return answers as unknown as SystemOneAnswers<Q>;
    },
  };
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The System One phase's present threshold is an exported constant — a
  // source change that moved it fails here. The page quotes the value next to
  // this region.
  assert.equal(DEFAULT_PRESENCE_THRESHOLD, 0.2);
}
// #endregion defaults
