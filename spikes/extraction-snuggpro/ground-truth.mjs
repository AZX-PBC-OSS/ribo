/**
 * The vocabulary-neutral ground-truth format: its runtime shape check, its resolver, and the
 * loader both `score.mjs` and annotators (via `validate-ground-truth.mjs`) use. The FORMAT ITSELF
 * is documented in `ground-truth-format.md` — read that first; this file enforces what it
 * describes and must not drift from it.
 *
 * A ground-truth file is "new format" iff it has a `leaves` object; the 13 pre-existing files (old
 * adapter shape: flat snake_case fields, an 11-test `healthSafety` object, no `schemaVersion`) have
 * `fields` instead and are left alone by everything here — `isNewFormat` below is the single place
 * that draws the line, so score.mjs can report "not yet re-annotated" instead of crashing on the
 * ones the fan-out has not reached yet.
 *
 * TWO LAYERS, not one:
 *   - The RAW file an annotator writes: `leaves` is SPARSE — only the leaves they can address
 *     specifically — plus `disclaimers`, a list of blanket/generic negations recorded as data (a
 *     verbatim span + a mechanical scope), never resolved by the annotator's own judgment. See
 *     `disclaimer-policy.mjs` for why, and for the scope vocabulary.
 *   - The RESOLVED ground truth `score.mjs` actually scores against: all 51 leaves, filled in by
 *     applying every disclaimer's scope through the CURRENT policy, then overlaid with the
 *     annotator's explicit `leaves` entries (which always win — the most specific statement about a
 *     leaf beats a blanket one covering it). `resolveGroundTruth` is the only place this happens,
 *     so changing the disclaimer policy re-scores every transcript without touching a single
 *     ground-truth file.
 */

import { LEAF_BY_PATH, LEAF_PATHS } from "./schema-leaves.mjs";
import { defaultTruthForDisclaimer, leavesInScope, scopeError } from "./disclaimer-policy.mjs";

export const SCHEMA_VERSION = "snuggpro-51-leaf-v2";

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
 * Materialize the full 51-leaf ground truth a disclaimer-bearing raw file implies, under the
 * CURRENT disclaimer policy (`disclaimer-policy.mjs`). Precedence, most to least specific:
 *   1. an explicit `leaves[path]` entry the annotator wrote
 *   2. a disclaimer whose scope covers `path`
 *   3. the default: `{ status: "unmentioned", sourceSpan: null }`
 * @param {object} raw
 */
export function resolveGroundTruth(raw) {
  const leaves = {};
  for (const path of LEAF_PATHS) leaves[path] = { status: "unmentioned", sourceSpan: null };
  for (const disclaimer of raw.disclaimers ?? []) {
    if (scopeError(disclaimer?.scope)) continue; // invalid; validateGroundTruth already reports it
    for (const path of leavesInScope(disclaimer.scope)) {
      leaves[path] = defaultTruthForDisclaimer(path, disclaimer);
    }
  }
  for (const [path, truth] of Object.entries(raw.leaves ?? {})) {
    if (LEAF_BY_PATH.has(path)) leaves[path] = truth;
  }
  return { ...raw, leaves };
}

/**
 * Validate a whole new-format ground-truth document: the RAW shape (sparse `leaves`, `disclaimers`,
 * no overlapping scopes), then — if the raw shape is clean — the fully RESOLVED 51-leaf map, so a
 * bug in the disclaimer policy itself (not just in one file) is still caught.
 *
 * @param {unknown} raw parsed JSON
 * @param {string | null} transcriptText when given, every `sourceSpan` (on leaves AND disclaimers)
 *   is checked as a verbatim substring — the same rule prompt.md rule 3 states, enforced mechanically
 *   rather than trusted to a careful re-read.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGroundTruth(raw, transcriptText = null) {
  const errors = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["not an object"] };
  if (typeof raw.transcript !== "string") errors.push('"transcript" must be a string path');
  if (typeof raw.leaves !== "object" || raw.leaves === null) {
    errors.push('"leaves" must be an object');
    return { ok: false, errors };
  }

  for (const [path, truth] of Object.entries(raw.leaves)) {
    if (!LEAF_BY_PATH.has(path)) {
      errors.push(`unknown leaf key "${path}" — not one of schema.ts's 51 leaves (typo?)`);
      continue;
    }
    validateLeaf(path, LEAF_BY_PATH.get(path), truth, errors);
    if (
      transcriptText !== null &&
      truth?.sourceSpan &&
      !transcriptText.includes(truth.sourceSpan)
    ) {
      errors.push(
        `${path}: sourceSpan ${JSON.stringify(truth.sourceSpan)} is not a verbatim substring of the transcript`,
      );
    }
  }

  const disclaimers = raw.disclaimers ?? [];
  if (!Array.isArray(disclaimers)) {
    errors.push('"disclaimers" must be an array when present');
  } else {
    const coveredBy = new Map(); // leaf path -> disclaimer index that already claimed it
    for (const [i, d] of disclaimers.entries()) {
      const tag = (msg) => errors.push(`disclaimers[${i}]: ${msg}`);
      if (typeof d?.span !== "string" || d.span.length === 0)
        tag("requires a non-empty verbatim span");
      else if (transcriptText !== null && !transcriptText.includes(d.span)) {
        tag(`span ${JSON.stringify(d.span)} is not a verbatim substring of the transcript`);
      }
      if (typeof d?.topic !== "string" || d.topic.length === 0) {
        tag("requires a non-empty topic (a human-readable gloss — not consumed mechanically)");
      }
      const se = scopeError(d?.scope);
      if (se) {
        tag(se);
        continue;
      }
      for (const path of leavesInScope(d.scope)) {
        if (coveredBy.has(path)) {
          tag(
            `and disclaimers[${coveredBy.get(path)}] both cover leaf "${path}" — overlapping disclaimer ` +
              "scopes are not allowed; narrow one, or address that leaf with an explicit `leaves` entry instead",
          );
        } else {
          coveredBy.set(path, i);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Defense in depth: resolve and re-validate the full 51-leaf map, catching a bug in the
  // disclaimer POLICY itself (disclaimer-policy.mjs), not just in one annotator's file.
  const resolved = resolveGroundTruth(raw);
  for (const path of LEAF_PATHS)
    validateLeaf(path, LEAF_BY_PATH.get(path), resolved.leaves[path], errors);
  return { ok: errors.length === 0, errors };
}

/**
 * Read + parse + validate a ground-truth file, checking spans against its transcript. Never throws
 * on a validation problem (returns it in `errors`); throws only on missing file / bad JSON, same as
 * any other "this run cannot proceed" condition in this spike.
 * @param {string} path path to the ground-truth JSON file
 * @param {string} spikeRoot directory `raw.transcript` (e.g. "transcripts/NN-slug.txt") is relative to
 */
export async function readGroundTruth(path, spikeRoot) {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!isNewFormat(raw)) return { raw, isNew: false, ok: null, errors: [] };
  const transcriptPath = join(spikeRoot, raw.transcript ?? "");
  const transcriptText = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : null;
  const { ok, errors } = validateGroundTruth(raw, transcriptText);
  return { raw, isNew: true, ok, errors };
}
