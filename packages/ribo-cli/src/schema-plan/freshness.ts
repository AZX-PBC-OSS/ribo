import { schemaPlanSchema } from "@azx/ribo-core";
import type { SchemaPlan } from "@azx/ribo-core";

import { convertDocument } from "../inspect/convert.js";
import { walkFieldInventory } from "../inspect/field-inventory.js";
import { schemaFingerprint } from "../inspect/fingerprint.js";

const UPDATE_COMMAND = "ribo schema plan --update" as const;

/** The deterministic comparison between a stored plan and the current schema. */
export type SchemaPlanFreshnessStatus = "unchanged" | "fingerprint-only" | "stale";

/** Field differences and guidance for a stored schema plan. */
export interface SchemaPlanFreshness {
  /** Membership drift is stale; a fingerprint change alone is only drift. */
  readonly status: SchemaPlanFreshnessStatus;
  /** Current schema paths absent from the stored plan, sorted lexically. */
  readonly added: readonly string[];
  /** Stored plan paths absent from the current schema, sorted lexically. */
  readonly removed: readonly string[];
  /** Deterministic diagnostics; fingerprint-only drift has one note. */
  readonly notes: readonly string[];
  /** The only stale-plan repair command. */
  readonly fix?: typeof UPDATE_COMMAND;
}

/**
 * Compare a stored artifact with a schema document without chat, files or a clock. The stored
 * artifact must be internally valid, but is deliberately not parsed against the current schema:
 * unknown and omitted paths are the differences this function exists to report.
 */
export function schemaPlanFreshness(
  document: unknown,
  existingPlan: SchemaPlan,
): SchemaPlanFreshness {
  const plan = schemaPlanSchema.parse(existingPlan);
  const schema = convertDocument(document);
  const currentPaths = walkFieldInventory(schema).map((entry) => entry.path);
  const currentSet = new Set(currentPaths);
  const storedSet = new Set(plan.fieldPaths);
  const added = currentPaths.filter((path) => !storedSet.has(path)).sort();
  const removed = plan.fieldPaths.filter((path) => !currentSet.has(path)).sort();
  const fingerprint = schemaFingerprint(document);

  if (added.length > 0 || removed.length > 0) {
    return {
      status: "stale",
      added,
      removed,
      notes: [
        `schema field membership drift: added [${added.join(", ") || "none"}]; ` +
          `removed [${removed.join(", ") || "none"}]`,
      ],
      fix: UPDATE_COMMAND,
    };
  }

  if (plan.schemaFingerprint !== fingerprint) {
    return {
      status: "fingerprint-only",
      added,
      removed,
      notes: [
        `schema fingerprint drift: stored ${plan.schemaFingerprint}, current ${fingerprint}; ` +
          "field membership is unchanged",
      ],
    };
  }

  return { status: "unchanged", added, removed, notes: [] };
}
