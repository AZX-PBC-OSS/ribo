/**
 * @file The `ribo corpus text` command's core: the text each case's prompt
 * carries, computed the way `ribo eval` computes it.
 *
 * A transcript or text case's text is its input file's exact contents; a
 * document case's text is its transcription through `transcribeDocumentCases`
 * — the ONE document path, shared with `ribo eval`, never a second pdf.js
 * route. No model call is made and no credential is needed: transcription is
 * free and local.
 *
 * Every fault is the could-not-run class the bin already maps to exit 2: the
 * loader's `CorpusError` for an unreadable corpus, this module's
 * `CorpusError` for an unknown case id, and `transcribeDocumentCases`'s
 * `EvalError` for a document that cannot be transcribed.
 *
 * The module is INTERNAL: the bin imports it directly, and it is not exported
 * from the package's public entry.
 */
import { transcribeDocumentCases } from "../eval/documents.js";
import { caseTextOf } from "../eval/case-text.js";
import { CorpusError } from "./error.js";
import type { LoadedCorpus } from "./loader.js";

/**
 * The version of the `--json` document the command emits: a
 * `contractVersion` literal the CLI owns, bumped when a field's name or
 * meaning changes — the discipline the inspect report's contract set.
 *
 * Version 2 dropped the per-case `kind`: a case's inputs may be of several
 * kinds, so no singular kind is truthful, and the command's contract is the
 * combined model-facing text.
 */
export const CORPUS_TEXT_CONTRACT_VERSION = 2;

/**
 * One case's text: the case id and the text its prompt carries — the case's
 * inputs joined by core's combiner, markers included when they are on.
 */
export interface CorpusTextEntry {
  readonly caseId: string;
  readonly text: string;
}

/**
 * A corpus's case texts: the corpus's name, and one entry per selected case.
 */
export interface CorpusText {
  readonly corpus: string;
  readonly cases: readonly CorpusTextEntry[];
}

/**
 * Collect the text each selected case's prompt carries.
 *
 * The selection happens BEFORE transcription: asking for one case's text
 * never spends pdf.js on another case's document, and a broken document in
 * a case nobody asked about cannot refuse the question. Document inputs are
 * transcribed through `transcribeDocumentCases`, the same path `ribo eval`
 * uses, over exactly the selected cases; each case's text is then the ONE
 * combined assembly the run and the estimate also read (`caseTextOf`), so
 * what this prints is what the model reads.
 * @param corpus - The loaded corpus, from `loadCorpus`.
 * @param caseId - The one case to collect, or every case when absent.
 * @returns The corpus's name and the selected cases' texts, in corpus order.
 * @throws {@link CorpusError} when `caseId` names no case of the corpus —
 *   the message names the id and the cases the corpus holds.
 * @throws {@link EvalError} when a selected document input cannot be
 *   transcribed — the message names the case, the file and the reason.
 */
export async function collectCorpusText(
  corpus: LoadedCorpus,
  caseId?: string,
): Promise<CorpusText> {
  let selected = corpus.cases;
  if (caseId !== undefined) {
    selected = corpus.cases.filter((entry) => entry.id === caseId);
    if (selected.length === 0) {
      throw new CorpusError(
        `the corpus "${corpus.manifest.name}" holds no case "${caseId}" — the cases it holds ` +
          `are: ${corpus.cases.map((entry) => entry.id).join(", ")} (fix: pass one of those ` +
          "ids, or no id to print every case)",
      );
    }
  }
  const documents = await transcribeDocumentCases({ ...corpus, cases: selected });
  const cases = selected.map((entry) => ({
    caseId: entry.id,
    text: caseTextOf(corpus, entry, documents),
  }));
  return { corpus: corpus.manifest.name, cases };
}
