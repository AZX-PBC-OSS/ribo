#!/usr/bin/env node
/**
 * Main harness for the matched-schema-scale spike.
 *
 * Runs four arms (A–D) over a Manual J document with a 126-leaf matched schema,
 * several runs per arm, and writes aggregate scores to stdout plus raw results
 * to untracked files under _runs/.
 *
 *   node spikes/matched-schema-scale/harness.mjs [options]
 *
 * Options:
 *   --runs <n>          Runs per arm (default: 3)
 *   --arm <A|B|C|D>     Run only one arm
 *   --pdf <path>        PDF path (default: Quote 4 Wrightsoft)
 *   --model <id>        Claude model for arms B/C/D (default: claude-haiku-4-5)
 *   --help              Show this help
 *
 * Raw extractions, OCR markdown, and per-run details go to _runs/ (gitignored).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUNS_DIR = join(HERE, "_runs");
const PDF_DEFAULT =
  "/Users/ekongiy/Downloads/Turnkey Tech Review Doc Examples/Quote 4 - Manual J (Wrightsoft) - Final.pdf";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let runs = 3;
let armFilter = null;
let pdfPath = PDF_DEFAULT;
let model = "claude-haiku-4-5";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--runs") runs = parseInt(args[++i], 10);
  else if (args[i] === "--arm") armFilter = args[++i];
  else if (args[i] === "--pdf") pdfPath = args[++i];
  else if (args[i] === "--model") model = args[++i];
  else if (args[i] === "--help") {
    console.log(`Usage: node harness.mjs [--runs N] [--arm A|B|C|D] [--pdf PATH] [--model ID]`);
    process.exit(0);
  }
}

mkdirSync(RUNS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { mistralOcr, mistralNative, extractMarkdown, anthropicChat } from "./api.mjs";
import {
  buildEnvelopedJsonSchema,
  buildPartTargets,
  mistralAnnotationPrompt,
  flattenLeaves,
  totalLeaves,
  leavesPerPart,
  MANUAL_J_PARTS,
} from "./envelop.mjs";
import { scoreExtraction } from "./score.mjs";
import { gapFill, ungroundedRetry } from "./retries.mjs";
import { singleShotExtractor } from "../../packages/ribo-extractor-openai/dist/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function saveRun(name, data) {
  const path = join(RUNS_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function parseAnnotation(ann) {
  if (typeof ann === "string") return JSON.parse(ann);
  return ann;
}

function costFromTokens(tokens, prices) {
  if (!tokens) return 0;
  return ((tokens.in || 0) * prices.in + (tokens.out || 0) * prices.out) / 1e6;
}

const CLAUDE_PRICES = { in: 1.0, out: 5.0 };

// ---------------------------------------------------------------------------
// Shared OCR — get Mistral markdown once (arm A gets its own from the native call)
// ---------------------------------------------------------------------------
let sharedMarkdown = null;
let sharedOcrElapsed = 0;

async function getSharedMarkdown() {
  if (sharedMarkdown) return { markdown: sharedMarkdown, elapsed: sharedOcrElapsed };
  console.log("  [shared] Mistral OCR...");
  const { json, elapsed } = await mistralOcr(pdfPath);
  sharedMarkdown = extractMarkdown(json);
  sharedOcrElapsed = elapsed;
  return { markdown: sharedMarkdown, elapsed: sharedOcrElapsed };
}

// ---------------------------------------------------------------------------
// Arm A — native, whole schema, one call
// ---------------------------------------------------------------------------
async function runArmA(runIdx) {
  console.log(`  [A] Mistral native (run ${runIdx + 1})...`);
  const schema = buildEnvelopedJsonSchema();
  const prompt = mistralAnnotationPrompt();

  const t0 = Date.now();
  const { json, elapsed } = await mistralNative(pdfPath, schema, prompt);
  const wallS = (Date.now() - t0) / 1000;

  const markdown = extractMarkdown(json);
  const annotation = parseAnnotation(json.document_annotation);
  const leaves = flattenLeaves(annotation);
  const score = scoreExtraction(leaves, markdown);

  const usage = json.usage_info || {};
  const cost = 0; // Mistral cost not directly available; tracked by latency

  saveRun(`A-run${runIdx}`, {
    arm: "A",
    run: runIdx,
    elapsed_s: elapsed,
    wall_s: wallS,
    score,
    usage,
    cost_usd: cost,
  });

  return {
    arm: "A",
    run: runIdx,
    elapsed_s: elapsed,
    wall_s: wallS,
    grounded: score.counts.grounded,
    nearMiss: score.counts.nearMiss,
    ungrounded: score.counts.ungrounded,
    abstained: score.counts.abstained,
    filled: score.filled,
    groundedPct: score.groundedPct,
    cost_usd: cost,
    annotation,
    markdown,
    leaves,
    scoreDetails: score.details,
  };
}

// ---------------------------------------------------------------------------
// Arm B — flatten-then-extract (Mistral OCR → singleShotExtractor per part, parallel)
// ---------------------------------------------------------------------------
// Uses `singleShotExtractor` from `@azx/ribo-extractor-openai` — Ribo's own
// extractor — one call per Manual J part, 4 in parallel.  This mirrors what
// the existing baseline did (4 routed calls, parallel, 64s wall).
//
// `perGroupExtractor` was the first choice but `splitExtractionSchema` falls
// back to a single non-grouped call for this schema because `isGroupObject`
// requires every property of a group to be a `ZodObject`, and
// `extraction_notes.unreadable_or_ambiguous` is a `z.array(extractedSchema(
// z.string()))` — an array of envelopes, not a nested object — which makes
// `isGroupObject` return false and collapses the split to one entry.
async function runArmB(runIdx) {
  console.log(`  [B] singleShotExtractor x4 + Claude (run ${runIdx + 1})...`);
  const { markdown, elapsed: ocrElapsed } = await getSharedMarkdown();

  const targets = buildPartTargets();
  const chat = anthropicChat({ model });

  // Build 4 extractors, one per part
  const extractors = {};
  for (const part of MANUAL_J_PARTS) {
    extractors[part] = singleShotExtractor({
      target: targets[part],
      chat,
      model,
      maxTokens: 16000,
    });
  }

  const t0 = Date.now();
  // Run all 4 in parallel, with per-part retry on schema parse failure
  const results = await Promise.all(
    MANUAL_J_PARTS.map(async (part) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await extractors[part].extract(markdown);
          return { part, result };
        } catch (err) {
          if (attempt < 2) {
            console.log(
              `    [B] ${part} attempt ${attempt + 1} failed: ${err.message.slice(0, 100)}, retrying...`,
            );
            await new Promise((r) => setTimeout(r, 1000));
          } else {
            console.log(`    [B] ${part} failed after 3 attempts: ${err.message.slice(0, 100)}`);
            return { part, error: err.message };
          }
        }
      }
    }),
  );
  const wallS = (Date.now() - t0) / 1000;

  // Merge into one object
  const merged = {};
  let totalCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  for (const { part, result } of results) {
    merged[part] = result.fields;
    totalCalls += result.usage.calls || 1;
    totalPromptTokens += result.usage.promptTokens || 0;
    totalCompletionTokens += result.usage.completionTokens || 0;
  }

  const leaves = flattenLeaves(merged);
  const score = scoreExtraction(leaves, markdown);

  const tokens = { in: totalPromptTokens, out: totalCompletionTokens };
  const cost = costFromTokens(tokens, CLAUDE_PRICES);

  saveRun(`B-run${runIdx}`, {
    arm: "B",
    run: runIdx,
    wall_s: wallS,
    ocr_elapsed_s: ocrElapsed,
    calls: totalCalls,
    tokens,
    cost_usd: cost,
    score,
  });

  return {
    arm: "B",
    run: runIdx,
    wall_s: wallS,
    ocrElapsed_s: ocrElapsed,
    calls: totalCalls,
    tokens,
    cost_usd: cost,
    grounded: score.counts.grounded,
    nearMiss: score.counts.nearMiss,
    ungrounded: score.counts.ungrounded,
    abstained: score.counts.abstained,
    filled: score.filled,
    groundedPct: score.groundedPct,
    fields: merged,
    markdown,
    leaves,
    scoreDetails: score.details,
  };
}

// ---------------------------------------------------------------------------
// Arm C — B plus gap-fill
// ---------------------------------------------------------------------------
async function runArmC(runIdx) {
  console.log(`  [C] perGroupExtractor + gap-fill (run ${runIdx + 1})...`);
  const bResult = await runArmB(runIdx);
  const chat = anthropicChat({ model });

  // Build a mini-schema for just the abstained paths
  const buildSchemaForPaths = (paths) => {
    // Build a simple object schema with just those paths
    const schema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
    const leafEnvelope = {
      type: "object",
      properties: {
        value: { type: ["string", "null"] },
        confidence: { type: "number" },
        sourceSpan: { type: ["string", "null"] },
      },
      required: ["value", "confidence", "sourceSpan"],
      additionalProperties: false,
    };
    for (const p of paths) {
      // Convert dot path to nested object
      const parts = p.split(".");
      let cur = schema;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur.properties[parts[i]]) {
          cur.properties[parts[i]] = {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          };
          cur.required.push(parts[i]);
        }
        cur = cur.properties[parts[i]];
      }
      cur.properties[parts[parts.length - 1]] = structuredClone(leafEnvelope);
      cur.required.push(parts[parts.length - 1]);
    }
    return { schema, prompt: "" };
  };

  const gfResult = await gapFill(
    bResult.fields,
    bResult.leaves,
    bResult.markdown,
    chat,
    model,
    buildSchemaForPaths,
  );

  // Re-score the merged result
  const mergedLeaves = flattenLeaves(gfResult.merged);
  const score = scoreExtraction(mergedLeaves, bResult.markdown);

  const totalTokens = {
    in: (bResult.tokens?.in || 0) + (gfResult.tokens?.in || 0),
    out: (bResult.tokens?.out || 0) + (gfResult.tokens?.out || 0),
  };
  const totalCost = bResult.cost_usd + costFromTokens(gfResult.tokens, CLAUDE_PRICES);
  const totalWall = bResult.wall_s + (gfResult.elapsed || 0);

  saveRun(`C-run${runIdx}`, {
    arm: "C",
    run: runIdx,
    wall_s: totalWall,
    base_wall_s: bResult.wall_s,
    gapfill_elapsed_s: gfResult.elapsed,
    base_calls: bResult.calls,
    gapfill_calls: gfResult.calls,
    tokens: totalTokens,
    cost_usd: totalCost,
    gapfill: {
      recovered: gfResult.recovered,
      grounded: gfResult.grounded,
      stillNull: gfResult.stillNull,
    },
    leaves: mergedLeaves.length,
    score,
  });

  return {
    arm: "C",
    run: runIdx,
    wall_s: totalWall,
    base_wall_s: bResult.wall_s,
    gapfill_elapsed_s: gfResult.elapsed,
    calls: (bResult.calls || 0) + (gfResult.calls || 0),
    tokens: totalTokens,
    cost_usd: totalCost,
    gapfill_recovered: gfResult.recovered,
    gapfill_grounded: gfResult.grounded,
    gapfill_still_null: gfResult.stillNull,
    leaves: mergedLeaves.length,
    grounded: score.counts.grounded,
    nearMiss: score.counts.nearMiss,
    ungrounded: score.counts.ungrounded,
    abstained: score.counts.abstained,
    filled: score.filled,
    groundedPct: score.groundedPct,
    scoreDetails: score.details,
  };
}

// ---------------------------------------------------------------------------
// Arm D — A plus ungrounded-retry
// ---------------------------------------------------------------------------
async function runArmD(runIdx) {
  console.log(`  [D] Mistral native + ungrounded-retry (run ${runIdx + 1})...`);
  const aResult = await runArmA(runIdx);
  const chat = anthropicChat({ model });

  // Build a mini-schema for just the ungrounded paths
  const buildSchemaForPaths = (paths) => {
    const schema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
    const leafEnvelope = {
      type: "object",
      properties: {
        value: { type: ["string", "null"] },
        confidence: { type: "number" },
        sourceSpan: { type: ["string", "null"] },
      },
      required: ["value", "confidence", "sourceSpan"],
      additionalProperties: false,
    };
    for (const p of paths) {
      const parts = p.split(".");
      let cur = schema;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur.properties[parts[i]]) {
          cur.properties[parts[i]] = {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          };
          cur.required.push(parts[i]);
        }
        cur = cur.properties[parts[i]];
      }
      cur.properties[parts[parts.length - 1]] = structuredClone(leafEnvelope);
      cur.required.push(parts[parts.length - 1]);
    }
    return { schema, prompt: "" };
  };

  const retryResult = await ungroundedRetry(
    aResult.leaves,
    aResult.markdown,
    chat,
    model,
    buildSchemaForPaths,
  );

  const totalWall = aResult.wall_s + (retryResult.elapsed || 0);
  // Total cost = Mistral cost (tracked by latency) + Claude retry cost
  const retryCost = costFromTokens(retryResult.tokens, CLAUDE_PRICES);

  saveRun(`D-run${runIdx}`, {
    arm: "D",
    run: runIdx,
    wall_s: totalWall,
    base_wall_s: aResult.wall_s,
    retry_elapsed_s: retryResult.elapsed,
    retry: {
      ungrounded_count: retryResult.converted + retryResult.stayedWrong,
      converted_to_grounded: retryResult.grounded,
      converted_to_null: retryResult.toNull,
      stayed_wrong: retryResult.stayedWrong,
    },
    retry_tokens: retryResult.tokens,
    retry_cost_usd: retryCost,
    leaves: aResult.leaves.length,
    baseScore: {
      grounded: aResult.grounded,
      nearMiss: aResult.nearMiss,
      ungrounded: aResult.ungrounded,
      abstained: aResult.abstained,
      filled: aResult.filled,
      groundedPct: aResult.groundedPct,
    },
  });

  return {
    arm: "D",
    run: runIdx,
    wall_s: totalWall,
    base_wall_s: aResult.wall_s,
    retry_elapsed_s: retryResult.elapsed,
    retry_converted: retryResult.converted,
    retry_grounded: retryResult.grounded,
    retry_to_null: retryResult.toNull,
    retry_stayed_wrong: retryResult.stayedWrong,
    retry_cost_usd: retryCost,
    retry_tokens: retryResult.tokens,
    leaves: aResult.leaves.length,
    // Base arm A scores
    grounded: aResult.grounded,
    nearMiss: aResult.nearMiss,
    ungrounded: aResult.ungrounded,
    abstained: aResult.abstained,
    filled: aResult.filled,
    groundedPct: aResult.groundedPct,
    // After retry: ungrounded - converted_to_grounded - converted_to_null
    post_retry_grounded: aResult.grounded + retryResult.grounded,
    post_retry_ungrounded: retryResult.stayedWrong,
    post_retry_abstained: aResult.abstained + retryResult.toNull,
    scoreDetails: aResult.scoreDetails,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Matched Schema Scale Spike ===`);
  console.log(`Document: ${pdfPath.split("/").pop()}`);
  console.log(`Schema: ${totalLeaves()} leaves (${JSON.stringify(leavesPerPart())})`);
  console.log(`Model: ${model}`);
  console.log(`Runs per arm: ${runs}\n`);

  const allResults = [];

  for (let run = 0; run < runs; run++) {
    if (!armFilter || armFilter === "A") {
      const r = await runArmA(run);
      allResults.push(r);
      console.log(
        `    A run ${run + 1}: grounded=${r.grounded} nearMiss=${r.nearMiss} ungrounded=${r.ungrounded} abstained=${r.abstained} filled=${r.filled} groundedPct=${r.groundedPct.toFixed(1)}% elapsed=${r.elapsed_s.toFixed(1)}s`,
      );
    }
  }

  for (let run = 0; run < runs; run++) {
    if (!armFilter || armFilter === "B") {
      const r = await runArmB(run);
      allResults.push(r);
      console.log(
        `    B run ${run + 1}: grounded=${r.grounded} nearMiss=${r.nearMiss} ungrounded=${r.ungrounded} abstained=${r.abstained} filled=${r.filled} groundedPct=${r.groundedPct.toFixed(1)}% wall=${r.wall_s.toFixed(1)}s cost=$${r.cost_usd.toFixed(4)}`,
      );
    }
  }

  for (let run = 0; run < runs; run++) {
    if (!armFilter || armFilter === "C") {
      const r = await runArmC(run);
      allResults.push(r);
      console.log(
        `    C run ${run + 1}: grounded=${r.grounded} nearMiss=${r.nearMiss} ungrounded=${r.ungrounded} abstained=${r.abstained} filled=${r.filled} groundedPct=${r.groundedPct.toFixed(1)}% wall=${r.wall_s.toFixed(1)}s cost=$${r.cost_usd.toFixed(4)} gapfill_recovered=${r.gapfill_recovered}`,
      );
    }
  }

  for (let run = 0; run < runs; run++) {
    if (!armFilter || armFilter === "D") {
      const r = await runArmD(run);
      allResults.push(r);
      console.log(
        `    D run ${run + 1}: base_grounded=${r.grounded} base_ungrounded=${r.ungrounded} retry_grounded=${r.retry_grounded} retry_toNull=${r.retry_to_null} retry_stayedWrong=${r.retry_stayed_wrong} wall=${r.wall_s.toFixed(1)}s retry_cost=$${r.retry_cost_usd.toFixed(4)}`,
      );
    }
  }

  // Summary
  console.log(`\n=== Summary ===\n`);
  const arms = ["A", "B", "C", "D"];
  for (const arm of arms) {
    if (armFilter && armFilter !== arm) continue;
    const armResults = allResults.filter((r) => r.arm === arm);
    if (armResults.length === 0) continue;
    console.log(`Arm ${arm}:`);
    for (const r of armResults) {
      if (arm === "A") {
        console.log(
          `  run ${r.run + 1}: G=${r.grounded} NM=${r.nearMiss} U=${r.ungrounded} Ab=${r.abstained} filled=${r.filled} pct=${r.groundedPct.toFixed(1)}% t=${r.elapsed_s.toFixed(1)}s`,
        );
      } else if (arm === "B") {
        console.log(
          `  run ${r.run + 1}: G=${r.grounded} NM=${r.nearMiss} U=${r.ungrounded} Ab=${r.abstained} filled=${r.filled} pct=${r.groundedPct.toFixed(1)}% t=${r.wall_s.toFixed(1)}s $${r.cost_usd.toFixed(4)} calls=${r.calls}`,
        );
      } else if (arm === "C") {
        console.log(
          `  run ${r.run + 1}: G=${r.grounded} NM=${r.nearMiss} U=${r.ungrounded} Ab=${r.abstained} filled=${r.filled} pct=${r.groundedPct.toFixed(1)}% t=${r.wall_s.toFixed(1)}s $${r.cost_usd.toFixed(4)} recovered=${r.gapfill_recovered}`,
        );
      } else if (arm === "D") {
        console.log(
          `  run ${r.run + 1}: base G=${r.grounded} U=${r.ungrounded} | retry→G=${r.retry_grounded} →null=${r.retry_to_null} stayed=${r.retry_stayed_wrong} | post G=${r.post_retry_grounded} U=${r.post_retry_ungrounded} t=${r.wall_s.toFixed(1)}s $${r.retry_cost_usd.toFixed(4)}`,
        );
      }
    }
    // Averages
    const avg = (key) => armResults.reduce((s, r) => s + (r[key] || 0), 0) / armResults.length;
    console.log(
      `  avg: groundedPct=${avg("groundedPct").toFixed(1)}% filled=${avg("filled").toFixed(0)}\n`,
    );
  }

  // Save aggregate
  const summary = arms
    .map((arm) => {
      if (armFilter && armFilter !== arm) return null;
      const rs = allResults.filter((r) => r.arm === arm);
      if (rs.length === 0) return null;
      return {
        arm,
        runs: rs.map((r) => ({
          run: r.run,
          grounded: r.grounded,
          nearMiss: r.nearMiss,
          ungrounded: r.ungrounded,
          abstained: r.abstained,
          filled: r.filled,
          groundedPct: parseFloat(r.groundedPct.toFixed(1)),
          elapsed_s: parseFloat((r.elapsed_s || r.wall_s || 0).toFixed(1)),
          cost_usd: parseFloat((r.cost_usd || r.retry_cost_usd || 0).toFixed(4)),
        })),
      };
    })
    .filter(Boolean);

  saveRun("_summary", { model, pdf: pdfPath.split("/").pop(), leaves: totalLeaves(), summary });
  console.log(`\nDetailed results saved to ${RUNS_DIR}/`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
