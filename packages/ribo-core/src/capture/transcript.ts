import { z } from "zod";

/**
 * The text a {@link Transcriber} produced for one {@link AudioCapture}.
 *
 * Flat and boring on purpose: this is the input to extraction and the text that
 * `isSpanGrounded` checks extracted spans against, so it must be text as a human
 * reads it — rendered, not escaped markup. Document transcribers decode HTML
 * entities at the transcriber (see `decodeEntities`) so the canonical text is
 * already rendered by the time anything quotes from or checks against it.
 * Segments, word timings and speaker labels are not modelled — nothing
 * downstream needs them yet, and a shape nobody consumes is a shape nobody keeps
 * honest.
 *
 * Annotations are an optional field on this type. When a transcriber produces them (page
 * boundaries, table structure, a provider's own structured response), they travel alongside
 * the text into the storage document and are merged into the {@link @azx/ribo-core!AnnotatedTranscript}
 * annotations bag by `listSessionTranscriptParts`. The relay also supplies capture metadata
 * (`capture.seq`, `capture.kind`, `capture.id`) into the same bag; the `capture.` prefix is a
 * reserved namespace so a transcriber's own `seq` or `id` cannot collide with it. A transcriber
 * that produces no annotations simply omits the field — existing documents have no annotations,
 * which is the correct state for them. Because this object is persisted inside the storage
 * document, adding the field required a schema version bump (v6 → v7) and a migration strategy;
 * the strategy is identity, since the field is optional and absent on existing documents.
 *
 * **Confidence here is the transcriber's overall score for the utterance, and it is not
 * load-bearing.** Per-field confidence is a different thing entirely: it lives in the provenance
 * envelope (`provenance.ts`, `Extracted<T>`) and is documented there as non-load-bearing —
 * the extraction spike returned ~1.0 on all 168 slots, so nothing flags on it. Treat this field
 * the same way: record it, show it if you like, never branch on it.
 * @category Captures & Sources
 */
export const transcriptSchema = z.strictObject({
  /** The `AudioCapture.id` this text came from. */
  recordingId: z.string().min(1),
  /**
   * The full transcript. May be empty — silence transcribes to nothing, which is a legitimate
   * result, not an error.
   */
  text: z.string(),
  /**
   * **Which engine produced this text** — `Transcriber.engine` of the implementation that
   * actually ran, never of a wrapper that delegated to it.
   *
   * Required, not optional, and that is the whole point. The failure this guards against is not
   * a crash: it is believing the fleet is offline-capable while on-device quietly fell back to
   * the managed STT path on every single recording and someone is paying per minute for it.
   * An optional field would be omitted by exactly the implementation whose fallbacks you most
   * need to see, and "what is the engine mix across the queue?" would be unanswerable.
   *
   * It rides into the storage document inside this object (`queue/schema.ts`), so the mix is
   * readable straight off `storage.captures.list()` without a second, denormalized copy of the same truth.
   *
   * The value is an opaque id owned by the implementation — `ribo-core` deliberately does not
   * enumerate engines, because the engines ship in other packages. `"fake"`,
   * `"ondevice-whisper"` and `"managed-azure"` are the ids in use.
   */
  engine: z.string().min(1),
  /**
   * Optional overall confidence in [0, 1], if the transcriber reports one. Optional rather than
   * nullable because not every engine emits it; see the note above before using it for anything.
   */
  confidence: z.number().min(0).max(1).optional(),
  /**
   * Optional annotations bag — structured data a transcriber contributes alongside
   * the text (page boundaries, table structure, provider metadata). Shaped as the same
   * open record {@link @azx/ribo-core!AnnotatedTranscript} uses, so it merges directly into the
   * annotations bag that an extractor receives.
   *
   * Optional because not every transcriber produces annotations; absent is the correct
   * state for a transcript that carries none. Persisted inside the storage document, so
   * adding this field required storage schema version 7 and a migration strategy (identity,
   * since the field is optional).
   *
   * The relay populates the annotations bag with capture metadata under a reserved
   * `capture.` prefix (`capture.seq`, `capture.kind`, `capture.id`); a transcriber's own
   * annotations are spread at the top level and cannot collide with those keys unless the
   * transcriber deliberately uses the reserved prefix.
   */
  annotations: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Inferred from {@link transcriptSchema} — never hand-declared alongside it.
 *
 * @category Captures & Sources
 */
export type Transcript = z.infer<typeof transcriptSchema>;
