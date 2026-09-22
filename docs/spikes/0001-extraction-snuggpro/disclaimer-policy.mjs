/**
 * THE SWAPPABLE POLICY for blanket/generic disclaimers ("no tests", "none of that stuff", "the
 * rest of the shell next visit"). See `ground-truth-format.md`'s "Disclaimers" section for the full
 * rationale; the short version:
 *
 * An annotator does NOT decide which leaves a blanket disclaimer reaches — that is a judgment
 * call, and judgment calls do not converge across independent, blind annotators. A split where
 * half read a disclaimer broadly and half narrowly produces files that look like ordinary careful
 * disagreement but are actually a SYSTEMATIC scope split, invisible to a disagreement count.
 *
 * Instead, an annotator records a disclaimer as DATA — a verbatim span plus a scope drawn from a
 * small, closed, mechanical vocabulary (see `Scope` below) — and never touches a leaf the
 * disclaimer covers directly. This module is the ONE place that turns a scope into leaf paths and
 * a default truth. Change it, and every ground-truth file's SCORED meaning changes with it — no
 * re-annotation, exactly the property vocabulary-neutrality gets us for enums, one level up.
 */

import { GROUPS, HEALTH_TEST_PATHS, LEAF_PATHS } from "./schema-leaves.mjs";

/**
 * A FEW named leaf-sets that recur across the corpus but are narrower than a whole resource group,
 * so a bare group name would over-reach. Hand-named facts, not a parallel enumeration of leaves.
 *
 *   - `healthTests`  — the pass/fail/warning/not-tested matrix leaves. Narrower than `group:
 *     "health"`, which would also sweep in `healthRoofCondition` (a visual condition judgement,
 *     not a "test"). Derived from HEALTH_TEST_PATHS, itself derived from the schema, so this
 *     entry never needs hand-updating when a test is added.
 *   - `blowerDoor`   — the two `basedata` leaves specifically about the blower-door reading;
 *     `group: "basedata"` would incorrectly sweep in `yearBuilt` and friends.
 *   - `shell`        — the building envelope: attic + wall + window leaves, plus the blower-door
 *     pair. Justified by real corpus text (06-homeowner-crosstalk.txt: "Attic and the REST OF THE
 *     SHELL we'll do on the next visit") and by this spike's README, which names "shell /
 *     mechanicals / safety" as the sections a real audit visit splits into.
 *
 * This list is deliberately short. If a future transcript's disclaimer needs a scope that is
 * neither a full group nor one of these, do not force it into the nearest one — see `"unresolved"`
 * below, and add a new named set only when a second real transcript needs the SAME one (one
 * occurrence is not evidence of a recurring pattern).
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

// This module is the SINGLE place that re-scores every transcript using a given named set, so a
// typo'd path here would silently affect all of them — and ground-truth.mjs's re-validation only
// walks the REAL LEAF_PATHS, so it can never notice a bad path sitting unused inside NAMED_SETS.
// Assert the invariant at import time so a typo fails LOUDLY the moment anything loads this module.
for (const [name, paths] of Object.entries(NAMED_SETS)) {
  for (const p of paths) {
    if (!LEAF_PATHS.includes(p)) {
      throw new Error(
        `disclaimer-policy.mjs: NAMED_SETS.${name} contains "${p}", which is not one of schema.ts's ` +
          "real leaf paths (typo?). Fix it here — this module re-scores every transcript that " +
          "uses this named set, so a bad path here is not a one-file bug.",
      );
    }
  }
}

/**
 * A disclaimer's scope, in the closed vocabulary annotators choose from:
 *
 *   - `{ kind: "group", group: <a schema.ts resource group> }` — every leaf under that group.
 *     Mechanical: a prefix match on LEAF_PATHS.
 *   - `{ kind: "namedSet", set: <a key of NAMED_SETS> }` — a recurring scope narrower than a
 *     whole group.
 *   - `{ kind: "unresolved" }` — the disclaimer is real and worth recording, but it does not
 *     reach any leaf today; every leaf it might plausibly cover stays at its default rather
 *     than being guessed at.
 *
 * Free text ("topic") is NOT part of the mechanical scope — it is the easiest thing for an
 * annotator to write and the hardest to apply the same way twice. `topic` travels on the
 * disclaimer object as a human-readable gloss; it is documentation, not an input to
 * `leavesInScope`.
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
      : `scope.group ${JSON.stringify(scope.group)} is not a schema.ts resource group`;
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
 * A cheap, deliberately loose keyword table for the ONE thing `scope` cannot self-check: whether
 * `topic` (free text) actually describes the same thing `scope` (mechanical) points at — e.g. a
 * copy-paste mistake, or a scope picked for the wrong disclaimer in a multi-disclaimer sentence.
 * NOT a semantic check (that is exactly the judgment call disclaimers exist to avoid): a keyword
 * substring test, loose on purpose, meant to catch the OBVIOUS mismatch. A miss here is a
 * warning, never a hard validation failure — the lists are incomplete by construction.
 */
const SCOPE_KEYWORDS = {
  group: {
    basedata: ["basedata", "bedroom", "blower door", "year built", "home", "house", "floor"],
    hvac: [
      "furnace",
      "boiler",
      "heat",
      "hvac",
      "duct",
      "cooling",
      "air condition",
      " ac ",
      "heat pump",
    ],
    attic: ["attic", "insulation", "roof"],
    wall: ["wall"],
    window: ["window"],
    dhw: ["water heater", "dhw", "hot water", "tank"],
    health: [
      "test",
      "safety",
      " co ",
      "carbon monoxide",
      "asbestos",
      "mold",
      "gas leak",
      "vent",
      "draft",
      "spillage",
      "radon",
      "lead",
      "electrical",
      "health",
    ],
  },
  namedSet: {
    healthTests: ["test", "safety"],
    blowerDoor: ["blower door", "blower"],
    shell: ["shell", "attic", "wall", "window", "envelope", "blower door"],
  },
};

const normalizeForKeywordMatch = (s) =>
  ` ${String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")} `;

/**
 * @param {{kind: string, group?: string, set?: string}} scope
 * @param {string} topic
 * @returns {string | null} a warning message, or null if `topic` plausibly matches `scope` (or
 *   the scope kind has no keyword table — `"unresolved"` never warns, having no mechanical
 *   target to compare against).
 */
export function topicScopeMismatchWarning(scope, topic) {
  if (!scope || typeof topic !== "string") return null;
  const table =
    scope.kind === "group"
      ? SCOPE_KEYWORDS.group[scope.group]
      : scope.kind === "namedSet"
        ? SCOPE_KEYWORDS.namedSet[scope.set]
        : null;
  if (!table) return null;
  const normalized = normalizeForKeywordMatch(topic);
  if (table.some((kw) => normalized.includes(normalizeForKeywordMatch(kw).trim()))) return null;
  return (
    `topic ${JSON.stringify(topic)} does not obviously match scope ${JSON.stringify(scope)} ` +
    `(expected one of: ${table.join(", ")}) — check this isn't a copy-paste mistake or the wrong ` +
    "scope for a multi-part disclaimer sentence"
  );
}

/**
 * The default LeafTruth a disclaimer assigns to a leaf it covers, absent a more specific
 * annotator-supplied `leaves` entry for that same leaf (which always wins — see
 * `ground-truth.mjs`'s `resolveGroundTruth`). THE mechanical rule, stated once:
 *
 *   - The health-matrix tests have their OWN "explicitly did not happen" member (`"Not
 *     Tested"` — a real, gradable value, not a null). A blanket disclaimer covering a
 *     health test asserts that member.
 *   - Every other leaf kind has no such member — an explicit group negation means the leaf
 *     has nothing to report, i.e. `declared_absent`.
 */
export function defaultTruthForDisclaimer(path, disclaimer) {
  if (HEALTH_TEST_PATHS.includes(path)) {
    return { status: "asserted", sourceSpan: disclaimer.span, member: "Not Tested" };
  }
  return { status: "declared_absent", sourceSpan: disclaimer.span };
}
