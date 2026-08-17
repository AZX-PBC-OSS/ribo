import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * MANUAL, OPT-IN verification config — deliberately NOT wired into `./check.sh` or any Vitest
 * project the gate runs. It downloads a real (small) Whisper model over the network, so it is
 * network-dependent and slow by nature; gating it would be exactly the "a 165 MB CDN fetch
 * masquerading as a check" trap the plan warns against.
 *
 * Run it by hand:
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts
 *
 * It proves the real path the gated unit tests only double: `whisper-tiny.en` actually downloads
 * with per-file progress, lands in `transformers-cache`, and a second construction reads from that
 * cache — with the ORT runtime served **same-origin** (never jsDelivr), which is the whole point of
 * the required `wasmPaths` config.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Locate the ONNX Runtime wasm files pnpm nested under transformers, and expose their directory as a
// same-origin `/@fs/` base the Vite dev server will serve. This mirrors what a real consumer does —
// copy `onnxruntime-web/dist/ort-wasm-simd-threaded*.{wasm,mjs}` into a static dir on their own
// origin — without adding a dependency just to grab the bytes.
const pnpmDir = join(repoRoot, "node_modules", ".pnpm");

// Resolve through transformers' OWN link rather than scanning `.pnpm` for a name prefix. The scan
// used to be `readdirSync(...).find(n => n.startsWith("onnxruntime-web@"))`, which silently picks
// the alphabetically-first match — fine while exactly one version was installed, wrong the moment a
// `pnpm.overrides` entry puts two there, because `1.26.0-dev…` sorts before `1.27.0`. That serves
// one version's `.wasm` binaries to another version's JS, and the resulting failure looks like a
// dtype or model problem rather than a mismatched runtime.
const transformersEntry = readdirSync(pnpmDir).find((name) =>
  name.startsWith("@huggingface+transformers@"),
);
if (!transformersEntry) {
  throw new Error(
    "@huggingface/transformers not found under node_modules/.pnpm — run `pnpm install` first.",
  );
}
const ortDist = join(
  realpathSync(join(pnpmDir, transformersEntry, "node_modules", "onnxruntime-web")),
  "dist",
);
const ortWasmBase = `/@fs${ortDist}/`;

export default defineConfig({
  root: repoRoot,
  test: {
    reporters: [["default", { summary: false }]],
    projects: [
      {
        // Vitest 4 projects do not inherit root `define`/`server`, so these live on the project.
        root: repoRoot,
        // The wasm binaries live under node_modules; allow the dev server to serve from repo root.
        server: { fs: { allow: [repoRoot] } },
        define: {
          __ORT_WASM_BASE__: JSON.stringify(ortWasmBase),
        },
        // Pre-bundle transformers so the browser project does not re-optimize mid-run (which makes
        // Vitest reload the test and warn). Both the client and the worker pull it.
        optimizeDeps: { include: ["@huggingface/transformers"] },
        test: {
          name: "ondevice-manual",
          include: ["packages/ribo-transcriber-ondevice/src/**/*.manual.ts"],
          // A cold model download + ORT init; generous margin for a slow uplink.
          testTimeout: 300_000,
          hookTimeout: 300_000,
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
