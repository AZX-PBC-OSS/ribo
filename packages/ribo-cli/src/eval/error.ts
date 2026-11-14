/**
 * @file The eval runner's fault class: the run never became a run.
 *
 * It extends the package's could-not-run class (`SchemaInspectError`), the
 * pattern `CorpusError` already sets, so the bin's exit-2 mapping — T9b's to
 * wire — covers every eval fault without a second exit-code discipline, and
 * `instanceof` stays truthful for a caller narrowing on the eval fault
 * specifically.
 *
 * Every refusal the runner raises before a model call is this class: an
 * invalid settings object, a corpus holding a document case, a schema the arm
 * cannot drive, an example naming no leaf.
 */
import { SchemaInspectError } from "../inspect/error.js";

/**
 * The eval fault: a run that could not be started, or could not be driven.
 *
 * Every message names the offending item and the fix, the way the loader's
 * refusals do.
 * @category Eval
 */
export class EvalError extends SchemaInspectError {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}
