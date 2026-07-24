#!/usr/bin/env node
/**
 * Phase 3 Task 4 — Part B extraction runner. Same blind-extraction path as the extraction spike's
 * runner, but the transcript text is sourced from the ON-DEVICE Whisper output (Part A) instead of
 * the clean authored text. NEVER touches ground-truth/ — leak-safe by construction. Feeds each
 * on-device transcript + prompt.md + schema.ts to a model CLI and captures the JSON.
 *
 *   node spikes/transcription-measurement/extract-ondevice.mjs <codex|opencode> <modelSlug>
 *   # modelSlug e.g. whisper-base.en  (reads results/ondevice/whisper-base.en/*.txt)
 *
 * Output: results/extract/<modelSlug>/<codex|opencode>/<slug>.json
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPIKE = join(HERE, "..", "extraction-snuggpro");

const extractor = process.argv[2];
const modelSlug = process.argv[3];
if (!["codex", "opencode"].includes(extractor) || !modelSlug) {
  console.error("usage: extract-ondevice.mjs <codex|opencode> <modelSlug>");
  process.exit(1);
}

const srcDir = join(HERE, "results", "ondevice", modelSlug);
const outDir = join(HERE, "results", "extract", modelSlug, extractor);
mkdirSync(outDir, { recursive: true });

const promptMd = readFileSync(join(SPIKE, "prompt.md"), "utf8");
const schemaTs = readFileSync(join(SPIKE, "schema.ts"), "utf8");
const sysIdx = promptMd.indexOf("## System");
const body = promptMd.slice(sysIdx);
const tIdx = body.indexOf("### Transcript");
const head = body.slice(0, tIdx);
const tail = body.slice(tIdx);

function buildPrompt(transcript) {
  return `${head}\n\n# schema.ts\n\n\`\`\`ts\n${schemaTs}\n\`\`\`\n\n${tail}\n\n${transcript}\n`;
}

function extractJson(out) {
  let depth = 0;
  let start = -1;
  let best = null;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) best = out.slice(start, i + 1);
    }
  }
  return best;
}

function runModel(prompt) {
  if (extractor === "codex") {
    return execFileSync(
      "codex",
      ["exec", "--skip-git-repo-check", "--sandbox", "read-only", prompt],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        cwd: "/tmp",
      },
    );
  }
  // cwd:/tmp — opencode `run` is agentic and will explore its working directory; keeping it OUT of
  // the repo prevents it from reading ground-truth or the committed clean baseline (a blind-test
  // leak), and matches how the extraction spike's baseline runner was invoked (a non-repo tmp dir).
  return execFileSync("opencode", ["run", prompt], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    cwd: "/tmp",
  });
}

// Only the hinted on-device transcripts (production config); skip the .unhinted.txt variants.
const files = readdirSync(srcDir)
  .filter((f) => f.endsWith(".txt") && !f.endsWith(".unhinted.txt"))
  .sort();
for (const f of files) {
  const outPath = join(outDir, f.replace(/\.txt$/, ".json"));
  if (existsSync(outPath)) {
    console.log(`[${extractor}/${modelSlug}] skip ${f} (exists)`);
    continue;
  }
  const transcript = readFileSync(join(srcDir, f), "utf8");
  const t0 = Date.now();
  try {
    const raw = runModel(buildPrompt(transcript));
    const json = extractJson(raw);
    if (!json) {
      console.log(`[${extractor}/${modelSlug}] FAIL ${f}: no JSON`);
      writeFileSync(`${outPath}.raw`, raw);
      continue;
    }
    JSON.parse(json);
    writeFileSync(outPath, `${json}\n`);
    console.log(`[${extractor}/${modelSlug}] ok ${f} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (e) {
    console.log(`[${extractor}/${modelSlug}] ERR ${f}: ${e.message.split("\n")[0]}`);
  }
}
console.log(`[${extractor}/${modelSlug}] done`);
