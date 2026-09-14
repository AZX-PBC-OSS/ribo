#!/usr/bin/env node
/**
 * Fair-fight harness — re-runs the matched-schema-scale comparison with the
 * prompt asymmetry removed.
 *
 * Changes from the original harness (everything else stays constant):
 *
 *   1. Arm A gets the pinned span instruction (the wording that produced 95.8%
 *      verbatim-span rate on Mistral in the prior spike) instead of the
 *      compressed `document_annotation_prompt`.
 *   2. Arm B gets the same pinned span instruction appended to each part's
 *      existing system prompt, so both arms have a comparably invested span
 *      rule.
 *   3. Scoring uses `spanGroundedness` from `@azx/ribo-core` (the real
 *      three-tier function) instead of `isSpanGrounded` + a custom near-miss
 *      classifier.
 *   4. Five runs per arm (up from three).
 *   5. Tries passing `temperature: 0` to the Mistral endpoint.
 *   6. Reports figures both with and without `extraction_notes.confidence`
 *      excluded.
 *
 * Raw extractions, OCR markdown, and per-run details go to _runs/ (gitignored).
 *
 *   node spikes/matched-schema-scale/fair-fight/harness.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Parent harness imports — reuse, do not rebuild
// ---------------------------------------------------------------------------
import { mistralOcr, extractMarkdown, anthropicChat } from "../api.mjs";
import {
  buildEnvelopedJsonSchema,
  buildPartTargets,
  flattenLeaves,
  totalLeaves,
  leavesPerPart,
  MANUAL_J_PARTS,
  PARTS,
} from "../envelop.mjs";
import { scoreExtraction } from "./score.mjs";
import { singleShotExtractor } from "../../../packages/ribo-extractor-openai/dist/index.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUNS_DIR = join(HERE, "_runs");
const PDF_PATH =
  "/Users/ekongiy/Downloads/Turnkey Tech Review Doc Examples/Quote 4 - Manual J (Wrightsoft) - Final.pdf";
const ENV_PATH = "/Users/ekongiy/projects/azx/ribo/.env.local";
const MODEL = "claude-haiku-4-5";

mkdirSync(RUNS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Env + Mistral URL (duplicated from api.mjs because fetchWithRetry is not
// exported — only used for the temperature test and arm A calls with temp)
// ---------------------------------------------------------------------------
function loadEnv() {
  const text = readFileSync(ENV_PATH, "utf-8");
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const ENV = loadEnv();
const API_KEY = ENV.AZURE_AI_FOUNDRY_API_KEY;
const ANTHROPIC_BASE = ENV.AZURE_AI_FOUNDRY_ANTHROPIC_BASE_URL;

function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

const MISTRAL_ORIGIN = originOf(ANTHROPIC_BASE);
const MISTRAL_URL = `${MISTRAL_ORIGIN}/providers/mistral/azure/ocr?api-version=2024-05-01-preview`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetryFair(url, body, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": API_KEY },
        body: JSON.stringify(body),
      });
      const elapsed = (Date.now() - t0) / 1000;
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(`Mistral API ${res.status}: ${detail.slice(0, 500)}`);
        err.status = res.status;
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw err;
      }
      const json = await res.json();
      return { json, elapsed };
    } catch (err) {
      if (err.status) throw err;
      lastErr = err;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function mistralNativeFair(pdfPath, envelopedJsonSchema, prompt, temperature) {
  const pdfBytes = readFileSync(pdfPath);
  const b64 = pdfBytes.toString("base64");
  const body = {
    model: "mistral-document-ai-2512",
    document: {
      type: "document_url",
      document_url: `data:application/pdf;base64,${b64}`,
    },
    document_annotation_format: {
      type: "json_schema",
      json_schema: { name: "manual-j-extraction", strict: true, schema: envelopedJsonSchema },
    },
    document_annotation_prompt: prompt,
  };
  if (temperature !== undefined) body.temperature = temperature;
  return fetchWithRetryFair(MISTRAL_URL, body);
}

// ---------------------------------------------------------------------------
// Pinned span instruction — the wording from the prior spike that produced
// 95.8% verbatim-span rate on Mistral across five runs.
// ---------------------------------------------------------------------------
const PINNED_SPAN_ARM_A = [
  "A sourceSpan MUST be a contiguous substring copied character-for-character out of the page markdown you produce for this document. It is pasted, not written.",
  "",
  "- If the value sits in a table, copy the ENTIRE table row verbatim, pipes and spacing included",
  "- If the value sits in running text, copy the exact phrase around it",
  "- NEVER build a span by joining a label to a value unless those characters appear adjacently",
  "- NEVER reformat, re-space, re-order, abbreviate or summarise a span",
  "- If you cannot find text you can copy exactly, set sourceSpan to null. A null span is correct and useful; an invented one is a failure.",
  "",
  "Before returning, re-read each sourceSpan and confirm it appears verbatim in the markdown.",
].join("\n");

const PINNED_SPAN_ARM_B = [
  "A sourceSpan MUST be a contiguous substring copied character-for-character out of the document text provided to you. It is pasted, not written.",
  "",
  "- If the value sits in a table, copy the ENTIRE table row verbatim, pipes and spacing included",
  "- If the value sits in running text, copy the exact phrase around it",
  "- NEVER build a span by joining a label to a value unless those characters appear adjacently",
  "- NEVER reformat, re-space, re-order, abbreviate or summarise a span",
  "- If you cannot find text you can copy exactly, set sourceSpan to null. A null span is correct and useful; an invented one is a failure.",
  "",
  "Before returning, re-read each sourceSpan and confirm it appears verbatim in the document text.",
].join("\n");

function pinnedPromptArmA() {
  return (
    MANUAL_J_PARTS.map((p) => PARTS[p].system).join("\n\n---\n\n") +
    "\n\n---\n\n" +
    "For every field, provide:\n" +
    "- value: the verbatim value from the document, or null if not stated\n" +
    "- confidence: your confidence score (0.0 to 1.0)\n" +
    "- sourceSpan: the verbatim quote from the document text that justifies this value, or null\n\n" +
    PINNED_SPAN_ARM_A
  );
}

function buildPartTargetsFair() {
  const targets = buildPartTargets();
  for (const part of MANUAL_J_PARTS) {
    targets[part].instructions = targets[part].instructions + "\n\n---\n\n" + PINNED_SPAN_ARM_B;
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function saveRun(name, data) {
  writeFileSync(join(RUNS_DIR, `${name}.json`), JSON.stringify(data, null, 2));
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
// Shared OCR
// ---------------------------------------------------------------------------
let sharedMarkdown = null;
let sharedOcrElapsed = 0;

async function getSharedMarkdown() {
  if (sharedMarkdown) return { markdown: sharedMarkdown, elapsed: sharedOcrElapsed };
  console.log("  [shared] Mistral OCR...");
  const { json, elapsed } = await mistralOcr(PDF_PATH);
  sharedMarkdown = extractMarkdown(json);
  sharedOcrElapsed = elapsed;
  return { markdown: sharedMarkdown, elapsed: sharedOcrElapsed };
}

// ---------------------------------------------------------------------------
// Arm A — Mistral native with pinned span instruction
// ---------------------------------------------------------------------------
let temperatureState = "untested"; // "untested" | "accepted" | "rejected"
let temperatureError = null;

async function runArmA(runIdx) {
  const useTemp = temperatureState === "accepted" || temperatureState === "untested";
  const tempVal = useTemp ? 0 : undefined;
  console.log(
    `  [A] Mistral native (run ${runIdx + 1})${tempVal !== undefined ? " temp=0" : ""}...`,
  );

  const schema = buildEnvelopedJsonSchema();
  const prompt = pinnedPromptArmA();

  let json, elapsed;
  try {
    const result = await mistralNativeFair(PDF_PATH, schema, prompt, tempVal);
    json = result.json;
    elapsed = result.elapsed;
    if (temperatureState === "untested") {
      temperatureState = "accepted";
      console.log("  [temp] Temperature 0 ACCEPTED by Mistral API");
    }
  } catch (err) {
    if ((err.status === 400 || err.status === 422) && temperatureState === "untested") {
      temperatureState = "rejected";
      temperatureError = err.message;
      console.log(`  [temp] Temperature REJECTED: ${err.message.slice(0, 300)}`);
      // Retry without temperature
      const result = await mistralNativeFair(PDF_PATH, schema, prompt, undefined);
      json = result.json;
      elapsed = result.elapsed;
    } else {
      throw err;
    }
  }

  const markdown = extractMarkdown(json);
  const annotation = parseAnnotation(json.document_annotation);
  const leaves = flattenLeaves(annotation);
  const score = scoreExtraction(leaves, markdown);

  const usage = json.usage_info || {};

  saveRun(`fair-A-run${runIdx}`, {
    arm: "A",
    run: runIdx,
    elapsed_s: elapsed,
    score,
    usage,
    temperatureUsed: tempVal !== undefined,
  });

  return {
    arm: "A",
    run: runIdx,
    elapsed_s: elapsed,
    grounded: score.counts.grounded,
    nearMiss: score.counts.nearMiss,
    ungrounded: score.counts.ungrounded,
    abstained: score.counts.abstained,
    filled: score.filled,
    groundedPct: score.groundedPct,
    groundedExclConf: score.countsExclConf.grounded,
    nearMissExclConf: score.countsExclConf.nearMiss,
    ungroundedExclConf: score.countsExclConf.ungrounded,
    groundedPctExclConf: score.groundedPctExclConf,
    spanScorableExclConf: score.spanScorableExcl,
  };
}

// ---------------------------------------------------------------------------
// Arm B — Mistral OCR → singleShotExtractor x4 with pinned span instruction
// ---------------------------------------------------------------------------
async function runArmB(runIdx) {
  console.log(`  [B] singleShotExtractor x4 + Claude (run ${runIdx + 1})...`);
  const { markdown, elapsed: ocrElapsed } = await getSharedMarkdown();

  const targets = buildPartTargetsFair();
  const chat = anthropicChat({ model: MODEL });

  const extractors = {};
  for (const part of MANUAL_J_PARTS) {
    extractors[part] = singleShotExtractor({
      target: targets[part],
      chat,
      model: MODEL,
      maxTokens: 16000,
    });
  }

  const t0 = Date.now();
  const results = await Promise.all(
    MANUAL_J_PARTS.map(async (part) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await extractors[part].extract({ text: markdown, annotations: {} });
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

  saveRun(`fair-B-run${runIdx}`, {
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
    calls: totalCalls,
    tokens,
    cost_usd: cost,
    grounded: score.counts.grounded,
    nearMiss: score.counts.nearMiss,
    ungrounded: score.counts.ungrounded,
    abstained: score.counts.abstained,
    filled: score.filled,
    groundedPct: score.groundedPct,
    groundedExclConf: score.countsExclConf.grounded,
    nearMissExclConf: score.countsExclConf.nearMiss,
    ungroundedExclConf: score.countsExclConf.ungrounded,
    groundedPctExclConf: score.groundedPctExclConf,
    spanScorableExclConf: score.spanScorableExcl,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const RUNS = 5;

  console.log(`\n=== Fair-Fight Re-Run (Prompt Parity) ===`);
  console.log(`Document: ${PDF_PATH.split("/").pop()}`);
  console.log(`Schema: ${totalLeaves()} leaves (${JSON.stringify(leavesPerPart())})`);
  console.log(`Model: ${MODEL}`);
  console.log(`Runs per arm: ${RUNS}`);
  console.log(`Scoring: spanGroundedness (three-tier) from @azx/ribo-core\n`);

  const allResults = [];

  // Arm A
  for (let run = 0; run < RUNS; run++) {
    const r = await runArmA(run);
    allResults.push(r);
    console.log(
      `    A run ${run + 1}: G=${r.grounded} NM=${r.nearMiss} U=${r.ungrounded} Ab=${r.abstained} ` +
        `filled=${r.filled} pct=${r.groundedPct.toFixed(1)}% ` +
        `| excl conf: G=${r.groundedExclConf} NM=${r.nearMissExclConf} U=${r.ungroundedExclConf} ` +
        `pct=${r.groundedPctExclConf.toFixed(1)}% t=${r.elapsed_s.toFixed(1)}s`,
    );
  }

  // Arm B
  for (let run = 0; run < RUNS; run++) {
    const r = await runArmB(run);
    allResults.push(r);
    console.log(
      `    B run ${run + 1}: G=${r.grounded} NM=${r.nearMiss} U=${r.ungrounded} Ab=${r.abstained} ` +
        `filled=${r.filled} pct=${r.groundedPct.toFixed(1)}% ` +
        `| excl conf: G=${r.groundedExclConf} NM=${r.nearMissExclConf} U=${r.ungroundedExclConf} ` +
        `pct=${r.groundedPctExclConf.toFixed(1)}% wall=${r.wall_s.toFixed(1)}s $${r.cost_usd.toFixed(4)}`,
    );
  }

  // Temperature answer
  console.log(`\n=== Temperature ===`);
  if (temperatureState === "accepted") {
    console.log(`Temperature 0 was ACCEPTED. Arm A ran at temperature 0.`);
  } else if (temperatureState === "rejected") {
    console.log(`Temperature was REJECTED. Error: ${temperatureError?.slice(0, 300)}`);
  } else {
    console.log(`Temperature was not tested (unexpected state).`);
  }

  // Summary
  console.log(`\n=== Summary ===\n`);
  for (const arm of ["A", "B"]) {
    const rs = allResults.filter((r) => r.arm === arm);
    if (rs.length === 0) continue;
    console.log(`Arm ${arm}:`);
    for (const r of rs) {
      console.log(
        `  run ${r.run + 1}: G=${r.grounded} NM=${r.nearMiss} U=${r.ungrounded} Ab=${r.abstained} ` +
          `pct=${r.groundedPct.toFixed(1)}% exclConf=${r.groundedPctExclConf.toFixed(1)}%`,
      );
    }
    const avg = (key) => rs.reduce((s, r) => s + r[key], 0) / rs.length;
    const min = (key) => Math.min(...rs.map((r) => r[key]));
    const max = (key) => Math.max(...rs.map((r) => r[key]));
    console.log(
      `  avg: pct=${avg("groundedPct").toFixed(1)}% exclConf=${avg("groundedPctExclConf").toFixed(1)}% ` +
        `range=[${min("groundedPct").toFixed(1)}%–${max("groundedPct").toFixed(1)}%] filled=${avg("filled").toFixed(0)}\n`,
    );
  }

  // Ribo's own ungrounded rate
  const bResults = allResults.filter((r) => r.arm === "B");
  if (bResults.length > 0) {
    console.log(`Ribo's own ungrounded rate (arm B):`);
    for (const r of bResults) {
      console.log(
        `  run ${r.run + 1}: ungrounded=${r.ungrounded} (excl conf: ${r.ungroundedExclConf}) ` +
          `of spanScorable=${r.grounded + r.nearMiss + r.ungrounded}`,
      );
    }
    const avgU = bResults.reduce((s, r) => s + r.ungrounded, 0) / bResults.length;
    const avgUExcl = bResults.reduce((s, r) => s + r.ungroundedExclConf, 0) / bResults.length;
    console.log(`  avg: ${avgU.toFixed(1)} ungrounded (excl conf: ${avgUExcl.toFixed(1)})\n`);
  }

  // Save aggregate
  const summary = ["A", "B"]
    .map((arm) => {
      const rs = allResults.filter((r) => r.arm === arm);
      if (rs.length === 0) return null;
      return {
        arm,
        temperature: temperatureState,
        runs: rs.map((r) => ({
          run: r.run,
          grounded: r.grounded,
          nearMiss: r.nearMiss,
          ungrounded: r.ungrounded,
          abstained: r.abstained,
          filled: r.filled,
          groundedPct: parseFloat(r.groundedPct.toFixed(1)),
          groundedExclConf: r.groundedExclConf,
          nearMissExclConf: r.nearMissExclConf,
          ungroundedExclConf: r.ungroundedExclConf,
          groundedPctExclConf: parseFloat(r.groundedPctExclConf.toFixed(1)),
          spanScorableExclConf: r.spanScorableExclConf,
          elapsed_s: parseFloat((r.elapsed_s || r.wall_s || 0).toFixed(1)),
          cost_usd: parseFloat((r.cost_usd || 0).toFixed(4)),
        })),
      };
    })
    .filter(Boolean);

  saveRun("_fair-summary", {
    model: MODEL,
    pdf: PDF_PATH.split("/").pop(),
    leaves: totalLeaves(),
    temperature: { state: temperatureState, error: temperatureError },
    summary,
  });

  console.log(`\nDetailed results saved to ${RUNS_DIR}/`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
