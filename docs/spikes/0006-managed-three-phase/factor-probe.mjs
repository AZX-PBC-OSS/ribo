/**
 * A synthetic flat object of 72 plain string properties is accepted, but the real `health`
 * group is rejected at 37 properties. So "total properties" is not the rule either. Take the
 * real health group at the exact size where it flips (8 leaves OK, 9 rejected) and remove one
 * factor at a time to find what actually tips it.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { loadEnvLocal } from "./probe.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const dist = (p) => join(ROOT, "packages", p, "dist", "index.js");
const { snuggProAdapter } = await import(dist("ribo-adapter-snuggpro"));
const { splitExtractionSchema } = await import(dist("ribo-extractor-openai"));
const { z } = await import(
  createRequire(dist("ribo-adapter-snuggpro"))
    .resolve("zod")
    .replace(/\.cjs$/, ".js")
);

const env = loadEnvLocal();
const url = `${env.HELIX_BASE_URL}/_api/llm/chat`;
const MODEL = "claude-sonnet-5";

async function tryIt(schema) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.HELIX_ORIGIN,
      authorization: `Bearer ${env.HELIX_DEV_TOKEN}`,
    },
    body: JSON.stringify({
      model: MODEL,
      system: "Extract.",
      messages: [{ role: "user", content: "anything" }],
      stream: false,
      maxTokens: 4096,
      responseFormat: { type: "json_schema", name: "probe", schema },
    }),
  });
  return res.ok ? "OK" : `REJECTED`;
}

const groups = Object.fromEntries(
  splitExtractionSchema(snuggProAdapter.extractionSchema).map((g) => [g.key, g.schema]),
);
const healthJs = z.toJSONSchema(groups.health, { target: "draft-2020-12" });

const clone = (o) => JSON.parse(JSON.stringify(o));
const strip = (n) =>
  Array.isArray(n)
    ? n.map(strip)
    : n && typeof n === "object"
      ? Object.fromEntries(
          Object.entries(n)
            .filter(([k]) => k !== "description")
            .map(([k, v]) => [k, strip(v)]),
        )
      : n;

/** health with only the first `n` leaves, then a per-leaf transform. */
function variant(n, transform) {
  const js = clone(healthJs);
  const leaves = js.properties.health.properties;
  const keys = Object.keys(leaves).slice(0, n);
  js.properties.health.properties = Object.fromEntries(
    keys.map((k) => [k, transform ? transform(leaves[k]) : leaves[k]]),
  );
  js.properties.health.required = keys;
  return js;
}

function count(node, acc = { props: 0, chars: 0 }) {
  if (Array.isArray(node)) node.forEach((x) => count(x, acc));
  else if (node && typeof node === "object") {
    if (node.properties) acc.props += Object.keys(node.properties).length;
    for (const v of Object.values(node)) count(v, acc);
  }
  return acc;
}

const onlyValue = (leaf) => ({
  type: "object",
  properties: { value: leaf.properties.value },
  required: ["value"],
  additionalProperties: false,
});
const plainString = (leaf) => ({
  ...leaf,
  properties: {
    ...leaf.properties,
    value: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
});
const flattenLeaf = (leaf) => leaf.properties.value; // no envelope at all

const cases = [
  ["health 8 leaves, as shipped", variant(8)],
  ["health 9 leaves, as shipped", variant(9)],
  ["health 9 leaves, descriptions stripped", strip(variant(9))],
  ["health 9 leaves, value-only envelope (no confidence/sourceSpan)", variant(9, onlyValue)],
  ["health 14 leaves, value-only envelope", variant(14, onlyValue)],
  ["health 9 leaves, enums replaced by plain strings", variant(9, plainString)],
  ["health 14 leaves, enums replaced by plain strings", variant(14, plainString)],
  ["health 9 leaves, no envelope at all (bare values)", variant(9, flattenLeaf)],
  ["health 14 leaves, no envelope at all", variant(14, flattenLeaf)],
  ["health 14 leaves, value-only + plain strings", variant(14, (l) => onlyValue(plainString(l)))],
];

for (const [label, schema] of cases) {
  const c = count(schema);
  console.log(
    `${(await tryIt(schema)).padEnd(9)} props=${String(c.props).padStart(3)} chars=${String(JSON.stringify(schema).length).padStart(6)}  ${label}`,
  );
}
