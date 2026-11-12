/**
 * The could-not-run fault class: the input never became a report. The bin maps
 * it to exit 2 with stderr only (design §4); every raise site inside the
 * loader — the document check, the draft-form refusal, the converter, the leaf
 * walk — throws exactly this class, so `instanceof` stays truthful.
 */
export class SchemaInspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaInspectError";
  }
}
