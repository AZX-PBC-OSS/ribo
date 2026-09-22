/**
 * `hvac` and `health` both fail at exactly 37 total properties (1 group key + 9 leaf keys +
 * 27 envelope members) while succeeding at 33, at very different character counts (6,970 vs
 * 8,894). That says the binding limit is a PROPERTY COUNT, not a byte count. Pin it exactly
 * with a synthetic flat object, and check whether it is per-object or whole-schema, and
 * whether it moves with the model.
 */
import { loadEnvLocal } from "./probe.mjs";

const env = loadEnvLocal();
const url = `${env.HELIX_BASE_URL}/_api/llm/chat`;

async function tryIt(schema, model) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.HELIX_ORIGIN,
      authorization: `Bearer ${env.HELIX_DEV_TOKEN}`,
    },
    body: JSON.stringify({
      model,
      system: "Fill it in.",
      messages: [{ role: "user", content: "anything" }],
      stream: false,
      maxTokens: 4096,
      responseFormat: { type: "json_schema", name: "probe", schema },
    }),
  });
  if (res.ok) return true;
  const body = await res.text();
  if (!body.includes("validation_failed"))
    console.log(`      (non-validation error: ${body.slice(0, 160)})`);
  return false;
}

/** A flat object with `n` string properties. */
const flat = (n) => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`f${i}`, { type: "string" }]),
  ),
  required: Array.from({ length: n }, (_, i) => `f${i}`),
  additionalProperties: false,
});

/** `g` sibling objects of `k` properties each: g*(k+1) total properties, none over k in one object. */
const nested = (g, k) => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: g }, (_, i) => [
      `g${i}`,
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: k }, (_, j) => [`f${j}`, { type: "string" }]),
        ),
        required: Array.from({ length: k }, (_, j) => `f${j}`),
        additionalProperties: false,
      },
    ]),
  ),
  required: Array.from({ length: g }, (_, i) => `g${i}`),
  additionalProperties: false,
});

async function bisect(label, build, lo, hi, model) {
  // invariant: build(lo) passes, build(hi) fails
  if (!(await tryIt(build(lo), model))) return `${label}: even ${lo} fails`;
  if (await tryIt(build(hi), model))
    return `${label}: ${hi} still passes (no cap found below ${hi})`;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await tryIt(build(mid), model)) lo = mid;
    else hi = mid;
  }
  return `${label}: largest accepted = ${lo}; ${hi} rejected`;
}

const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"];

for (const model of models) {
  console.log(`\n=== ${model} ===`);
  console.log("  " + (await bisect("flat object, total properties", flat, 1, 200, model)));
  // Whole-schema vs per-object: 12 objects of 4 properties = 60 total, max 4 in any one object.
  for (const [g, k] of [
    [4, 8],
    [8, 8],
    [12, 8],
    [20, 4],
  ]) {
    const total = g * (k + 1);
    const ok = await tryIt(nested(g, k), model);
    console.log(
      `  ${g} sibling objects x ${k} props (total ${total} props, max ${k} per object) -> ${ok ? "OK" : "REJECTED"}`,
    );
  }
}
