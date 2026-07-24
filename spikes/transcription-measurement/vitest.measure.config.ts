import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * MANUAL, OPT-IN measurement config for Phase 3 Task 4 — NOT wired into ./check.sh (it downloads a
 * real Whisper model and runs minutes of inference). Sibling of the package's own
 * vitest.manual.config.ts; kept SEPARATE so the systematic 14-transcript spike cannot perturb that
 * file's single-clip proof.
 *
 * Drive it via spikes/transcription-measurement/run.mjs (which also samples browser-process RSS and
 * collects the @@MEASURE@@ JSON the test logs). Or by hand:
 *
 *   MEASURE_MODEL=Xenova/whisper-tiny.en \
 *   pnpm exec vitest run --config spikes/transcription-measurement/vitest.measure.config.ts
 *
 * Env knobs (read here, injected as `define`s the browser test reads):
 *   MEASURE_MODEL   model id (default Xenova/whisper-base.en — the production choice)
 *   MEASURE_LIMIT   cap the transcript count for a quick smoke (default: all)
 *   MEASURE_UNHINTED_SLUGS  comma-separated slugs to ALSO run without hints (the hint-delta subset)
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
const ortEntry = readdirSync(pnpmDir).find((name) => name.startsWith("onnxruntime-web@"));
if (!ortEntry) {
  throw new Error("onnxruntime-web not found under node_modules/.pnpm — run `pnpm install` first.");
}
const ortDist = join(pnpmDir, ortEntry, "node_modules", "onnxruntime-web", "dist");
const ortWasmBase = `/@fs${ortDist}/`;

const measureDir = fileURLToPath(new URL(".", import.meta.url));
const manifestUrl = `/@fs${join(measureDir, "testdata", "manifest.json")}`;

export default defineConfig({
  root: repoRoot,
  test: {
    reporters: [["default", { summary: false }]],
    projects: [
      {
        root: repoRoot,
        server: { fs: { allow: [repoRoot] } },
        define: {
          __ORT_WASM_BASE__: JSON.stringify(ortWasmBase),
          __MANIFEST_URL__: JSON.stringify(manifestUrl),
          __MODEL_ID__: JSON.stringify(process.env.MEASURE_MODEL ?? "Xenova/whisper-base.en"),
          __LIMIT__: JSON.stringify(process.env.MEASURE_LIMIT ?? ""),
          __UNHINTED_SLUGS__: JSON.stringify(process.env.MEASURE_UNHINTED_SLUGS ?? ""),
        },
        optimizeDeps: { include: ["@huggingface/transformers"] },
        test: {
          name: "transcription-measure",
          include: ["spikes/transcription-measurement/measure.manual.ts"],
          testTimeout: 1_800_000,
          hookTimeout: 1_800_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
