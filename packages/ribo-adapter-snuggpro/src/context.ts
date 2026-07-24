/**
 * The Snugg Pro write context — the `C` in `ToolAdapter<F, C>`.
 *
 * This is a REAL type, never `unknown`. `ToolAdapter`'s `C` exists so the type
 * system checks that a host handed the adapter everything its `write` needs; an
 * `unknown` ctx hides the host↔adapter coupling (see `ribo-core`'s adapter.ts and
 * its `@ts-expect-error` tests). This is what identifies the destination the
 * accepted fields are written into.
 *
 * Shapes tracked to the real Snugg Pro write API (doc 12 §1). The exact assessment
 * PATCH endpoint and its JSON body are still `[unknown]` in doc 12 — this context
 * carries what is needed to TARGET the write regardless of the final endpoint
 * shape; the request itself (and its A1 HMAC-SHA256 signing) lands in Phase 4
 * Task 6. `jobId` in doc 05's placeholder `PATCH /assessments/{jobId}` becomes
 * `assessmentId` here.
 */
export interface SnuggWriteContext {
  /**
   * The Snugg Pro assessment (a.k.a. job) the accepted fields are written into —
   * the record the write PATCHes. Doc 05's placeholder called this `jobId`.
   */
  readonly assessmentId: string;

  /**
   * The Snugg Pro company the API key was provisioned under (Settings > Your
   * Companies > App Integrations). Scopes the write to the right tenant.
   */
  readonly companyId: string;

  /**
   * Base URL of the Snugg Pro API, reached through the Helix egress proxy that
   * holds the credential and signs the request server-side (doc 12 §1). The
   * client never holds the key and never signs — it targets this base.
   */
  readonly apiBaseUrl: string;
}
