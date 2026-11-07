import { z } from "zod";

/**
 * @file The four fields both capture branches share.
 *
 * `Recording` (audio) and `DocumentCapture` (document) each spread this bag
 * into their own `z.strictObject`. It exists so the two branch declarations
 * cannot drift: a shared field added to one and forgotten in the other would
 * be a union whose common shape is narrower than it reads.
 *
 * Neither branch sets `kind` here — `kind` is the discriminator and each
 * branch declares its own literal.
 */

/**
 * The shared capture fields, parameterised by the host's context schema.
 *
 * Returns a plain object (not a `z.ZodObject`) so each branch spreads it into
 * its own `z.strictObject` with its own `kind` and branch-specific fields.
 * @category Captures & Sources
 */
export const captureFields = <C extends z.ZodType>(ctx: C) =>
  ({
    /** Stable identifier. Also the key the queue stores the bytes under. */
    id: z.string().min(1),
    /** When capture finished, as an ISO 8601 UTC timestamp — string, so it survives JSON. */
    capturedAt: z.iso.datetime(),
    /** The MIME type of the captured bytes (`audio/webm;codecs=opus`, `application/pdf`, …). */
    mimeType: z.string().min(1),
    /**
     * Host-supplied association. Required, never `.optional()`: a host that has no
     * context should say so explicitly with an empty object rather than leave the key
     * off, so that "no context" and "forgot the context" stay distinguishable.
     */
    ctx,
  }) as const;
