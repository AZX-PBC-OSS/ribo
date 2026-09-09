import { z } from "zod";

import { captureFields } from "./capture-fields.js";

/**
 * @file The document capture branch and the `CaptureItem` union.
 *
 * Lands D1, D2 and D3 of the document-transcription plan:
 *
 * - **D1** — `Recording` is the audio branch; `DocumentCapture` is the document
 *   branch; `CaptureItem` is the union of the two, discriminated by `kind`.
 * - **D2** — no RxDB version bump. The outbox schema's `recording` field is
 *   `{ type: "object" }` with no nested `properties`, so RxDB neither validates
 *   nor indexes the interior. The zod schema is the only description of that
 *   interior, and it is parsed on read — which is where legacy tolerance lives.
 * - **D3** — `z.discriminatedUnion` ignores a branch's `.default()` on the
 *   discriminator: it selects a branch by reading the _raw_ discriminator value
 *   before any branch's defaults run, so a legacy row with no `kind` reaches no
 *   branch and fails. The union wraps the discriminated union in a `z.preprocess`
 *   that stamps `kind: "audio"` onto a row that has **no `kind` key at all**, and
 *   leaves a row carrying an unrecognised `kind` alone so it fails as a bad
 *   discriminator rather than being quietly rewritten.
 */

/**
 * The document capture branch: a PDF (or other document) enqueued for
 * transcription.
 *
 * Same shared fields as {@link recordingSchema}, plus `kind: "document"` (no
 * default — there are no legacy document rows to be tolerant of) and `pageCount`.
 *
 * `pageCount` is `.int().positive()` where `durationMs` is `.int().nonnegative()`:
 * a zero-length recording is a legitimate capture, but a zero-page document is
 * not a document — it is a parse that went wrong upstream.
 */
export const documentCaptureSchema = <C extends z.ZodType>(ctx: C) =>
  z.strictObject({
    ...captureFields(ctx),
    kind: z.literal("document"),
    /** Page count, known at enqueue time. Zero is not a document. */
    pageCount: z.number().int().positive(),
  });

/** A `DocumentCapture` whose context is carried but not validated. */
export const baseDocumentCaptureSchema = documentCaptureSchema(z.unknown());

/** Inferred from {@link documentCaptureSchema} — never hand-declared alongside it. */
export type DocumentCapture<C extends z.ZodType = z.ZodUnknown> = z.infer<
  ReturnType<typeof documentCaptureSchema<C>>
>;

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/**
 * The `CaptureItem` union, parameterised by the host's context schema.
 *
 * A `z.preprocess` wrapper around a `z.discriminatedUnion` on `kind`. The
 * preprocess stamps `kind: "audio"` onto a row that has **no `kind` key at all**
 * (legacy rows predating the discriminant), and leaves a row with an
 * unrecognised `kind` alone so it fails as a bad discriminator rather than being
 * quietly rewritten to `audio`.
 *
 * Both mechanisms ship: the branch `.default("audio")` (in `recordingSchema`)
 * serves a direct `recordingSchema.parse(...)` — which is what `recorder.ts` and
 * roughly two dozen test fixtures do — and this preprocess serves every parse
 * that goes through the union. If a later zod applies branch defaults during
 * discrimination, the preprocess can go, and the test that pins the behaviour
 * will go red to say so.
 */
export const captureItemSchema = <C extends z.ZodType>(ctx: C) => {
  const audio = z.strictObject({
    ...captureFields(ctx),
    kind: z.literal("audio").default("audio"),
    /** Length of the audio in milliseconds. Zero is legal: a recording can be empty. */
    durationMs: z.number().int().nonnegative(),
  });

  const document = documentCaptureSchema(ctx);

  const discriminated = z.discriminatedUnion("kind", [audio, document]);

  return z.preprocess((raw) => {
    if (raw !== null && typeof raw === "object" && !("kind" in raw)) {
      return { ...raw, kind: "audio" };
    }
    return raw;
  }, discriminated);
};

/** A `CaptureItem` whose context is carried but not validated. */
export const baseCaptureItemSchema = captureItemSchema(z.unknown());

/** Inferred from {@link captureItemSchema} — never hand-declared alongside it. */
export type CaptureItem<C extends z.ZodType = z.ZodUnknown> = z.infer<
  ReturnType<typeof captureItemSchema<C>>
>;
