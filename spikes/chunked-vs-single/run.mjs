/**
 * Does chunking lose anything a single pass finds?
 *
 * `chunkedExtractor` assumes that splitting a transcript, extracting each piece and
 * merging beats failing on a transcript that does not fit. Nothing in the repo tests
 * that assumption. This runs both paths over the SAME real transcripts, with the same
 * model and the same target, and diffs the results leaf by leaf.
 *
 * The corpus transcripts are short (700–2000 chars), so a realistic context budget
 * would produce one chunk and measure nothing. The budget here is deliberately small
 * enough to force several chunks over a real transcript — which is the same phenomenon
 * a long document produces, at a price worth paying.
 *
 * What a difference MEANS:
 *   - chunked null where single-pass committed  -> chunking LOST a fact
 *   - chunked committed where single-pass null  -> chunking FOUND one (smaller prompts
 *     can genuinely help), or invented one
 *   - both committed, different values          -> a merge policy decision
 *   - collection length differs                 -> the case that motivated all of this
 *
 * Usage: node spikes/chunked-vs-single/run.mjs [maxChars] [transcript...]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// Spikes are not workspace members (pnpm-workspace.yaml lists packages/* and
// playground), so the built dist is the only way in. `./check.sh`'s
// build:packages stage keeps these current.
import {
  chunkedExtractor,
  splitOnBudget,
  isExtractedLeaf,
} from "../../packages/ribo-core/dist/index.js";
import {
  openAiChat,
  singleShotExtractor,
} from "../../packages/ribo-extractor-openai/dist/index.js";
import { enveloped } from "../../packages/ribo-core/dist/index.js";
import {
  snuggValuesSchema,
  snuggGroupInstructions,
} from "../../packages/ribo-adapter-snuggpro/dist/index.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS = join(here, "..", "extraction-snuggpro", "transcripts");

const MAX_CHARS = Number(process.argv[2] ?? 600);
const ONLY = process.argv.slice(3);

const env = Object.fromEntries(
  readFileSync(join(here, "..", "..", ".env.local"), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

// The platform's OPENAI-COMPATIBLE surface (`/_api/openai/v1`), not the
// provider-neutral `/_api/llm/chat` route. Both exist; only this one works here,
// which `franklin-field-app` demonstrates and which cost an afternoon to find.
//
// `openAiChat` has no `origin` option — `helixChat` does — and the dev gateway
// requires an origin registered against the token, so a fetch wrapper adds it.
//
// The model list is the gateway's own: `GET /_api/openai/v1/models` is the only
// introspection this surface offers (no capabilities/manifest endpoint exists),
// and the names are platform-specific — no `gpt-4o`/`gpt-4.1` here. The Claude
// models are ALLOWED but their upstream rejects every request on this tenant,
// including a bare chat with no schema, so the gpt-5.6 family is the working set.
const withOrigin = (url, init = {}) =>
  fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      accept: "application/json",
      origin: env.HELIX_ORIGIN ?? "http://localhost:5173",
    },
  });

const chat = openAiChat({
  apiKey: env.HELIX_DEV_TOKEN,
  baseUrl: env.HELIX_BASE_URL ?? "https://dev-api.azx.helix.azxlabs.io/ribo-docs/_api/openai/v1",
  fetchImpl: withOrigin,
});

// ONE group, not the whole adapter. The full extraction schema serialises to
// ~303KB — nearly 10x the repo's own SCHEMA_SERIALIZED_CHAR_CAP (32_768) — and
// the gateway rejects it outright, which is why per-group extraction exists.
// `hvac` is the right single group here: it is a COLLECTION, so it exercises the
// cross-chunk instance question that motivated the design.
const GROUP = process.env.SPIKE_GROUP ?? "hvac";
const groupSchema = z.object({ [GROUP]: snuggValuesSchema.shape[GROUP] }).strict();

const target = {
  name: `snuggpro-${GROUP}`,
  extractionSchema: enveloped(groupSchema),
  instructions: snuggGroupInstructions(GROUP),
};

const schemaBytes = JSON.stringify(
  z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }),
).length;
process.stdout.write(`group ${GROUP}: schema ${schemaBytes} chars\n`);
if (schemaBytes > 32_768) {
  throw new Error(`over SCHEMA_SERIALIZED_CHAR_CAP (32768)`);
}

const MODEL = env.SPIKE_MODEL ?? "gpt-5.6-luna";
const single = singleShotExtractor({ target, chat, model: MODEL });
const chunked = chunkedExtractor(single, { target, chunk: splitOnBudget(MAX_CHARS) });

/** Every leaf path in an enveloped result, as dotted strings. */
const leavesOf = (node, path = [], out = new Map()) => {
  if (isExtractedLeaf(node)) {
    out.set(path.join("."), node);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => leavesOf(item, [...path, i], out));
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) leavesOf(value, [...path, key], out);
  }
  return out;
};

/** Per-group instance counts, so a collection difference is visible on its own. */
const countsOf = (fields) =>
  Object.fromEntries(
    Object.entries(fields ?? {})
      .filter(([, value]) => Array.isArray(value))
      .map(([group, value]) => [group, value.length]),
  );

const files = readdirSync(TRANSCRIPTS)
  .filter((f) => f.endsWith(".txt"))
  .filter((f) => ONLY.length === 0 || ONLY.some((needle) => f.includes(needle)));

const rows = [];

for (const file of files) {
  const text = readFileSync(join(TRANSCRIPTS, file), "utf8");
  const transcript = { text, annotations: {} };
  const chunks = splitOnBudget(MAX_CHARS)(transcript);

  process.stdout.write(`\n${file}  (${text.length} chars -> ${chunks.length} chunks)\n`);

  let a, b;
  try {
    [a, b] = await Promise.all([single.extract(transcript), chunked.extract(transcript)]);
  } catch (error) {
    process.stdout.write(`  ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    rows.push({ file, error: String(error) });
    continue;
  }

  const aLeaves = leavesOf(a.fields);
  const bLeaves = leavesOf(b.fields);
  const paths = new Set([...aLeaves.keys(), ...bLeaves.keys()]);

  const diffs = { lost: [], found: [], changed: [] };
  for (const path of paths) {
    const av = aLeaves.get(path)?.value ?? null;
    const bv = bLeaves.get(path)?.value ?? null;
    if (Object.is(av, bv)) continue;
    if (av !== null && bv === null) diffs.lost.push({ path, was: av });
    else if (av === null && bv !== null) diffs.found.push({ path, now: bv });
    else diffs.changed.push({ path, single: av, chunked: bv });
  }

  const aCounts = countsOf(a.fields);
  const bCounts = countsOf(b.fields);
  const countDiffs = Object.keys({ ...aCounts, ...bCounts })
    .filter((group) => (aCounts[group] ?? 0) !== (bCounts[group] ?? 0))
    .map((group) => ({ group, single: aCounts[group] ?? 0, chunked: bCounts[group] ?? 0 }));

  const committed = (leaves) => [...leaves.values()].filter((l) => l.value !== null).length;

  process.stdout.write(
    `  committed: single ${committed(aLeaves)}, chunked ${committed(bLeaves)}` +
      `   calls: single ${a.usage.calls}, chunked ${b.usage.calls}\n`,
  );
  if (countDiffs.length > 0) {
    for (const d of countDiffs) {
      process.stdout.write(`  COLLECTION ${d.group}: single ${d.single}, chunked ${d.chunked}\n`);
    }
  }
  for (const d of diffs.lost) process.stdout.write(`  LOST    ${d.path} = ${d.was}\n`);
  for (const d of diffs.found) process.stdout.write(`  FOUND   ${d.path} = ${d.now}\n`);
  for (const d of diffs.changed) {
    process.stdout.write(`  CHANGED ${d.path}: ${d.single} -> ${d.chunked}\n`);
  }
  if (diffs.lost.length + diffs.found.length + diffs.changed.length + countDiffs.length === 0) {
    process.stdout.write("  identical\n");
  }

  rows.push({
    file,
    chars: text.length,
    chunks: chunks.length,
    committedSingle: committed(aLeaves),
    committedChunked: committed(bLeaves),
    callsSingle: a.usage.calls,
    callsChunked: b.usage.calls,
    countDiffs,
    ...diffs,
  });
}

const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `${stamp}-budget-${MAX_CHARS}.json`);
writeFileSync(outFile, JSON.stringify({ maxChars: MAX_CHARS, model: MODEL, rows }, null, 2));

const totals = rows.reduce(
  (acc, r) => ({
    lost: acc.lost + (r.lost?.length ?? 0),
    found: acc.found + (r.found?.length ?? 0),
    changed: acc.changed + (r.changed?.length ?? 0),
    countDiffs: acc.countDiffs + (r.countDiffs?.length ?? 0),
    callsSingle: acc.callsSingle + (r.callsSingle ?? 0),
    callsChunked: acc.callsChunked + (r.callsChunked ?? 0),
  }),
  { lost: 0, found: 0, changed: 0, countDiffs: 0, callsSingle: 0, callsChunked: 0 },
);

process.stdout.write(
  `\n== budget ${MAX_CHARS} chars, ${rows.length} transcripts ==\n` +
    `lost ${totals.lost}   found ${totals.found}   changed ${totals.changed}   ` +
    `collection-count diffs ${totals.countDiffs}\n` +
    `calls: single ${totals.callsSingle}, chunked ${totals.callsChunked} ` +
    `(${(totals.callsChunked / Math.max(1, totals.callsSingle)).toFixed(1)}x)\n` +
    `written to ${basename(outFile)}\n`,
);
