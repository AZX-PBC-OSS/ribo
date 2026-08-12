import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * MANUAL, OPT-IN config for the live-model comparison spike — never wired into `./check.sh`.
 * It downloads real models over the network and runs minutes of inference.
 *
 *   node spikes/live-model-comparison/run.mjs
 *
 * Structure copied deliberately from `spikes/transcription-measurement/vitest.measure.config.ts`
 * rather than invented: the same `/@fs` ORT wasm trick, the same browser project shape. The one
 * addition is `__MODELS__`, a JSON array, because this spike's whole point is running more than one
 * model in a single process so the timings share a warm browser and are comparable.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
const ortEntry = readdirSync(pnpmDir).find((name) => name.startsWith("onnxruntime-web@"));
if (!ortEntry) {
  throw new Error("onnxruntime-web not found under node_modules/.pnpm — run `pnpm install` first.");
}
const ortDist = join(pnpmDir, ortEntry, "node_modules", "onnxruntime-web", "dist");
const ortWasmBase = `/@fs${ortDist}/`;

/**
 * The 54-second energy-audit fixture already in the repo. Reused rather than synthesized so these
 * numbers sit beside `long-audio.manual.ts`'s measured RTF 0.158 on the same audio.
 */
const fixture = join(
  repoRoot,
  "packages",
  "ribo-transcriber-ondevice",
  "testdata",
  "energy-audit-long-48k-mono.wav",
);

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
          __FIXTURE_URL__: JSON.stringify(`/@fs${fixture}`),
          __MODELS__: JSON.stringify(
            process.env.COMPARE_MODELS ??
              "onnx-community/whisper-base.en,onnx-community/moonshine-base-ONNX,onnx-community/moonshine-tiny-ONNX",
          ),
          __DURATIONS__: JSON.stringify(process.env.COMPARE_DURATIONS ?? "2,4,8,16,29"),
          __REPEATS__: JSON.stringify(process.env.COMPARE_REPEATS ?? "3"),
        },
        optimizeDeps: { include: ["@huggingface/transformers"] },
        test: {
          name: "live-model-comparison",
          include: ["spikes/live-model-comparison/compare.manual.ts"],
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
