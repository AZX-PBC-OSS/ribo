/**
 * THE SWAPPABLE POLICY for blanket/generic disclaimers ("no tests", "none of that stuff", "the
 * rest of the shell next visit"). See `ground-truth-format.md`'s "Disclaimers" section for the full
 * rationale; the short version:
 *
 * An annotator does NOT decide which of the 51 leaves a blanket disclaimer reaches — that is a
 * judgment call, and judgment calls do not converge across 26 independent, blind annotators. A
 * split where half read a disclaimer broadly and half narrowly produces files that look like
 * ordinary careful disagreement but are actually a SYSTEMATIC scope split, which is invisible to a
 * disagreement count and far worse than noise.
 *
 * Instead, an annotator records a disclaimer as DATA — a verbatim span plus a scope drawn from a
 * small, closed, mechanical vocabulary (see `Scope` below) — and never touches a leaf the
 * disclaimer covers directly. This module is the ONE place that turns a scope into leaf paths and a
 * default truth. Change it, and every ground-truth file's SCORED meaning changes with it — no
 * re-annotation, exactly the same property vocabulary-neutrality gets us for enums, one level up.
 */

import { GROUPS, HEALTH_TEST_PATHS, LEAF_PATHS } from "./schema-leaves.mjs";

/**
 * A FEW named leaf-sets that recur across the corpus but are narrower than a whole resource group,
 * so a bare group name would over-reach. Each entry here is a short, deliberate, hand-named fact —
 * exactly like `BAND_LEAVES`/`AXIS_PAIRS` in `score.mjs` — not a parallel enumeration of leaves that
 * could instead be derived from `schema.ts`'s shape.
 *
 *   - `healthTests`  — the 13 pass/fail/warning/not-tested matrix leaves. Narrower than `group:
 *     "health"`, which would also sweep in `healthRoofCondition` (a visual condition judgement, not
 *     a "test" — a blanket "no tests" should not touch it). Derived from HEALTH_TEST_PATHS, itself
 *     derived from the schema, so this entry never needs hand-updating even if a 14th test is added.
 *   - `blowerDoor`   — the two `basedata` leaves that are specifically about the blower-door
 *     reading. `basedata` also holds `yearBuilt`, `numberOfBedrooms` and other leaves with nothing
 *     to do with a blower door; `group: "basedata"` would incorrectly sweep those in too.
 *   - `shell`        — the building envelope: attic + wall + window leaves, plus the blower-door
 *     pair. Justified by real corpus text (06-homeowner-crosstalk.txt: "Attic and the REST OF THE
 *     SHELL we'll do on the next visit" — naming attic as one part of a larger "shell" the auditor
 *     is visibly treating as one deferred unit) and by this spike's own README, which names "shell /
 *     mechanicals / safety" as the three sections a real audit visit splits into.
 *
 * This list is deliberately short. If a future transcript's disclaimer needs a scope that is
 * neither a full group nor one of these, do not force it into the nearest one — see `"unresolved"`
 * below, and add a new named set here only when a second real transcript needs the SAME one (one
 * occurrence is not evidence of a recurring pattern; see the report for why none of the 13 pending
 * transcripts has needed a set beyond these three, on inspection).
 */
export const NAMED_SETS = {
  healthTests: HEALTH_TEST_PATHS,
  blowerDoor: ["basedata.blowerDoorReading", "basedata.blowerDoorTestPerformed"],
  shell: LEAF_PATHS.filter(
    (p) =>
      p.startsWith("attic.") ||
      p.startsWith("wall.") ||
      p.startsWith("window.") ||
      p === "basedata.blowerDoorReading" ||
      p === "basedata.blowerDoorTestPerformed",
  ),
};

/**
 * A disclaimer's scope, in the closed vocabulary annotators choose from:
 *
 *   - `{ kind: "group", group: <one of the 7 schema.ts resource groups> }` — every leaf under that
 *     group. Mechanical: a prefix match on LEAF_PATHS, needs no named list at all.
 *   - `{ kind: "namedSet", set: <a key of NAMED_SETS> }` — for a recurring scope narrower than a
 *     whole group.
 *   - `{ kind: "unresolved" }` — the disclaimer is real and worth recording (a future annotator or a
 *     future NAMED_SETS entry may resolve it), but it does not reach any leaf today. Every leaf that
 *     might plausibly be "covered" stays at its default ("unmentioned" unless something else says
 *     otherwise) rather than being guessed at.
 *
 * Free text ("topic") is NOT part of the mechanical scope — see ground-truth-format.md for why: it
 * is the easiest thing for an annotator to write and the hardest thing to apply the same way twice.
 * `topic` still travels on the disclaimer object as a human-readable gloss; it is documentation, not
 * an input to `leavesInScope`.
 */
export function leavesInScope(scope) {
  if (!scope || typeof scope !== "object") return [];
  if (scope.kind === "group") {
    return GROUPS.includes(scope.group)
      ? LEAF_PATHS.filter((p) => p.startsWith(`${scope.group}.`))
      : [];
  }
  if (scope.kind === "namedSet") {
    return NAMED_SETS[scope.set] ?? [];
  }
  if (scope.kind === "unresolved") return [];
  return [];
}

/** Is this a recognized, well-formed scope object? (Used by the validator, not by resolution.) */
export function scopeError(scope) {
  if (!scope || typeof scope !== "object") return "scope must be an object";
  if (scope.kind === "group") {
    return GROUPS.includes(scope.group)
      ? null
      : `scope.group ${JSON.stringify(scope.group)} is not one of the 7 resource groups`;
  }
  if (scope.kind === "namedSet") {
    return scope.set in NAMED_SETS
      ? null
      : `scope.set ${JSON.stringify(scope.set)} is not one of NAMED_SETS (${Object.keys(NAMED_SETS).join(", ")})`;
  }
  if (scope.kind === "unresolved") return null;
  return `scope.kind must be "group", "namedSet", or "unresolved", got ${JSON.stringify(scope.kind)}`;
}

/**
 * The default LeafTruth a disclaimer assigns to a leaf it covers, absent a more specific
 * annotator-supplied `leaves` entry for that same leaf (which always wins — see
 * `ground-truth.mjs`'s `resolveGroundTruth`). THE mechanical rule, stated once:
 *
 *   - The 13 health-matrix tests have their OWN "explicitly did not happen" member (`"Not
 *     Tested"` — a real, gradable value, not a null). A blanket disclaimer covering a health test
 *     asserts that member.
 *   - Every other leaf kind (number/string/other enums) has no such member — an explicit group
 *     negation means the leaf has nothing to report, i.e. `declared_absent`.
 */
export function defaultTruthForDisclaimer(path, disclaimer) {
  if (HEALTH_TEST_PATHS.includes(path)) {
    return { status: "asserted", sourceSpan: disclaimer.span, member: "Not Tested" };
  }
  return { status: "declared_absent", sourceSpan: disclaimer.span };
}
