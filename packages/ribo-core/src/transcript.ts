import { z } from "zod";

/**
 * The text a {@link Transcriber} produced for one {@link Recording}.
 *
 * Flat and boring on purpose: this is the input to extraction and the text that
 * `isSpanGrounded` checks extracted spans against, so it must be exactly what the model saw.
 * Segments, word timings and speaker labels are not modelled — nothing downstream needs them
 * yet, and a shape nobody consumes is a shape nobody keeps honest.
 *
 * **Confidence here is the transcriber's overall score for the utterance, and it is not
 * load-bearing.** Per-field confidence is a different thing entirely: it lives in the provenance
 * envelope (`provenance.ts`, `Extracted<T>`) and is documented there as non-load-bearing —
 * the extraction spike returned ~1.0 on all 168 slots, so nothing flags on it. Treat this field
 * the same way: record it, show it if you like, never branch on it.
 */
export const transcriptSchema = z.strictObject({
  /** The `Recording.id` this text came from. */
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
   * It rides into the outbox document inside this object (`queue/schema.ts`), so the mix is
   * readable straight off `Outbox.list()` without a second, denormalized copy of the same truth.
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
});

/** Inferred from {@link transcriptSchema} — never hand-declared alongside it. */
export type Transcript = z.infer<typeof transcriptSchema>;
