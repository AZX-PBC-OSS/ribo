/**
 * @file The ONE case-text assembly: a case's inputs joined into the one text
 * the model reads, through core's own combiner.
 *
 * The runner, the spend estimate and `ribo corpus text` all price, extract
 * and print the SAME text, so the join lives here and nowhere else — a second
 * copy of the joining could omit a marker or an input where another includes
 * it. The combiner is core's `createDefaultTranscriptCombiner`, used as is:
 * its marker format and its unmarked single-space join are not reproduced
 * here.
 *
 * Every part carries the open-bag annotations the marker reads —
 * `capture.seq` (the 1-based position across the case's inputs),
 * `capture.kind` (the entry's declared kind) and `capture.id` (the entry's
 * file name). The combiner throws on a missing key, so an annotation gap is
 * loud, not silent garbage in the grounding substrate.
 */
import { createDefaultTranscriptCombiner } from "@azx/ribo-core";
import type { AnnotatedTranscript } from "@azx/ribo-core";

import type { CorpusInputKind } from "../corpus/case.js";
import type { LoadedCase, LoadedCorpus } from "../corpus.js";
import { documentTextKey } from "./documents.js";
import type { DocumentTexts } from "./documents.js";
import { EvalError } from "./error.js";

/** One input's text and identity, as the shared join reads them. */
export interface CaseInputText {
  readonly kind: CorpusInputKind;
  readonly file: string;
  readonly text: string;
}

/** The open-bag annotations the marker reads, built once for every caller. */
function annotatedParts(
  inputs: readonly CaseInputText[],
): readonly AnnotatedTranscript<Record<string, string | number>>[] {
  return inputs.map((input, index) => ({
    text: input.text,
    annotations: {
      "capture.seq": index + 1,
      "capture.kind": input.kind,
      "capture.id": input.file,
    },
  }));
}

/**
 * The one marked join every sample's text is made of: the inputs in order,
 * each under its capture marker, through core's combiner. Eval's
 * `caseTextOf` and schema init's sample loader both call this — a second
 * copy of the marked join could omit a marker or an input where the other
 * includes it.
 * @param inputs - The case's inputs, in declared order, with their text.
 * @returns The combined text, exactly as core's combiner produces it.
 * @category Eval
 */
export function joinCaseInputTexts(inputs: readonly CaseInputText[]): string {
  return createDefaultTranscriptCombiner({ markCaptures: true })(annotatedParts(inputs)).text;
}

/**
 * The corpus's effective marker policy: the manifest's `combine.markCaptures`
 * when it declares one, `true` when it does not — an absent block, an absent
 * member and an explicit `true` are the same effective setting.
 * @param corpus - The loaded corpus.
 * @returns Whether the case texts carry core's capture markers.
 * @category Eval
 */
export function effectiveMarkCaptures(corpus: LoadedCorpus): boolean {
  return corpus.manifest.combine?.markCaptures ?? true;
}

/**
 * One case's ordered per-input texts: each declared input's `kind`, `file` and exact text, with
 * document inputs transcribed through the one map `transcribeDocumentCases` built. The shared
 * join and the proposal engine's per-input evidence matching both read this — one mapping, so
 * the combined text and the evidence substrate can never disagree about an input's text.
 * @param entry - The loaded case whose inputs are mapped.
 * @param documents - The document inputs' transcribed text, keyed by `documentTextKey`.
 * @returns The case's inputs, in declared order, with their text.
 * @throws {@link EvalError} when a document input has no transcribed text.
 * @category Eval
 */
export function caseInputsOf(
  entry: LoadedCase,
  documents: DocumentTexts | undefined,
): readonly CaseInputText[] {
  return entry.inputs.map((input): CaseInputText => {
    if (input.kind !== "document") return { kind: input.kind, file: input.file, text: input.text };
    const text = documents?.get(documentTextKey(entry.id, input.file));
    if (text === undefined) {
      throw new EvalError(
        `eval: the corpus case "${entry.id}"'s document input "${input.file}" has no ` +
          "transcribed text — document inputs are transcribed once per run and the run " +
          "refuses rather than skipping one: a partially-run corpus measures nothing (fix: " +
          "transcribe the corpus's document inputs with transcribeDocumentCases and pass " +
          "the result to every arm and to the estimate)",
      );
    }
    return { kind: input.kind, file: input.file, text };
  });
}

/**
 * The one text a case's prompt carries: its declared inputs, each loaded or
 * transcribed exactly as a single input is today, joined in declared order by
 * core's combiner under the corpus's marker policy.
 *
 * A document input whose transcription is missing from the supplied map is a
 * REFUSAL, never an empty string — the caller (the runner, the estimate)
 * cannot ask a case a question its own input does not answer.
 * @param corpus - The loaded corpus, for the manifest's combine policy.
 * @param entry - The loaded case whose inputs are joined.
 * @param documents - The document inputs' transcribed text, keyed by
 *   `documentTextKey` — the one map `transcribeDocumentCases` built.
 * @returns The combined text, exactly as core's combiner produces it.
 * @throws {@link EvalError} when a document input has no transcribed text.
 * @category Eval
 */
export function caseTextOf(
  corpus: LoadedCorpus,
  entry: LoadedCase,
  documents: DocumentTexts | undefined,
): string {
  const inputs = caseInputsOf(entry, documents);
  if (effectiveMarkCaptures(corpus)) return joinCaseInputTexts(inputs);
  return createDefaultTranscriptCombiner({ markCaptures: false })(annotatedParts(inputs)).text;
}
