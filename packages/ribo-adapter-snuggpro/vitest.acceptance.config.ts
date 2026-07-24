import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * MANUAL, OPT-IN acceptance gate for Phase 4 Task 3 — the extraction-QUALITY test,
 * deliberately NOT wired into `./check.sh` or any Vitest project the gate runs. It
 * makes real, keyed inference calls to an OpenAI-compatible endpoint (the whole
 * point: measure the built extractor against the spike corpus), so it needs
 * `OPENAI_API_KEY` and cannot run in CI. Sibling of `vitest.manual.config.ts` in
 * `ribo-transcriber-ondevice`; kept separate so a network-and-key run can never be
 * confused for a gated check.
 *
 * Run it by hand (see acceptance/README.md for the full env contract):
 *
 *   OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-2024-08-06 \
 *   pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts
 *
 * Node environment: the extractor is a plain `fetch` call, no browser or WASM. The
 * gate reads the spike corpus (ground-truth + transcripts) read-only and imports
 * the spike's `score.mjs` scoring functions in-process, so it never writes into
 * `spikes/`.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: repoRoot,
  test: {
    reporters: [["default", { summary: false }]],
    projects: [
      {
        root: repoRoot,
        server: { fs: { allow: [repoRoot] } },
        // Resolve `@azx/*` workspace imports to their `src/` — the gate now imports
        // `@azx/ribo-extractor-openai` by name (the extractor graduated out of this
        // adapter). This is a NODE-environment project, so the condition MUST be
        // `ssr.resolve.conditions`, not plain `resolve.conditions`: node tests go
        // through Vite's SSR pipeline. Same reasoning (and the same verified caveat)
        // as the root `vitest.config.ts` `unit` project. Without it the entry
        // resolves to a nonexistent `dist/` and the suite fails to collect instead
        // of skipping cleanly when no key is set.
        ssr: {
          resolve: {
            conditions: ["@azx/source"],
          },
        },
        test: {
          name: "snuggpro-acceptance",
          environment: "node",
          include: ["packages/ribo-adapter-snuggpro/acceptance/**/*.manual.ts"],
          // 14 sequential model calls over the corpus; generous margin for a slow endpoint.
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
