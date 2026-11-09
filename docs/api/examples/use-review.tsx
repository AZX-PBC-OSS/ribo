/**
 * The type-checked-only example behind docs/api/use-review.html.
 *
 * Rendering a hook needs React plus browser globals, so this file is a plain
 * `.tsx` — never executed (the runner's glob matches `.run.ts` only). Its page
 * says "type-checked only", which scripts/check-api-examples.mjs enforces.
 * Runtime behaviour is covered by packages/ribo-ui-react's browser suite and
 * the e2e project.
 */

import { z } from "zod";
import { useReview } from "@azx/ribo-ui-react";
import type { SessionItem } from "@azx/ribo-core";

// A host passes its own adapter's PATCH schema — the schema, never the whole
// adapter: the hook needs to walk a ZodObject and has no business holding
// `write` or `instructions`. Hold it still (a module constant): it is a
// `useMemo` dependency, and an inline `z.object` rebuilds every field on every
// render, so a text input loses focus on every keystroke.
const valuesSchema = z.object({
  rValue: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});

// Hooks run inside a component, never at module scope — this is the component
// body a host would write.
// #region usage
export function ReviewCard({ session }: { session: SessionItem | undefined }) {
  const { ready, fields, decisionOf, accept, edit, reject, untouched, errors, tree, submit } =
    useReview(session, { valuesSchema });

  // Decisions start complete — every leaf begins `{ status: "accepted" }` —
  // and `untouched` reports what nobody acted on, so a host can require every
  // ungrounded leaf to be visited before enabling submit. The guarantee itself
  // is core's: `resolveReview` refuses a submission whose leaf set is not the
  // request's.
  for (const path of untouched) {
    const field = fields?.[path];
    if (field && !field.isGrounded) reject(path);
  }
  void decisionOf("rValue");
  void accept("rValue");
  void edit;
  void errors;
  void tree;
  void ready;
  void submit;
  return null;
}
// #endregion usage

// #region instance-identity
// Existing records enter at review, never at extraction; the safe default for
// an instance with no explicit link decision is always create.
export function InstanceIdentityCard({ session }: { session: SessionItem | undefined }) {
  const { linkDecisionOf, linkInstance, createInstance, rankedCandidatesOf, addInstance } =
    useReview(session, {
      valuesSchema,
      existingRecords: { hvac: [{ uuid: "uuid-1", fields: { fuel: "Gas" } }] },
    });

  void linkDecisionOf("hvac[k1]");
  void linkInstance;
  void createInstance;
  void rankedCandidatesOf;
  void addInstance;
  return null;
}
// #endregion instance-identity
