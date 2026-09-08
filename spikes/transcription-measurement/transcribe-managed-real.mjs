#!/usr/bin/env node
/**
 * Runs every file in `testdata/real/` through the REAL `@azx/ribo-transcriber-managed`
 * `ManagedTranscriber` against Azure AI Speech Fast Transcription — the same production class the
 * app uses, not a reimplementation of its request shape. Companion to `run-real-ondevice.mjs`; this
 * is the "managed" half of the on-device-vs-managed comparison the Asana ticket asks for.
 *
 * Requires the package to be built first (this is a plain Node script, not a Vite/vitest process
 * that transforms TS on the fly):
 *
 *   pnpm --filter @azx/ribo-core --filter @azx/ribo-transcriber-managed build
 *   node spikes/transcription-measurement/transcribe-managed-real.mjs
 *
 * Credentials: `AZURE_AI_FOUNDRY_API_KEY` / `AZURE_AI_FOUNDRY_OPENAI_BASE_URL` from `.env.local` at
 * the repo root — the same vars `playground/vite-transcribe.ts` uses for the same purpose. Loaded by
 * hand here (below) because this script isn't a Vite process and .env.local isn't auto-read.
 *
 * Writes results/real/_raw/managed.json (git-ignored — carries real transcript text).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ManagedTranscriber } from "../../packages/ribo-transcriber-managed/dist/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");
const REAL_DIR = join(HERE, "testdata", "real");
const RAW_DIR = join(HERE, "results", "real", "_raw");
const AUDIO_EXT = /\.(m4a|mp3|wav)$/i;

// ---- load .env.local (repo root) into process.env, without clobbering an already-set var ----------
const envPath = join(REPO, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const key = process.env.AZURE_AI_FOUNDRY_API_KEY;
const baseUrl = process.env.AZURE_AI_FOUNDRY_OPENAI_BASE_URL;
if (!key || !baseUrl) {
  console.error(
    "[managed] Set AZURE_AI_FOUNDRY_API_KEY and AZURE_AI_FOUNDRY_OPENAI_BASE_URL in .env.local " +
      "at the repo root (a fresh worktree doesn't have one — copy it from the main checkout).",
  );
  process.exit(1);
}

// Mirrors playground/vite-transcribe.ts's `speechEndpointFrom` — duplicated rather than imported
// because that file is a dev-only Vite plugin, not a shared export.
const API_VERSION = "2025-10-15";
function speechEndpointFrom(url) {
  const { host } = new URL(url);
  return `https://${host}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;
}
const endpoint = speechEndpointFrom(baseUrl);

const MIME_BY_EXT = { ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" };

const files = existsSync(REAL_DIR)
  ? readdirSync(REAL_DIR)
      .filter((f) => AUDIO_EXT.test(f))
      .sort()
  : [];
if (files.length === 0) {
  console.error(`[managed] no audio files in ${REAL_DIR} — see testdata/real/README.md`);
  process.exit(1);
}

// The package adds no credential itself (design §5.2) — the injected fetch attaches it, mirroring
// what the playground's dev-only /api/transcribe endpoint does server-side.
const doFetch = (url, init) =>
  fetch(url, { ...init, headers: { ...(init?.headers ?? {}), "Ocp-Apim-Subscription-Key": key } });

const transcriber = new ManagedTranscriber({ endpoint, fetchImpl: doFetch });

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  const results = [];
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    const slug = file.slice(0, -ext.length);
    const bytes = readFileSync(join(REAL_DIR, file));
    const blob = new Blob([bytes], { type: MIME_BY_EXT[ext] ?? "application/octet-stream" });
    const recording = {
      id: slug,
      capturedAt: new Date().toISOString(),
      durationMs: 0,
      mimeType: blob.type,
      ctx: {},
    };
    console.log(`[managed] transcribing ${file} (${(bytes.length / 1e6).toFixed(1)} MB)...`);
    const t0 = performance.now();
    const out = await transcriber.transcribe(recording, blob);
    const processMs = performance.now() - t0;
    console.log(`[managed] ${slug}: ${(processMs / 1000).toFixed(1)}s, ${out.text.length} chars`);
    results.push({
      slug,
      text: out.text,
      processMs: Math.round(processMs),
      audioBytes: bytes.length,
    });
  }
  const outPath = join(RAW_DIR, "managed.json");
  writeFileSync(
    outPath,
    `${JSON.stringify(
      { generatedAt: new Date().toISOString(), engine: transcriber.engine, results },
      null,
      2,
    )}\n`,
  );
  console.log(`[managed] wrote ${outPath}`);
}

main().catch((err) => {
  console.error("[managed]", err);
  process.exit(1);
});
