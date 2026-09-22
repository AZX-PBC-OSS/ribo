// Probe 8, part 1: produce CURRENT-schema extractions, so the corroboration fraction can be
// measured against the schema ribo actually ships rather than the superseded 23-field one.
//
// Uses the production wiring — `perGroupExtractor` over `snuggProAdapter`, 20 groups — because
// the 467-leaf schema does not fit a single-shot call.
//
//   node run-8-extract.mjs <model> [transcriptLimit]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openAiChat, perGroupExtractor } from "../../packages/ribo-extractor-openai/dist/index.js";
import {
  snuggProAdapter,
  snuggGroupInstructions,
} from "../../packages/ribo-adapter-snuggpro/dist/index.js";
import { loadEnv } from "./env.mjs";
import { corpus } from "./corpus.mjs";

const model = process.argv[2] ?? "claude-haiku-4-5";
const limit = Number(process.argv[3] ?? "99");
const env = loadEnv();

// Helix's OpenAI-compatible surface. The Azure Foundry resource in .env.local lists a 474-model
// catalog but has no deployments, so every model id 404s there.
const HELIX = "https://dev-api.azx.helix.azxlabs.io/ribo-docs/_api/openai/v1";

// The dev token is scoped to registered origins, and node's fetch sends no Origin.
const withOrigin = (input, init = {}) =>
  fetch(input, { ...init, headers: { ...init.headers, Origin: "http://localhost:5173" } });

const chat = openAiChat({
  apiKey: env.HELIX_DEV_TOKEN,
  baseUrl: HELIX,
  fetchImpl: withOrigin,
});

const extractor = perGroupExtractor({
  target: snuggProAdapter,
  chat,
  model,
  groupInstructions: snuggGroupInstructions,
});

const outDir = fileURLToPath(new URL(`./results/extractions-${model}/`, import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const entry of corpus().slice(0, limit)) {
  const t0 = Date.now();
  try {
    const result = await extractor.extract(
      { text: entry.transcript, annotations: [] },
      { deadline: Date.now() + 10 * 60_000 },
    );
    writeFileSync(`${outDir}${entry.name}.json`, JSON.stringify(result.fields, null, 2));
    console.log(
      `${entry.name.padEnd(28)} ${String(Date.now() - t0).padStart(7)}ms  ` +
        `${result.usage.calls} calls  ${result.usage.promptTokens ?? "?"} in / ` +
        `${result.usage.completionTokens ?? "?"} out`,
    );
  } catch (e) {
    console.log(
      `${entry.name.padEnd(28)} FAILED after ${Date.now() - t0}ms: ${String(e).slice(0, 200)}`,
    );
  }
}
console.log(`\nwrote ${outDir}`);
