/**
 * @file The structured value an extractor receives: a canonical text plus an
 * open bag of annotations alongside it.
 *
 * This replaces the bare `string` that the transcribe→extract seam used to
 * carry. A string was the right type for dictation and nothing else — document
 * transcribers already have more to say (page boundaries, table structure,
 * per-capture attribution) and smuggling that through as in-band text markers
 * loses structure or leaks it into a human-facing surface.
 *
 * **Grounding is unaffected.** {@link isSpanGrounded} needs a canonical text —
 * it does not need the seam to *be* a string. `isSpanGrounded(span, t.text)` is
 * the same check it always was. There is exactly one canonical text per
 * transcript; if a span check is ever ambiguous about which text it checks
 * against, the type has been designed wrong.
 */

/**
 * The input to {@link Extractor.extract}: a canonical text plus an open bag of
 * annotations.
 *
 * `text` is the exact string that extracted spans are checked against — the one
 * canonical text. `annotations` is an open bag whose contents are deliberately
 * left undefined until a real transcriber produces them. A speculative schema
 * for a consumer that does not exist will be wrong, and it will be load-bearing
 * by the time anyone finds out.
 */
export interface AnnotatedTranscript {
  /**
   * The canonical text — the exact string extracted spans are checked against.
   * What a model quotes from and what `isSpanGrounded` checks against.
   */
  readonly text: string;
  /**
   * Open bag of annotations alongside the text. Left empty by dictation
   * transcribers; document transcribers may populate it with page boundaries,
   * table structure, or per-capture attribution when a real consumer needs them.
   * Does not affect grounding — `isSpanGrounded` reads `text` only.
   */
  readonly annotations: Readonly<Record<string, unknown>>;
}
