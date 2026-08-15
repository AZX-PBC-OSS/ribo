#!/usr/bin/env node
/**
 * Tests for run-extraction.mjs — the corpus comparison harness.
 *
 *   node spikes/extraction-snuggpro/run-extraction.test.mjs
 *
 * "A gate you haven't watched fail isn't a gate." Each test runs the harness
 * against a FAKE ChatClient (no network, no key) and asserts:
 *
 *   1. SHAPE — both strategies write files in the shape `score.mjs` consumes
 *      (7 groups → leaf keys → `{value, confidence, sourceSpan}`), and the
 *      manifest records strategy, model, and per-transcript call count.
 *   2. RESUME — a transcript whose result file already exists is skipped
 *      unless `force` is passed.
 *   3. ISOLATION — one transcript failing does not abort the rest; the failed
 *      transcript gets no result file and is recorded in the manifest, while
 *      every other transcript succeeds.
 *
 * Exit non-zero if any assertion fails.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GROUPS, LEAF_PATHS } from "./schema-leaves.mjs";
import { loadResult } from "./score.mjs";
import { runExtraction } from "./run-extraction.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRANSCRIPT_DIR = join(HERE, "transcripts");

const SLUGS = readdirSync(TRANSCRIPT_DIR)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => f.replace(/\.txt$/, ""))
  .sort();

let failures = 0;
let passes = 0;

function check(desc, cond) {
  if (cond) {
    passes++;
    console.log(`   PASS  ${desc}`);
  } else {
    failures++;
    console.log(`   FAIL  ${desc}`);
  }
}

function heading(title) {
  console.log("");
  console.log("=".repeat(82));
  console.log(title);
  console.log("=".repeat(82));
}

// ---------------------------------------------------------------------------
// Fake ChatClient — returns canned per-group and whole-schema responses.
// ---------------------------------------------------------------------------

/** Build an all-null enveloped response for the full schema (all 7 groups). */
function buildAllNullFields() {
  const fields = {};
  for (const group of GROUPS) fields[group] = {};
  for (const path of LEAF_PATHS) {
    const [group, leaf] = path.split(".");
    fields[group][leaf] = { value: null, confidence: 0, sourceSpan: null };
  }
  return fields;
}

/** Build an all-null enveloped response for one group only. */
function buildGroupFields(groupKey) {
  const fields = { [groupKey]: {} };
  for (const path of LEAF_PATHS) {
    const [group, leaf] = path.split(".");
    if (group === groupKey) {
      fields[groupKey][leaf] = { value: null, confidence: 0, sourceSpan: null };
    }
  }
  return fields;
}

/**
 * A fake ChatClient that returns canned all-null responses. The single-shot
 * extractor's request has `response_format.json_schema.name` without a colon
 * (just the target name); the per-group extractor's has `<target>:<groupKey>`.
 *
 * @param {{ failOnTranscript?: (text: string) => boolean }} [opts]
 */
function fakeChat(opts = {}) {
  const { failOnTranscript } = opts;
  return {
    async complete(request) {
      const transcript = request.messages[request.messages.length - 1].content;
      if (failOnTranscript && failOnTranscript(transcript)) {
        throw new Error("fake: simulated extraction failure");
      }
      const name = request.response_format.json_schema.name;
      const colonIdx = name.indexOf(":");
      const fields =
        colonIdx !== -1 ? buildGroupFields(name.slice(colonIdx + 1)) : buildAllNullFields();
      return {
        content: JSON.stringify(fields),
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(label) {
  return mkdtempSync(join(tmpdir(), `ribo-run-ext-${label}-`));
}

/** Read and parse a JSON file, returning null if it doesn't exist or fails. */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TEST 1: SHAPE — both strategies write files score.mjs can consume
// ---------------------------------------------------------------------------

async function testShape() {
  heading("TEST 1: SHAPE — both strategies write files in the shape score.mjs consumes");
  const out = makeTmpDir("shape");
  try {
    const chat = fakeChat();
    await runExtraction({
      chat,
      model: "fake-model",
      outputDir: out,
      transcriptDir: TRANSCRIPT_DIR,
      log: () => {},
    });

    for (const strategyName of ["single-shot", "per-group"]) {
      console.log(`\n   -- ${strategyName} --`);
      const dir = join(out, strategyName);

      // Manifest exists and is well-formed
      const manifest = readJson(join(dir, "manifest.json"));
      check(`${strategyName}: manifest.json exists`, manifest !== null);
      check(`${strategyName}: manifest has strategy`, manifest?.strategy === strategyName);
      check(`${strategyName}: manifest has model`, manifest?.model === "fake-model");
      check(
        `${strategyName}: manifest has ${SLUGS.length} transcript entries`,
        manifest?.transcripts?.length === SLUGS.length,
      );
      check(
        `${strategyName}: all manifest entries are "ok"`,
        manifest?.transcripts?.every((t) => t.status === "ok"),
      );
      check(
        `${strategyName}: every ok entry has a call count`,
        manifest?.transcripts?.every((t) => typeof t.calls === "number" && t.calls > 0),
      );

      // Every transcript has a result file
      for (const slug of SLUGS) {
        const resultPath = join(dir, `${slug}.json`);
        check(`${strategyName}: ${slug}.json exists`, existsSync(resultPath));

        // score.mjs's loadResult can parse it
        const loaded = loadResult(dir, slug);
        check(`${strategyName}: ${slug} loads via score.mjs (no problem)`, loaded.problem === null);
        check(`${strategyName}: ${slug} data is an object`, loaded.data !== null);

        // Has exactly the 7 group keys
        const dataKeys = Object.keys(loaded.data ?? {}).sort();
        check(
          `${strategyName}: ${slug} has exactly the 7 groups`,
          JSON.stringify(dataKeys) === JSON.stringify([...GROUPS].sort()),
        );

        // Every leaf has the {value, confidence, sourceSpan} envelope
        let allEnvelopesOk = true;
        for (const path of LEAF_PATHS) {
          const [group, leaf] = path.split(".");
          const cell = loaded.data?.[group]?.[leaf];
          if (cell === undefined || cell === null) {
            allEnvelopesOk = false;
            break;
          }
          const keys = Object.keys(cell).sort();
          if (JSON.stringify(keys) !== '["confidence","sourceSpan","value"]') {
            allEnvelopesOk = false;
            break;
          }
        }
        check(
          `${strategyName}: ${slug} every leaf has {value, confidence, sourceSpan}`,
          allEnvelopesOk,
        );
      }

      // Per-group should make more calls per transcript than single-shot
      if (strategyName === "per-group") {
        const firstCalls = manifest?.transcripts?.[0]?.calls;
        check("per-group: first transcript made 7 calls (one per group)", firstCalls === 7);
      } else {
        const firstCalls = manifest?.transcripts?.[0]?.calls;
        check("single-shot: first transcript made 1 call", firstCalls === 1);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// TEST 2: RESUME — existing result files are skipped unless forced
// ---------------------------------------------------------------------------

async function testResume() {
  heading("TEST 2: RESUME — existing result files are skipped unless forced");
  const out = makeTmpDir("resume");
  try {
    const chat = fakeChat();
    const strategy = "single-shot"; // one strategy is enough for this test

    // First run — writes everything
    await runExtraction({
      chat,
      model: "fake-model",
      outputDir: out,
      transcriptDir: TRANSCRIPT_DIR,
      strategies: [strategy],
      log: () => {},
    });

    // Snapshot a few result file contents
    const dir = join(out, strategy);
    const snapshots = new Map();
    for (const slug of SLUGS.slice(0, 3)) {
      snapshots.set(slug, readFileSync(join(dir, `${slug}.json`), "utf8"));
    }

    // Second run without force — should skip all
    const manifest2 = await runExtraction({
      chat,
      model: "fake-model",
      outputDir: out,
      transcriptDir: TRANSCRIPT_DIR,
      strategies: [strategy],
      force: false,
      log: () => {},
    });

    const entries2 = manifest2[strategy]?.transcripts ?? [];
    check(
      "resume: all entries are 'skipped'",
      entries2.every((t) => t.status === "skipped"),
    );
    check(`resume: ${SLUGS.length} skipped entries`, entries2.length === SLUGS.length);

    // Files unchanged
    let unchanged = true;
    for (const [slug, snap] of snapshots) {
      const current = readFileSync(join(dir, `${slug}.json`), "utf8");
      if (current !== snap) {
        unchanged = false;
        break;
      }
    }
    check("resume: existing result files were not modified", unchanged);

    // Third run with force — should re-write all
    const manifest3 = await runExtraction({
      chat,
      model: "fake-model",
      outputDir: out,
      transcriptDir: TRANSCRIPT_DIR,
      strategies: [strategy],
      force: true,
      log: () => {},
    });

    const entries3 = manifest3[strategy]?.transcripts ?? [];
    check(
      "force: all entries are 'ok'",
      entries3.every((t) => t.status === "ok"),
    );
    check(`force: ${SLUGS.length} ok entries`, entries3.length === SLUGS.length);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// TEST 3: ISOLATION — one transcript failing does not abort the rest
// ---------------------------------------------------------------------------

async function testIsolation() {
  heading("TEST 3: ISOLATION — one transcript failing does not abort the rest");
  const out = makeTmpDir("isolation");
  try {
    // Fail on the 3rd transcript (by slug)
    const failSlug = SLUGS[2]; // e.g. "03-quick-exterior-short"
    const failText = readFileSync(join(TRANSCRIPT_DIR, `${failSlug}.txt`), "utf8");
    const chat = fakeChat({ failOnTranscript: (text) => text === failText });

    const manifests = await runExtraction({
      chat,
      model: "fake-model",
      outputDir: out,
      transcriptDir: TRANSCRIPT_DIR,
      log: () => {},
    });

    for (const strategyName of ["single-shot", "per-group"]) {
      console.log(`\n   -- ${strategyName} --`);
      const dir = join(out, strategyName);
      const manifest = manifests[strategyName];
      const entries = manifest?.transcripts ?? [];

      // The failed transcript has no result file
      check(
        `${strategyName}: ${failSlug} has no result file`,
        !existsSync(join(dir, `${failSlug}.json`)),
      );

      // The failed transcript is recorded as "failed" in the manifest
      const failedEntry = entries.find((t) => t.slug === failSlug);
      check(
        `${strategyName}: ${failSlug} manifest status is "failed"`,
        failedEntry?.status === "failed",
      );
      check(
        `${strategyName}: ${failSlug} manifest has error message`,
        typeof failedEntry?.error === "string" && failedEntry.error.length > 0,
      );

      // All other transcripts succeeded and have result files
      const others = entries.filter((t) => t.slug !== failSlug);
      check(
        `${strategyName}: all other ${others.length} entries are "ok"`,
        others.every((t) => t.status === "ok"),
      );
      for (const entry of others) {
        check(
          `${strategyName}: ${entry.slug}.json exists despite ${failSlug} failing`,
          existsSync(join(dir, `${entry.slug}.json`)),
        );
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await testShape();
await testResume();
await testIsolation();

console.log("");
if (failures) {
  console.error(`${failures} FAIL, ${passes} PASS`);
  process.exit(1);
} else {
  console.log(`All ${passes} checks passed.`);
}
