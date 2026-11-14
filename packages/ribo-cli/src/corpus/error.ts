/**
 * @file The corpus-load fault class: the corpus never became a loaded corpus.
 *
 * It extends the package's could-not-run class (`SchemaInspectError`), so the
 * bin's existing mapping — exit 2, stderr only, empty stdout — covers every
 * corpus fault without a second exit-code discipline. The class membership is
 * also what lets a caller narrow on the corpus fault specifically.
 */
import { SchemaInspectError } from "../inspect/error.js";

/**
 * The corpus-load fault: a corpus directory that could not be loaded.
 *
 * Every refusal the loader raises is this class — a missing input file, an
 * unknown leaf path, an unresolvable schema reference, a malformed case file —
 * and each message names the file, the offending item and the fix.
 * @category Eval
 */
export class CorpusError extends SchemaInspectError {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}
