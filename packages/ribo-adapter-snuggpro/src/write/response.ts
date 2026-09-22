/**
 * The response shapes the Snugg Pro write path parses — the vendor's success
 * bodies and the Helix gateway's denial envelope. The writer does I/O; this
 * file describes shapes. zod, because a vendor response is a trust boundary
 * (AGENTS §4).
 */

import { z } from "zod";

/**
 * A collection write returns the created or updated record as JSON. Only the
 * `uuid` is read — it is the write receipt a future amend pass UPDATEs against.
 * The record's other keys are its own and are stripped.
 */
export const snuggRecordSchema = z.object({
  uuid: z.string().min(1),
});

/**
 * The Helix platform's denial envelope: `{"error":{"code":…}}`.
 *
 * A shape check ONLY — the `code` is deliberately not matched against a list,
 * so a future gateway error code still parses as the platform's own answer.
 * This envelope is what separates a lapsed platform session from the vendor's
 * refusal relayed with the vendor's — empty — body.
 */
export const helixErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
  }),
});
