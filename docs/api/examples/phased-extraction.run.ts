/**
 * The runnable example behind docs/api/phased-extraction.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the ask phase drives `scriptedChat`
 * and the compute phase is model-free by construction.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  askPhase,
  computePhase,
  demandNote,
  enveloped,
  type ExtractionTarget,
  noteKey,
  type NoteKey,
  PER_CALL_CEILING_MS,
  phasedExtractor,
  type DeepPartial,
  type Enveloped,
  type PhaseUnit,
  scriptedChat,
  validatePhases,
} from "@azx/ribo-core";

const valuesSchema = z.object({ note: z.string().nullable().optional() });
type Values = z.infer<typeof valuesSchema>;

const target: ExtractionTarget<Values> = {
  name: "notes",
  extractionSchema: enveloped(valuesSchema),
  instructions: "Extract the note.",
};

const transcript = { text: "the attic is drafty", annotations: {} } as const;

// The caller's own question: schema, answer type and note key, all declared
// here — the way a host's would be.
const answerSchema = z.object({ verdict: z.string() });
type Answer = z.infer<typeof answerSchema>;
const answerKey: NoteKey<Answer> = noteKey("example-answer");

export async function anAskWritesItsAnswerAndAComputeFoldsItIn(): Promise<void> {
  // #region usage
  const ask = askPhase<Values>()({
    schema: answerSchema,
    chat: scriptedChat({ content: { verdict: "drafty windows" } }),
    model: "fake-mini",
    messages: (_draft, ctx) => [
      { role: "system", content: "Summarise the transcript in a few words." },
      { role: "user", content: ctx.transcript.text },
    ],
    noteKey: answerKey,
  });
  const compute = computePhase<Values>({
    // The fold reads the note back AT THE ANSWER'S TYPE — `demandNote` throws
    // if an earlier phase never wrote it, so a mis-ordered list fails loudly.
    fold: (draft) => {
      const answer = demandNote(draft.notes, answerKey, "compute", "ask");
      return {
        ...draft,
        fields: { note: { value: answer.verdict, confidence: 1, sourceSpan: "drafty" } },
      };
    },
    requires: ["ask"],
  });
  const extractor = phasedExtractor<Values>({ target, phases: [ask, compute] });
  const result = await extractor.extract(transcript);
  // #endregion usage

  assert.equal(result.fields.note?.value, "drafty windows");
  // One model call (the ask); the compute reports none — honestly.
  assert.equal(result.usage.calls, 1);
}

export function aMisWiredListIsRejectedBeforeAnyCallIsPaidFor(): void {
  // The compute requires "ask", but the list names nothing before it —
  // validatePhases throws at construction, naming the dangling id.
  assert.throws(() => {
    const compute = computePhase<Values>({
      fold: (draft) => draft,
      requires: ["ask"],
    });
    validatePhases([compute]);
  }, /requires/);
}

export async function aTransientItemIsRetriedWithinTheDefaultBudget(): Promise<void> {
  // The default maxRetries is 2 — total attempts per item is 3. Observed here
  // against the default, not retyped: the ask's responder throws twice, then
  // answers on the third attempt.
  const ask = askPhase<Values>()({
    schema: answerSchema,
    chat: scriptedChat((_request, context) => {
      if (context.call < 2) throw new Error("uplink down");
      return { content: { verdict: "third time" } };
    }),
    model: "fake-mini",
    messages: () => [{ role: "system", content: "ask" }],
    noteKey: answerKey,
  });
  const compute = computePhase<Values>({
    fold: (draft) => {
      const answer = demandNote(draft.notes, answerKey, "compute", "ask");
      return {
        ...draft,
        fields: { note: { value: answer.verdict, confidence: 1, sourceSpan: null } },
      };
    },
    requires: ["ask"],
  });
  const extractor = phasedExtractor<Values>({
    target,
    phases: [ask, compute],
    delay: async () => undefined,
  });

  const result = await extractor.extract(transcript);
  assert.equal(result.fields.note?.value, "third time");
}

export async function theUnitStreamNamesEachPhaseAndAttempt(): Promise<void> {
  const units: PhaseUnit[] = [];
  const ask = askPhase<Values>()({
    schema: answerSchema,
    chat: scriptedChat({ content: { verdict: "observed" } }),
    model: "fake-mini",
    messages: () => [{ role: "system", content: "ask" }],
    // The fold sink: the answer is folded straight into the draft, at its type.
    fold: (draft, value) => ({
      ...draft,
      fields: { note: { value: value.verdict, confidence: 1, sourceSpan: null } },
    }),
  });
  const extractor = phasedExtractor<Values>({
    target,
    phases: [ask],
    onUnit: (unit) => units.push(unit),
  });

  await extractor.extract(transcript);

  // start/done events carry the phase's id and the attempt number, so a
  // reviewer watching a run sees each unit of work start and settle.
  assert.deepEqual(
    units.map((unit) => `${unit.phaseId}:${unit.phase}`),
    ["ask:start", "ask:done"],
  );
}

export async function normalizeRunsOnceBeforeTheClosingParse(): Promise<void> {
  const ask = askPhase<Values>()({
    schema: answerSchema,
    chat: scriptedChat({ content: { verdict: "normalized" } }),
    model: "fake-mini",
    messages: () => [{ role: "system", content: "ask" }],
    // The fold sink: write the answer straight into the draft, at its type.
    fold: (draft, value: Answer) => ({
      ...draft,
      fields: { note: { value: value.verdict, confidence: 1, sourceSpan: null } },
    }),
  });
  const seen: DeepPartial<Enveloped<Values>>[] = [];
  const extractor = phasedExtractor<Values>({
    target,
    phases: [ask],
    normalize: (fields) => {
      seen.push(fields);
      return fields;
    },
  });

  const result = await extractor.extract(transcript);
  // The normalize pass ran exactly once, on the merged fields.
  assert.equal(seen.length, 1);
  assert.equal(result.fields.note?.value, "normalized");
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The per-call ceiling is an exported constant — a source change that moved
  // it fails here. The page quotes the value next to this region.
  assert.equal(PER_CALL_CEILING_MS, 120_000);

  // concurrency (4), maxRetries (2) and stepTimeoutMs (900_000) are not
  // exported: the retry test above observes maxRetries against the default,
  // and the page cites packages/ribo-core/src/phases/phased-extractor.ts for
  // the rest.
}
// #endregion defaults
