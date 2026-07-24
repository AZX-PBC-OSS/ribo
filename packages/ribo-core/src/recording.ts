import { z } from "zod";

/**
 * The metadata record for one captured dictation.
 *
 * **The audio bytes are not here.** A `Recording` is metadata only; the `Blob` lives in the
 * capture queue (Phase 2), keyed by `id`, and is handed to a {@link Transcriber} alongside the
 * record. Keeping the two apart is what lets a `Recording` be serialized, logged, persisted and
 * passed around freely — a record carrying megabytes of audio cannot be. If you came here
 * looking for the audio, you want the queue's `getAudio(recording.id)`, not this type.
 *
 * ## The `ctx` slot
 *
 * `ribo-core` is host-agnostic: it has no idea what a recording is *about*. A host does — a job,
 * an assessment, a work order — and needs that association to survive the round trip through the
 * queue. `ctx` is that slot: opaque to core, meaningful to the host.
 *
 * It is deliberately **not** `ctx: unknown`. An untyped hole hides host coupling from the type
 * system (the same review finding that produced `ToolAdapter<F, C>`), so the shape is a *type
 * parameter* instead, supplied by the host as a zod schema:
 *
 * ```ts
 * const jobContext = z.object({ jobId: z.string().min(1) });
 * const schema = recordingSchema(jobContext);
 * type JobRecording = Recording<typeof jobContext>; // ctx: { jobId: string }
 * ```
 *
 * Because zod is the source of truth, the generic lives on the *schema factory* and the type is
 * inferred back off it — there is no hand-written `Recording` interface to drift. `Recording`
 * with no type argument defaults to `ctx: unknown`, which is the right shape for core-internal
 * code that carries the slot through without ever reading it.
 */
export const recordingSchema = <C extends z.ZodType>(ctx: C) =>
  z.strictObject({
    /** Stable identifier. Also the key the queue stores the audio blob under. */
    id: z.string().min(1),
    /** When capture finished, as an ISO 8601 UTC timestamp — string, so it survives JSON. */
    capturedAt: z.iso.datetime(),
    /** Length of the audio in milliseconds. Zero is legal: a recording can be empty. */
    durationMs: z.number().int().nonnegative(),
    /** The `MediaRecorder` MIME type, codecs parameter included (`audio/webm;codecs=opus`). */
    mimeType: z.string().min(1),
    /**
     * Host-supplied association. Required, never `.optional()`: a host that has no context
     * should say so explicitly with an empty object rather than leave the key off, so that
     * "no context" and "forgot the context" stay distinguishable.
     */
    ctx,
  });

/**
 * A `Recording` whose context is carried but not validated.
 *
 * For core-internal code and tests that must parse a record without knowing the host's context
 * shape. Still strict about every field it does own, and still requires the `ctx` key to exist.
 */
export const baseRecordingSchema = recordingSchema(z.unknown());

/** Inferred from {@link recordingSchema} — never hand-declared alongside it. */
export type Recording<C extends z.ZodType = z.ZodUnknown> = z.infer<
  ReturnType<typeof recordingSchema<C>>
>;
