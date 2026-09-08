/**
 * What bounds each of three-phase's own call shapes on the managed route?
 *
 *   phase 0 — one boolean per leaf in the group.        No anyOf.
 *   phase 1 — one `anyOf: [string, null]` per ACTIVE leaf. One anyOf each.
 *   phase 2 — one leaf, wrapped in an object root.       Always tiny.
 *
 * The claim under test is that three-phase's per-call schema "never grows with total schema
 * size". It does grow — with GROUP size (phase 0) and with the number of leaves the presence
 * gate turns on (phase 1). These bisections say where each one stops.
 */
import { loadEnvLocal } from "./probe.mjs";

const env = loadEnvLocal();
const url = `${env.HELIX_BASE_URL}/_api/llm/chat`;

async function accepts(schema, model) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.HELIX_ORIGIN,
      authorization: `Bearer ${env.HELIX_DEV_TOKEN}`,
    },
    body: JSON.stringify({
      model,
      system: "Answer.",
      messages: [{ role: "user", content: "anything" }],
      stream: false,
      maxTokens: 8192,
      responseFormat: { type: "json_schema", name: "probe", schema },
    }),
  });
  return res.ok;
}

const obj = (n, leaf) => ({
  type: "object",
  properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, leaf])),
  required: Array.from({ length: n }, (_, i) => `f${i}`),
  additionalProperties: false,
});

const phase0 = (n) => obj(n, { type: "boolean" });
const phase1 = (n) => obj(n, { anyOf: [{ type: "string" }, { type: "null" }] });

async function bisect(build, lo, hi, model) {
  if (!(await accepts(build(lo), model))) return `even ${lo} rejected`;
  if (await accepts(build(hi), model)) return `>= ${hi}`;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await accepts(build(mid), model)) lo = mid;
    else hi = mid;
  }
  return String(lo);
}

for (const model of ["claude-sonnet-5", "gpt-4.1"]) {
  console.log(`\n=== ${model} ===`);
  console.log(
    `  phase 0 — largest group (boolean per leaf)      : ${await bisect(phase0, 1, 300, model)} leaves`,
  );
  console.log(
    `  phase 1 — largest active set (nullable per leaf): ${await bisect(phase1, 1, 300, model)} leaves`,
  );
}
