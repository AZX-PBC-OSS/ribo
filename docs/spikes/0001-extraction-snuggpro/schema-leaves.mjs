/**
 * Everything about the Snugg Pro schema shape that ground-truth authoring and scoring need —
 * LEAF PATHS, LEAF KINDS, and the two enum VOCABULARIES (the API's literal wire strings, and a
 * mechanically-derived snake_case alternative) — derived by walking the REAL, built
 * `snuggValuesSchema` from `@azx/ribo-adapter-snuggpro`. Nothing here is a hand-maintained
 * parallel table: change `schema.ts` and this file's exports change with it.
 *
 * WHY THIS EXISTS. The old spike (`docs/spikes/0001-extraction-snuggpro/schema.ts`, now dead)
 * hand-declared its own snake_case copy of "the Snugg Pro model", which silently drifted from
 * the real adapter schema when that was rebuilt from Snugg's machine-readable spec. This file
 * is the fix for the CLASS of bug: it reads `snuggValuesSchema` directly, so the ground truth
 * and the scorer can never again describe a schema that doesn't match `schema.ts`.
 *
 * PRECONDITION: `pnpm build:packages` must have been run at least once (this imports the built
 * `dist/index.js`, not `src/`). `./check.sh` always builds before `test`; for a standalone
 * `node score.mjs` run, build first or you get the clear error thrown below.
 *
 * WHY dist/ AND NOT src/schema.ts. Node 24's native TypeScript support strips types but does
 * NOT remap the `./foo.js` specifiers TypeScript's NodeNext-style source uses for sibling `.ts`
 * files — only a bundler-aware resolver (Vite, tsdown) does that, and adding one here would be
 * a new devDependency this spike does not need. The built `dist/index.js` has real, correct
 * extensions, and it IS `schema.ts` — tsdown's output, not a second authored copy.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIST = join(
  HERE,
  "..",
  "..",
  "..",
  "packages",
  "ribo-adapter-snuggpro",
  "dist",
  "index.js",
);

if (!existsSync(ADAPTER_DIST)) {
  throw new Error(
    `schema-leaves.mjs: ${ADAPTER_DIST} does not exist yet.\n` +
      "Run `pnpm build:packages` from the repo root first — this module reads the built " +
      "@azx/ribo-adapter-snuggpro so the leaf set and enum vocabularies can never drift from " +
      "packages/ribo-adapter-snuggpro/src/schema.ts, the authority.",
  );
}

const { snuggValuesSchema } = await import(ADAPTER_DIST);

// ---------------------------------------------------------------------------
// Walk snuggValuesSchema -> the ordered leaf list
// ---------------------------------------------------------------------------

/**
 * @typedef {{ path: string, kind: "enum" | "number" | "string", options?: string[] }} Leaf
 */

/** @type {Leaf[]} */
const leaves = [];

function unwrap(node) {
  const def = node.def ?? node._def;
  if (def.type === "optional" || def.type === "nullable") return unwrap(def.innerType);
  return node;
}

function walk(node, path) {
  const bare = unwrap(node);
  const def = bare.def ?? bare._def;
  if (def.type === "object") {
    for (const [key, child] of Object.entries(bare.shape)) walk(child, [...path, key]);
    return;
  }
  if (def.type === "array") {
    // The per-instance groups are arrays of instance records. One `items` schema
    // describes every element, so the leaf set is the same regardless of how many
    // instances a transcript describes.
    walk(bare.element, path);
    return;
  }
  if (def.type === "enum") {
    leaves.push({ path: path.join("."), kind: "enum", options: [...bare.options] });
    return;
  }
  if (def.type === "number") {
    leaves.push({ path: path.join("."), kind: "number" });
    return;
  }
  if (def.type === "string") {
    leaves.push({ path: path.join("."), kind: "string" });
    return;
  }
  throw new Error(
    `schema-leaves.mjs: leaf "${path.join(".")}" has an unhandled zod type "${def.type}". ` +
      "snuggValuesSchema grew a shape this walker does not understand yet — teach it here " +
      "rather than hand-listing the new leaf elsewhere.",
  );
}

for (const [group, node] of Object.entries(snuggValuesSchema.shape)) walk(node, [group]);

/** All leaves, in `schema.ts` declaration order. The count is asserted, not hard-coded — see score.test.mjs. */
export const LEAVES = leaves;

/** Just the dotted paths, same order. */
export const LEAF_PATHS = leaves.map((l) => l.path);

/** @type {Map<string, Leaf>} */
export const LEAF_BY_PATH = new Map(leaves.map((l) => [l.path, l]));

/** The resource-group keys, in schema order. */
export const GROUPS = Object.keys(snuggValuesSchema.shape);

/**
 * The health-matrix TEST leaves, derived by finding every enum leaf whose exact member set
 * equals schema.ts's `HealthTestState` (Passed/Failed/Warning/Not Tested) — not hand-listed.
 * This is what excludes `health.healthRoofCondition` (a different condition enum) without
 * anyone having to remember it is the one health-group leaf that isn't a "test".
 */
const HEALTH_STATE_SHAPE = JSON.stringify(["Passed", "Failed", "Warning", "Not Tested"]);
export const HEALTH_TEST_PATHS = leaves
  .filter((l) => l.kind === "enum" && JSON.stringify(l.options) === HEALTH_STATE_SHAPE)
  .map((l) => l.path);

// ---------------------------------------------------------------------------
// Vocabulary A: the API's literal wire strings — schema.ts's own enum members,
// unmodified. This is not "derived" from anything else; it IS schema.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Vocabulary B: a mechanically-derived snake_case alternative. NOT a
// reproduction of the pre-rebuild spike schema's hand-chosen tokens — that was
// editorial judgment, exactly the kind of hand-maintained table this file
// exists to avoid. Instead this is a FORMULA applied uniformly to every member
// (see `slugifyMember`). Two members of the SAME enum are asserted never to
// collide (score.test.mjs) — collision across DIFFERENT enums is fine, since
// resolution is always leaf-scoped.
//
// A future slug-vocabulary extraction run must generate ITS enum list with this
// exact function, so its output matches this vocabulary by construction.
// ---------------------------------------------------------------------------

/** @param {string} raw */
export function slugifyMember(raw) {
  return String(raw)
    .replace(/^\d+%\s*-\s*/, "") // "6% - Well sealed" -> "Well sealed"
    .toLowerCase()
    .replace(/['"]/g, "") // quote / apostrophe / inch marks
    .replace(/[^a-z0-9]+/g, "_") // any run of non-alphanumerics -> one underscore
    .replace(/^_+|_+$/g, ""); // trim
}

/**
 * Per-enum-leaf vocabulary: the ordered API members, the parallel derived
 * slugs, and both lookup directions. Built once, at import time, from LEAVES —
 * never hand-listed.
 * @type {Map<string, { options: string[], slugs: string[], apiSet: Set<string>, slugSet: Set<string>, slugToApi: Map<string, string> }>}
 */
export const ENUM_VOCAB = new Map();

for (const leaf of leaves) {
  if (leaf.kind !== "enum") continue;
  const slugToApi = new Map();
  const slugs = [];
  for (const member of leaf.options) {
    const slug = slugifyMember(member);
    slugs.push(slug);
    if (slugToApi.has(slug)) {
      throw new Error(
        `schema-leaves.mjs: enum members "${slugToApi.get(slug)}" and "${member}" of leaf ` +
          `"${leaf.path}" both slugify to "${slug}". slugifyMember needs a sharper rule before ` +
          "this leaf's slug vocabulary can be trusted.",
      );
    }
    slugToApi.set(slug, member);
  }
  ENUM_VOCAB.set(leaf.path, {
    options: leaf.options,
    slugs,
    apiSet: new Set(leaf.options),
    slugSet: new Set(slugs),
    slugToApi,
  });
}

// ---------------------------------------------------------------------------
// The resolver: match a run's raw enum output, in EITHER vocabulary, back to
// the canonical API member — so ground truth (which stores the API member) can
// be scored against a run regardless of which vocabulary that run used.
//
// EXACT MATCH ONLY, in both directions. `raw` (trimmed) must equal either the
// literal API string or one of the precomputed slugs character-for-character —
// it is NOT re-slugified before the slug check. An earlier version slugified
// every non-API-matching input before comparing, so ANY string that happened to
// slugify to a real slug — a mis-cased near-miss of the API string, not the
// generated token — was labelled "slug". That made vocabulary ATTRIBUTION
// unreliable even though CORRECTNESS was unaffected. Exact matching removes the
// ambiguity: a near-miss now resolves to `null` (unrecognized).
//
// Residual case: a member whose literal API spelling already IS its own slug
// (`AtticInsulationDepth`'s `"0"`) makes the two vocabularies coincide for that
// one string; it is reported as "api" (the apiSet check runs first). No
// exact-match scheme can attribute it either way.
// ---------------------------------------------------------------------------

/**
 * @param {string} path dotted leaf path, e.g. "hvac.hvacSystemEquipmentType"
 * @param {unknown} raw the run's emitted value for that leaf
 * @returns {{ member: string, vocabulary: "api" | "slug" } | { member: null, vocabulary: null }}
 */
export function resolveEnumMember(path, raw) {
  if (typeof raw !== "string") return { member: null, vocabulary: null };
  const vocab = ENUM_VOCAB.get(path);
  if (!vocab) return { member: null, vocabulary: null };
  const trimmed = raw.trim();
  if (vocab.apiSet.has(trimmed)) return { member: trimmed, vocabulary: "api" };
  if (vocab.slugSet.has(trimmed))
    return { member: vocab.slugToApi.get(trimmed), vocabulary: "slug" };
  return { member: null, vocabulary: null };
}
