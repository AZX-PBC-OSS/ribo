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
   * Open bag of annotations alongside the text. Does not affect grounding —
   * `isSpanGrounded` reads `text` only.
   *
   * **Today this is populated by core, not by transcribers.** The relay fills it from outbox row
   * metadata (`seq`, `kind`, `id` — see `listSessionTranscriptParts`), and the default combiner
   * reads those to build per-capture markers. A `Transcriber` has no way to contribute: it returns
   * a {@link Transcript}, which carries no annotations field, so page boundaries and table
   * structure have nowhere to go.
   *
   * That is a gap, not the intended end state — an earlier version of this comment claimed
   * transcribers populate the bag, which was never true. Closing it means adding the field to
   * `Transcript`, which is persisted inside the outbox document, so it is a stored-schema change
   * needing an outbox version bump and a migration strategy rather than a type edit. Decided and
   * planned; see the plan in `docs/roadmap/plans/`.
   *
   * Note also that annotations do **not** survive combination: a {@link TranscriptCombiner}
   * returns one transcript with its own bag, and the default returns an empty one. Per-part
   * annotations are an input to combination, not a channel through it. State that has to reach an
   * extractor from a transcriber belongs in plugin-scoped storage, which is keyed by capture and
   * survives both the combine step and a reload.
   */
  readonly annotations: Readonly<Record<string, unknown>>;
}
