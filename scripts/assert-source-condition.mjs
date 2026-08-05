#!/usr/bin/env node
/**
 * @file Asserts BOTH directions of every publishable package's `exports` block.
 *
 *   with `--conditions=@azx/source` -> src/index.ts   (what this workspace gets)
 *   without it                      -> dist/index.js  (what every consumer gets)
 *
 * This replaces a guard that R1 destroyed. Before R1 the source condition was
 * protected by absence — no `dist/` existed, so losing the condition hard-failed
 * the build. Now the same mistake resolves quietly to `dist/`, killing HMR into
 * library source while CI stays green. AGENTS.md §5 warns that the condition is
 * exactly the kind of thing someone tidies away on a quiet afternoon; this is the
 * gate that catches it.
 *
 * It asserts the `exports` block with Node's own resolver rather than a bundler's,
 * so it is bundler-independent and catches a broken condition AND a broken default
 * in one pass. It can only work once `dist/` exists, which is why it runs after
 * the `build:packages` stage.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = [
  "@azx/ribo-core",
  "@azx/ribo-ui-react",
  "@azx/ribo-adapter-snuggpro",
  "@azx/ribo-extractor-openai",
  "@azx/ribo-transcriber-ondevice",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

const failures = [];

for (const pkg of PACKAGES) {
  for (const [useCondition, expectedSuffix] of [
    [true, "/src/index.ts"],
    [false, "/dist/index.js"],
  ]) {
    const label = useCondition ? "with @azx/source" : "without @azx/source";
    let resolved;
    try {
      resolved = resolveFrom(pkg, useCondition);
    } catch (error) {
      failures.push(`${pkg} (${label}): did not resolve at all — ${error.message.split("\n")[0]}`);
      continue;
    }
    // Suffix, not a full path: Node returns the realpath when the target exists
    // and the symlink path when it does not, so a full-path match would be brittle.
    if (!resolved.endsWith(expectedSuffix)) {
      failures.push(`${pkg} (${label}): expected a path ending ${expectedSuffix}, got ${resolved}`);
    }
  }
}

if (failures.length > 0) {
  console.error("The @azx/source export condition is broken:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nIf the `with` direction failed, check `customConditions` in " +
      "packages/tsconfig/base.json and `resolve.conditions` in playground/vite.config.ts.\n" +
      "If the `without` direction failed, the packages are unbuilt or an `exports` " +
      "default is wrong — run `pnpm build:packages` first.\n" +
      "Background: AGENTS.md §5.1.",
  );
  process.exit(1);
}

console.log(`source condition: ${PACKAGES.length} packages resolve correctly in both directions`);
