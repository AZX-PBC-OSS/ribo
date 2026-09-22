/**
 * The hypothesis the factor probe leaves standing: the route caps the number of `anyOf`
 * unions in one response schema, not its bytes, properties or enum values.
 *
 * Evidence it has to explain (all measured, claude-sonnet-5):
 *   health  8 leaves as shipped -> 16 anyOf -> OK       (33 props,  7,938 chars)
 *   health  9 leaves as shipped -> 18 anyOf -> REJECTED (37 props,  8,894 chars)
 *   health 14 leaves value-only -> 14 anyOf -> OK       (29 props, 11,706 chars)
 *   health 14 leaves plain str  -> 28 anyOf -> REJECTED (57 props,  4,380 chars)
 *   flat object of 72 strings   ->  0 anyOf -> OK
 *
 * This repo's provenance envelope emits TWO anyOf per leaf (`value` nullable, `sourceSpan`
 * nullable), so a cap on anyOf is a cap on leaves-per-call at half the rate.
 *
 * Also separates route from model family: the same probe across Anthropic and OpenAI models.
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
  if (res.ok) return { ok: true };
  return { ok: false, body: (await res.text()).slice(0, 200) };
}

/** Flat object, `n` properties, each a nullable union (`anyOf: [string, null]`). */
const nullableFlat = (n) => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `f${i}`,
      { anyOf: [{ type: "string" }, { type: "null" }] },
    ]),
  ),
  required: Array.from({ length: n }, (_, i) => `f${i}`),
  additionalProperties: false,
});

/** Same property count, but nullability expressed as `type: ["string","null"]` — no anyOf. */
const nullableTypeArray = (n) => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`f${i}`, { type: ["string", "null"] }]),
  ),
  required: Array.from({ length: n }, (_, i) => `f${i}`),
  additionalProperties: false,
});

/** Full provenance envelope, `n` leaves — exactly what `enveloped()` emits (2 anyOf per leaf). */
const envelopedFlat = (n) => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `f${i}`,
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "null" }] },
          confidence: { type: "number" },
          sourceSpan: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["value", "confidence", "sourceSpan"],
        additionalProperties: false,
      },
    ]),
  ),
  required: Array.from({ length: n }, (_, i) => `f${i}`),
  additionalProperties: false,
});

async function bisect(build, lo, hi, model) {
  const first = await tryIt(build(lo), model);
  if (!first.ok) return `even ${lo} rejected (${first.body})`;
  if ((await tryIt(build(hi), model)).ok) return `${hi} still accepted (no cap below ${hi})`;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await tryIt(build(mid), model)).ok) lo = mid;
    else hi = mid;
  }
  return `largest accepted = ${lo}`;
}

for (const model of ["claude-sonnet-5", "claude-opus-5", "gpt-4.1", "gpt-4o"]) {
  console.log(`\n=== ${model} ===`);
  console.log(`  nullable anyOf properties : ${await bisect(nullableFlat, 1, 120, model)}`);
  console.log(`  type:["string","null"]    : ${await bisect(nullableTypeArray, 1, 120, model)}`);
  console.log(`  full enveloped leaves     : ${await bisect(envelopedFlat, 1, 120, model)}`);
}
