import { defineConfig } from "tsdown";
import type { Plugin } from "rolldown";

import { sharedTsdown } from "@azx/build-config";

/**
 * The single-file invariant, enforced at the bundle level. The dts pass of
 * rolldown-plugin-dts stubs fake JS modules for every external `.d.ts` it
 * walks (zod's alone is enormous), and once the graph crosses rolldown's
 * chunker threshold the pass splits rolldown's shared runtime helpers
 * (`__exportAll`) into a second chunk file beside the entry — which the packed
 * bin must never ship (ADR 0037: it must run with nothing installed beside
 * it, and the pack-and-consume gate asserts exactly that).
 * `outputOptions.codeSplitting: false` does not reach the pass that emits it,
 * so this plugin inlines the runtime-helper chunk back into its importers at
 * `generateBundle` and deletes it.
 *
 * Deliberately narrow: it only touches the one chunk shape that exists today —
 * a `.js` chunk carrying rolldown's `\0rolldown/runtime.js` helpers, imported
 * by an entry under the helpers' own local names. Any other non-entry chunk
 * shape is left untouched for the pack-and-consume gate to refuse, rather
 * than being silently mis-inlined.
 */
function singleFile(): Plugin {
  return {
    name: "ribo-cli:single-file",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== "chunk" || chunk.isEntry || !fileName.endsWith(".js")) continue;
          if (!chunk.code.includes("//#region \\0rolldown/runtime.js")) continue;
          // The helpers' code minus its export line — the export statement is
          // the last `export { ... }` of the module.
          const helpers = chunk.code.replace(/export\s*\{[^}]*\}\s*;?\s*$/, "");
          // The chunk's external names mapped to the locals that define them,
          // read off the export statement itself: `export { __exportAll as t }`
          // — external "t", local "__exportAll".
          const exportStatement = chunk.code.match(/export\s*\{([^}]*)\}/);
          if (exportStatement === null) {
            throw new Error(
              `${fileName}: a non-entry .js chunk with no export statement — the bundle's ` +
                "chunk shape changed; re-justify this plugin",
            );
          }
          const locals = new Map<string, string>();
          for (const entry of exportStatement[1]!.split(",")) {
            const [local, external = local] = entry.split(" as ").map((part) => part.trim());
            locals.set(external!, local!);
          }
          const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const importPattern = new RegExp(
            `import\\s*\\{([^}]*)\\}\\s*from\\s*["']\\./${escaped}["'];?\\n?`,
          );
          for (const candidate of Object.values(bundle)) {
            if (candidate.type !== "chunk") continue;
            const imports = candidate.code.match(importPattern);
            if (imports === null) continue;
            let inlined = helpers;
            for (const pair of imports[1]!.split(",")) {
              const [external, alias = external] = pair.split(" as ").map((part) => part.trim());
              const local = locals.get(external!);
              if (local === undefined) {
                throw new Error(
                  `${fileName}: ${candidate.fileName} imports "${external}" which the chunk does ` +
                    "not export — the bundle's chunk shape changed; re-justify this plugin",
                );
              }
              if (alias === local) continue;
              // The importer bound the helper under a different local name —
              // rename the helper's definition to the alias while inlining.
              inlined = inlined.replace(new RegExp(`\\b${local}\\b`, "g"), alias!);
            }
            candidate.code = `${inlined}${candidate.code.replace(importPattern, "")}`;
          }
          delete bundle[fileName];
        }
      },
    },
  };
}

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
    plugins: [singleFile()],
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
