#!/usr/bin/env node
/**
 * Structured search-plan extraction pipeline runner (spike).
 *
 *   node run-pipeline.mjs <codex|opencode> [slug-substring]
 *
 * Three LLM nodes per transcript, all leak-safe by construction (NEVER reads
 * ground-truth/):
 *
 *   Node 1 PLAN   : prompts/plan.md   + schema.ts + transcript  -> {targets:[...]}
 *   Node 2 LOCATE : prompts/locate.md + targets   + transcript  -> {located:[...]}
 *   Node 3 DECIDE : prompts/decide.md + schema.ts + located spans (NO transcript) -> SnuggFields JSON
 *
 * Between LOCATE and DECIDE a DETERMINISTIC verbatim gate drops any located span
 * that is not a character-for-character substring of the transcript. This is the
 * design's grounding guarantee: DECIDE can only ever see real quotes.
 *
 * SAFETY: both CLIs run with cwd = an out-of-repo temp dir, stdin closed. codex
 * gets --skip-git-repo-check --sandbox read-only. Output is parsed by taking the
 * last balanced top-level JSON object (CLIs print noise around the JSON).
 *
 * RESUMABILITY: every node writes its raw output to results/<model>/<slug>/ and is
 * skipped if that file already exists. Runs are long; re-invoke to continue.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNUGG = join(HERE, "..", "extraction-snuggpro"); // read-only source of schema + transcripts
const SAFE_CWD = tmpdir(); // OUTSIDE the repo — agentic CLIs must not roam the repo

const model = process.argv[2];
const only = process.argv[3] ?? "";
if (!["codex", "opencode"].includes(model)) {
  console.error("usage: run-pipeline.mjs <codex|opencode> [slug-substring]");
  process.exit(1);
}

const schemaTs = readFileSync(join(SNUGG, "schema.ts"), "utf8");

/** From a prompt.md file take everything from "## System" down (human header stripped). */
function systemBody(file) {
  const md = readFileSync(join(HERE, "prompts", file), "utf8");
  const i = md.indexOf("## System");
  if (i === -1) throw new Error(`no "## System" in ${file}`);
  return md.slice(i);
}
const PLAN = systemBody("plan.md");
const LOCATE = systemBody("locate.md");
const DECIDE = systemBody("decide.md");

/** Pull the last balanced top-level JSON object from noisy CLI output. */
function extractJson(out) {
  let depth = 0,
    start = -1,
    best = null,
    inStr = false,
    esc = false;
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
  if (model === "codex") {
    return execFileSync(
      "codex",
      ["exec", "--skip-git-repo-check", "--sandbox", "read-only", prompt],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        cwd: SAFE_CWD,
      },
    );
  }
  return execFileSync("opencode", ["run", prompt], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    cwd: SAFE_CWD,
  });
}

/** Run a node with resumability. Returns {json, raw, cached, seconds}. */
function node(dir, name, prompt) {
  const rawPath = join(dir, `${name}.txt`);
  const jsonPath = join(dir, `${name}.json`);
  if (existsSync(jsonPath)) {
    return { json: JSON.parse(readFileSync(jsonPath, "utf8")), cached: true, seconds: 0 };
  }
  const t0 = Date.now();
  const raw = runModel(prompt);
  const seconds = (Date.now() - t0) / 1000;
  writeFileSync(rawPath, raw);
  const jsonText = extractJson(raw);
  if (!jsonText) throw new Error(`${name}: no JSON in output`);
  const json = JSON.parse(jsonText);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2) + "\n");
  return { json, raw, cached: false, seconds };
}

/** Deterministic verbatim gate: keep only spans that are exact substrings of the transcript. */
function gateSpans(located, transcript) {
  const kept = [];
  let dropped = 0;
  for (const row of located.located ?? []) {
    const field = row.field;
    const spans = (row.spans ?? []).filter((s) => typeof s === "string" && transcript.includes(s));
    dropped += (row.spans ?? []).length - spans.length;
    if (spans.length) kept.push({ field, spans });
  }
  return { located: kept, dropped };
}

const files = readdirSync(join(SNUGG, "transcripts"))
  .filter((f) => f.endsWith(".txt") && f.includes(only))
  .sort();

const timing = [];
for (const f of files) {
  const slug = f.replace(/\.txt$/, "");
  const transcript = readFileSync(join(SNUGG, "transcripts", f), "utf8");
  const dir = join(HERE, "results", model, slug);
  mkdirSync(dir, { recursive: true });
  const finalPath = join(HERE, "results", model, `${slug}.json`);

  try {
    // Node 1 — PLAN
    const plan = node(
      dir,
      "plan",
      `${PLAN}\n\n# schema.ts\n\n\`\`\`ts\n${schemaTs}\n\`\`\`\n\n${transcript}\n`,
    );

    // Node 2 — LOCATE
    const targetsJson = JSON.stringify(plan.json, null, 2);
    const locate = node(
      dir,
      "locate",
      `${LOCATE}\n\n# Targets from the PLAN stage\n\n\`\`\`json\n${targetsJson}\n\`\`\`\n\n${transcript}\n`,
    );

    // Deterministic verbatim gate (design guarantee: DECIDE sees only real quotes).
    const gated = gateSpans(locate.json, transcript);
    writeFileSync(join(dir, "gated.json"), JSON.stringify(gated, null, 2) + "\n");

    // Node 3 — DECIDE (NO transcript; only the gated spans + schema)
    const evidenceJson = JSON.stringify({ located: gated.located }, null, 2);
    const decide = node(
      dir,
      "decide",
      `${DECIDE}\n\n# schema.ts\n\n\`\`\`ts\n${schemaTs}\n\`\`\`\n\n# Located evidence spans\n\n\`\`\`json\n${evidenceJson}\n\`\`\`\n`,
    );

    // The scored artifact is the DECIDE output.
    writeFileSync(finalPath, JSON.stringify(decide.json, null, 2) + "\n");

    const secs = plan.seconds + locate.seconds + decide.seconds;
    timing.push({
      slug,
      plan: plan.seconds,
      locate: locate.seconds,
      decide: decide.seconds,
      total: secs,
      spansDropped: gated.dropped,
    });
    console.log(
      `[${model}] ok   ${slug}  plan=${plan.seconds.toFixed(0)}s locate=${locate.seconds.toFixed(0)}s decide=${decide.seconds.toFixed(0)}s  gated-out=${gated.dropped}` +
        (plan.cached && locate.cached && decide.cached ? " (all cached)" : ""),
    );
  } catch (e) {
    console.log(`[${model}] ERR  ${slug}: ${e.message.split("\n")[0]}`);
  }
}

// Append timing to a per-model log (merge with any prior partial runs).
const timingPath = join(HERE, "results", `${model}-timing.json`);
let prior = [];
if (existsSync(timingPath)) prior = JSON.parse(readFileSync(timingPath, "utf8"));
const bySlug = new Map(prior.map((r) => [r.slug, r]));
for (const t of timing) if (t.total > 0) bySlug.set(t.slug, t); // only overwrite with real (non-cached) timings
writeFileSync(
  timingPath,
  JSON.stringify(
    [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    null,
    2,
  ) + "\n",
);
console.log(`[${model}] done`);
