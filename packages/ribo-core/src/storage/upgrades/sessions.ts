/**
 * @file The session document's shape version and upgrade ladder.
 *
 * The version constant is maintained by hand and is **not** derived from the
 * ladder's length — see `captures.ts` for why.
 */

import type { ShapeUpgrade } from "./rung.js";

/** @category Offline & Storage */
export const SESSION_DOCUMENT_VERSION = 3;

/** @category Offline & Storage */
export const SESSION_DOCUMENT_UPGRADES: readonly ShapeUpgrade[] = [
  {
    reason:
      "Added the optional `extractionUsage` field. No stored document needs " +
      "transforming — and the bump is still required, which is the expensive lesson " +
      "this repository has already paid for once. RxDB validates a declared schema " +
      "against the one the collection was CREATED with, so adding a property at the " +
      "same version is refused at `addCollections` with DB6 on any device that has " +
      "merely opened the app. All three collections are added in one call on one " +
      "database, so that refusal is not scoped to sessions: it rejects the whole open " +
      "and takes the captures with it, leaving an auditor's recordings and their audio " +
      'on the device with no way in. "The new field is optional so no data needs ' +
      'transforming" answers the data question and leaves the schema question unasked.',
    rewrite: "none",
  },
  {
    reason:
      "Review outcomes carry explicit per-instance keys. Synthesises `instanceKeys` " +
      "for outcomes that predate the field, matching what `resolveReview` would have " +
      "produced, while leaving any keys a document already has untouched.",
    upgrade: (document) => {
      const reviewOutcome = document.reviewOutcome as
        | {
            status?: string;
            fields?: Record<string, unknown>;
            instanceKeys?: Record<string, string[]>;
          }
        | undefined;
      if (reviewOutcome === undefined || reviewOutcome.status === "discarded") return document;
      const fields = reviewOutcome.fields ?? {};
      // Seeded from what is already there, and each group is skipped if it already
      // has keys. Both matter: these keys identify instances in the destination
      // system, so synthesising over a real one would silently break the mapping
      // between a reviewed group and what was actually written.
      const instanceKeys: Record<string, string[]> = { ...reviewOutcome.instanceKeys };
      for (const [group, groupFields] of Object.entries(fields)) {
        if (!Array.isArray(groupFields) || groupFields.length === 0) continue;
        if (instanceKeys[group] !== undefined) continue;
        instanceKeys[group] = Array.from({ length: groupFields.length }, (_, i) => `k${i + 1}`);
      }
      return { ...document, reviewOutcome: { ...reviewOutcome, instanceKeys } };
    },
  },
  {
    reason:
      "Added the optional `skippedItems` field — the per-item report of what an " +
      '`onItemFailure: "skip"` policy gave up on, persisted so review can tell an ' +
      "engine-written abstention from a genuine one (ADR 0026 deferred exactly this step). " +
      "No stored document needs transforming — an absent optional field is the correct " +
      "state for every pre-existing session — but the bump is still required, which is " +
      "the expensive lesson this repository has already paid for twice. RxDB validates " +
      "a declared schema against the one the collection was CREATED with, so adding a " +
      "property at the same version is refused at `addCollections` with DB6 on any " +
      "device that has merely opened the app; all three collections are added in one " +
      "call on one database, so that refusal takes the captures with it.",
    rewrite: "none",
  },
];
