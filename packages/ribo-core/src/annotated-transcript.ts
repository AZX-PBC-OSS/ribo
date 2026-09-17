/** The capture metadata annotations written by the relay. */
export type CaptureAnnotations = Readonly<{
  readonly "capture.seq": number;
  readonly "capture.kind": "audio" | "document";
  readonly "capture.id": string;
}>;

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
 *
 * @typeParam P - the shape of the annotations bag. Defaults to
 * `Readonly<Record<string, unknown>>` for backward compatibility.
 */
export interface AnnotatedTranscript<P = Readonly<Record<string, unknown>>> {
  /**
   * The canonical text — the exact string extracted spans are checked against.
   * What a model quotes from and what `isSpanGrounded` checks against.
   */
  readonly text: string;
  /**
   * Open bag of annotations alongside the text. Does not affect grounding —
   * `isSpanGrounded` reads `text` only.
   *
   * **Two sources merge into the bag.** The relay fills `capture.seq`,
   * `capture.kind`, and `capture.id` from storage row metadata, so a combiner
   * that builds per-capture markers has what it needs without reaching back into
   * the database. A `Transcriber` that produces its own annotations (page
   * boundaries, table structure, a provider's own structured response) spreads
   * them at the top level alongside the relay's keys. The `capture.` prefix is a
   * reserved namespace: a transcriber's own `seq` or `id` cannot collide with
   * the relay's metadata, because the relay's keys are namespaced under `capture.`
   * and the transcriber's are not. If a transcriber does use a `capture.`-prefixed
   * key, the relay's value wins.
   *
   * Note also that annotations do **not** survive combination: a {@link TranscriptCombiner}
   * returns one transcript with its own bag, and the default returns an empty one. Per-part
   * annotations are an input to combination, not a channel through it. State that has to reach an
   * extractor from a transcriber belongs in plugin-scoped storage, which is keyed by capture and
   * survives both the combine step and a reload.
   *
   * @typeParam P - the shape of this part's annotations bag. Defaults to
   * `Readonly<Record<string, unknown>>` for backward compatibility.
   */
  readonly annotations: Readonly<P>;
}
