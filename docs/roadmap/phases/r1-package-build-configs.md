# R1 — Package Build Configs Implementation Plan

A detailed implementation record for R1 — real tsdown build configs for the five publishable packages. R1 is complete; this is a step-by-step record useful for anyone reproducing the work, not something to read for direction. The [index](../index.md) is where direction lives.

**Goal:** Give the five publishable ribo packages real tsdown builds producing `dist/`, and gates that prove the artifact is valid for a consumer.

**Architecture:** A new private workspace package `@azx/build-config` holds one shared tsdown base plus the syntax floor; each publishable package gets a thin `tsdown.config.ts` that spreads it and declares only its own entries. The floor is generated from browserslist's Baseline query into a committed file, so builds resolve nothing. Three new `check.sh` stages prove the artifact: the packages build, the `@azx/source` condition still resolves both ways, and no tarball carries TypeScript.

**Tech Stack:** pnpm workspaces + catalog · tsdown 0.22.14 (rolldown/oxc) · rolldown-plugin-dts with the `tsc` generator · publint · `@arethetypeswrong/core` · browserslist · Vitest 4 (`unit` project) · TypeScript 6.0.3

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **ESM-only.** `format: ["esm"]`. Never a UMD build — `import.meta.url` is `undefined` there, which silently breaks worker/WASM URL resolution.
- **Exact version pins, no carets, in `pnpm-workspace.yaml`'s `catalog:`.** Do **not** invent version numbers — resolve at install time and pin what you actually got. tsdown is `0.22.14` (pre-1.0, pinned exact per doc 10 §9).
- **`isolatedDeclarations` stays off** and the dts generator is **explicitly `"tsc"`**. zod's `z.infer<typeof Schema>` cannot be emitted otherwise. `packages/tsconfig/base.json` already sets `"isolatedDeclarations": false`.
- **`target` must always be set explicitly.** tsdown's only inference path is `engines.node` → `nodeNN`, which would be wrong for five browser libraries.
- **Externalize React by regex:** `/^react($|\/)/` and `/^react-dom($|\/)/`. A bare `"react"` misses `react/jsx-runtime` and breaks consumer builds.
- **`experimental.resolveNewUrlToAsset` stays off** (the default). Rolldown's tracking issue says it "does not work well when bundling libraries", and off is what lets `new URL("./worker.js", import.meta.url)` pass through verbatim.
- **Entries always use the object form** (`{ index: "src/index.ts" }`), never the array form, so output filenames are stable for subpath exports.
- **`"types"` first** among conditions in any `exports` block (publint enforces it).
- **Relative imports carry the `.js` extension** and type-only imports use `import type` (`verbatimModuleSyntax` + an ESLint rule enforce it).
- **Prettier owns formatting** (`.prettierrc.json`: semicolons, double quotes, trailing commas, 100 columns). Never hand-format; run `pnpm format`.
- **Every new package needs a `"typecheck"` script.** `pnpm -r --parallel typecheck` only runs in packages that define it, so a package without one is silently absent from the gate.
- **`./check.sh` green is the definition of done**, and its summary line gets pasted rather than asserted.

---

## Task 1: `@azx/build-config` and the oxc target mapper

Creates the shared-config package and the one piece of real logic in R1: translating browserslist output into the tokens oxc accepts. Pure function, TDD'd, no tsdown dependency yet — so this task can't be blocked by build-tool surprises.

**Files:**

- Create: `packages/build-config/package.json`
- Create: `packages/build-config/tsconfig.json`
- Create: `packages/build-config/src/target.ts`
- Test: `packages/build-config/src/target.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `toOxcTargets(browsers: readonly string[]): string[]` from `packages/build-config/src/target.ts` — takes raw browserslist output (`["chrome 121", "and_chr 150", …]`) and returns sorted oxc tokens (`["chrome121", …]`). Task 2 calls it.

**Why `src/`:** the root Vitest `unit` project's include glob is `packages/*/src/**/*.test.{ts,tsx}`. Logic outside a package's `src/` is never discovered, so it would be untested.

- **Step 1: Create the package manifest**

`packages/build-config/package.json`:

```json
{
  "name": "@azx/build-config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@azx/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

Three things to note. It is `private: true` and never published, so `exports` points straight at TypeScript source — none of the `@azx/source` machinery applies. `@azx/tsconfig` must be in `devDependencies` even though it is only referenced from `tsconfig.json`; AGENTS.md §6.2 records that this bug has already shipped once. `vitest` is here because `src/target.test.ts` imports from it and that import must type-resolve during this package's own `tsc --noEmit`.

- **Step 2: Create the tsconfig**

`packages/build-config/tsconfig.json`:

```jsonc
{
  "extends": "@azx/tsconfig/base.json",
  "compilerOptions": {
    // This package's code runs in NODE at build time — it is a tsdown config
    // factory, never shipped code. It also imports tsdown's types, which reach
    // through to rolldown's, and those use `Symbol.asyncDispose`, absent from
    // base.json's ES2023 lib. Same two widenings, for the same reason, as
    // playground/tsconfig.node.json (AGENTS.md §5.3). Scoped here so base.json
    // stays the environment-free root of the config chain.
    "types": ["node"],
    "lib": ["ESNext"],
  },
  "include": ["src"],
}
```

- **Step 3: Write the failing test**

`packages/build-config/src/target.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { toOxcTargets } from "./target.js";

describe("toOxcTargets", () => {
  test("keeps the lowest version per family", () => {
    expect(toOxcTargets(["chrome 150", "chrome 121", "chrome 135"])).toEqual(["chrome121"]);
  });

  test("drops Android families, which browserslist reports as current-only", () => {
    // This is the real shape of `baseline widely available`: and_chr reports only 150
    // while desktop chrome goes down to 121. Folding and_chr into a per-family minimum
    // would emit chrome150 — a floor high enough to break every device the target
    // exists to protect. Neither and_chr nor and_ff has an oxc token, and desktop
    // Chrome/Firefox already bind the same syntax.
    expect(toOxcTargets(["chrome 121", "and_chr 150", "and_ff 152"])).toEqual(["chrome121"]);

    // The assertion above documents the real shape but cannot FAIL under the bug: with
    // and_chr folded into chrome, min(121, 150) is still 121. These two use an Android
    // version BELOW its desktop counterpart, so folding would yield chrome115 / firefox118
    // and the test breaks — which is what makes the guard real. The inputs are synthetic
    // (browserslist reports Android above desktop); that is fine, this is a unit test of
    // the mapping, not of browserslist.
    expect(toOxcTargets(["chrome 121", "and_chr 115"])).toEqual(["chrome121"]);
    expect(toOxcTargets(["firefox 122", "and_ff 118"])).toEqual(["firefox122"]);
  });

  test("takes the low end of a version range", () => {
    expect(toOxcTargets(["safari 18.5-18.7"])).toEqual(["safari18.5"]);
  });

  test("compares versions numerically, not lexically", () => {
    // "16.10" sorts BELOW "16.4" as a string, and parseFloat reads it as 16.1.
    // Either bug would publish a floor two minors too high.
    expect(toOxcTargets(["safari 16.10", "safari 16.4"])).toEqual(["safari16.4"]);
  });

  test("maps ios_saf to oxc's ios token", () => {
    expect(toOxcTargets(["ios_saf 17.2"])).toEqual(["ios17.2"]);
  });

  test("ignores families oxc has no token for", () => {
    expect(toOxcTargets(["op_mob 80", "kaios 3.0", "chrome 121"])).toEqual(["chrome121"]);
  });

  test("returns tokens sorted, so the generated file is deterministic", () => {
    expect(toOxcTargets(["safari 17.2", "chrome 121", "edge 121"])).toEqual([
      "chrome121",
      "edge121",
      "safari17.2",
    ]);
  });

  test("returns nothing for an empty query result", () => {
    expect(toOxcTargets([])).toEqual([]);
  });
});
```

- **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run packages/build-config`
Expected: FAIL — cannot resolve `./target.js`.

- **Step 5: Write the implementation**

`packages/build-config/src/target.ts`:

```ts
/**
 * @file Translates browserslist output into the tokens oxc accepts.
 *
 * tsdown reads no browserslist config of its own — verified by inspection of
 * `resolveTarget` in tsdown 0.22.14, whose only inference path is `engines.node`
 * — so the query result has to be translated here. Called only by
 * `scripts/refresh-target.mjs`; builds read the generated tokens and never run
 * this. See docs/roadmap/design/2026-08-04-r1-package-build-configs-design.md §3.
 */

/**
 * browserslist family name -> oxc target name.
 *
 * `and_chr` and `and_ff` are deliberately absent, and that omission is
 * load-bearing rather than an oversight — see the test that covers it. Neither
 * has an oxc token, and browserslist reports Chrome and Firefox for Android as
 * current-only, so folding them into a per-family minimum raises the floor to
 * the newest shipping version. Desktop Chrome and Firefox bind the same syntax,
 * so dropping them costs nothing.
 */
const OXC_FAMILY: Readonly<Record<string, string>> = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  safari: "safari",
  ios_saf: "ios",
};

/** Segment-wise numeric compare. Negative when `a` is the lower version. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Reduces raw browserslist output (`["chrome 121", "safari 18.5-18.7", …]`) to
 * one sorted oxc token per family, at that family's lowest supported version.
 */
export function toOxcTargets(browsers: readonly string[]): string[] {
  const lowest = new Map<string, string>();

  for (const entry of browsers) {
    const [family, range] = entry.split(" ");
    if (family === undefined || range === undefined) continue;

    const token = OXC_FAMILY[family];
    if (token === undefined) continue;

    // browserslist collapses adjacent releases into "18.5-18.7"; the low end is
    // the floor we must support.
    const version = range.split("-")[0];
    if (version === undefined) continue;

    const incumbent = lowest.get(token);
    if (incumbent === undefined || compareVersions(version, incumbent) < 0) {
      lowest.set(token, version);
    }
  }

  // Sorted so the generated file is byte-stable regardless of browserslist's
  // output ordering — otherwise a reordering upstream looks like a real diff.
  return [...lowest].map(([token, version]) => `${token}${version}`).sort();
}
```

- **Step 6: Register the workspace member and run the tests**

Run: `pnpm install && pnpm vitest run packages/build-config`
Expected: PASS, 8 tests. `packages/*` is already a workspace glob, so `pnpm install` discovers the directory with no config edit.

- **Step 7: Verify typecheck, lint and format**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all pass. `pnpm typecheck` now prints `Scope: 8 of 9 workspace projects` (it was 7 of 8) — the new member is the difference, and Task 10 updates AGENTS.md §2 to match.

- **Step 8: Commit**

```bash
git add packages/build-config pnpm-lock.yaml
git commit -m "feat(build-config): add @azx/build-config with the oxc target mapper"
```

---

## Task 2: Generate and commit the syntax floor

Turns browserslist's Baseline query into a committed constant, the way Vite generates its own. After this task the floor exists as data; nothing consumes it yet.

**Files:**

- Create: `scripts/refresh-target.mjs`
- Create: `packages/build-config/src/target.generated.ts` (written by the script, committed)
- Test: `packages/build-config/src/target.generated.test.ts`
- Modify: `pnpm-workspace.yaml` (catalog: add `browserslist`)
- Modify: `package.json` (root: add `browserslist` devDependency and the `target:refresh` script)

**Interfaces:**

- Consumes: `toOxcTargets` from Task 1.
- Produces: `BROWSER_TARGET: string[]` exported from `packages/build-config/src/target.generated.ts`. Task 3 re-exports it and feeds it to tsdown's `target`. Typed `string[]` rather than `readonly string[]` so it is assignable to tsdown's `target` option without a spread at every use site.

- **Step 1: Add browserslist to the catalog**

In `pnpm-workspace.yaml`, inside the `catalog:` block's `# --- toolchain ---` section, add:

```yaml
# Resolves the Baseline syntax floor for the library builds. Used ONLY by
# scripts/refresh-target.mjs — never at build time, which reads the committed
# tokens in packages/build-config/src/target.generated.ts.
#
# Already present transitively (vite-plugin-pwa -> workbox-build ->
# @babel/preset-env), but declared explicitly rather than leaned on: see the
# rxjs entry above and the Phase 1 zod incident it references.
browserslist: "4.28.7"
```

Resolve the actual version at install time and pin what you got — `4.28.7` is what was in the lockfile when this plan was written, and matching it avoids adding a second copy.

- **Step 2: Add the root devDependency and script**

In the root `package.json`, add `"browserslist": "catalog:"` to `devDependencies`, and to `scripts`:

```json
"target:refresh": "node scripts/refresh-target.mjs"
```

- **Step 3: Write the generator script**

`scripts/refresh-target.mjs`:

```js
#!/usr/bin/env node
/**
 * @file Regenerates packages/build-config/src/target.generated.ts.
 *
 * Run with `pnpm target:refresh`. Deliberately NOT run by check.sh or CI:
 * regenerating is an intentional act, like `update-browserslist-db`, so the
 * published syntax floor lands in a reviewable diff instead of drifting with the
 * lockfile's caniuse-lite. See the R1 design spec §3.
 *
 * This file stays thin on purpose. All the real logic lives in the typechecked,
 * unit-tested `toOxcTargets`; nothing under scripts/ is covered by a tsconfig.
 *
 * It imports that module with an explicit `.ts` specifier because Node 24 strips
 * types natively but does no extension substitution — `./target.js` would not
 * exist on disk. The module is plain types-and-functions, so stripping applies
 * cleanly.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import browserslist from "browserslist";

import { toOxcTargets } from "../packages/build-config/src/target.ts";

/**
 * Baseline "widely available" — a feature set every major browser has supported
 * for 30 months. Chosen over tsdown's own `baseline-widely-available` token
 * because that token expands to a snapshot hardcoded in tsdown (and, identically,
 * in Vite) which was roughly ten Chrome majors stale. See the design spec §3.1.
 */
const QUERY = "baseline widely available";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(repoRoot, "packages/build-config/src/target.generated.ts");

const require = createRequire(import.meta.url);
// caniuse-lite is browserslist's own direct dependency, so resolve it THROUGH
// browserslist. Resolving it from the repo root fails under pnpm's strict layout,
// where only declared dependencies are visible.
const browserslistPkgPath = require.resolve("browserslist/package.json");
const browserslistVersion = require(browserslistPkgPath).version;
const caniuseVersion = createRequire(browserslistPkgPath)("caniuse-lite/package.json").version;

const targets = toOxcTargets(browserslist(QUERY));

if (targets.length === 0) {
  throw new Error(
    `browserslist("${QUERY}") produced no oxc-mappable targets. Refusing to write an empty floor.`,
  );
}

const resolvedOn = new Date().toISOString().slice(0, 10);

const contents = `// GENERATED by \`pnpm target:refresh\` — do not edit by hand.
//
// Query:        ${QUERY}
// Resolved:     ${resolvedOn}
// browserslist: ${browserslistVersion}
// caniuse-lite: ${caniuseVersion}
//
// This is the SYNTAX floor handed to tsdown, and it is deliberately LOWER than
// the support matrix in docs/implementation/10-build-and-packaging.md §2.1. The
// error directions are not symmetric: a floor below real support only costs bytes
// through extra downleveling, while a floor above it breaks a supported device we
// cannot hot-fix. See the R1 design spec §3.3.

/** Oxc-style target tokens. Typed \`string[]\` for assignability to tsdown's \`target\`. */
export const BROWSER_TARGET: string[] = ${JSON.stringify(targets, null, 2)};
`;

writeFileSync(outFile, contents, "utf8");

// Prettier owns formatting and format:check is a check.sh stage, so normalize the
// generated file rather than hand-matching the repo's style in a template string.
execFileSync("pnpm", ["prettier", "--write", path.relative(repoRoot, outFile)], {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log(`target:refresh -> ${targets.join(", ")}`);
```

- **Step 4: Install and run the generator**

Run: `pnpm install && pnpm target:refresh`
Expected: prints `target:refresh -> chrome…, edge…, firefox…, ios…, safari…` and creates `packages/build-config/src/target.generated.ts`. When this plan was written the query resolved to `chrome121, edge121, firefox122, ios17.2, safari17.2`; do not treat those numbers as expected output — the point of generating is that they move.

- **Step 5: Write the test for the generated artifact**

This guards the artifact's _shape_, never specific versions — pinning versions here would make the test fail on every legitimate regeneration.

`packages/build-config/src/target.generated.test.ts`:

```ts
import { expect, test } from "vitest";

import { BROWSER_TARGET } from "./target.generated.js";

test("the generated floor is not empty", () => {
  // An empty target silently disables all downleveling, which would look like a
  // successful build while publishing whatever syntax the source happened to use.
  expect(BROWSER_TARGET.length).toBeGreaterThan(0);
});

test("every token is an oxc family followed by a version", () => {
  for (const token of BROWSER_TARGET) {
    expect(token).toMatch(/^(chrome|edge|firefox|safari|ios)\d+(\.\d+)*$/);
  }
});

test("no browserslist family name leaked through unmapped", () => {
  // and_chr/and_ff are current-only; if either reaches the floor, the mapping in
  // target.ts regressed and the floor is far too high.
  for (const token of BROWSER_TARGET) {
    expect(token).not.toMatch(/^and_/);
  }
});

test("one token per family", () => {
  const families = BROWSER_TARGET.map((t) => t.replace(/[\d.]+$/, ""));
  expect(new Set(families).size).toBe(families.length);
});
```

- **Step 6: Run the tests**

Run: `pnpm vitest run packages/build-config`
Expected: PASS, 12 tests (8 from Task 1, 4 new).

- **Step 7: Verify the repo gates still pass**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all pass. If `format:check` flags `target.generated.ts`, the Prettier call in Step 3 did not run — fix the script rather than hand-formatting the output.

- **Step 8: Commit**

```bash
git add scripts/refresh-target.mjs packages/build-config/src/target.generated.ts \
        packages/build-config/src/target.generated.test.ts \
        package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(build-config): generate the Baseline syntax floor from browserslist"
```

---

## Task 3: The shared tsdown base, and the first package that builds

The highest-risk task in the plan, deliberately scoped to one package so the risks surface once rather than five times: whether tsdown's config loader can import a TypeScript workspace dependency, whether declaration emit works against a tsconfig that sets `noEmit: true`, and whether publint/attw tolerate the `@azx/source` condition.

**Files:**

- Create: `packages/build-config/src/index.ts`
- Create: `packages/ribo-core/tsdown.config.ts`
- Modify: `packages/build-config/package.json` (add the `tsdown` devDependency for its types)
- Modify: `packages/ribo-core/package.json` (add the `build` script and four devDependencies)
- Modify: `pnpm-workspace.yaml` (catalog: add `tsdown`, `publint`, `@arethetypeswrong/core`)

**Interfaces:**

- Consumes: `BROWSER_TARGET` from Task 2.
- Produces: `sharedTsdown: UserConfig` from `@azx/build-config`, and `BROWSER_TARGET` re-exported from the same entry. Tasks 4, 5 and 9 spread `sharedTsdown` into their configs. The type is tsdown's `UserConfig` — **not** `Options`, which is internal and not exported.

- **Step 1: Add the toolchain to the catalog**

In `pnpm-workspace.yaml`'s `# --- toolchain ---` section:

```yaml
# The library build tool for all five publishable packages. Pinned EXACT and
# not carets: tsdown is pre-1.0 and ships several times a week, so the residual
# risk is API churn from healthy development (doc 10 §9). Declares
# `typescript: "^5 || ^6 || ^7"`, so it is fine with the TS 6.0.3 hold above.
tsdown: "0.22.14"
# Both are OPTIONAL PEERS of tsdown, not independent tools: tsdown runs them
# in-build when `publint: { strict: true }` / `attw: { profile: "esm-only",
# level: "error" }` are set (`esm-only`, not a bare `true`: the default
# `strict` profile reports node10/CJS resolution failures that are expected
# for a deliberately ESM-only package; `level: "error"` is required because
# tsdown's default `level: "warn"` with `failOnWarn: false` exits 0), so a bad
# exports block fails the build that produced it. Note this is
# @arethetypeswrong/CORE — the `cli` package is a different thing and is not
# what tsdown peers on.
publint: "0.3.23"
"@arethetypeswrong/core": "0.18.5"
```

Resolve all three at install time within tsdown's declared peer ranges (`publint: ^0.3.8`, `@arethetypeswrong/core: ^0.18.1`) and pin what you got.

- **Step 2: Add tsdown to `@azx/build-config` for its types**

In `packages/build-config/package.json`, add to `devDependencies`:

```json
"tsdown": "catalog:"
```

- **Step 3: Write the shared base**

`packages/build-config/src/index.ts`:

```ts
/**
 * @file The one tsdown configuration shared by every publishable package.
 *
 * Each package's `tsdown.config.ts` spreads this and adds only its own `entry`.
 * Keeping the settings here is what makes "one build tool, one syntax target"
 * true rather than aspirational — five inlined copies of the floor is exactly the
 * drift R1 exists to remove.
 *
 * Do not "simplify" the explicit settings below. Every one of them overrides a
 * default that would be wrong for a browser library, and two of them defuse
 * silent footguns. See docs/roadmap/design/2026-08-04-r1-package-build-configs-design.md.
 */
import type { UserConfig } from "tsdown";

import { BROWSER_TARGET } from "./target.generated.js";

export { BROWSER_TARGET };

export const sharedTsdown: UserConfig = {
  // tsdown defaults to `node`. All five packages are browser libraries.
  platform: "browser",

  // ESM-only. Dual-publishing invites the dual-package hazard, which is fatal
  // for a React library carrying context. NEVER add a UMD format: `import.meta.url`
  // is `undefined` there, which silently breaks worker and WASM URL resolution.
  format: ["esm"],

  // ALWAYS explicit. tsdown's only inference path is `engines.node` -> `nodeNN`,
  // so the day someone adds `engines` as publishing metadata, five browser
  // libraries would silently start targeting Node.
  target: BROWSER_TARGET,

  dts: {
    // ALSO always explicit. rolldown-plugin-dts infers `'tsgo'` — the experimental
    // TypeScript Go compiler, which "may not support all TypeScript features yet"
    // — whenever TypeScript 7 is installed. Doc 10 §9 calls TS 7 a fast-follow, so
    // that bump is coming, and it must not quietly change how our types are built.
    // `'oxc'` is equally wrong here: it requires isolatedDeclarations, which zod's
    // `z.infer<typeof Schema>` cannot satisfy (base.json turns it off for this
    // reason, and doc 10 §3.1 records one package hitting 374 errors).
    generator: "tsc",
    // Declaration maps are OFF. Their `sources` point at `../src/*.ts`, but
    // `files: ["dist"]` (and the tarball gate) deliberately exclude `src/` from
    // every published tarball, so a consumer's "Go to Definition" on any ribo
    // type would target a path absent from the package — a broken affordance,
    // worse than shipping no map. Inlining `sourcesContent` was rejected: it
    // bloats the tarball and effectively ships source. JS sourcemaps below are
    // unaffected — they ship WITH `sourcesContent` and resolve in the consumer's
    // debugger. The top-level `sourcemap: true` is forced on by `declarationMap`
    // in `packages/tsconfig/base.json`, so this MUST be set on the `dts` block
    // specifically, not by changing the top-level flag.
    sourcemap: false,
  },

  // React must be externalized BY REGEX. A bare "react" does not match
  // `react/jsx-runtime`, and missing it breaks consumer builds. tsdown already
  // externalizes `dependencies` and `peerDependencies`; this is belt-and-braces
  // for the subpath case.
  deps: { neverBundle: [/^react($|\/)/, /^react-dom($|\/)/] },

  sourcemap: true,

  // The host minifies. A minified library only obstructs their debugging.
  minify: false,

  // Optional tsdown peers, run in-build so a bad package contract fails the build
  // that produced it rather than a later CI step. Both are set to FAIL the build:
  // publint with `{ strict: true }` (warnings and suggestions are fatal, matching
  // the `publint --strict` the CI TODO this branch replaced), and attw with
  // `level: "error"` (tsdown's default `level: "warn"` with `failOnWarn: false`
  // prints WARN and exits 0; only `logger.error` sets `process.exitCode = 1`).
  publint: { strict: true },
  // `esm-only`, not a bare `true`: attw's default profile resolves under Node10
  // and Node16 (CJS) too, which reports `No resolution (node10)` and `CJS
  // resolves to ESM (node16-cjs)` for a deliberately ESM-only package.
  attw: { profile: "esm-only", level: "error" },

  // NOTE what is deliberately absent: `experimental.resolveNewUrlToAsset`.
  // Rolldown's own tracking issue says it "does not work well when bundling
  // libraries". With it off (the default) `new URL("./worker.js", import.meta.url)`
  // passes through roughly verbatim, which is what native ESM and webpack 5
  // statically analyze. Doc 10 §3.1.
};
```

- **Step 4: Write ribo-core's config**

`packages/ribo-core/tsdown.config.ts`:

```ts
import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  // Object form, not the array form: it makes the output filename explicit rather
  // than trusting tsdown's name derivation, which the `exports` block depends on.
  entry: { index: "src/index.ts" },
});
```

- **Step 5: Add the build script and devDependencies**

In `packages/ribo-core/package.json`, add to `scripts`:

```json
"build": "tsdown"
```

and to `devDependencies`:

```json
"@arethetypeswrong/core": "catalog:",
"@azx/build-config": "workspace:*",
"publint": "catalog:",
"tsdown": "catalog:"
```

All four are per-package rather than root-level because pnpm does not hoist: `pnpm run build` inside a package resolves the `tsdown` binary from that package's own `node_modules/.bin`, and tsdown resolves its optional peers the same way.

`tsdown.config.ts` is deliberately **not** added to this package's `tsconfig.json` `include` (which stays `["src"]`). Typechecking it would pull tsdown's Node-flavored types into a `browser-library.json` config; the build itself validates the config, so the coverage gap is not real.

- **Step 6: Install and build**

Run: `pnpm install && pnpm --filter @azx/ribo-core build`
Expected: a successful build. Read the log for the line `target: chrome…, edge…, …` — tsdown prints the resolved floor on every build, which is how the syntax floor stays observable even though it is not reviewable in advance.

**If it fails at config load** (tsdown cannot import `@azx/build-config` because it is TypeScript inside `node_modules`), this is design-spec risk 6. Convert `@azx/build-config` to ship plain JavaScript: rename `src/index.ts` to `src/index.mjs`, hand-write `src/index.d.mts` declaring `sharedTsdown: UserConfig` and `BROWSER_TARGET: string[]`, and point `exports` at `{ "types": "./src/index.d.mts", "default": "./src/index.mjs" }`. Nothing else in the plan changes — `target.ts` and `target.generated.ts` stay TypeScript, since only the tsdown-loaded entry has this constraint.

**If declarations are missing** from `dist/`, it is `base.json`'s `"noEmit": true`. Add to the `dts` block in `packages/build-config/src/index.ts`:

```ts
    compilerOptions: { noEmit: false },
```

- **Step 7: Verify the artifact by inspection**

Run:

```bash
ls -la packages/ribo-core/dist/
cd playground && node --input-type=module \
  -e 'import("@azx/ribo-core").then(m => console.log(Object.keys(m).length + " exports"))'; cd ..
```

Expected: `dist/` contains `index.js`, `index.js.map`, `index.d.ts`; the import prints a non-zero export count.

The import runs from `playground/` deliberately, and this is not incidental: with no `--conditions` flag it resolves to `dist/index.js` (the consumer path), and `playground/node_modules` is where `rxdb`, `rxjs` and `zod` actually resolve from. Running the same import from the repo root fails — pnpm makes only declared dependencies visible, and the libraries' runtime dependencies are not root dependencies. So this doubles as the first real proof that the built artifact loads.

Confirm `rxdb`, `rxjs` and `zod` are **not** bundled — they are `dependencies` and tsdown externalizes those automatically:

```bash
grep -c 'from"rxdb\|from "rxdb' packages/ribo-core/dist/index.js
```

Expected: at least 1 — an import, not an inlined copy.

- **Step 8: Confirm publint and attw ran clean**

The build log must show publint and attw reporting on `@azx/ribo-core`. If either complains that `exports` references a file missing from the published tarball, that is design-spec risk 5.1 — the `@azx/source` condition pointing at `./src/index.ts`, which is not in `files: ["dist"]`. The fix is to make the tools read the `publishConfig`-resolved manifest (pnpm applies `publishConfig` at pack time, and its `exports` carry no `@azx/source` branch), by setting `pack: "pnpm"` in the publint/attw options:

```ts
  publint: { pack: "pnpm" },
  attw: { pack: "pnpm" },
```

Do **not** suppress the rule instead — it is reporting a real fact about a manifest we are choosing to resolve differently.

- **Step 9: Verify the playground still resolves to source**

This is the one thing R1 must not break: `dist/` now exists, so the source condition has something to lose to.

Run: `pnpm --filter playground build`
(The `build:app` script does not exist until Task 6; the filter form is what it will wrap.)
Expected: PASS. Then confirm resolution still prefers source:

```bash
cd playground && node --input-type=module --conditions=@azx/source \
  -e 'process.stdout.write(import.meta.resolve("@azx/ribo-core")+"\n")'
```

Expected: a path ending `/packages/ribo-core/src/index.ts`. Task 7 turns this into a gate.

- **Step 10: Run the full check**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all pass.

- **Step 11: Commit**

```bash
git add packages/build-config packages/ribo-core/tsdown.config.ts \
        packages/ribo-core/package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(ribo-core): add the tsdown build over a shared @azx/build-config base"
```

---

## Task 4: Build configs for the three remaining headless packages

Repeats Task 3's now-proven pattern across `ribo-adapter-snuggpro`, `ribo-extractor-openai` and `ribo-ui-react`, and makes the manifest fix that `ribo-ui-react`'s build forces.

**Files:**

- Create: `packages/ribo-adapter-snuggpro/tsdown.config.ts`
- Create: `packages/ribo-extractor-openai/tsdown.config.ts`
- Create: `packages/ribo-ui-react/tsdown.config.ts`
- Modify: `packages/ribo-adapter-snuggpro/package.json`
- Modify: `packages/ribo-extractor-openai/package.json`
- Modify: `packages/ribo-ui-react/package.json` (build script, devDependencies, **and** the `styles.css` removal)

**Interfaces:**

- Consumes: `sharedTsdown` from Task 3.
- Produces: `dist/` for three more packages. No new code interfaces.

- **Step 1: Write the three configs**

All three are identical apart from the file they live in. `packages/ribo-adapter-snuggpro/tsdown.config.ts`:

```ts
import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  entry: { index: "src/index.ts" },
});
```

`packages/ribo-extractor-openai/tsdown.config.ts`:

```ts
import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  entry: { index: "src/index.ts" },
});
```

`packages/ribo-ui-react/tsdown.config.ts`:

```ts
import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  entry: { index: "src/index.ts" },
});
```

`ribo-ui-react` needs no React-specific settings: `sharedTsdown` already externalizes React by regex, and the package's `tsconfig.json` extends `react-library.json`, which is where `jsx: "react-jsx"` comes from.

- **Step 2: Add the build script and devDependencies to all three**

To each of `packages/ribo-adapter-snuggpro/package.json`, `packages/ribo-extractor-openai/package.json` and `packages/ribo-ui-react/package.json`, add to `scripts`:

```json
"build": "tsdown"
```

and to `devDependencies`:

```json
"@arethetypeswrong/core": "catalog:",
"@azx/build-config": "workspace:*",
"publint": "catalog:",
"tsdown": "catalog:"
```

- **Step 3: Remove the stylesheet subpath from `ribo-ui-react`**

Forced by the build, not a preference: MVP design §5.7 makes this package a **headless hook layer** with no markup and no stylesheet, so `dist/styles.css` will never be produced, and publint fails a subpath pointing at a file that does not exist.

In `packages/ribo-ui-react/package.json`, delete the `"./styles.css": "./dist/styles.css"` line from **both** `exports` and `publishConfig.exports`, and change `sideEffects` from `["*.css"]` to `false`. The resulting blocks:

```jsonc
{
  "sideEffects": false,
  "exports": {
    ".": {
      "@azx/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js",
    },
    "./package.json": "./package.json",
  },
  "publishConfig": {
    "access": "restricted",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js",
      },
      "./package.json": "./package.json",
    },
  },
}
```

Leave `peerDependencies` alone — React stays `^18.3 || ^19`, mirrored in `devDependencies` as `catalog:`. Hooks are still React, and §5.7 keeps this unchanged. Everything _inside_ the package remains R2's work; this task touches only the manifest.

- **Step 4: Install and build all four packages built so far**

Run: `pnpm install && pnpm -r --filter "./packages/*" build`
Expected: four successful builds (`ribo-core`, `ribo-adapter-snuggpro`, `ribo-extractor-openai`, `ribo-ui-react`), each printing its resolved target and a clean publint/attw report. pnpm orders these topologically off the existing `workspace:` deps, so `ribo-core` builds before the packages that declare it.

- **Step 5: Verify each artifact**

Run:

```bash
for p in ribo-adapter-snuggpro ribo-extractor-openai ribo-ui-react; do
  echo "== $p"; ls packages/$p/dist/
done
```

Expected: each has `index.js`, `index.js.map`, `index.d.ts`. Confirm no stylesheet was emitted and React was not bundled into the UI package:

```bash
test ! -e packages/ribo-ui-react/dist/styles.css && echo "no stylesheet: correct"
grep -c 'jsx-runtime' packages/ribo-ui-react/dist/index.js
```

Expected: the first prints `no stylesheet: correct`. The second is `0` or shows an _import_ of `react/jsx-runtime` — never an inlined copy of React. (`ribo-ui-react` exports one constant until R2, so a `0` here is expected and fine.)

- **Step 6: Run the full check**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all pass.

- **Step 7: Commit**

```bash
git add packages/ribo-adapter-snuggpro packages/ribo-extractor-openai \
        packages/ribo-ui-react pnpm-lock.yaml
git commit -m "feat: add tsdown builds for the adapter, extractor and ui-react packages

ribo-ui-react also drops its ./styles.css subpath and switches sideEffects to
false: the headless-hooks decision means no stylesheet is ever produced, and
publint fails a subpath pointing at a nonexistent file."
```

---

## Task 5: `ribo-transcriber-ondevice`, with the worker entry

Separated from Task 4 because this package's build has failure modes none of the others do: a second entry whose filename an `exports` subpath depends on, a shared chunk between the two entries, and `src/` files that must not reach `dist/`.

**Files:**

- Create: `packages/ribo-transcriber-ondevice/tsdown.config.ts`
- Modify: `packages/ribo-transcriber-ondevice/package.json`

**Interfaces:**

- Consumes: `sharedTsdown` from Task 3.
- Produces: `dist/index.js`, `dist/index.d.ts`, `dist/worker.js`, `dist/worker.d.ts`. The last two are what the package's existing `./worker` subpath export already points at.

- **Step 1: Write the config**

`packages/ribo-transcriber-ondevice/tsdown.config.ts`:

```ts
import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

export default defineConfig({
  ...sharedTsdown,
  // The object form is REQUIRED here, not merely preferred: the package's
  // `./worker` export points at `./dist/worker.js`, so the output filename is
  // part of the published contract. The array form would leave that filename to
  // tsdown's name derivation.
  //
  // The worker ships as a plain published entry — and never as a `?worker`
  // import — because Vite's library-mode worker bug (vitejs/vite#15618) emits an
  // absolute path that 404s in the consumer's app, in production only. That is a
  // failure that passes every check we run and breaks at the host. Consumers
  // construct the worker themselves via the injected `createWorker` factory. See
  // AGENTS.md §5.2 and doc 10 §4.
  entry: { index: "src/index.ts", worker: "src/worker.ts" },
});
```

- **Step 2: Add the build script and devDependencies**

In `packages/ribo-transcriber-ondevice/package.json`, add `"build": "tsdown"` to `scripts` and to `devDependencies`:

```json
"@arethetypeswrong/core": "catalog:",
"@azx/build-config": "workspace:*",
"publint": "catalog:",
"tsdown": "catalog:"
```

- **Step 3: Install and build**

Run: `pnpm install && pnpm --filter @azx/ribo-transcriber-ondevice build`
Expected: a successful build with a clean publint/attw report.

- **Step 4: Verify both entries and the shared chunk**

Run:

```bash
ls packages/ribo-transcriber-ondevice/dist/
grep -o "from\"[^\"]*\"\|from '[^']*'" packages/ribo-transcriber-ondevice/dist/worker.js | sort -u
```

Expected: `dist/` contains `index.js`, `index.d.ts`, `worker.js`, `worker.d.ts` and their sourcemaps, plus very likely a shared chunk file. `src/index.ts` and `src/worker.ts` both import `protocol.ts` and `config.ts`, so code-splitting hoists the common code and **`dist/worker.js` is not self-contained** — it carries a sibling import. That is expected and acceptable for a `{type: "module"}` worker (doc 10 §3.1).

What must be true: every import in `worker.js` is either a **relative** specifier resolving to a file that exists in `dist/`, or a bare specifier for a declared dependency (`@huggingface/transformers`). An absolute path or a specifier escaping `dist/` is a bug — that is the class of failure that only shows up in a consumer's production build. Verify each relative import exists:

```bash
cd packages/ribo-transcriber-ondevice/dist && \
  grep -o "from\"\./[^\"]*\"" worker.js | sed 's/from"//;s/"//' | while read -r f; do
    test -e "$f" && echo "ok: $f" || echo "MISSING: $f"
  done
```

Expected: every line begins `ok:`.

- **Step 5: Verify nothing extraneous reached `dist/`**

The package's `src/` holds `prime.manual.ts`, `transcribe.manual.ts`, `*.test.ts` files and `assets.d.ts` (an ambient `declare module "*.wav?url"`). Only the two declared entries and their reachable imports should be published.

Run:

```bash
ls packages/ribo-transcriber-ondevice/dist/ | grep -iE 'manual|test' || echo "no manual/test output: correct"
grep -rl 'wav?url' packages/ribo-transcriber-ondevice/dist/ || echo "no asset declaration leak: correct"
```

Expected: both print their `correct` message.

- **Step 6: Run the full check**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all pass.

- **Step 7: Commit**

```bash
git add packages/ribo-transcriber-ondevice pnpm-lock.yaml
git commit -m "feat(transcriber-ondevice): add the tsdown build with the worker entry"
```

---

## Task 6: Root build scripts and the `check.sh` restructure

All five packages build individually; this makes "build the workspace" mean something, and splits `check.sh`'s single `build` stage so a library failure and an app-bundling failure are distinguishable.

**Files:**

- Modify: `package.json` (root scripts)
- Modify: `check.sh`

**Interfaces:**

- Consumes: the five `build` scripts from Tasks 3–5.
- Produces: root scripts `build:packages` and `build:app`; `build` becomes their composition. Tasks 7 and 8 add stages after `build:packages`.

- **Step 1: Split the root build scripts**

In the root `package.json`, replace `"build": "pnpm --filter playground build"` with:

```json
"build:packages": "pnpm -r --filter \"./packages/*\" build",
"build:app": "pnpm --filter playground build",
"build": "pnpm build:packages && pnpm build:app",
```

`pnpm -r` already respects topological order via the existing `workspace:` deps, so no task runner is needed — doc 10 §9 says cut Turborepo first, and at five packages it earns nothing. `@azx/tsconfig` and `@azx/build-config` define no `build` script, so `pnpm -r` skips them silently.

- **Step 2: Replace the single build stage in `check.sh`**

Replace this block:

```bash
# The playground's production build is the only gate that exercises Vite's
# resolver, the `@azx/source` condition, the JSX transform, React dedup and
# real bundling. `tsc` cannot see any of that. It runs after the cheap static
# gates (so their output is not buried) and before `test`, because a module
# resolution failure explains most test failures that would follow it.
run_stage "build" pnpm build
```

with:

```bash
# Two build stages, not one, so a failure is attributable: a library build that
# cannot emit is a different diagnosis from an app that cannot bundle.
#
# `build:packages` produces every publishable `dist/` and runs publint + attw
# in-build, so a broken `exports` block fails here rather than in a later job.
run_stage "build:packages" pnpm build:packages
# The playground's production build is the only gate that exercises Vite's
# resolver, the `@azx/source` condition, the JSX transform, React dedup and
# real bundling. `tsc` cannot see any of that. Both run after the cheap static
# gates (so their output is not buried) and before `test`, because a module
# resolution failure explains most test failures that would follow.
run_stage "build:app" pnpm build:app
```

- **Step 3: Update the summary line**

In `check.sh`, change the PASS message so it lists the real stages:

```bash
  printf 'check.sh: PASS — typecheck, lint, format:check, build:packages, build:app, test\n'
```

- **Step 4: Run the full check**

Run: `./check.sh`
Expected: `check.sh: PASS — typecheck, lint, format:check, build:packages, build:app, test`. Paste the summary line rather than asserting success.

- **Step 5: Commit**

```bash
git add package.json check.sh
git commit -m "build: split the build into build:packages and build:app in check.sh"
```

---

## Task 7: The source-condition resolver assertion

R1 removes a safety net and this replaces it. Until now the `@azx/source` condition was protected by absence: AGENTS.md §7 verifies it with "`dist/` does not exist yet, so a bundle containing these strings can only have come from `src/`", and deleting `resolve.conditions` from `playground/vite.config.ts` made the build hard-fail on a missing file. Now that `dist/` exists, that same deletion silently resolves to `dist/index.js` — HMR into library source dies, CI stays green, nobody finds out for weeks. That is precisely the AGENTS.md §5 "tidied away on a quiet afternoon" failure, aimed at the mechanism §5 warns about most.

The gate has two complementary checks. First, it derives the publishable packages from the workspace (and fails loudly if that set is not the expected five, so adding a package cannot leave it silently ungated), then asserts BOTH directions of each root export plus the `./worker` subpath (six targets total) with Node's own resolver: with `--conditions=@azx/source` each must resolve to its `src/` file (what this workspace gets), and without it to its `dist/` file (what every consumer gets). Second — and this is the check the first one cannot do — it loads the playground's Vite config through Vite's own `resolveConfig` and asserts the resolved `resolve.conditions` includes `@azx/source`. The Node assertions pass `--conditions` directly to Node and so bypass Vite entirely; deleting `resolve.conditions` from `playground/vite.config.ts` (the exact regression this task exists to catch) leaves them green while playground HMR silently resolves libraries from `dist/`. The Vite assertion is what catches that. `resolveConfig` is used rather than grepping the file because it reports what Vite actually computes after config merging and plugins, not merely what the source text happens to say. `vite` is already a root devDependency, so there is nothing to install.

**Files:**

- Create: `scripts/assert-source-condition.mjs`
- Modify: `package.json` (add the `check:resolve` script)
- Modify: `check.sh` (add the `resolve` stage)

**Interfaces:**

- Consumes: the five `dist/` trees from Tasks 3–5, and the playground's Vite config (via `resolveConfig`).
- Produces: root script `check:resolve`, exiting non-zero with a report that distinguishes two failure classes — a package `exports` problem (points at the failing package's `package.json`) and a playground Vite-config problem (points at `playground/vite.config.ts`).

- **Step 1: Write the assertion script**

Resolution runs from `playground/`, whose `node_modules/@azx/*` symlinks all five packages — the repo root cannot resolve them, because pnpm makes only declared dependencies visible and the libraries are not root dependencies. Running from the playground also matches how a real consumer resolves them.

The script has two halves. The per-package loop asserts the `exports` block with Node's own resolver (bundler-independent, catches a broken condition AND a broken default). Then, after that loop, it loads the playground's Vite config via `resolveConfig({ root }, "serve")` and asserts `resolve.conditions` includes `@azx/source` — the dev-server path where HMR into source matters. The two failure classes are tracked in separate arrays so the epilogue can point each at the file its reader needs to open. `"serve"` is the command, not `"build"`, because HMR into library source is a dev-server concern.

`scripts/assert-source-condition.mjs`:

```js
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
```

- **Step 2: Add the root script**

In the root `package.json`'s `scripts`:

```json
"check:resolve": "node scripts/assert-source-condition.mjs",
```

- **Step 3: Verify it passes against the built tree**

Run: `pnpm build:packages && pnpm check:resolve`
Expected: `source condition: 6 export targets (5 root + ./worker subpath) resolve correctly in both directions, and playground Vite requests @azx/source`.

- **Step 4: Prove the gate actually catches the regression**

A gate nobody has seen fail is not known to work. The script has two checks, so each must be watched to fail independently. Temporarily break each, confirm the failure, then restore with `git checkout` (not a `.bak` file, so the restore is verifiable).

**4a — the per-package `exports` check.** Break it the way a real mistake would — the runtime `exports` condition, not `customConditions` in the tsconfig, which is TypeScript-only and not what this asserts:

```bash
sed -i '' 's|"@azx/source": "./src/index.ts"|"@azx/sourc": "./src/index.ts"|' \
  packages/ribo-core/package.json
pnpm check:resolve; echo "exit: $?"
git checkout packages/ribo-core/package.json
git diff --stat packages/ribo-core/package.json
```

Expected: the run reports `@azx/ribo-core (with @azx/source): expected a path ending /src/index.ts, got …/dist/index.js`, prints `exit: 1`, and the final `git diff --stat` prints nothing. (The `sed -i ''` form is BSD/macOS; on GNU sed use `sed -i`.)

**4b — the playground Vite-config check.** This is the check the Node assertions above cannot see — it is the whole reason the second half of the script exists. Delete (or comment out) the `conditions` entry in `playground/vite.config.ts`'s `resolve` block:

```bash
# Show the line, remove it, run the gate, then restore.
sed -i '' '/conditions: \["@azx\/source"\],/d' playground/vite.config.ts
pnpm check:resolve; echo "exit: $?"
git checkout playground/vite.config.ts
git diff --stat playground/vite.config.ts
```

Expected: the run reports `playground/vite.config.ts: Vite's resolved `resolve.conditions` does not include "@azx/source" …`, the epilogue names the `Playground Vite-config problem` class and points at `playground/vite.config.ts`, prints `exit: 1`, and the final `git diff --stat` prints nothing.

Both restores must leave `git status --short` empty.

- **Step 5: Add the `resolve` stage to `check.sh`**

Insert between the `build:packages` and `build:app` stages:

```bash
# Replaces the guard that building destroyed. Runs AFTER build:packages (for
# diagnostic clarity — a resolve failure reads better against a built tree) and
# BEFORE build:app because a resolution failure explains most bundling failures
# that would follow it. NOTE: `import.meta.resolve` does exports resolution
# without stat-ing the target, so this gate does NOT prove `dist/` exists — file
# existence is covered by publint in the build stage, not here.
run_stage "resolve" pnpm check:resolve
```

Update the PASS summary line to:

```bash
  printf 'check.sh: PASS — typecheck, lint, format:check, build:packages, resolve, build:app, test\n'
```

- **Step 6: Run the full check**

Run: `./check.sh`
Expected: `check.sh: PASS — typecheck, lint, format:check, build:packages, resolve, build:app, test`.

- **Step 7: Commit**

```bash
git add scripts/assert-source-condition.mjs package.json check.sh
git commit -m "test: assert both directions of the @azx/source export condition

Building gives dist/ a chance to answer imports that used to hard-fail, so
losing resolve.conditions would now degrade silently. Asserts the exports block
with Node's own resolver instead."
```

---

## Task 8: The tarball and duplicate-React gates

The CI gates doc 10 §8 names that publint and attw do not cover — no TypeScript source in any tarball, exactly one resolved React, and react/react-dom declared as peer deps where used — plus the CI-only `changeset status`. This closes `ci.yml`'s `TODO(phase-later)` block except its pack-and-consume line, which is R3's.

**Files:**

- Create: `scripts/pkg-gates.mjs`
- Modify: `package.json` (add the `check:pkg` script)
- Modify: `check.sh` (add the `pkg:gates` stage)
- Modify: `.github/workflows/ci.yml` (add `changeset status`, trim the TODO)

**Interfaces:**

- Consumes: the five `dist/` trees from Tasks 3–5.
- Produces: root script `check:pkg`.

- **Step 1: Write the gates script**

`scripts/pkg-gates.mjs`:

```js
#!/usr/bin/env node
/**
 * @file The two publishing gates from doc 10 §8 that publint and attw do not cover.
 *
 *   1. No TypeScript source in any tarball. `.d.ts` files are expected; a `.ts`
 *      that is not a declaration means `files`/`exports` leaked source, and a host
 *      app would be handed TypeScript it cannot compile.
 *   2. Exactly one resolved React. Duplicate React silently breaks hooks in a
 *      consumer's app, and a published library is the usual way it happens.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// Derive the publishable packages from the workspace rather than hard-coding a
// list: removing a package fails loudly below (count mismatch), but ADDING one
// would be silently ungated while the green line still reads as success. The
// non-private packages under packages/ are the publishable set. We keep both the
// directory name (for `pnpm pack --dry-run` cwd) and the parsed manifest (for
// the React peer-dep gate below).
const packagesDir = path.join(repoRoot, "packages");
const publishable = [];
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
  publishable.push({ dir: dir.name, name: manifest.name, manifest });
}
publishable.sort((a, b) => a.name.localeCompare(b.name));

const EXPECTED_PUBLISHED_COUNT = 5;
if (publishable.length !== EXPECTED_PUBLISHED_COUNT) {
  console.error(
    `pkg-gates: discovered ${publishable.length} publishable packages, expected ` +
      `${EXPECTED_PUBLISHED_COUNT} (${publishable.map((p) => p.name).join(", ")}). ` +
      "If you added or removed a package, update EXPECTED_PUBLISHED_COUNT.",
  );
  process.exit(1);
}

/**
 * Parses the file list from `pnpm pack --dry-run` output.
 *
 * The list is every non-empty line strictly BETWEEN the `Tarball Contents` and
 * `Tarball Details` boundary lines. Returns `{ ok: false, reason }` if either
 * boundary is missing, if `Tarball Details` does not come after `Tarball
 * Contents`, if the section has no entries, or if any entry is not a bare
 * relative path (no whitespace; a dotted extension is deliberately not
 * required — extensionless entries like LICENSE are legitimate) — in all those
 * cases the offender filter cannot be trusted to find real source leaks, so the
 * gate must refuse to pass rather than report a vacuous zero offenders.
 */
function parseTarballContents(output) {
  const lines = output.split("\n").map((line) => line.trim());
  const start = lines.indexOf("Tarball Contents");
  if (start === -1) {
    return { ok: false, reason: 'no "Tarball Contents" boundary' };
  }
  const end = lines.indexOf("Tarball Details", start + 1);
  if (end === -1) {
    return { ok: false, reason: 'no "Tarball Details" boundary after "Tarball Contents"' };
  }
  const files = lines.slice(start + 1, end).filter((line) => line.length > 0);
  if (files.length === 0) {
    return { ok: false, reason: "no entries between the boundaries" };
  }
  // A bare path only — no whitespace. This deliberately does NOT require a dotted
  // extension: extensionless entries like LICENSE are legitimate, and rejecting them
  // would fail the gate on valid output. What we ARE guarding is trailing text after
  // the path (a hypothetical `dist/index.js (1.2 kB)` format), which would defeat the
  // $-anchored extension match below and let every package pass.
  //
  // Known limitation, accepted: a filename genuinely containing a space would be
  // reported as format-not-understood. That case is indistinguishable from
  // path-plus-trailing-text, so failing loudly is the correct direction, and no file
  // in this repo has one.
  const BARE_PATH = /^\S+$/;
  const badShape = files.find((line) => !BARE_PATH.test(line));
  if (badShape) {
    return {
      ok: false,
      reason: `entry is not a bare relative path: "${badShape}"`,
    };
  }
  return { ok: true, files };
}

// --- Gate 1: no TypeScript source in the tarball -----------------------------
for (const { dir, name } of publishable) {
  const cwd = path.join(repoRoot, "packages", dir);
  const output = execFileSync("pnpm", ["pack", "--dry-run"], { cwd, encoding: "utf8" });

  // Defensive: if the output format is not understood, the offender filter would
  // find nothing regardless — a vacuous pass. Fail loudly instead of silently
  // checking zero files.
  const parsed = parseTarballContents(output);
  if (!parsed.ok) {
    failures.push(
      `${name}: pnpm pack --dry-run output format not understood ` +
        `(${parsed.reason}) — gate is not vacuous, refusing to pass`,
    );
    continue;
  }

  // A declaration is `.d.ts` / `.d.mts` / `.d.cts`; anything else ending in a
  // TypeScript extension — `.ts`, `.mts`, `.cts`, `.tsx` — is source that must
  // not ship. The list is exact so the matcher does not also claim to cover
  // non-existent forms like `.mtsx`/`.ctsx`. `.d.tsx` is not a real thing, so
  // it is not exempted. The declaration exemption stays a prefix pattern so the
  // hashed shared chunk `protocol-*.d.ts` is still covered.
  const offenders = parsed.files.filter(
    (line) => /\.(ts|mts|cts|tsx)$/.test(line) && !/\.d\.(m|c)?ts$/.test(line),
  );

  if (offenders.length > 0) {
    failures.push(`${name}: TypeScript source in the tarball -> ${offenders.join(", ")}`);
  }
}

// --- Gate 2: exactly one resolved React --------------------------------------
// Read pnpm's content-addressed store directly rather than parsing `pnpm ls`
// output: the directory names ARE the resolved versions, so this cannot drift with
// a reporter change. Peer-suffixed entries like `react-dom@19.2.8(react@19.2.8)`
// do not match, because the pattern is anchored.
//
// Known limitation, accepted: this proves uniqueness only for pnpm-managed
// virtual-store entries. A consumer using npm or yarn would have a different
// layout, but this gate runs in OUR workspace, which is pnpm-only — so the
// limitation does not reduce what the gate can see here.
const reactVersions = new Set(
  readdirSync(path.join(repoRoot, "node_modules/.pnpm"))
    .filter((entry) => /^react@\d/.test(entry))
    .map((entry) => entry.slice("react@".length)),
);

if (reactVersions.size === 0) {
  failures.push(
    "no resolved React found in node_modules/.pnpm — the workspace is not " +
      "installed or the detection broke. The gate proved nothing, so it cannot " +
      "pass. (Expected exactly one react@* entry.)",
  );
} else if (reactVersions.size > 1) {
  failures.push(
    `more than one resolved React: ${[...reactVersions].join(", ")}. ` +
      "One React is a stacked defense (doc 10 §5): peer+dev deps, a single catalog " +
      "version, and resolve.dedupe. Check which package widened its range.",
  );
}

// --- Gate 3: React must be peer, not a dependency ----------------------------
// The duplicate-React failure mode this gate's header names — a published
// library causing duplicate React in a consumer's app — comes from `react`
// moving out of `peerDependencies` into `dependencies` (or vanishing entirely
// while the package still uses it). Gate 2 above counts resolved copies in THIS
// workspace, where a single catalog version makes duplication impossible to
// detect; this gate catches the manifest-level mistake that would duplicate
// React in a CONSUMER's app. For every publishable package: if it depends on
// react or react-dom at all, they must appear in `peerDependencies` and NOT in
// `dependencies`.
const REACT_DEPS = ["react", "react-dom"];
for (const { name, manifest } of publishable) {
  const deps = Object.keys(manifest.dependencies ?? {});
  const peerDeps = Object.keys(manifest.peerDependencies ?? {});
  const devDeps = Object.keys(manifest.devDependencies ?? {});
  for (const dep of REACT_DEPS) {
    const referenced = deps.includes(dep) || peerDeps.includes(dep) || devDeps.includes(dep);
    if (!referenced) continue;
    if (deps.includes(dep)) {
      failures.push(
        `${name}: "${dep}" is in dependencies, not peerDependencies. ` +
          "A published library bundling React as a regular dependency causes " +
          "duplicate React in a consumer's app (doc 10 §5). Move it to " +
          "peerDependencies and mirror it in devDependencies as catalog:.",
      );
    }
    if (!peerDeps.includes(dep)) {
      failures.push(
        `${name}: "${dep}" is referenced but missing from peerDependencies. ` +
          "A consumer must be told which React version to provide, or they may " +
          "install a different one and duplicate it.",
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Package gates failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `package gates: ${publishable.length} tarballs carry no TypeScript source; ` +
    `one resolved React (${[...reactVersions].join(", ")}); ` +
    `react/react-dom declared as peer deps where used`,
);
```

- **Step 2: Add the root script**

In the root `package.json`'s `scripts`:

```json
"check:pkg": "node scripts/pkg-gates.mjs",
```

- **Step 3: Run it**

Run: `pnpm build:packages && pnpm check:pkg`
Expected: `package gates: 5 tarballs carry no TypeScript source; one resolved React (19.2.8); react/react-dom declared as peer deps where used`.

If gate 1 fails, the cause is almost certainly a package whose `files` or `exports` reaches outside `dist/` — fix the manifest, not the gate.

- **Step 4: Add the stage to `check.sh`**

Insert after the `build:app` stage:

```bash
# The two publishing gates publint and attw do not cover: no TypeScript source in
# any tarball, and exactly one resolved React. Runs here rather than in CI alone so
# `./check.sh` stays the single "am I done?" signal.
run_stage "pkg:gates" pnpm check:pkg
```

Update the PASS summary line to:

```bash
  printf 'check.sh: PASS — typecheck, lint, format:check, build:packages, resolve, build:app, pkg:gates, test\n'
```

- **Step 5: Update CI**

In `.github/workflows/ci.yml`, replace the whole `TODO(phase-later)` comment block with a real step plus the one remaining marker:

```yaml
# `changeset status` is CI-only: it needs a git remote and a base ref to diff
# against, so it does not belong in a local ./check.sh run. Scoped to pull
# requests because on a push to `main` the base ref IS the current ref, so
# there is nothing to diff and the check reports a spurious failure.
# `origin/main` matches `baseBranch` in .changeset/config.json.
- if: github.event_name == 'pull_request'
  run: pnpm changeset status --since=origin/main
# TODO(R3): add the pack-and-consume matrix from
# docs/implementation/10-build-and-packaging.md section 8 — pack the
# tarballs, install into a scratch app, build, and assert the worker spawns
# and WASM loads. The source-condition playground never touches dist/, so
# every WASM/worker failure mode is production-build-only.
```

Also update the job's `name:` to keep it in sync with `check.sh`'s stages, as its existing comment instructs:

```yaml
name: typecheck, lint, format, build, resolve, pkg gates, test # keep in sync with check.sh's stages
```

- **Step 6: Run the full check**

Run: `./check.sh`
Expected: `check.sh: PASS — typecheck, lint, format:check, build:packages, resolve, build:app, pkg:gates, test`.

- **Step 7: Commit**

```bash
git add scripts/pkg-gates.mjs package.json check.sh .github/workflows/ci.yml
git commit -m "ci: gate on no-TypeScript-in-tarball, one React, and changeset status"
```

---

## Task 9: Confirm the syntax floor costs nothing

The design spec §3.3 accepts a floor looser than doc 10 §2.1's support matrix on the argument that a lower floor "only costs bytes". That argument is testable, and leaving it untested would leave a decision resting on an assumption. This task measures it once and records the number.

**Files:**

- Modify: `docs/roadmap/design/2026-08-04-r1-package-build-configs-design.md` (record the result in §3.3)

**Interfaces:**

- Consumes: `sharedTsdown` and all five builds.
- Produces: a recorded measurement. No code changes survive this task.

- **Step 1: Build at the committed floor and record sizes**

```bash
pnpm build:packages
find packages/*/dist -name '*.js' -exec wc -c {} + | sort -k2 > /tmp/floor-baseline.txt
cat /tmp/floor-baseline.txt
```

- **Step 2: Rebuild at an explicitly modern floor**

Temporarily edit `packages/build-config/src/index.ts`, replacing `target: BROWSER_TARGET,` with a clearly-modern floor roughly matching doc 10 §2.1:

```ts
  target: ["chrome138", "edge138", "safari18"],
```

These three tokens are illustrative, not pins — this edit is thrown away in Step 3, and any floor comfortably newer than the generated one serves the purpose. Pick current-minus-two from the actual §2.1 matrix if you prefer; the measurement is what matters, not the exact numbers.

Then:

```bash
pnpm build:packages
find packages/*/dist -name '*.js' -exec wc -c {} + | sort -k2 > /tmp/floor-modern.txt
diff /tmp/floor-baseline.txt /tmp/floor-modern.txt && echo "IDENTICAL — the looser floor is free"
```

- **Step 3: Restore the committed floor**

```bash
git checkout packages/build-config/src/index.ts
pnpm build:packages
git diff --stat   # expect empty: dist/ is gitignored, and index.ts is restored
```

Expected: `git diff --stat` prints nothing.

- **Step 4: Record the finding in the spec**

In §3.3 of `docs/roadmap/design/2026-08-04-r1-package-build-configs-design.md`, replace the paragraph beginning "One-time empirical check during implementation" with the measured result. If the outputs were identical:

```markdown
**Measured 2026-08-04 (R1 implementation).** Built all five packages at the
generated Baseline floor and again at `["chrome138", "edge138", "safari18"]`
(roughly §2.1's matrix). The emitted JavaScript was **byte-identical** — this
codebase uses no syntax newer than the Baseline floor, so the looser floor costs
nothing and the question is closed. Re-measure only if a package starts using
notably newer syntax.
```

If the outputs differed, record the actual byte delta per package instead of the sentence above, and state whether it was judged acceptable — do not paper over a real difference.

- **Step 5: Verify and commit**

Run: `./check.sh`
Expected: PASS.

```bash
git add docs/roadmap/design/2026-08-04-r1-package-build-configs-design.md
git commit -m "docs: record the measured cost of the Baseline syntax floor"
```

---

## Task 10: Truth-maintenance in AGENTS.md

R1 falsifies several specific statements in AGENTS.md. Correcting them is R1's own responsibility — the doc 10 §3.1 and doc 04 rewrites belong to R5 and must **not** be touched here.

**Files:**

- Modify: `AGENTS.md` (§1, §2, §5.1, §6.2, §7)

**Interfaces:**

- Consumes: everything from Tasks 1–9.
- Produces: documentation only.

- **Step 1: Update §2 (Commands)**

Add the build commands to the code block, after the `./check.sh` line:

```bash
pnpm build:packages                   # build all five publishable packages (tsdown)
pnpm target:refresh                   # regenerate the syntax floor from browserslist
```

Then fix the root-scripts sentence to name the new scripts (`build:packages`, `build:app`, `build`, `check:resolve`, `check:pkg`, `target:refresh`), and correct the typecheck-scope note, which is now wrong in both numbers:

> `pnpm typecheck` prints `Scope: 8 of 9 workspace projects`: the nine are the root plus the eight members, and `pnpm -r` excludes the root. Of those eight, only **seven** actually run a typecheck — `packages/tsconfig` ships JSON only and defines no `typecheck` script. A package without that script is silently absent from the gate (§6).

Also note that `pnpm target:refresh` **writes to the working tree**, alongside the existing warning about `pnpm format` and `pnpm lint:fix`.

- **Step 2: Update §1 (What this repo is)**

The status paragraph says write-back is scaffolded and describes the packages; add that the packages now build. Change the sentence "`ribo-ui-react` is still a `PACKAGE_NAME` stub." to note the build exists while the contents remain R2's:

> `ribo-ui-react` is still a `PACKAGE_NAME` stub — it builds, but populating it as a headless hook layer is a separate task.

- **Step 3: Update §5.1 (the `@azx/source` export condition)**

Two edits. First, the "Subpath exports, and what is actually live today" paragraph is now wrong in three ways: `dist/` exists, `./styles.css` is gone, and only one subpath remains. Replace it with:

> **Subpath exports.** One subpath exists beyond `.`: `@azx/ribo-transcriber-ondevice/worker` (§5.2). All five packages build (`pnpm build:packages`), so `dist/index.js`, `dist/index.d.ts` and `dist/worker.js` all exist and **both** branches of the five root `exports` plus the `./worker` subpath resolve — which is what `pnpm check:resolve` asserts on every `./check.sh` run. `@azx/ribo-ui-react` no longer has a `./styles.css` subpath: it is a headless hook layer and ships no stylesheet, so the subpath was removed along with `sideEffects: ["*.css"]`.

Second, add the new hazard, since this is the section that exists to record load-bearing mechanisms:

> **The condition no longer fails loudly.** Before the packages built, deleting `resolve.conditions` from `playground/vite.config.ts` hard-failed the build on a missing `dist/index.js`. Now it resolves quietly to the built artifact: HMR into library source dies, CI stays green, and nothing announces it. `pnpm check:resolve` (`scripts/assert-source-condition.mjs`) is the gate that replaces that lost property, and it asserts **both** directions — with the condition to `src/`, without it to `dist/`. Deleting `customConditions` from `packages/tsconfig/base.json` lost the same property for the same reason (`dist/*.d.ts` now exists): a local run with a warm `dist/` silently typechecks against built declarations instead of source — CI still catches it, because typecheck runs before any build on a clean checkout.

- **Step 4: Update §6.2 (The package skeleton)**

Add `"build": "tsdown"` to the `scripts` in the skeleton JSON, add the four build devDependencies, and add two checklist bullets next to the existing `typecheck` warning:

> - **Add a `tsdown.config.ts`** that spreads `sharedTsdown` from `@azx/build-config` and declares only its own `entry` in **object form**. Do not inline build settings — the shared base is what keeps one syntax target across all five packages.
> - **Add the four build devDependencies**: `tsdown`, `publint` and `@arethetypeswrong/core` as `catalog:`, and `@azx/build-config` as `workspace:*`. All four are per-package because pnpm does not hoist: `pnpm run build` resolves the `tsdown` binary from the package's own `node_modules/.bin`, and tsdown resolves its optional peers the same way.

- **Step 5: Update §7 (Definition of done)**

The stage list and the verification recipe are both now wrong. Update the first paragraph's stage list to `typecheck → lint → format:check → build:packages → resolve → build:app → pkg:gates → test`, and replace the "Two headless options" block — option 1's reasoning is explicitly `dist/`-does-not-exist and is now invalid:

> If you touched anything under §5, `./check.sh`'s **resolve** stage already verifies source-first resolution end to end, in both directions, for all five packages — that is what `scripts/assert-source-condition.mjs` does, and it is a gate rather than a manual step. To run it alone:
>
> ```bash
> pnpm build:packages && pnpm check:resolve
> ```
>
> The old recipe — grepping `playground/dist/assets/*.js` for `@azx/ribo-core` — no longer proves anything. It worked only because `dist/` did not exist, so a bundle containing library strings could only have come from `src/`. Now both are possible, which is precisely why the resolve stage exists.
>
> To watch the dev server resolve into source by hand:
>
> ```bash
> pnpm --filter playground dev &
> curl -s http://localhost:5173/src/App.tsx | head -3   # expect /@fs/.../packages/ribo-core/src/index.ts
> ```

Also update the `build` stage description in the same section to name both build stages.

- **Step 6: Verify no stale claim survives**

Run:

```bash
grep -n 'No library is built yet\|dist/ does not exist yet\|Scope: 7 of 8\|"./styles.css"' AGENTS.md
```

Expected: no output. Any hit is a statement R1 made false. Note the patterns are the **stale phrasings** specifically — the §5.1 replacement text legitimately mentions `./styles.css` while explaining that the subpath was removed, so a bare `styles.css` search would flag correct work.

- **Step 7: Run the full check and commit**

Run: `./check.sh`
Expected: PASS.

```bash
git add AGENTS.md
git commit -m "docs: bring AGENTS.md in line with the packages actually building"
```

---

## Completion

R1 is done when `./check.sh` prints:

```
check.sh: PASS — typecheck, lint, format:check, build:packages, resolve, build:app, pkg:gates, test
```

and the spec's §9 definition of done holds:

1. All five packages produce `dist/` with `index.js`, `index.d.ts` and sourcemaps; `ribo-transcriber-ondevice` additionally produces `worker.js` / `worker.d.ts`.
2. publint and attw pass for all five.
3. The resolver assertion passes in **both** directions for all five.
4. No `.ts` in any tarball; exactly one resolved React.
5. The playground still resolves to **source**, and its production build still passes.
6. AGENTS.md carries no statement R1 has made false.

**Deliberately still open**, and not R1's to close: publishing (R4), the pack-and-consume matrix (R3), populating `ribo-ui-react` (R2), and the doc 10 §3.1 / doc 04 rewrites (R5). RxDB against Oxc is untested by R1 by design — `rxdb` is externalized, so tsdown never transforms it, and that risk lands on the playground and field-app Vite builds.
