/**
 * @file The run: a corpus, an arm and a transport, one result per case.
 *
 * Two entries, one implementation. The public entry takes a loaded corpus —
 * the only way a corpus enters this package — and resolves with one result per
 * case. The internal entry takes the schema, the prompt inputs and the case
 * inputs directly, so a test can drive the same run from a schema that never
 * went through the loader; it is not exported from the barrel.
 *
 * Cases run in order, one at a time. A case whose ladder exhausts is a
 * measurement, not an abort: the failure is captured, the remaining cases
 * still run, and the run resolves with both.
 */
import type {
  AnnotatedTranscript,
  CapableChatClient,
  ChatClient,
  ExtractionUsage,
} from "@azx/ribo-core";
import type { z } from "zod";

import type { CorpusPromptInputs, LoadedCorpus } from "../corpus.js";
import { buildArm } from "./arm.js";
import { caseTextOf } from "./case-text.js";
import { asCapableChat } from "./chat.js";
import { transcribeDocumentCases } from "./documents.js";
import type { DocumentTexts } from "./documents.js";
import { EvalError } from "./error.js";
import { validateEvalSettings } from "./settings.js";
import { buildEvalTarget } from "./target.js";
import type { EvalCaseResult, EvalJsonValue, EvalSettings, EvalUsage } from "./types.js";

/**
 * One case's input to the runner: its id and its combined text.
 *
 * The text is the case's declared inputs joined by core's combiner — a
 * document input's contribution is the transcription the run made of its PDF,
 * transcription happening once per run, before any model call (see
 * `documents.ts` and `case-text.ts`).
 */
export interface EvalCaseInput {
  /** The case's id. */
  readonly id: string;
  /** The case's combined text, verbatim — markers included when they are on. */
  readonly text: string;
}

/**
 * A run driven from a schema, a set of prompt inputs and a set of cases — the
 * internal seam the round-trip test drives both sides of.
 */
export interface EvalSchemaRun {
  /** The schema, in plain values. */
  readonly schema: z.ZodObject;
  /** The prompt inputs the manifest declares. */
  readonly prompt: CorpusPromptInputs;
  /** The corpus manifest's name, for the refusal's messages. */
  readonly manifestName: string;
  /** The cases to run, in order. */
  readonly cases: readonly EvalCaseInput[];
  /** The transport every call goes through. */
  readonly chat: ChatClient | CapableChatClient;
  /** The arm's settings. */
  readonly settings: EvalSettings;
  /** The injectable sleep between retry attempts, so a test never waits real backoff. */
  readonly delay?: (ms: number) => Promise<void>;
}

/** The message of a thrown fault — a non-Error sentinel must not read "undefined". */
const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The usage, as the runner's own shape — the members core reported, and no others. */
const toUsage = (usage: ExtractionUsage, engine: string): EvalUsage => ({
  calls: usage.calls,
  // `engine` is WHICH TRANSPORT produced the result. The phase-shaped
  // strategies report it themselves; the whole-schema one does not, so the
  // runner fills it in from the transport it injected — the same value, from
  // the one place that knows it. Absent in the extraction's usage means "the
  // strategy did not report it", never "no transport".
  engine: usage.engine ?? engine,
  ...(usage.strategy === undefined ? {} : { strategy: usage.strategy }),
  ...(usage.promptTokens === undefined ? {} : { promptTokens: usage.promptTokens }),
  ...(usage.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
  ...(usage.cachedPromptTokens === undefined
    ? {}
    : { cachedPromptTokens: usage.cachedPromptTokens }),
  ...(usage.cacheCreationPromptTokens === undefined
    ? {}
    : { cacheCreationPromptTokens: usage.cacheCreationPromptTokens }),
});

/**
 * Run one arm over a set of cases, from a schema and a set of prompt inputs.
 *
 * This is the internal seam: it accepts a zod schema, so a test can drive the
 * same run from a directly-built schema as from a loader-round-tripped one.
 * The public entry is the corpus-shaped one; this one is not exported from the
 * barrel.
 * @param run - The schema, the prompt inputs, the cases, the transport and the settings.
 * @returns One result per case, in the order the cases were given.
 * @throws {@link EvalError} when the settings or the schema cannot drive an arm.
 * @category Eval
 */
export async function runEvalOverSchema(run: EvalSchemaRun): Promise<EvalCaseResult[]> {
  validateEvalSettings(run.settings);

  // Core's presence fill phase takes no field-descriptions option, so under
  // "prompt" the rung would run in schema mode while the record claims prompt.
  if (
    run.prompt.fieldDescriptions === "prompt" &&
    run.settings.strategies.includes("presence-narrowed")
  ) {
    throw new EvalError(
      'eval: the corpus declares fieldDescriptions "prompt", and the presence-narrowed strategy ' +
        "cannot honour it — core's presence fill phase has no field-descriptions option, so the " +
        "run would measure schema mode under a prompt-mode record (fix: drop presence-narrowed " +
        'from the arm, or set the manifest\'s fieldDescriptions to "schema")',
    );
  }

  const { target, groups } = buildEvalTarget(
    run.schema,
    run.prompt,
    run.manifestName,
    run.settings.splitCaps ?? {},
  );

  const chat = asCapableChat(run.chat);
  const arm = buildArm({
    target,
    groups,
    chat,
    model: run.settings.model,
    settings: run.settings,
    // The per-group instructions are ALWAYS passed, even when the manifest
    // declares none: core's hook is what projects a group's example to that
    // group, and a group with no entry of its own falls back to the main
    // instructions.
    groupInstructions: (groupKey: string): string =>
      run.prompt.groupInstructions?.[groupKey] ?? run.prompt.instructions,
    ...(run.prompt.fieldDescriptions === undefined
      ? {}
      : { fieldDescriptions: run.prompt.fieldDescriptions }),
    ...(run.delay === undefined ? {} : { delay: run.delay }),
  });

  const results: EvalCaseResult[] = [];
  for (const entry of run.cases) {
    const transcript: AnnotatedTranscript = { text: entry.text, annotations: {} };
    try {
      const result = await arm.extract(transcript, {});
      results.push({
        caseId: entry.id,
        status: "extracted",
        // The trust boundary already parsed the model's answer; the runner's
        // own boundary is the JSON shape, which the extraction's values are by
        // construction (they came out of a JSON Schema's parse).
        fields: result.fields,
        ...(result.raw === undefined ? {} : { raw: result.raw as EvalJsonValue }),
        usage: toUsage(result.usage, chat.engine),
      });
    } catch (error) {
      results.push({ caseId: entry.id, status: "failed", error: faultMessage(error) });
    }
  }
  return results;
}

/**
 * How one arm's run gets its document cases' text.
 * @category Eval
 */
export interface RunEvalOptions {
  /**
   * The document inputs' transcribed text, keyed by case id and file name —
   * transcribed ONCE per run and shared by every arm, so no arm re-transcribes.
   * Absent, the run transcribes the corpus's document inputs itself (the
   * single-run path); a multi-arm command transcribes once and hands the one
   * map to every arm.
   */
  readonly documents?: DocumentTexts;
}

/**
 * Run one arm over a loaded corpus.
 *
 * The corpus enters here and nowhere else: the runner reads no corpus files
 * itself and accepts no other corpus representation, so a run can never happen
 * over a corpus that was not validated.
 *
 * Every case runs on its combined text — its declared inputs, joined by core's
 * combiner in `case-text.ts` (a document input's contribution is its PDF's
 * transcription). The text comes from `options.documents` when the caller
 * transcribed already (the bin does, once per run, shared by every arm), and
 * from `transcribeDocumentCases` here when it did not. A document input that
 * cannot be transcribed, or whose transcription the caller did not supply,
 * refuses the whole run, before any model call — a partially-run corpus would
 * measure nothing.
 *
 * The transport may be a plain `ChatClient` or an already-capable one: a
 * capable client carries its own engine id, and the run's usage reports it —
 * which is how a run against a CLI backend records which transport produced
 * its fields.
 * @param corpus - The loaded corpus, from `loadCorpus`.
 * @param chat - The transport every call goes through.
 * @param settings - The arm's settings.
 * @param options - The document inputs' transcribed text, when the caller has it.
 * @returns One result per case, in the corpus's case order.
 * @throws {@link EvalError} when a document input cannot be transcribed, the settings are invalid, or the schema cannot be driven.
 * @category Eval
 */
export async function runEval(
  corpus: LoadedCorpus,
  chat: ChatClient | CapableChatClient,
  settings: EvalSettings,
  options?: RunEvalOptions,
): Promise<EvalCaseResult[]> {
  validateEvalSettings(settings);

  const documents = options?.documents ?? (await transcribeDocumentCases(corpus));
  const cases: EvalCaseInput[] = corpus.cases.map((entry) => ({
    id: entry.id,
    text: caseTextOf(corpus, entry, documents),
  }));

  return runEvalOverSchema({
    schema: corpus.schema,
    prompt: corpus.manifest.prompt,
    manifestName: corpus.manifest.name,
    cases,
    chat,
    settings,
  });
}
