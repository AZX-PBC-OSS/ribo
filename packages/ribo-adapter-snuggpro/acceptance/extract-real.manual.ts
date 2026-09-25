import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

import { type ChatClient, singleShotExtractor } from "@azx/ribo-core";
import { openAiChat } from "@azx/ribo-chat-openai";

import { cliChat } from "./cli-chat.js";
import { normalizeFields, snuggProAdapter } from "../src/index.js";

/**
 * Real-audio companion to `gate.manual.ts` (Asana: "Add audio files ... to extraction accuracy
 * documentation"). Runs the SAME production extraction path — `singleShotExtractor` +
 * `snuggProAdapter` + `normalizeFields` — against the real field recordings' transcripts instead of
 * the 14-transcript spike corpus. Deliberately reuses `cliChat` (this directory's own keyless CLI
 * transport) rather than reimplementing its CLI-prompt-building/shape-retry logic — see its header
 * for what that buys, and why a plain Node script can't do this: `cliChat` is TS source only, never
 * built to `dist`, so it needs vitest's transform to import at all (same reason `gate.manual.ts`
 * itself is a vitest test, not a `.mjs` script).
 *
 * MANUAL, OPT-IN — matches every other file in this directory. Picked up by
 * `vitest.acceptance.config.ts`'s `**\/*.manual.ts` glob, so target THIS file explicitly or the
 * 14-transcript gate runs too:
 *
 *   REAL_EXTRACT_SOURCE=ondevice REAL_EXTRACT_BACKEND=claude \
 *   pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts extract-real
 *
 * `REAL_EXTRACT_SOURCE`: `ondevice` | `managed` (the ASR drafts) | `clean` (the human-corrected
 * transcript, once it exists). `REAL_EXTRACT_BACKEND`: `claude` | `codex` (keyless CLIs) | `openai`
 * (needs `OPENAI_API_KEY`). Default `claude` — at the time this was written `codex`'s workspace was
 * deactivated (402) and the `.env.local` `OPENAI_API_KEY` was invalid (401); `claude` was the only
 * backend that actually worked.
 *
 * Output: `docs/spikes/0002-transcription-measurement/results/real/extract/<source>/<slug>.json` — git-ignored,
 * real form content, same as every other real-audio artifact under `results/real/`.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REAL_GT_DIR = join(
  HERE,
  "..",
  "..",
  "..",
  "spikes",
  "transcription-measurement",
  "testdata",
  "real",
  "ground-truth",
);
const OUT_ROOT = join(
  HERE,
  "..",
  "..",
  "..",
  "spikes",
  "transcription-measurement",
  "results",
  "real",
  "extract",
);

type Source = "ondevice" | "managed" | "clean";
type Backend = "claude" | "codex" | "openai";

const source = (process.env.REAL_EXTRACT_SOURCE ?? "ondevice") as Source;
const backend = (process.env.REAL_EXTRACT_BACKEND ?? "claude") as Backend;
if (!["ondevice", "managed", "clean"].includes(source)) {
  throw new Error(`REAL_EXTRACT_SOURCE must be ondevice|managed|clean, got "${source}"`);
}
if (!["claude", "codex", "openai"].includes(backend)) {
  throw new Error(`REAL_EXTRACT_BACKEND must be claude|codex|openai, got "${backend}"`);
}

/** slug -> transcript file for the requested source, from whatever's in ground-truth/ right now. */
function findSourceFiles(): string[] {
  if (!existsSync(REAL_GT_DIR)) return [];
  const all = readdirSync(REAL_GT_DIR);
  if (source === "clean") {
    // A human-corrected file is exactly `<slug>.txt` — never a `.draft-*.txt`.
    return all.filter((f) => f.endsWith(".txt") && !f.includes(".draft-"));
  }
  const suffix = `.draft-${source}.txt`;
  return all.filter((f) => f.endsWith(suffix));
}

function makeChat(): ChatClient {
  if (backend === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    return openAiChat({ apiKey, baseUrl });
  }
  // The default 120s (matches playground/vite-extract.ts's CLI_TIMEOUT_MS) is tuned for the spike
  // corpus's short transcripts. A 19-minute real recording's transcript is far longer, and the
  // schema-in-prompt CLI path is already slower than a strict-mode API call — 120s undershoots it.
  return cliChat({ backend, timeoutMs: 480_000 });
}

test("extract real-audio transcripts through the production extraction path", async () => {
  const files = findSourceFiles();
  if (files.length === 0) {
    console.warn(
      `[extract-real] no transcripts in ${REAL_GT_DIR} for source "${source}" — see ` +
        "docs/spikes/0002-transcription-measurement/testdata/real/README.md. Skipping.",
    );
    return;
  }

  const outDir = join(OUT_ROOT, source);
  mkdirSync(outDir, { recursive: true });

  const chat = makeChat();
  const model =
    backend === "openai" ? (process.env.OPENAI_MODEL ?? "gpt-4o-2024-08-06") : `${backend}-cli`;
  const extractor = singleShotExtractor({
    target: snuggProAdapter,
    chat,
    model,
    normalize: normalizeFields,
  });

  for (const f of files) {
    const slug =
      source === "clean" ? f.replace(/\.txt$/, "") : f.replace(`.draft-${source}.txt`, "");
    const outPath = join(outDir, `${slug}.json`);
    if (existsSync(outPath)) {
      console.log(`[extract-real] skip ${slug} (exists)`);
      continue;
    }
    const transcript = readFileSync(join(REAL_GT_DIR, f), "utf8");
    const t0 = Date.now();
    const result = await extractor.extract({ text: transcript, annotations: {} });
    writeFileSync(outPath, `${JSON.stringify(result.fields, null, 2)}\n`);
    console.log(`[extract-real] ok ${slug} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}, 1_800_000);
