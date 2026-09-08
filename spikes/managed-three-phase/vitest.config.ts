import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * MANUAL, OPT-IN measurement spike (doc 20). Not wired into `./check.sh`.
 * Node environment, real network calls to the Helix LLM route.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * `spikes/` is not a pnpm workspace member, so `@azx/*` has no `node_modules`
 * link here. Alias the four packages this harness imports straight at their
 * `src/index.ts` — the same source-first resolution the `@azx/source` condition
 * gives a real workspace member, without making the spike a published package.
 */
const alias = {
  "@azx/ribo-core": `${repoRoot}packages/ribo-core/src/index.ts`,
  "@azx/ribo-adapter-snuggpro": `${repoRoot}packages/ribo-adapter-snuggpro/src/index.ts`,
  "@azx/ribo-extractor-openai": `${repoRoot}packages/ribo-extractor-openai/src/index.ts`,
  "@azx/ribo-extractor-ondevice": `${repoRoot}packages/ribo-extractor-ondevice/src/index.ts`,
};

export default defineConfig({
  root: repoRoot,
  test: {
    reporters: [["default", { summary: false }]],
    projects: [
      {
        root: repoRoot,
        server: { fs: { allow: [repoRoot] } },
        resolve: { alias },
        ssr: { resolve: { conditions: ["@azx/source"], alias } },
        test: {
          name: "managed-three-phase",
          environment: "node",
          include: ["spikes/managed-three-phase/**/*.manual.ts"],
          testTimeout: 3_600_000,
          hookTimeout: 3_600_000,
        },
      },
    ],
  },
});
