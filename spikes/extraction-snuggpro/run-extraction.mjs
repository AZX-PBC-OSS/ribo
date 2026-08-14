#!/usr/bin/env node
/**
 * Corpus comparison harness — drives the real `singleShotExtractor` and
 * `perGroupExtractor` over the 14 spike transcripts and writes results in the
 * shape `score.mjs` already consumes.
 *
 *   node spikes/extraction-snuggpro/run-extraction.mjs [options]
 *
 * Both strategies come from `@azx/ribo-extractor-openai`, constructed with a real
 * `ChatClient` exactly as `playground/src/extractor-store.ts` constructs them —
 * the single-shot as the baseline, the per-group with the adapter's
 * `snuggGroupInstructions` as the change under test. See `playground/src/
 * extractor-store.ts` for the wiring rationale.
 *
 * ## Environment
 *
 *   OPENAI_API_KEY   — required. The API key for the OpenAI-compatible endpoint.
 *                      Named explicitly so `--help` can state it and the
 *                      absence-check can name it. Never read from `.env.local`;
 *                      never printed.
 *   OPENAI_BASE_URL  — optional. Base URL without `/chat/completions`
 *                      (default: https://api.openai.com/v1). Override with a
 *                      CORS-OK proxy or the Helix platform route in production.
 *
 * ## Options
 *
 *   --model <id>       Model id (default: gpt-4o-2024-08-06)
 *   --output <dir>     Base output directory (default: spikes/extraction-snuggpro/results)
 *   --base-url <url>   Override OPENAI_BASE_URL from the command line
 *   --force            Overwrite existing results (default: skip — a 14×2 run
 *                      costs real money and a crash on transcript 12 must not
 *                      discard the first eleven)
 *   --strategy <name>  Run only one strategy: "single-shot" or "per-group"
 *                      (default: both)
 *   --help             Show this help
 *
 * ## Output shape
 *
 * Each result file `<output>/<strategy>/NN-slug.json` is the extractor's
 * `fields` — the `Enveloped<V>` shape `score.mjs`'s `loadResult` and `readLeaf`
 * expect (group keys → leaf keys → `{value, confidence, sourceSpan}`). A
 * `manifest.json` in each strategy directory records what produced the results
 * (strategy, model, base URL, per-transcript status and call count) so the
 * directory is self-describing six weeks later.
 *
 * A transcript that fails extraction gets no result file — `score.mjs` scores
 * that as "unscored" (whole-transcript miss), matching its own robustness
 * stance. The failure is recorded in the manifest with the error message.
 *
 * ## Resumability
 *
 * A result file that already exists is skipped unless `--force` is passed. This
 * is the whole point: a crash on transcript 12 must not discard the first
 * eleven, and re-running picks up where it left off.
 *
 * PRECONDITION: `pnpm build:packages` must have been run at least once — this
 * module imports the built `dist/index.js` of the workspace packages, not their
 * TypeScript source (same pattern as `schema-leaves.mjs`; plain Node cannot
 * remap `.js` specifiers to `.ts` files).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ADAPTER_DIST = join(
  HERE,
  "..",
  "..",
  "packages",
  "ribo-adapter-snuggpro",
  "dist",
  "index.js",
);
const EXTRACTOR_DIST = join(
  HERE,
  "..",
  "..",
  "packages",
  "ribo-extractor-openai",
  "dist",
  "index.js",
);

for (const [label, path] of [
  ["@azx/ribo-adapter-snuggpro", ADAPTER_DIST],
  ["@azx/ribo-extractor-openai", EXTRACTOR_DIST],
]) {
  if (!existsSync(path)) {
    console.error(
      `run-extraction.mjs: ${label} not built yet (${path} does not exist).\n` +
        "Run `pnpm build:packages` from the repo root first.",
    );
    process.exit(1);
  }
}

const { snuggProAdapter, normalizeFields, snuggGroupInstructions } = await import(ADAPTER_DIST);
const { openAiChat, helixChat, singleShotExtractor, perGroupExtractor } =
  await import(EXTRACTOR_DIST);

// ---------------------------------------------------------------------------
// Strategy definitions — how each extractor is built from a ChatClient + model.
// ---------------------------------------------------------------------------

/** @typedef {"single-shot" | "per-group"} StrategyName */

/**
 * Build the extractor for a given strategy. Mirrors `buildExtractorStep` in
 * `playground/src/extractor-store.ts` — the same target, normalize, and (for
 * per-group) groupInstructions — but returns the raw `Extractor`, not an
 * `ExtractStep`, because this harness calls `extract()` directly rather than
 * going through the relay.
 *
 * @param {StrategyName} name
 * @param {import(EXTRACTOR_DIST).ChatClient} chat
 * @param {string} model
 */
export function buildExtractor(name, chat, model) {
  if (name === "single-shot") {
    return singleShotExtractor({
      target: snuggProAdapter,
      chat,
      model,
      normalize: normalizeFields,
    });
  }
  return perGroupExtractor({
    target: snuggProAdapter,
    chat,
    model,
    normalize: normalizeFields,
    groupInstructions: snuggGroupInstructions,
  });
}

const STRATEGY_NAMES = /** @type {const} */ (["single-shot", "per-group"]);

// ---------------------------------------------------------------------------
// Core runner — exported for testing (the test injects a fake ChatClient).
// ---------------------------------------------------------------------------

/**
 * Run one or both strategies over the corpus transcripts and write results.
 *
 * @param {{
 *   chat:        import(EXTRACTOR_DIST).ChatClient,
 *   model:       string,
 *   outputDir:   string,
 *   transcriptDir: string,
 *   force?:      boolean,
 *   strategies?: readonly StrategyName[],
 *   log?:        (msg: string) => void,
 *   baseUrl?:    string,
 * }} opts
 * @returns {Promise<Record<StrategyName, import(EXTRACTOR_DIST).ChatCompletion[]>>}
 *   Per-strategy manifest entries (the same data written to `manifest.json`).
 */
export async function runExtraction({
  chat,
  model,
  outputDir,
  transcriptDir,
  force = false,
  strategies = STRATEGY_NAMES,
  log = (msg) => console.log(msg),
  baseUrl,
  only,
}) {
  const slugs = readdirSync(transcriptDir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(/\.txt$/, ""))
    .sort()
    // `only` subsets the corpus by slug prefix (e.g. "01,05,08"). A full 14x2 run is
    // 112 model calls; a subset proves the harness against a real endpoint and gives an
    // early signal for a fraction of the spend. Resume then adds the rest without
    // redoing these, because existing result files are skipped.
    .filter((slug) => only === undefined || only.some((p) => slug.startsWith(p)));

  const manifests = {};

  for (const name of strategies) {
    const dir = join(outputDir, name);
    mkdirSync(dir, { recursive: true });

    const extractor = buildExtractor(name, chat, model);
    const entries = [];

    log(`[${name}] ${slugs.length} transcripts, model=${model}`);

    for (const slug of slugs) {
      const resultPath = join(dir, `${slug}.json`);

      if (!force && existsSync(resultPath)) {
        log(`  [${name}] skip ${slug} (exists — use --force to overwrite)`);
        entries.push({ slug, status: "skipped" });
        continue;
      }

      try {
        const transcript = readFileSync(join(transcriptDir, `${slug}.txt`), "utf8");
        const result = await extractor.extract(transcript);
        writeFileSync(resultPath, `${JSON.stringify(result.fields, null, 2)}\n`);
        const calls = result.usage?.calls ?? null;
        log(`  [${name}] ok   ${slug} (${calls} calls)`);
        entries.push({ slug, status: "ok", calls });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`  [${name}] FAIL ${slug}: ${message}`);
        entries.push({ slug, status: "failed", calls: null, error: message });
      }
    }

    const manifest = {
      strategy: name,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      generatedAt: new Date().toISOString(),
      transcripts: entries,
    };
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    manifests[name] = manifest;
  }

  return manifests;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `\
run-extraction.mjs — drive single-shot and per-group extractors over the corpus

Usage:
  node spikes/extraction-snuggpro/run-extraction.mjs [options]

Environment:
  OPENAI_API_KEY   Required. API key for the OpenAI-compatible endpoint.
                   If absent, the runner exits with an error naming this variable.
  OPENAI_BASE_URL  Optional. Base URL without /chat/completions
                   (default: https://api.openai.com/v1).

Options:
  --model <id>       Model id (default: gpt-4o-2024-08-06)
  --output <dir>     Base output directory (default: spikes/extraction-snuggpro/results)
  --base-url <url>   Override OPENAI_BASE_URL
  --force            Overwrite existing results (default: skip)
  --strategy <name>  Run only one: "single-shot" or "per-group" (default: both)
  --only <prefixes>  Comma-separated slug prefixes, e.g. "01,05,08" (default: all 14)
  --transport <name> "openai" (default) or "helix" (POST <base>/_api/llm/chat)
  --origin <url>     Origin header for a Helix dev token (default: http://localhost:5173)
  --help             Show this help

Output:
  <output>/<strategy>/NN-slug.json   Extraction result (enveloped fields — what
                                     score.mjs reads)
  <output>/<strategy>/manifest.json  Strategy, model, per-transcript status & calls

Scoring:
  node spikes/extraction-snuggpro/score.mjs <output>/<strategy>
`;

function parseArgs(argv) {
  const opts = {
    model: process.env.OPENAI_MODEL ?? "gpt-4o-2024-08-06",
    output: join(HERE, "results"),
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    force: false,
    strategies: [...STRATEGY_NAMES],
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--transport") opts.transport = argv[++i];
    else if (a === "--origin") opts.origin = argv[++i];
    else if (a === "--only") opts.only = String(argv[++i]).split(",").map((x) => x.trim());
    else if (a === "--output") opts.output = resolve(argv[++i]);
    else if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "--strategy") {
      const v = argv[++i];
      if (v !== "single-shot" && v !== "per-group") {
        console.error(
          `run-extraction.mjs: --strategy must be "single-shot" or "per-group", got "${v}"`,
        );
        process.exit(1);
      }
      opts.strategies = [v];
    } else {
      console.error(`run-extraction.mjs: unknown option "${a}"\nSee --help.`);
      process.exit(1);
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const apiKey =
    parseArgs(process.argv.slice(2)).transport === "helix"
      ? (process.env.HELIX_DEV_TOKEN ?? process.env.OPENAI_API_KEY)
      : process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "run-extraction.mjs: OPENAI_API_KEY is not set. " +
        "Set it to your OpenAI-compatible API key and re-run.",
    );
    process.exit(1);
  }

  // Helix's LLM route is provider-neutral, not OpenAI-compatible: system is a
  // top-level field, roles are user/assistant only, and the path is /_api/llm/chat.
  // Its dev token is also origin-scoped, so the Origin header is not optional — a
  // call without one is 403 regardless of the token. See helix-chat.ts.
  const chat =
    opts.transport === "helix"
      ? helixChat({
          token: apiKey,
          baseUrl: opts.baseUrl ?? process.env.HELIX_BASE_URL ?? "",
          origin: opts.origin ?? process.env.HELIX_ORIGIN ?? "http://localhost:5173",
        })
      : openAiChat({ apiKey, baseUrl: opts.baseUrl });

  await runExtraction({
    chat,
    model: opts.model,
    outputDir: opts.output,
    transcriptDir: join(HERE, "transcripts"),
    force: opts.force,
    strategies: opts.strategies,
    baseUrl: opts.baseUrl,
    only: opts.only,
  });
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(`run-extraction.mjs: unhandled error: ${err.message}`);
    process.exit(1);
  });
}
