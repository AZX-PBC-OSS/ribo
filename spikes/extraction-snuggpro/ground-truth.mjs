/**
 * The vocabulary-neutral ground-truth format: its runtime shape check, its resolver, and the
 * loader both `score.mjs` and annotators (via `validate-ground-truth.mjs`) use. The FORMAT ITSELF
 * is documented in `ground-truth-format.md` — read that first; this file enforces what it
 * describes and must not drift from it.
 *
 * A ground-truth file is "new format" iff it has a `leaves` object. All 14 corpus transcripts have
 * been re-annotated into the new format; `isNewFormat` below remains as the single place that draws
 * the line, so a stale old-format file (if one is ever reintroduced) is reported as "not yet
 * re-annotated" by score.mjs instead of crashing on it.
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
import {
  defaultTruthForDisclaimer,
  leavesInScope,
  scopeError,
  topicScopeMismatchWarning,
} from "./disclaimer-policy.mjs";

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
  // Every kind-specific field this leaf's kind does NOT use must be absent. Checked up front, for
  // ALL statuses (not just "asserted") and for every kind, so e.g. an enum leaf cannot carry a
  // stray `value`, and a number/string leaf cannot carry a stray `member`/`noFittingMember` —
  // whether or not `status` happens to be "asserted".
  const kindFields = { number: ["value"], string: ["value"], enum: ["member", "noFittingMember"] };
  const allValueFields = ["value", "member", "noFittingMember"];
  const disallowed = allValueFields.filter((f) => !kindFields[leafSpec.kind].includes(f));
  for (const f of disallowed) {
    if (f in truth && truth[f] !== undefined) {
      tag(
        `a ${leafSpec.kind} leaf must not carry \`${f}\` (that belongs to a different leaf kind)`,
      );
    }
  }

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
        if (typeof r !== "object" || r === null || Array.isArray(r)) {
          tag(`retracted[${i}] must be an object`);
          continue;
        }
        if (typeof r.note !== "string" || r.note.length === 0) {
          tag(`retracted[${i}] requires a non-empty note`);
        }
        if (!("value" in r)) {
          tag(`retracted[${i}] requires a value`);
        } else if (typeof r.value !== "number" && typeof r.value !== "string") {
          tag(`retracted[${i}].value must be a number or string, got ${JSON.stringify(r.value)}`);
        }
      }
    }
  }
  if ("arguable" in truth && truth.arguable !== undefined) {
    const a = truth.arguable;
    if (typeof a !== "object" || a === null || Array.isArray(a)) {
      tag(`arguable must be an object, got ${JSON.stringify(a)}`);
    } else {
      if (typeof a.note !== "string" || a.note.length === 0) {
        tag("arguable requires a non-empty note explaining the call");
      }
      let alternativesAreValidMembers = false;
      if ("acceptableAlternatives" in a) {
        if (!Array.isArray(a.acceptableAlternatives)) {
          tag("arguable.acceptableAlternatives must be an array when present");
        } else if (leafSpec.kind === "enum") {
          alternativesAreValidMembers = true;
          for (const alt of a.acceptableAlternatives) {
            if (!leafSpec.options.includes(alt)) {
              alternativesAreValidMembers = false;
              tag(
                `arguable.acceptableAlternatives includes ${JSON.stringify(alt)}, not one of this leaf's members`,
              );
            }
          }
        }
      }
      if ("acceptableMiss" in a && typeof a.acceptableMiss !== "boolean") {
        tag("arguable.acceptableMiss must be a boolean when present");
      }
      // Rule 6's determinism (ANNOTATOR_GUIDE.md): when several enum members equally fit and the
      // schema forces a pick between them, `member` must be whichever one appears FIRST in
      // schema.ts's own enum-list order — never a free choice, because two annotators each "picking
      // either one" would disagree on WHICH member sits in `member` even though their files score
      // identically. That rule was previously enforced only by prose; `arguable.symmetric: true` is
      // the marker that makes it checkable WITHOUT hand-listing which members form a conflated
      // set anywhere: the "set" being ordered is simply `{member} ∪ acceptableAlternatives` — exactly
      // what the annotator wrote on THIS leaf, nothing pre-declared elsewhere. This does NOT fire on
      // the (legitimate, different) case of an asymmetric "lesser but tolerated" alternative — that
      // case never sets `symmetric: true`, and schema order has no bearing on it (the annotator's own
      // note explains why a specific member is more correct, not the order they happen to appear in).
      if ("symmetric" in a) {
        if (typeof a.symmetric !== "boolean") {
          tag("arguable.symmetric must be a boolean when present");
        } else if (a.symmetric) {
          if (leafSpec.kind !== "enum") {
            tag(
              "arguable.symmetric only applies to enum leaves (schema order has no meaning for a number/string)",
            );
          } else if (typeof truth.member !== "string") {
            tag(
              "arguable.symmetric requires an asserted `member` to order (not `noFittingMember` — " +
                "there is no schema member there to place first)",
            );
          } else if (
            !Array.isArray(a.acceptableAlternatives) ||
            a.acceptableAlternatives.length === 0
          ) {
            tag(
              "arguable.symmetric requires a non-empty acceptableAlternatives to be symmetric WITH",
            );
          } else if (alternativesAreValidMembers) {
            const options = leafSpec.options;
            const memberIndex = options.indexOf(truth.member);
            for (const alt of a.acceptableAlternatives) {
              const altIndex = options.indexOf(alt);
              if (altIndex !== -1 && altIndex < memberIndex) {
                tag(
                  `member ${JSON.stringify(truth.member)} (index ${memberIndex}) is NOT the earliest of its ` +
                    `symmetric set in schema.ts's enum order — ${JSON.stringify(alt)} appears earlier ` +
                    `(index ${altIndex}). Swap them: the earliest member goes in \`member\`, the rest in ` +
                    "`acceptableAlternatives` (ANNOTATOR_GUIDE.md rule 6).",
                );
              }
            }
          }
        }
      }
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
 * bug in the disclaimer policy itself (not just in one file) is still caught. Never throws: every
 * branch that reads a field off a value of unknown shape checks that shape first, so a malformed
 * file (e.g. `arguable: "oops"`, a primitive where an object is expected) becomes a reported error,
 * not an uncaught exception the CLI would have to guard against separately.
 *
 * @param {unknown} raw parsed JSON
 * @param {string | null} transcriptText when given, every `sourceSpan` (on leaves AND disclaimers)
 *   is checked as a verbatim substring — the same rule prompt.md rule 3 states, enforced mechanically
 *   rather than trusted to a careful re-read.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }} `warnings` never affects `ok` —
 *   they flag things worth a human's attention (an implausible topic/scope pairing, an `unresolved`
 *   disclaimer needing reconciliation) that cannot be mechanically proven wrong.
 */
export function validateGroundTruth(raw, transcriptText = null) {
  const errors = [];
  const warnings = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["not an object"], warnings };
  }
  if (typeof raw.transcript !== "string") errors.push('"transcript" must be a string path');
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      `"schemaVersion" must be ${JSON.stringify(SCHEMA_VERSION)}, got ${JSON.stringify(raw.schemaVersion)}`,
    );
  }
  if (typeof raw.leaves !== "object" || raw.leaves === null || Array.isArray(raw.leaves)) {
    errors.push('"leaves" must be an object (not an array, not null)');
    return { ok: false, errors, warnings };
  }

  for (const [path, truth] of Object.entries(raw.leaves)) {
    if (!LEAF_BY_PATH.has(path)) {
      errors.push(`unknown leaf key "${path}" — not one of schema.ts's 51 leaves (typo?)`);
      continue;
    }
    validateLeaf(path, LEAF_BY_PATH.get(path), truth, errors);
    if (
      transcriptText !== null &&
      typeof truth?.sourceSpan === "string" &&
      truth.sourceSpan.length > 0 &&
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
    for (const [i, dRaw] of disclaimers.entries()) {
      const tag = (msg) => errors.push(`disclaimers[${i}]: ${msg}`);
      const warn = (msg) => warnings.push(`disclaimers[${i}]: ${msg}`);
      if (typeof dRaw !== "object" || dRaw === null || Array.isArray(dRaw)) {
        tag(`must be an object, got ${JSON.stringify(dRaw)}`);
        continue;
      }
      const d = dRaw;
      if (typeof d.span !== "string" || d.span.length === 0) {
        tag("requires a non-empty verbatim span");
      } else if (transcriptText !== null && !transcriptText.includes(d.span)) {
        tag(`span ${JSON.stringify(d.span)} is not a verbatim substring of the transcript`);
      }
      if (typeof d.topic !== "string" || d.topic.length === 0) {
        tag("requires a non-empty topic (a human-readable gloss — not consumed mechanically)");
      }
      const se = scopeError(d.scope);
      if (se) {
        tag(se);
        continue;
      }
      if (d.scope.kind === "unresolved") {
        // Reaches no leaf and cannot participate in overlap detection — the one place an error
        // could hide silently. Require a note explaining why, and flag it every time as something
        // reconciliation must look at, so it is never merely "valid and forgotten."
        if (typeof d.note !== "string" || d.note.length === 0) {
          tag(
            'scope "unresolved" requires a non-empty `note` explaining why no group/namedSet fits',
          );
        }
        warn(
          `scope is "unresolved" (topic: ${JSON.stringify(d.topic)}) — reaches NO leaf under the current ` +
            "policy. NEEDS RECONCILIATION: a human should confirm this is intentional, not a missed scope.",
        );
      } else if (typeof d.topic === "string" && d.topic.length > 0) {
        const mismatch = topicScopeMismatchWarning(d.scope, d.topic);
        if (mismatch) warn(mismatch);
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

  if (errors.length > 0) return { ok: false, errors, warnings };

  // Defense in depth: resolve and re-validate the full 51-leaf map, catching a bug in the
  // disclaimer POLICY itself (disclaimer-policy.mjs), not just in one annotator's file.
  const resolved = resolveGroundTruth(raw);
  for (const path of LEAF_PATHS)
    validateLeaf(path, LEAF_BY_PATH.get(path), resolved.leaves[path], errors);
  return { ok: errors.length === 0, errors, warnings };
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
  if (!isNewFormat(raw)) return { raw, isNew: false, ok: null, errors: [], warnings: [] };
  const transcriptPath = join(spikeRoot, raw.transcript ?? "");
  const transcriptText = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : null;
  const { ok, errors, warnings } = validateGroundTruth(raw, transcriptText);
  return { raw, isNew: true, ok, errors, warnings };
}
