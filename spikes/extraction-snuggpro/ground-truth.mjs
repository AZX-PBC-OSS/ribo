/**
 * The vocabulary-neutral ground-truth format: its runtime shape check, and the
 * loader both `score.mjs` and annotators (via `validate-ground-truth.mjs`) use.
 * The FORMAT ITSELF is documented in `ground-truth-format.md` — read that
 * first; this file enforces what it describes and must not drift from it.
 *
 * A ground-truth file is "new format" iff it has a `leaves` object; the 14
 * pre-existing files (old adapter shape: flat snake_case fields, an 11-test
 * `healthSafety` object, no `schemaVersion`) have `fields` instead and are
 * left alone by everything here — `isNewFormat` below is the single place
 * that draws the line, so score.mjs can report "not yet re-annotated" instead
 * of crashing on the 13 the fan-out has not reached yet.
 */

import { LEAF_BY_PATH, LEAF_PATHS } from "./schema-leaves.mjs";

export const SCHEMA_VERSION = "snuggpro-51-leaf-v1";

/** @param {unknown} raw parsed JSON */
export function isNewFormat(raw) {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "leaves" in raw &&
    typeof raw.leaves === "object" &&
    raw.leaves !== null
  );
}

const STATUSES = new Set(["unmentioned", "declared_absent", "asserted"]);

/**
 * Validate one leaf's truth object against the leaf's kind. Pushes to `errors`
 * (path-prefixed) rather than throwing, so one bad leaf does not hide the rest.
 * @param {string} path
 * @param {{kind: string, options?: string[]}} leafSpec
 * @param {unknown} truth
 * @param {string[]} errors
 */
function validateLeaf(path, leafSpec, truth, errors) {
  const tag = (msg) => errors.push(`${path}: ${msg}`);
  if (typeof truth !== "object" || truth === null || Array.isArray(truth)) {
    tag("must be an object");
    return;
  }
  const { status, sourceSpan } = truth;
  if (!STATUSES.has(status)) {
    tag(`status must be one of ${[...STATUSES].join("/")}, got ${JSON.stringify(status)}`);
    return;
  }
  if (status === "unmentioned") {
    if (sourceSpan !== null) tag('status "unmentioned" requires sourceSpan: null');
  } else if (typeof sourceSpan !== "string" || sourceSpan.length === 0) {
    tag(`status ${JSON.stringify(status)} requires a non-empty verbatim sourceSpan string`);
  }
  // `retracted` and `arguable` are meaningful at ANY status — most commonly on "asserted" (the
  // final value itself was contested, or a retraction preceded it), but also on "unmentioned" /
  // "declared_absent" (a model producing a sanctioned soft non-null on a GT-null slot is a mild
  // call, not a hard hallucination — the old scorer's TOP_PARTIAL table, now living on the leaf
  // it describes instead of a slug-keyed table in score.mjs).
  if (status === "asserted") {
    if (leafSpec.kind === "number") {
      if (typeof truth.value !== "number" || !Number.isFinite(truth.value)) {
        tag("asserted number leaf requires a finite numeric value");
      }
    } else if (leafSpec.kind === "string") {
      if (typeof truth.value !== "string" || truth.value.length === 0) {
        tag("asserted string leaf requires a non-empty string value");
      }
    } else {
      // enum
      const hasMember = "member" in truth && truth.member !== null && truth.member !== undefined;
      const hasNoFit = "noFittingMember" in truth && truth.noFittingMember !== null;
      if (hasMember === hasNoFit) {
        tag("asserted enum leaf requires exactly one of `member` or `noFittingMember`");
      } else if (hasMember) {
        if (!leafSpec.options.includes(truth.member)) {
          tag(
            `member ${JSON.stringify(truth.member)} is not one of this leaf's schema.ts members ` +
              "(if the auditor's words genuinely fit none of them, use noFittingMember instead)",
          );
        }
      } else {
        const gloss = truth.noFittingMember?.auditorMeaning;
        if (typeof gloss !== "string" || gloss.length === 0) {
          tag("noFittingMember requires a non-empty auditorMeaning");
        }
      }
    }
  } else if ("value" in truth || "member" in truth || "noFittingMember" in truth) {
    tag(`status ${JSON.stringify(status)} must carry no value/member/noFittingMember`);
  }
  if ("retracted" in truth && truth.retracted !== undefined) {
    if (!Array.isArray(truth.retracted)) tag("retracted must be an array");
    else {
      for (const [i, r] of truth.retracted.entries()) {
        if (typeof r?.note !== "string" || r.note.length === 0) {
          tag(`retracted[${i}] requires a non-empty note`);
        }
        if (!("value" in (r ?? {}))) tag(`retracted[${i}] requires a value`);
      }
    }
  }
  if ("arguable" in truth && truth.arguable !== undefined) {
    const a = truth.arguable;
    if (typeof a?.note !== "string" || a.note.length === 0) {
      tag("arguable requires a non-empty note explaining the call");
    }
    if ("acceptableAlternatives" in (a ?? {})) {
      if (!Array.isArray(a.acceptableAlternatives)) {
        tag("arguable.acceptableAlternatives must be an array when present");
      } else if (leafSpec.kind === "enum") {
        for (const alt of a.acceptableAlternatives) {
          if (!leafSpec.options.includes(alt)) {
            tag(
              `arguable.acceptableAlternatives includes ${JSON.stringify(alt)}, not one of this leaf's members`,
            );
          }
        }
      }
    }
    if ("acceptableMiss" in (a ?? {}) && typeof a.acceptableMiss !== "boolean") {
      tag("arguable.acceptableMiss must be a boolean when present");
    }
  }
}

/**
 * Validate a whole new-format ground-truth document.
 * @param {unknown} raw parsed JSON
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGroundTruth(raw) {
  const errors = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["not an object"] };
  if (typeof raw.transcript !== "string") errors.push('"transcript" must be a string path');
  if (typeof raw.leaves !== "object" || raw.leaves === null) {
    errors.push('"leaves" must be an object');
    return { ok: false, errors };
  }
  const seen = new Set(Object.keys(raw.leaves));
  for (const path of LEAF_PATHS) {
    if (!seen.has(path)) {
      errors.push(
        `missing leaf "${path}" — every one of the 51 leaves must be a key, even when unmentioned`,
      );
      continue;
    }
    seen.delete(path);
    validateLeaf(path, LEAF_BY_PATH.get(path), raw.leaves[path], errors);
  }
  for (const extra of seen)
    errors.push(`unknown leaf key "${extra}" — not one of schema.ts's 51 leaves (typo?)`);
  return { ok: errors.length === 0, errors };
}

/**
 * Read + parse + validate a ground-truth file. Never throws on a validation
 * problem (returns it in `errors`); throws only on missing file / bad JSON,
 * same as any other "this run cannot proceed" condition in this spike.
 * @param {string} path
 */
export async function readGroundTruth(path) {
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!isNewFormat(raw)) return { raw, isNew: false, ok: null, errors: [] };
  const { ok, errors } = validateGroundTruth(raw);
  return { raw, isNew: true, ok, errors };
}
