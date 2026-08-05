#!/usr/bin/env node
/**
 * @file Asserts the `@azx/source` export condition end to end — both that the
 * packages OFFER a source branch and that the playground actually ASKS for it.
 *
 *   1. Per-package `exports` (Node's own resolver), for each root export AND
 *      the one published subpath (`@azx/ribo-transcriber-ondevice/worker`):
 *        with `--conditions=@azx/source` -> the src/ file   (what this workspace gets)
 *        without it                      -> the dist/ file  (what every consumer gets)
 *   2. Playground Vite config (Vite's own resolveConfig):
 *        `resolve.conditions` includes `@azx/source` — the dev-server path where
 *        HMR into library source matters.
 *
 * This replaces a guard that R1 destroyed. Before R1 the source condition was
 * protected by absence — no `dist/` existed, so losing the condition hard-failed
 * the build. Now the same mistake resolves quietly to `dist/`, killing HMR into
 * library source while CI stays green. AGENTS.md §5 warns that the condition is
 * exactly the kind of thing someone tidies away on a quiet afternoon; this is the
 * gate that catches it.
 *
 * The per-package assertions use Node's own resolver rather than a bundler's, so
 * they are bundler-independent and catch a broken condition AND a broken default
 * in one pass. But they pass `--conditions=@azx/source` directly to Node, which
 * BYPASSES Vite — so they cannot see the playground's `resolve.conditions`.
 * Deleting `resolve.conditions` from `playground/vite.config.ts` (the exact
 * regression this script exists to catch) leaves the Node assertions green while
 * playground HMR silently resolves libraries from `dist/` instead of source. The
 * Vite assertion fills that gap. `resolveConfig` is used rather than grepping the
 * file because it reports what Vite actually computes after config merging and
 * plugins, not merely what the source text happens to say.
 *
 * The per-package assertions run after the `build:packages` stage for diagnostic
 * clarity (a resolve failure reads better against a built tree), NOT because
 * `dist/` must exist: `import.meta.resolve` does exports resolution without
 * stat-ing the target, so the gate would pass identically on an unbuilt tree.
 * File existence is covered by publint in the build stage, not here.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Derive the publishable packages from the workspace rather than hard-coding a
// list: removing a package fails loudly below (count mismatch), but ADDING one
// would be silently ungated while the green line still reads as success. The
// non-private packages under packages/ are the publishable set.
const packagesDir = path.join(repoRoot, "packages");
const publishedPackages = [];
for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const manifestPath = path.join(packagesDir, dir.name, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }
  if (manifest.private) continue;
  publishedPackages.push(manifest.name);
}
publishedPackages.sort();

const EXPECTED_PUBLISHED_COUNT = 5;
if (publishedPackages.length !== EXPECTED_PUBLISHED_COUNT) {
  console.error(
    `assert-source-condition: discovered ${publishedPackages.length} publishable packages, ` +
      `expected ${EXPECTED_PUBLISHED_COUNT} (${publishedPackages.join(", ")}). ` +
      "If you added or removed a package, update EXPECTED_PUBLISHED_COUNT and the " +
      "worker subpath entry below if needed.",
  );
  process.exit(1);
}

// Each target is a specifier plus the suffixes its `@azx/source` and `default`
// branches must resolve to. The root exports all land on index; the one
// published subpath (`./worker`) lands on worker.ts/worker.js — its filename is
// part of the published contract, so it gets the same guarantee as the roots
// rather than being left to the "every exports block" hand-wave.
const TARGETS = publishedPackages.map((name) => ({
  specifier: name,
  sourceSuffix: "/src/index.ts",
  distSuffix: "/dist/index.js",
}));
// The one published subpath, kept as an explicit extra target (its suffixes
// differ from the root exports, so it cannot be derived generically).
TARGETS.push({
  specifier: "@azx/ribo-transcriber-ondevice/worker",
  sourceSuffix: "/src/worker.ts",
  distSuffix: "/dist/worker.js",
});

// Every package is a dependency of `playground`, so its node_modules is the only
// directory from which all five resolve by name.
const from = path.join(repoRoot, "playground");

/**
 * `node -e` runs as CommonJS by default, where `import.meta` does not exist —
 * hence `--input-type=module`.
 */
function resolveFrom(specifier, useSourceCondition) {
  const args = ["--input-type=module"];
  if (useSourceCondition) args.push("--conditions=@azx/source");
  args.push("-e", `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`);
  return execFileSync(process.execPath, args, { cwd: from, encoding: "utf8" }).trim();
}

// Two failure classes, tracked separately so the epilogue can point each at the
// file its reader needs to open. A CI reader has likely never heard of
// `@azx/source`; a named file is more useful than a generic "broken".
const exportsFailures = [];
const viteFailures = [];

for (const { specifier, sourceSuffix, distSuffix } of TARGETS) {
  for (const [useCondition, expectedSuffix] of [
    [true, sourceSuffix],
    [false, distSuffix],
  ]) {
    const label = useCondition ? "with @azx/source" : "without @azx/source";
    let resolved;
    try {
      resolved = resolveFrom(specifier, useCondition);
    } catch (error) {
      exportsFailures.push(
        `${specifier} (${label}): did not resolve at all — ${error.message.split("\n")[0]}`,
      );
      continue;
    }
    // Suffix, not a full path: Node returns the realpath when the target exists
    // and the symlink path when it does not, so a full-path match would be brittle.
    if (!resolved.endsWith(expectedSuffix)) {
      exportsFailures.push(
        `${specifier} (${label}): expected a path ending ${expectedSuffix}, got ${resolved}`,
      );
    }
  }
}

// The exports assertions above prove the packages OFFER a source branch. This
// proves the playground actually ASKS for it. Deleting `resolve.conditions` from
// playground/vite.config.ts is the regression this whole script exists to catch,
// and the Node assertions above cannot see it — they hand Node the condition
// directly, bypassing Vite. `"serve"` is the dev-server path where HMR into
// source matters.
const viteConfig = await resolveConfig({ root: from }, "serve");
if (
  !Array.isArray(viteConfig.resolve.conditions) ||
  !viteConfig.resolve.conditions.includes("@azx/source")
) {
  viteFailures.push(
    "playground/vite.config.ts: Vite's resolved `resolve.conditions` does not include " +
      `"@azx/source" (got: ${JSON.stringify(viteConfig.resolve.conditions)}). ` +
      "The playground would resolve libraries from dist/ instead of src/, silently killing HMR " +
      "into library source.",
  );
}

const failures = [...exportsFailures, ...viteFailures];

if (failures.length > 0) {
  console.error("The @azx/source export condition is broken:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error();
  if (exportsFailures.length > 0) {
    console.error(
      "Package `exports` problem — a publishable package's manifest is wrong. Open the " +
        "failing package's `package.json` and check the `exports` block named in the failure: " +
        "the `@azx/source` branch must point at the `src/` file and the `default` at the matching " +
        "`dist/` artifact (root exports use `index`, the `./worker` subpath uses `worker`). If " +
        "the `with` direction failed, also check `customConditions` in " +
        "`packages/tsconfig/base.json`. If the `without` direction failed, the packages are " +
        "unbuilt or the `default` is wrong — run `pnpm build:packages` first.",
    );
  }
  if (viteFailures.length > 0) {
    console.error(
      "Playground Vite-config problem — the playground is not asking for the source condition, " +
        "so dev/HMR resolves libraries from `dist/` instead of `src/`. Open " +
        "`playground/vite.config.ts` and make sure `resolve.conditions` includes " +
        `"@azx/source".`,
    );
  }
  console.error("Background: AGENTS.md §5.1.");
  process.exit(1);
}

console.log(
  `source condition: ${TARGETS.length} export targets (${publishedPackages.length} root + ./worker subpath) ` +
    "resolve correctly in both directions, and playground Vite requests @azx/source",
);
