/**
 * Throwaway measurement: does the per-group extractor's 32,768-char schema cap get
 * threatened by a realistic 163-leaf basedata group?
 *
 * Run from the repo root:
 *   node docs/spikes/0006-managed-three-phase/cap-probe.mjs
 *
 * Precondition: `pnpm build:packages` (imports the built dists, not source, because
 * docs/spikes/ is not a pnpm workspace member).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "../../../packages/ribo-core/node_modules/zod/index.js";
import { enveloped } from "../../../packages/ribo-core/dist/index.js";
import { splitExtractionSchema } from "../../../packages/ribo-extractor-openai/dist/index.js";
import {
  SCHEMA_NESTING_DEPTH_CAP,
  SCHEMA_SERIALIZED_CHAR_CAP,
  snuggExtractionSchema,
} from "../../../packages/ribo-adapter-snuggpro/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripDescriptions(node) {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (node === null || typeof node !== "object") return node;
  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description") continue;
    copy[key] = stripDescriptions(value);
  }
  return copy;
}

function maxNestingDepth(node, depth) {
  let deepest = depth;
  if (Array.isArray(node)) {
    for (const child of node) deepest = Math.max(deepest, maxNestingDepth(child, depth));
    return deepest;
  }
  if (node === null || typeof node !== "object") return deepest;
  for (const [key, child] of Object.entries(node)) {
    deepest = Math.max(deepest, maxNestingDepth(child, key === "properties" ? depth + 1 : depth));
  }
  return deepest;
}

function serializeSchema(schema) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
  const withDesc = JSON.stringify(jsonSchema);
  const withoutDesc = JSON.stringify(stripDescriptions(jsonSchema));
  return {
    withDesc: withDesc.length,
    withoutDesc: withoutDesc.length,
    depth: maxNestingDepth(jsonSchema, 0),
  };
}

function countGroupLeaves(jsonSchema) {
  // group.schema serializes to a strict object with exactly one top-level key.
  const top = Object.values(jsonSchema.properties ?? {})[0];
  if (!top) return 0;
  if (top.type === "array" && top.items?.properties) {
    return Object.keys(top.items.properties).length;
  }
  if (top.properties) {
    return Object.keys(top.properties).length;
  }
  return 0;
}

function readVendorDescriptions() {
  const path = join(
    HERE,
    "..",
    "..",
    "..",
    "packages",
    "ribo-adapter-snuggpro",
    "src",
    "descriptions.generated.ts",
  );
  const text = readFileSync(path, "utf8");
  const values = [];
  // Key and value may be on the same line or on consecutive lines; handles both
  // double-quoted and single-quoted string values, including escaped quotes.
  const re = /([A-Za-z0-9_]+):\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*,?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    values.push(m[2] ?? m[3]);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Synthesized 163-leaf basedata schema
// ---------------------------------------------------------------------------

const WORD_POOL = [
  "Residential",
  "Primary",
  "Secondary",
  "Standard",
  "Optional",
  "Upgraded",
  "Custom",
  "Unknown",
  "Verified",
  "Measured",
  "Observed",
  "Reported",
  "Estimated",
  "Confirmed",
  "Typical",
  "Common",
  "Baseline",
  "Advanced",
  "Existing",
  "Recommended",
  "Required",
  "Suggested",
  "Available",
  "Selected",
  "Assigned",
  "Indicated",
  "Noted",
  "Recorded",
  "Identified",
  "Documented",
  "Captured",
  "Detected",
  "Reviewed",
  "Assessed",
  "Evaluated",
];

function makeDescription(fieldName, length) {
  let s = `Vendor guidance for ${fieldName}: describes the expected capture value, units, and constraints for extraction.`;
  let i = 0;
  while (s.length < length) {
    s += " " + WORD_POOL[i % WORD_POOL.length];
    i++;
  }
  return s.slice(0, length);
}

function makeEnumMember(seed, index) {
  const target = 12 + (seed % 14); // 12–25 chars
  let s = `Option ${index + 1}`;
  let k = 0;
  while (s.length < target) {
    s += " " + WORD_POOL[(seed + k) % WORD_POOL.length];
    k++;
  }
  return s.slice(0, target);
}

function makeEnumMembers(seed, count) {
  return Array.from({ length: count }, (_, i) => makeEnumMember(seed + i * 7, i));
}

function leafType(i) {
  const r = i % 10;
  if (r < 4) return "enum";
  if (r < 7) return "number";
  if (r < 9) return "string";
  return "boolean";
}

function buildBasedataPatch(leafCount, descLen) {
  const shape = {};
  for (let i = 0; i < leafCount; i++) {
    const name = `field_${String(i + 1).padStart(3, "0")}`;
    const type = leafType(i);
    const desc = makeDescription(name, descLen);
    let field;
    if (type === "enum") {
      const memberCount = 4 + (i % 5); // 4–8 members
      field = z.enum(makeEnumMembers(i, memberCount)).describe(desc);
    } else if (type === "number") {
      field = z.number().describe(desc);
    } else if (type === "string") {
      field = z.string().describe(desc);
    } else {
      field = z.boolean().describe(desc);
    }
    shape[name] = field.nullable().optional();
  }
  return z
    .object({
      basedata: z.strictObject(shape).optional(),
    })
    .strict();
}

function buildBasedataExtractionSchema(leafCount, descLen) {
  return enveloped(buildBasedataPatch(leafCount, descLen));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function fmt(n) {
  return n.toLocaleString("en-US");
}

const vendorDescs = readVendorDescriptions();
const avgDescLen = Math.round(vendorDescs.reduce((a, b) => a + b.length, 0) / vendorDescs.length);

console.log("=== Per-group cap probe: today's real Snugg Pro schema ===\n");
console.log(`Vendor descriptions in file: ${vendorDescs.length}`);
console.log(`Average vendor description length: ${avgDescLen} chars\n`);

const whole = serializeSchema(snuggExtractionSchema);
const groups = splitExtractionSchema(snuggExtractionSchema);
const groupLeafCounts = groups.map((g) =>
  countGroupLeaves(z.toJSONSchema(g.schema, { target: "draft-2020-12" })),
);
const totalLeaves = groupLeafCounts.reduce((a, b) => a + b, 0);

console.log(`Single-shot whole schema (all 7 groups):`);
console.log(`  leaves:           ${totalLeaves}`);
console.log(`  with desc:        ${fmt(whole.withDesc)} chars`);
console.log(`  without desc:     ${fmt(whole.withoutDesc)} chars`);
console.log(`  nesting depth:    ${whole.depth} / ${SCHEMA_NESTING_DEPTH_CAP}`);
console.log(`  over char cap?     ${whole.withDesc > SCHEMA_SERIALIZED_CHAR_CAP ? "YES" : "no"}\n`);

console.log("Per-group schemas (what perGroupExtractor actually sends):");
console.log("group        leaves  with-desc   without-desc  depth  over-cap?");
console.log("------------ ------  ----------  ------------  -----  ---------");
for (let i = 0; i < groups.length; i++) {
  const { key } = groups[i];
  const m = serializeSchema(groups[i].schema);
  const over = m.withDesc > SCHEMA_SERIALIZED_CHAR_CAP ? "YES" : "no";
  console.log(
    `${key.padEnd(12)} ${String(groupLeafCounts[i]).padStart(3)}   ${fmt(m.withDesc).padStart(10)}  ${fmt(m.withoutDesc).padStart(12)}  ${String(m.depth).padStart(5)}  ${over}`,
  );
}

console.log("\n=== Synthesized 163-leaf basedata slice ===\n");
const sliceSchema = buildBasedataExtractionSchema(163, avgDescLen);
const sliceGroup = splitExtractionSchema(sliceSchema)[0];
const slice = serializeSchema(sliceGroup.schema);
console.log(`Leaf mix: ~40% enums, ~30% numbers, ~20% strings, ~10% booleans`);
console.log(`Description length per leaf: ${avgDescLen} chars (measured average)`);
console.log(`  leaves:           163`);
console.log(`  with desc:        ${fmt(slice.withDesc)} chars`);
console.log(`  without desc:     ${fmt(slice.withoutDesc)} chars`);
console.log(`  nesting depth:    ${slice.depth} / ${SCHEMA_NESTING_DEPTH_CAP}`);
console.log(
  `  exceeds char cap with desc?    ${slice.withDesc > SCHEMA_SERIALIZED_CHAR_CAP ? "YES" : "no"}`,
);
console.log(
  `  exceeds char cap without desc? ${slice.withoutDesc > SCHEMA_SERIALIZED_CHAR_CAP ? "YES" : "no"}`,
);

console.log("\n=== Leaf-count sweep for a one-group basedata schema ===\n");
console.log("n    with-desc   without-desc  depth  over-cap-with  over-cap-without");
console.log("---  ----------  ------------  -----  -------------  ---------------");
let firstWith = null;
let firstWithout = null;
for (let n = 10; n <= 200; n += 10) {
  const s = buildBasedataExtractionSchema(n, avgDescLen);
  const g = splitExtractionSchema(s)[0];
  const m = serializeSchema(g.schema);
  if (firstWith === null && m.withDesc > SCHEMA_SERIALIZED_CHAR_CAP) firstWith = n;
  if (firstWithout === null && m.withoutDesc > SCHEMA_SERIALIZED_CHAR_CAP) firstWithout = n;
  const overWith = m.withDesc > SCHEMA_SERIALIZED_CHAR_CAP ? "YES" : "no";
  const overWithout = m.withoutDesc > SCHEMA_SERIALIZED_CHAR_CAP ? "YES" : "no";
  console.log(
    `${String(n).padStart(3)}  ${fmt(m.withDesc).padStart(10)}  ${fmt(m.withoutDesc).padStart(12)}  ${String(m.depth).padStart(5)}  ${overWith.padStart(13)}  ${overWithout.padStart(14)}`,
  );
}
console.log("\nFirst leaf count to break the 32,768 char cap:");
console.log(`  with descriptions:    ${firstWith === null ? "none up to 200" : firstWith}`);
console.log(`  without descriptions: ${firstWithout === null ? "none up to 200" : firstWithout}`);

console.log("\n=== Verdict ===\n");
const overWithDesc = slice.withDesc > SCHEMA_SERIALIZED_CHAR_CAP;
const overWithoutDesc = slice.withoutDesc > SCHEMA_SERIALIZED_CHAR_CAP;
if (overWithDesc) {
  const margin = slice.withDesc - SCHEMA_SERIALIZED_CHAR_CAP;
  console.log(
    `YES — a 163-leaf basedata group (one per-group call) exceeds the ` +
      `${fmt(SCHEMA_SERIALIZED_CHAR_CAP)} char cap by ${fmt(margin)} chars ` +
      `(${((slice.withDesc / SCHEMA_SERIALIZED_CHAR_CAP) * 100).toFixed(1)}%) with vendor-style descriptions.`,
  );
} else {
  const margin = SCHEMA_SERIALIZED_CHAR_CAP - slice.withDesc;
  console.log(
    `NO — a 163-leaf basedata group fits under the ${fmt(SCHEMA_SERIALIZED_CHAR_CAP)} ` +
      `char cap by ${fmt(margin)} chars with descriptions.`,
  );
}
if (overWithoutDesc) {
  const margin = slice.withoutDesc - SCHEMA_SERIALIZED_CHAR_CAP;
  console.log(
    `Without descriptions it still exceeds the cap by ${fmt(margin)} chars ` +
      `(${((slice.withoutDesc / SCHEMA_SERIALIZED_CHAR_CAP) * 100).toFixed(1)}%).`,
  );
} else {
  const margin = SCHEMA_SERIALIZED_CHAR_CAP - slice.withoutDesc;
  console.log(`Without descriptions it fits under the cap by ${fmt(margin)} chars.`);
}
console.log(
  `Nesting depth is not the threat: the slice nests ${slice.depth} levels, ` +
    `well under the ${SCHEMA_NESTING_DEPTH_CAP} cap.`,
);
