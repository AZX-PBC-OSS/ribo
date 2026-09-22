#!/usr/bin/env node
/**
 * Corpus harness for doc 20 — three-phase extraction against the MANAGED model.
 *
 *   node docs/spikes/0006-managed-three-phase/run.mjs --strategy three-phase --model claude-sonnet-5
 *
 * Drives one of three strategies over the 14 spike transcripts and writes results in the
 * shape `docs/spikes/0001-extraction-snuggpro/score.mjs` already consumes, so quality is graded by
 * that scorer **untouched** (the convention docs 16/18/19 all follow).
 *
 *   three-phase          `threePhaseExtractor` from `@azx/ribo-extractor-ondevice`, driven
 *                        by `helixChat` instead of `OnDeviceChat`. See the singleton
 *                        projection note below — it does NOT run against the adapter's real
 *                        extraction schema unmodified.
 *   per-group            `perGroupExtractor` (Tier 2, arrays) with `snuggGroupInstructions` —
 *                        exactly what `playground/src/extractor-store.ts` wires today.
 *   per-group-singleton  `perGroupSingletonExtractor` (Tier 3) — the same call shape as
 *                        three-phase's instance modelling, and therefore the apples-to-apples
 *                        baseline for it.
 *
 * ## The singleton projection, and why it is needed
 *
 * `threePhaseExtractor.extractGroups()` reads `schema.properties[group].properties[leaf]
 * .properties.value`. That walk assumes every top-level group is an OBJECT of enveloped
 * leaves. Since the R1.6 instance ladder, five of the adapter's seven groups (`hvac`,
 * `attic`, `wall`, `window`, `dhw`) are ARRAYS of instances, which have no `properties` —
 * so the walk silently drops them, and the extractor then throws on its own final
 * `extractionSchema.parse()` with five `invalid_type` errors. Three-phase cannot run
 * against today's adapter at all.
 *
 * This harness projects each collection group down to a single instance (`z.array(X)` -> `X`),
 * hands three-phase that projected target, and wraps each collection group's result back
 * into a one-element array before parsing against the real schema. That is precisely Tier
 * 3's semantics, which is why `per-group-singleton` is run alongside as its matched baseline.
 * `threePhaseExtractor` itself is used verbatim — nothing in `packages/` is modified.
 *
 * PRECONDITION: `pnpm build:packages`. This imports the built `dist/index.js`, exactly as
 * `docs/spikes/0001-extraction-snuggpro/run-extraction.mjs` does.
 *
 * Credentials come from the gitignored `.env.local` at the repo root: `HELIX_DEV_TOKEN`,
 * `HELIX_BASE_URL`, `HELIX_ORIGIN`. Never printed.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvLocal } from "./probe.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const CORPUS = join(ROOT, "spikes", "extraction-snuggpro");
const dist = (pkg) => join(ROOT, "packages", pkg, "dist", "index.js");

for (const pkg of ["ribo-adapter-snuggpro", "ribo-extractor-openai", "ribo-extractor-ondevice"]) {
  if (!existsSync(dist(pkg))) {
    console.error(`run.mjs: ${pkg}/dist/index.js is missing. Run \`pnpm build:packages\` first.`);
    process.exit(1);
  }
}

const { snuggProAdapter, snuggGroupInstructions, normalizeFields } = await import(
  dist("ribo-adapter-snuggpro")
);
const { helixChat, perGroupExtractor, perGroupSingletonExtractor } = await import(
  dist("ribo-extractor-openai")
);
const { threePhaseExtractor } = await import(dist("ribo-extractor-ondevice"));
// Resolve zod through the ADAPTER's own dependency graph, not the repo root: the projection
// below does `instanceof z.ZodArray` against schema objects the adapter's `dist` built, and a
// second zod instance would make every one of those checks silently false.
const { createRequire } = await import("node:module");
const adapterRequire = createRequire(dist("ribo-adapter-snuggpro"));
const { z } = await import(adapterRequire.resolve("zod").replace(/\.cjs$/, ".js"));

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const STRATEGIES = ["three-phase", "per-group", "per-group-singleton"];

function parseArgs(argv) {
  const opts = { model: "claude-sonnet-5", strategy: "three-phase", only: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") opts.model = argv[++i];
    else if (a === "--strategy") opts.strategy = argv[++i];
    else if (a === "--force") opts.force = true;
    else if (a === "--only") opts.only = String(argv[++i]).split(",");
    else if (a === "--output") opts.output = argv[++i];
    else {
      console.error(`run.mjs: unknown option "${a}"`);
      process.exit(1);
    }
  }
  if (!STRATEGIES.includes(opts.strategy)) {
    console.error(`run.mjs: --strategy must be one of ${STRATEGIES.join(" | ")}`);
    process.exit(1);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// The singleton projection (see the file header)
// ---------------------------------------------------------------------------

/**
 * Project the adapter's extraction schema so every collection group becomes a single
 * instance object. Returns the projected zod schema plus the list of group keys that
 * were projected, so results can be wrapped back into arrays.
 */
function projectToSingleton(extractionSchema) {
  const shape = extractionSchema.shape;
  const projected = {};
  const collections = [];
  for (const [key, value] of Object.entries(shape)) {
    if (value instanceof z.ZodArray) {
      projected[key] = value.element;
      collections.push(key);
    } else {
      projected[key] = value;
    }
  }
  return { schema: z.strictObject(projected), collections };
}

/**
 * `threePhaseExtractor` has no `model` option: it sets `ChatRequest.model = chat.engine`
 * (three-phase-extractor.ts, "The on-device chat transport ignores the model id, but
 * ChatRequest requires one"). That assumption is true only on-device. Against `helixChat`
 * it sends `model: "helix"` and the route answers `403 model_not_allowed` on every call —
 * which three-phase then swallows into an all-null result, so the run reports 14/14
 * "completed" with an empty grid. Restating `engine` as the model id is the smallest
 * change that does not touch the package; the cost is that `usage.engine` provenance now
 * reads as the model rather than the transport.
 */
function asModel(chat, model) {
  return { ...chat, engine: model, complete: (r, o) => chat.complete(r, o) };
}

/**
 * Phase 2 (`classifyLeaf`) sends the leaf's BARE value schema as the response-format root —
 * `{"type":"number"}`, or `{"anyOf":[{...enum},{"type":"null"}]}`. The Prompt API accepts
 * that; the managed route does not. Measured against this gateway (root-probe.mjs):
 * a bare `number` root and a bare `anyOf` root both return `400 validation_failed`; the
 * identical schema wrapped in an object root returns 200. Doc 16 §1 records the same rule
 * from OpenAI's side ("Root objects must not be `anyOf` and must be an object").
 *
 * `threePhaseExtractor` HAS a wrapped-schema fallback (`classifyWrapped`) — but it fires only
 * on `ChatError.kind === "unsupported"`, and a managed transport reports this as `http` 400.
 * So the fallback never runs: phase 2 retries the bare form four times, gives up, and returns
 * null for the leaf. Left alone, every leaf comes back null and the run scores a 100% miss
 * rate that says nothing about the strategy's quality.
 *
 * This shim does at the transport what `classifyWrapped` would have done at the extractor:
 * a non-object root is wrapped in `{value: ...}` on the wire and unwrapped out of the reply,
 * so `parsePhase2Bare` still sees the bare value it expects. Zero extra calls, and
 * `three-phase-extractor.ts` is used verbatim. The finding stands on its own — see doc 20.
 */
function wrapNonObjectRoots(chat) {
  return {
    ...chat,
    engine: chat.engine,
    async complete(request, options) {
      const schema = request.response_format.json_schema.schema;
      if (schema && schema.type === "object") return chat.complete(request, options);
      const wrapped = {
        ...request,
        response_format: {
          ...request.response_format,
          json_schema: {
            ...request.response_format.json_schema,
            schema: {
              type: "object",
              properties: { value: schema },
              required: ["value"],
              additionalProperties: false,
            },
          },
        },
      };
      const completion = await chat.complete(wrapped, options);
      let unwrapped = completion.content;
      try {
        unwrapped = JSON.stringify(JSON.parse(completion.content).value ?? null);
      } catch {
        // Leave the content alone; the extractor's own parse will reject it.
      }
      return { ...completion, content: unwrapped };
    },
  };
}

/** A three-phase extractor over the projected target, re-wrapping collections on the way out. */
function managedThreePhase({ target, chat, model }) {
  const { schema, collections } = projectToSingleton(target.extractionSchema);
  const inner = threePhaseExtractor({
    target: { name: target.name, extractionSchema: schema },
    chat: wrapNonObjectRoots(asModel(chat, model)),
  });
  return {
    async extract(transcript) {
      const result = await inner.extract(transcript);
      const wrapped = { ...result.fields };
      for (const key of collections) wrapped[key] = [wrapped[key]];
      return {
        fields: target.extractionSchema.parse(wrapped),
        usage: result.usage,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Instrumented transport — the seam is where token/latency accounting lives, because
// `threePhaseExtractor` discards `completion.usage` entirely (it only counts calls).
// ---------------------------------------------------------------------------

/**
 * Retry a `429 rate_limited` with backoff, at the transport, for every strategy alike.
 *
 * The route enforces a burst spend budget as well as a daily one, and a corpus run trips it.
 * Neither strategy handles that itself in a way this measurement can rely on: `threePhaseExtractor`
 * swallows a failed call into a null leaf, so a rate-limited run silently produces an all-null
 * grid and still reports "14/14 completed" — which is exactly what happened on the first pass and
 * corrupted two transcripts before the zero token counts gave it away. Retrying here keeps the
 * two strategies comparable (neither gets a retry the other doesn't) and keeps a platform
 * throttle out of the quality numbers.
 */
function retryRateLimits(inner, { attempts = 6, baseMs = 4000 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    ...inner,
    engine: inner.engine,
    async complete(request, options) {
      let lastError;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          return await inner.complete(request, options);
        } catch (error) {
          lastError = error;
          const rateLimited = error?.kind === "http" && error.status === 429;
          if (!rateLimited || attempt === attempts - 1) throw error;
          await sleep(baseMs * 2 ** attempt);
        }
      }
      throw lastError;
    },
  };
}

function instrument(inner) {
  const stats = {
    calls: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    cacheCreationPromptTokens: 0,
    latencyMsTotal: 0,
    maxSchemaChars: 0,
  };
  return {
    stats,
    engine: inner.engine,
    capability: () => inner.capability(),
    async complete(request, options) {
      stats.calls++;
      const chars = JSON.stringify(request.response_format.json_schema.schema).length;
      if (chars > stats.maxSchemaChars) stats.maxSchemaChars = chars;
      const started = Date.now();
      try {
        const completion = await inner.complete(request, options);
        stats.latencyMsTotal += Date.now() - started;
        const u = completion.usage;
        if (u) {
          stats.promptTokens += u.promptTokens ?? 0;
          stats.completionTokens += u.completionTokens ?? 0;
          stats.cachedPromptTokens += u.cachedPromptTokens ?? 0;
          stats.cacheCreationPromptTokens += u.cacheCreationPromptTokens ?? 0;
        }
        return completion;
      } catch (error) {
        stats.latencyMsTotal += Date.now() - started;
        stats.failures++;
        // `threePhaseExtractor` swallows every call failure into an all-null group, so a
        // wholly broken run reports "14/14 completed" with an empty grid. Surface the first
        // few here — a silent failure defeats reasoning about the numbers downstream.
        if (stats.failures <= 3) {
          console.error(
            `    [call failed] ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
          );
        }
        throw error;
      }
    },
  };
}

function snapshot(stats) {
  return { ...stats };
}

function delta(after, before) {
  const out = {};
  for (const k of Object.keys(after)) {
    out[k] = k === "maxSchemaChars" ? Math.max(after[k], before[k]) : after[k] - before[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const env = loadEnvLocal();
const token = env.HELIX_DEV_TOKEN;
const baseUrl = env.HELIX_BASE_URL;
const origin = env.HELIX_ORIGIN ?? "http://localhost:5173";
if (!token || !baseUrl) {
  console.error("run.mjs: HELIX_DEV_TOKEN and HELIX_BASE_URL must be set in .env.local");
  process.exit(1);
}

// Order matters: the retry wraps the INSTRUMENTED client, so every attempt — including the
// retried ones — passes through the counter, the way `usage.calls` counts retries. The retry
// wrapper spreads its inner client, so `chat.stats` is the same object either way.
const chat = retryRateLimits(instrument(helixChat({ token, baseUrl, origin })));

// `maxTokens` is set generously and explicitly. The Helix route defaults `claude-*` models
// to 1024, which a 7-leaf enveloped group response blows straight through — the resulting
// truncated JSON reads as "the model cannot produce valid output" rather than "the cap was
// too low". Every strategy gets the same ceiling so the comparison is not confounded by it.
const MAX_TOKENS = 8192;

function buildExtractor(strategy) {
  if (strategy === "three-phase") {
    return managedThreePhase({ target: snuggProAdapter, chat, model: opts.model });
  }
  const options = {
    target: snuggProAdapter,
    chat,
    model: opts.model,
    normalize: normalizeFields,
    groupInstructions: snuggGroupInstructions,
    maxTokens: MAX_TOKENS,
    concurrency: 4,
    maxRetries: 2,
    perCallCeilingMs: 120_000,
    stepTimeoutMs: 900_000,
  };
  return strategy === "per-group"
    ? perGroupExtractor(options)
    : perGroupSingletonExtractor(options);
}

const outDir = opts.output
  ? join(ROOT, opts.output)
  : join(CORPUS, "results", `managed-${opts.strategy}-${opts.model}`);
mkdirSync(outDir, { recursive: true });

const slugs = readdirSync(join(CORPUS, "ground-truth"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .filter((s) => !opts.only || opts.only.some((p) => s.startsWith(p)))
  .sort();

const extractor = buildExtractor(opts.strategy);
const manifest = {
  strategy: opts.strategy,
  model: opts.model,
  transport: "helixChat",
  baseUrl,
  maxTokens: MAX_TOKENS,
  startedAt: new Date().toISOString(),
  transcripts: [],
};

console.log(`[run] strategy=${opts.strategy} model=${opts.model} -> ${outDir}`);

const runStarted = Date.now();
for (const slug of slugs) {
  const resultPath = join(outDir, `${slug}.json`);
  if (existsSync(resultPath) && !opts.force) {
    console.log(`  ${slug}: skipped (exists)`);
    continue;
  }
  const transcript = readFileSync(join(CORPUS, "transcripts", `${slug}.txt`), "utf8");
  const before = snapshot(chat.stats);
  const t0 = Date.now();
  let entry;
  try {
    const result = await extractor.extract(transcript);
    writeFileSync(resultPath, `${JSON.stringify(result.fields, null, 2)}\n`);
    entry = { slug, status: "ok", wallMs: Date.now() - t0, ...delta(snapshot(chat.stats), before) };
  } catch (error) {
    entry = {
      slug,
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 400) : String(error),
      wallMs: Date.now() - t0,
      ...delta(snapshot(chat.stats), before),
    };
  }
  manifest.transcripts.push(entry);
  console.log(
    `  ${slug}: ${entry.status} calls=${entry.calls} in=${entry.promptTokens} out=${entry.completionTokens} ${(entry.wallMs / 1000).toFixed(1)}s` +
      (entry.error ? ` — ${entry.error}` : ""),
  );
}

manifest.finishedAt = new Date().toISOString();
manifest.wallMs = Date.now() - runStarted;
manifest.totals = snapshot(chat.stats);
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const ok = manifest.transcripts.filter((t) => t.status === "ok").length;
console.log(
  `\n[run] ${ok}/${manifest.transcripts.length} completed | calls ${chat.stats.calls} ` +
    `(${chat.stats.failures} failed) | in ${chat.stats.promptTokens} out ${chat.stats.completionTokens} ` +
    `| cacheRead ${chat.stats.cachedPromptTokens} cacheWrite ${chat.stats.cacheCreationPromptTokens} ` +
    `| largest schema sent ${chat.stats.maxSchemaChars} chars | wall ${(manifest.wallMs / 60000).toFixed(1)} min`,
);
console.log(`[run] score it: node docs/spikes/0001-extraction-snuggpro/score.mjs ${outDir}`);
