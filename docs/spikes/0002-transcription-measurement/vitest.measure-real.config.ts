import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * MANUAL, OPT-IN measurement config for REAL field audio (Asana: "Add audio files ... to extraction
 * accuracy documentation"). Sibling of `vitest.measure.config.ts`, kept separate because it points at
 * `testdata/real/` — git-ignored real recordings — instead of the synthesized corpus, and because the
 * real files are fed to the transcriber WHOLE: unlike when the synthetic-corpus harness was written,
 * the on-device transcriber now segments audio past Whisper's 30 s window itself
 * (`worker.ts`'s VAD-based `planChunks`), so no harness-level chunking is needed here.
 *
 * Drive it via `run-real-ondevice.mjs`, or by hand:
 *
 *   MEASURE_MODEL=Xenova/whisper-tiny.en \
 *   pnpm exec vitest run --config docs/spikes/0002-transcription-measurement/vitest.measure-real.config.ts
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
const ortEntry = readdirSync(pnpmDir).find((name) => name.startsWith("onnxruntime-web@"));
if (!ortEntry) {
  throw new Error("onnxruntime-web not found under node_modules/.pnpm — run `pnpm install` first.");
}
const ortDist = join(pnpmDir, ortEntry, "node_modules", "onnxruntime-web", "dist");
const ortWasmBase = `/@fs${ortDist}/`;

const measureDir = fileURLToPath(new URL(".", import.meta.url));
const realDir = join(measureDir, "testdata", "real");
const AUDIO_EXT = /\.(m4a|mp3|wav)$/i;
// `testdata/real/` may be empty (or absent) on a machine with no real recordings — the harness is
// manual/opt-in, not part of ./check.sh, so an empty list is valid here; `measure-real.manual.ts`
// asserts a non-empty list at run time instead of failing config evaluation.
const realFiles = existsSync(realDir)
  ? readdirSync(realDir)
      .filter((f) => AUDIO_EXT.test(f))
      .sort()
      .map((f) => ({ slug: f.replace(AUDIO_EXT, ""), url: `/@fs${join(realDir, f)}` }))
  : [];

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
          __REAL_FILES__: JSON.stringify(realFiles),
          __MODEL_ID__: JSON.stringify(process.env.MEASURE_MODEL ?? "Xenova/whisper-base.en"),
        },
        optimizeDeps: { include: ["@huggingface/transformers"] },
        test: {
          name: "transcription-measure-real",
          include: ["docs/spikes/0002-transcription-measurement/measure-real.manual.ts"],
          testTimeout: 3_600_000,
          hookTimeout: 3_600_000,
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
