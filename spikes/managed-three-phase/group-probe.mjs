/** Which per-group schema does the route reject, and does stripping descriptions fix it? */
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

async function tryIt(name, schema) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.HELIX_ORIGIN,
      authorization: `Bearer ${env.HELIX_DEV_TOKEN}`,
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      system: "Extract.",
      messages: [{ role: "user", content: "the attic is R-30" }],
      stream: false,
      maxTokens: 2048,
      responseFormat: { type: "json_schema", name, schema },
    }),
  });
  return `${res.status}${res.ok ? "" : " " + (await res.text()).slice(0, 180)}`;
}

/** Every JSON Schema keyword present anywhere in the tree, with counts. */
function keywords(node, acc = new Map()) {
  if (Array.isArray(node)) node.forEach((n) => keywords(n, acc));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      acc.set(k, (acc.get(k) ?? 0) + 1);
      keywords(v, acc);
    }
  }
  return acc;
}

for (const group of splitExtractionSchema(snuggProAdapter.extractionSchema)) {
  const full = z.toJSONSchema(group.schema, { target: "draft-2020-12" });
  const bare = strip(full);
  const kw = [...keywords(full).entries()].filter(
    ([k]) =>
      ![
        "type",
        "properties",
        "required",
        "additionalProperties",
        "description",
        "items",
        "anyOf",
        "enum",
        "$schema",
      ].includes(k),
  );
  console.log(
    `\n[${group.key}] chars=${JSON.stringify(full).length} (stripped ${JSON.stringify(bare).length})` +
      `  odd keywords: ${kw.length ? JSON.stringify(Object.fromEntries(kw)) : "none"}`,
  );
  console.log(`   with descriptions -> ${await tryIt(`g-${group.key}`, full)}`);
  console.log(`   stripped          -> ${await tryIt(`g-${group.key}-s`, bare)}`);
}
