import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

/**
 * The two deviations from the shared browser config, applied to both entries,
 * both ratified by ADR 0037 ("the CLI ships as @azx/ribo-cli, one single-file
 * Node bundle") and both named by the shared config's own comments as the
 * settings that must never change silently:
 *
 * 1. `platform: "node"` — the CLI is the workspace's first Node-platform
 *    package. It reads files and stdin and writes process streams; building it
 *    for a browser would be a lie about its runtime.
 * 2. `target: "node24"` — explicit, so the shared config's inference footgun
 *    (engines.node -> nodeNN) stays a decision instead of an accident. The
 *    bin's runtime floor is the workspace's own `engines.node` floor.
 *
 * The two entries are built as TWO configs, not one config with two entries:
 * this rolldown has no "disable chunking" option, and two entries sharing the
 * inspect module would emit a third chunk file beside the bin — while the
 * packed bin must run with nothing installed beside it (ADR 0037). One entry
 * per build inlines each entry's whole graph into its own single file.
 *
 * `fixedExtension: false` keeps the `.js`/`.d.ts` names the manifest's exports
 * and bin point at; tsdown's default for a Node platform is `.mjs`.
 *
 * The `bin` mapping is declared statically in the manifest
 * (`"bin": { "ribo": "./dist/bin.js" }`), like every other manifest in this
 * repo. `bin: false` disables tsdown's shebang auto-detection so the build
 * never rewrites the checked-in package.json; the shebang in src/bin.ts is
 * preserved into the chunk by the bundler itself.
 *
 * `alwaysBundle` is the single-file bundle itself: tsdown externalizes
 * `dependencies` by default, and these are exactly the ones that must be
 * INLINED instead. `rxjs` is listed because retained modules of the bundled
 * `@azx/ribo-core` import it — inlining a transitive dependency of an inlined
 * package adds no manifest dependency of the CLI's own.
 */
function nodeBundle(entry: { index: string } | { bin: string }) {
  return {
    ...sharedTsdown,
    platform: "node" as const,
    target: "node24",
    fixedExtension: false,
    bin: false as const,
    deps: {
      alwaysBundle: [
        "@azx/ribo-core",
        "@azx/ribo-core/package.json",
        "zod",
        "rxjs",
        "commander",
        "picocolors",
      ],
    },
    entry,
  };
}

export default defineConfig([
  nodeBundle({ index: "src/index.ts" }),
  nodeBundle({ bin: "src/bin.ts" }),
]);
