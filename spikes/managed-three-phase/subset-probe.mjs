/**
 * Why does the route reject the `hvac` and `health` per-group schemas? Neither is near the
 * 32,768 char cap, and stripping descriptions does not help — so it is a shape rule, not size.
 * Bisect: count enums/properties per group, then shrink the failing groups leaf by leaf.
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
const MODEL = process.argv[2] ?? "claude-sonnet-5";

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
      messages: [{ role: "user", content: "the attic is R-30" }],
      stream: false,
      maxTokens: 2048,
      responseFormat: { type: "json_schema", name: "probe", schema },
    }),
  });
  if (res.ok) return "OK";
  return `${res.status} ${(await res.text()).slice(0, 120)}`;
}

function stats(node, acc = { props: 0, enums: 0, enumValues: 0, maxEnum: 0, depth: 0 }, d = 0) {
  acc.depth = Math.max(acc.depth, d);
  if (Array.isArray(node)) node.forEach((n) => stats(n, acc, d));
  else if (node && typeof node === "object") {
    if (node.properties) acc.props += Object.keys(node.properties).length;
    if (Array.isArray(node.enum)) {
      acc.enums++;
      acc.enumValues += node.enum.length;
      acc.maxEnum = Math.max(acc.maxEnum, node.enum.length);
    }
    for (const v of Object.values(node)) stats(v, acc, d + 1);
  }
  return acc;
}

const groups = Object.fromEntries(
  splitExtractionSchema(snuggProAdapter.extractionSchema).map((g) => [g.key, g.schema]),
);

console.log("=== per-group static profile ===");
for (const [key, schema] of Object.entries(groups)) {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12" });
  const s = stats(js);
  console.log(
    `${key.padEnd(9)} chars=${String(JSON.stringify(js).length).padStart(6)} props=${String(s.props).padStart(4)} ` +
      `enums=${String(s.enums).padStart(3)} enumValues=${String(s.enumValues).padStart(4)} largestEnum=${String(s.maxEnum).padStart(3)} depth=${s.depth}`,
  );
}

/** Rebuild a group schema with only the first `n` leaves. */
function truncated(key, n) {
  const inner = groups[key].shape[key];
  const isArray = inner.def.type === "array";
  const leafShape = (isArray ? inner.element : inner).shape;
  const keys = Object.keys(leafShape).slice(0, n);
  const kept = Object.fromEntries(keys.map((k) => [k, leafShape[k]]));
  const obj = z.strictObject(kept);
  return { schema: z.strictObject({ [key]: isArray ? z.array(obj) : obj }), keys };
}

for (const key of ["health", "hvac"]) {
  console.log(`\n=== bisect ${key} by leaf count (${MODEL}) ===`);
  const total = Object.keys(
    (groups[key].shape[key].def.type === "array"
      ? groups[key].shape[key].element
      : groups[key].shape[key]
    ).shape,
  ).length;
  for (let n = 1; n <= total; n++) {
    const { schema, keys } = truncated(key, n);
    const js = z.toJSONSchema(schema, { target: "draft-2020-12" });
    const s = stats(js);
    const verdict = await tryIt(js);
    console.log(
      `  n=${String(n).padStart(2)} chars=${String(JSON.stringify(js).length).padStart(6)} props=${String(s.props).padStart(3)} enumValues=${String(s.enumValues).padStart(4)} -> ${verdict}   (+${keys[n - 1]})`,
    );
    if (verdict !== "OK") break;
  }
}
