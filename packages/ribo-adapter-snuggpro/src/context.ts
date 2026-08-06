/**
 * The Snugg Pro write context — the `C` in `ToolAdapter<V, C>`.
 *
 * This is a REAL type, never `unknown`. `ToolAdapter`'s `C` exists so the type
 * system checks that a host handed the adapter everything its `write` needs; an
 * `unknown` ctx hides the host↔adapter coupling (see `ribo-core`'s adapter.ts and
 * its `@ts-expect-error` tests). This is what identifies the destination the
 * accepted fields are written into.
 *
 * It is also a real SCHEMA, and the schema is the source of truth. A type alone
 * cannot parse `Recording.ctx`, which comes back out of IndexedDB and therefore
 * crosses a trust boundary — the destination of a write is exactly the thing that
 * must not be taken on trust from a persisted row. So the shape is declared once
 * as {@link snuggCtxSchema} and {@link SnuggWriteContext} is inferred back off it,
 * the pattern `recording.ts` documents for `recordingSchema(jobContext)`: "because
 * zod is the source of truth, the generic lives on the schema factory and the type
 * is inferred back off it — there is no hand-written interface to drift".
 *
 * The `readonly` modifiers the hand-written interface used to carry are KEPT, via
 * `Readonly<>` over the inferred type. Inferring the shape and marking it readonly
 * are independent choices, and only the first is what the `recordingSchema` pattern
 * is about — there is still no hand-written interface to drift from. Dropping
 * `readonly` would have been a silent regression from the interface this replaced,
 * and it would put this type out of step with every sibling at the same public
 * boundary: `ToolAdapter`'s members are `readonly`, and `Enveloped<V>` keeps
 * `readonly` on `extractionSchema` for precisely this consistency reason (see its
 * note in `ribo-core/src/enveloped.ts`). Costs nothing at runtime.
 *
 * Shapes tracked to the real Snugg Pro write API (doc 12 §1). The exact assessment
 * PATCH endpoint and its JSON body are still `[unknown]` in doc 12 — this context
 * carries what is needed to TARGET the write regardless of the final endpoint
 * shape; the request itself (and its A1 HMAC-SHA256 signing) lands in Phase 4
 * Task 6. `jobId` in doc 05's placeholder `PATCH /assessments/{jobId}` becomes
 * `assessmentId` here.
 *
 * Deliberately NOT `.strict()`, unlike every field schema in this package. A host
 * owns `Recording.ctx` and may reasonably keep more in it than this adapter needs
 * (its own job metadata, UI state); zod strips the extras, and rejecting them
 * would turn a harmless host convenience into a terminal write failure. What is
 * checked is that the three things a write cannot proceed without are present and
 * usable.
 */

import { z } from "zod";

export const snuggCtxSchema = z.object({
  /**
   * The Snugg Pro assessment (a.k.a. job) the accepted fields are written into —
   * the record the write PATCHes. Doc 05's placeholder called this `jobId`.
   * Non-empty: an empty id would target the collection, not a record.
   */
  assessmentId: z.string().min(1),

  /**
   * The Snugg Pro company the API key was provisioned under (Settings > Your
   * Companies > App Integrations). Scopes the write to the right tenant, so an
   * empty one is a write with no tenant rather than a harmless default.
   */
  companyId: z.string().min(1),

  /**
   * Base URL of the Snugg Pro API, reached through the Helix egress proxy that
   * holds the credential and signs the request server-side (doc 12 §1). The
   * client never holds the key and never signs — it targets this base. Checked as
   * a URL because a bare host or a path fragment would be silently concatenated
   * into a request aimed at nowhere.
   */
  apiBaseUrl: z.url(),
});

/**
 * Inferred from {@link snuggCtxSchema} — never hand-declared alongside it — and
 * `Readonly` because a write's destination is not something a caller should be
 * mutating in place. See the file header on why the modifier survives the move
 * from a hand-written interface to an inferred type.
 */
export type SnuggWriteContext = Readonly<z.infer<typeof snuggCtxSchema>>;
