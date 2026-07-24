# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ CORRECTION (2026-07-23) — this plan is a historical record, not current guidance.**
> It was written and executed with one rule that has since been **reversed**: everywhere below
> that says `ribo-core` "compiles with no DOM lib" and that this "mechanically enforces the
> headless constraint" (Global Constraints, Task 2 Step 2/Step 3, Task 4) is **no longer true**.
> `lib` controls which _types_ exist, not which layer a package belongs to, and omitting DOM
> blocked the browser APIs the engine exists to use. The shipped shape is:
> `base.json` (environment-free) → `browser-library.json` (adds `DOM` + `DOM.Iterable`) →
> `react-library.json` (adds JSX); `ribo-core` and `ribo-adapter-snuggpro` extend
> **`browser-library.json`**, and the headless boundary — **no React, no DOM _rendering_**;
> `MediaRecorder`, `IndexedDB`, `fetch`, `Blob`, `AudioContext` and `Worker` are all allowed — is
> enforced by `no-restricted-imports` / `no-restricted-globals` in `eslint.config.mjs`.
> **`AGENTS.md` §4 and §6 are the current authority.** The task history below is left as written.

**Goal:** A pnpm workspace with three library skeletons, a runnable playground, working lint/typecheck/test, one verification command, and an `AGENTS.md` that makes the repo navigable by agents.

**Architecture:** pnpm workspace mirroring Helix's conventions. Three publishable packages (`@azx/ribo-core`, `@azx/ribo-ui`, `@azx/ribo-adapter-snuggpro`) plus a private `playground` Vite app and a private `@azx/tsconfig` config package. Nothing has real behavior yet — this phase establishes the contract shape, the toolchain, and the guardrails everything else is built inside.

**Tech Stack:** pnpm workspaces + catalog · TypeScript (ESM-only) · Vite 8 (playground) · Vitest (unit + browser projects) · ESLint + Prettier · tsdown (`ribo-core`, wired in Phase 1+) · Vite library mode (`ribo-ui`, wired in Phase 5).

## Global Constraints

Copied from [`docs/implementation/10-build-and-packaging.md`](../../implementation/10-build-and-packaging.md) — these apply to **every** task:

- **ESM-only.** `"type": "module"` in every package. No CJS builds.
- **Node 24**, pnpm. Mirror Helix's conventions wherever a choice exists.
- **`exports` map ordering:** `@azx/source` → `types` → `default`. `types` must precede any JS condition.
- **The `@azx/source` custom condition** is how the workspace resolves to TS source; `exports` must **default to `dist/`** so the failure mode is safe. Never use the bare `development` condition.
- **React is `peerDependencies` + `devDependencies`, never `dependencies`.** Wide peer range.
- **`sideEffects`:** `false` for `ribo-core`/`ribo-adapter-snuggpro`; `["*.css"]` for `ribo-ui`.
- **`files: ["dist"]`** on every publishable package.
- **`ribo-core` compiles with no DOM lib** — this mechanically enforces the headless constraint.
- **Do not invent version numbers.** Resolve latest-compatible at install time, then **pin exact versions** into the catalog and record them.
- **Small, focused files.** One clear responsibility per file; prefer splitting over growing.

---

### Task 1: Root workspace + tooling config

**Files:**

- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.editorconfig`, `.prettierrc.json`, `.prettierignore`
- Modify: `.gitignore`

- [ ] **Step 1: Root `package.json`** — private, ESM, with placeholder scripts wired in later tasks.

```jsonc
{
  "name": "ribo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@<pin exact resolved version>",
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "pnpm -r --parallel typecheck",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "check": "./check.sh",
  },
}
```

- [ ] **Step 2: `pnpm-workspace.yaml`** — workspace globs, catalog, and the pnpm settings that guard React duplication and canary installs.

```yaml
packages:
  - "packages/*"
  - "playground"

catalog:
  # Pin EXACT versions resolved at setup time — do not use carets here.
  # Record what was chosen in the PR description.
  react: "<exact>"
  react-dom: "<exact>"
  "@types/react": "<exact>"
  "@types/react-dom": "<exact>"
  typescript: "<exact>"
  vite: "<exact>"
  vitest: "<exact>"

dedupePeerDependents: true
strictPeerDependencies: true

# pnpm 11 defaults minimumReleaseAge to 1440 (one day), which makes our own
# freshly published canaries invisible to `pnpm add`. Exclude our scope.
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - "@azx/*"
```

> **TypeScript version note:** `10 §9` says treat TypeScript 7 as a **fast-follow, not a day-one dependency** — the ecosystem (ESLint parser, editor plugins) lags a new major. Pick the most recent version with full ESLint/editor support and record the reasoning.

- [ ] **Step 3: `.npmrc`** — registry + auth only. pnpm 11 keeps _settings_ in `pnpm-workspace.yaml`; `.npmrc` is for registry/auth.

```ini
@azx:registry=https://<private-registry-host>/
//<private-registry-host>/:_authToken=${AZX_NPM_TOKEN}
```

> If the registry host isn't decided yet, leave a clearly-marked TODO comment and open an issue — do **not** guess a hostname.

- [ ] **Step 4: `.editorconfig`, `.prettierrc.json`, `.prettierignore`** — mirror Helix's versions of these files so formatting is identical across repos.

- [ ] **Step 5: Extend `.gitignore`** — add `dist/`, `coverage/`, `.turbo/`, `*.tsbuildinfo`, `.vite/`.

- [ ] **Step 6: Verify**

Run: `pnpm install`
Expected: completes with no errors; `node_modules/` created; no peer-dependency warnings.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: root workspace and tooling config"
```

---

### Task 2: Shared TypeScript config package

**Files:**

- Create: `packages/tsconfig/package.json`, `packages/tsconfig/base.json`, `packages/tsconfig/react-library.json`

**Interfaces:**

- Produces: `@azx/tsconfig/base.json` and `@azx/tsconfig/react-library.json`, extended by every other package.

- [ ] **Step 1: `packages/tsconfig/package.json`** — private, no build.

```jsonc
{
  "name": "@azx/tsconfig",
  "version": "0.0.0",
  "private": true,
  "files": ["base.json", "react-library.json"],
}
```

- [ ] **Step 2: `base.json`** — the load-bearing bits are `customConditions` (source-first resolution) and no DOM lib.

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "customConditions": ["@azx/source"],
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
  },
}
```

> `customConditions` requires `moduleResolution` of `bundler`/`node16`/`nodenext`. `isolatedDeclarations` is deliberately **off** — zod's `z.infer` cannot be emitted under it (`10 §3.1`).

- [ ] **Step 3: `react-library.json`**

```jsonc
{
  "extends": "./base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM", "DOM.Iterable"], "jsx": "react-jsx" },
}
```

- [ ] **Step 4: Verify** — `pnpm install` resolves the workspace package.

Run: `pnpm install && pnpm ls @azx/tsconfig -r`
Expected: `@azx/tsconfig` listed as a workspace link.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: shared tsconfig package"
```

---

### Task 3: Lint + format

**Files:**

- Create: `eslint.config.mjs`
- Modify: root `package.json` (devDependencies)

- [ ] **Step 1: Flat-config ESLint** covering TS + React, with the rules that enforce our conventions:
  - `@typescript-eslint` recommended-type-checked
  - `import/no-extraneous-dependencies` — catches a lib importing something not declared
  - `react-hooks` rules for `ribo-ui`
  - **A rule banning deep imports across packages** (force use of public entry points)

- [ ] **Step 2: Verify**

Run: `pnpm lint`
Expected: exits 0 (no files to lint yet is acceptable).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: eslint flat config and prettier"
```

---

### Tasks 4–6: Package skeletons (parallelizable)

Three packages, **identical shape**, differing only where noted. Each is an independent task.

**Files (per package `<pkg>`):**

- Create: `packages/<pkg>/package.json`, `packages/<pkg>/tsconfig.json`, `packages/<pkg>/src/index.ts`, `packages/<pkg>/src/index.test.ts`

- [ ] **Step 1: `package.json`** — the `exports` block is load-bearing; copy it exactly.

```jsonc
{
  "name": "@azx/<pkg>",
  "version": "0.0.0",
  "type": "module",
  "sideEffects": false,
  "files": ["dist"],
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
      ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "./package.json": "./package.json",
    },
  },
  "scripts": { "typecheck": "tsc --noEmit" },
  "devDependencies": { "@azx/tsconfig": "workspace:*", "typescript": "catalog:" },
}
```

Per-package differences:

- **Task 4 — `ribo-core`:** as above. `tsconfig.json` extends `@azx/tsconfig/base.json` (**no DOM**).
- **Task 5 — `ribo-ui`:** `"sideEffects": ["*.css"]`; add `peerDependencies` `{ "react": "^18.3 || ^19", "react-dom": "^18.3 || ^19", "@azx/ribo-core": "workspace:^" }` and matching `devDependencies` using `catalog:`. `tsconfig.json` extends `@azx/tsconfig/react-library.json`.
- **Task 6 — `ribo-adapter-snuggpro`:** add `"dependencies": { "@azx/ribo-core": "workspace:^" }`. Extends `base.json`.

- [ ] **Step 2: `src/index.ts`** — a real but trivial export so there's something to typecheck and test. No placeholder comments; export something meaningful, e.g. the package name constant:

```ts
export const PACKAGE_NAME = "@azx/<pkg>" as const;
```

- [ ] **Step 3: Write the test**

```ts
import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.js";

test("exports its package name", () => {
  expect(PACKAGE_NAME).toBe("@azx/<pkg>");
});
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @azx/<pkg> typecheck && pnpm vitest run packages/<pkg>`
Expected: typecheck clean, 1 test passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(<pkg>): package skeleton"
```

---

### Task 7: Playground app

**Files:**

- Create: `playground/package.json`, `playground/vite.config.ts`, `playground/index.html`, `playground/src/main.tsx`, `playground/src/App.tsx`, `playground/tsconfig.json`

**Interfaces:**

- Consumes: `@azx/ribo-core` (`PACKAGE_NAME`) — proves source-first resolution works.

- [ ] **Step 1: `package.json`** — private, depends on all three libs via `workspace:*`.

- [ ] **Step 2: `vite.config.ts`** — the two load-bearing settings:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // resolve workspace packages to TS source for instant HMR
    conditions: ["@azx/source"],
    // prevent duplicate React across linked/workspace packages
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
});
```

- [ ] **Step 3: Minimal `App.tsx`** that imports and renders `PACKAGE_NAME` from `@azx/ribo-core` — this is the assertion that the `@azx/source` condition actually resolves.

- [ ] **Step 4: Verify**

Run: `pnpm --filter playground dev`
Expected: dev server boots; page renders the string `@azx/ribo-core`. Then edit `packages/ribo-core/src/index.ts` and confirm **HMR updates the page without a rebuild step** — that's the source-first setup working.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(playground): vite app consuming ribo-core from source"
```

---

### Task 8: Vitest projects

**Files:**

- Create: `vitest.config.ts` (root)

- [ ] **Step 1: Two projects** — `unit` (node/jsdom, for pure logic) and `browser` (Playwright/Chromium, for MediaRecorder/IndexedDB/Workers/WASM in later phases). Browser project may have zero matching tests in Phase 0; it must still be configured and runnable.

- [ ] **Step 2: Verify**

Run: `pnpm test`
Expected: all package tests discovered and passing; both projects report.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: vitest unit and browser projects"
```

---

### Task 9: `check.sh`

**Files:**

- Create: `check.sh` (executable)

- [ ] **Step 1: One command that agents and CI both use.** Mirrors Helix's `check-and-lint.sh`. Must `set -euo pipefail`, run typecheck → lint → format:check → test, and print a clear pass/fail summary.

- [ ] **Step 2: Verify**

Run: `./check.sh`
Expected: exits 0 with every stage reported.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: single verification command"
```

---

### Task 10: `AGENTS.md`

**Files:**

- Create: `AGENTS.md`; Modify: `README.md` (link to it)

This is the highest-leverage artifact in the phase — it's what makes the repo tractable for agent work.

- [ ] **Step 1: Write it**, covering:
  - **Commands** — `pnpm install`, `./check.sh`, `pnpm --filter playground dev`, how to run one package's tests.
  - **Architecture map** — the four-tier layering, one line per package, and links into `docs/implementation/`.
  - **Conventions** — ESM-only; small focused files with one responsibility; small functions; zod at boundaries; `ribo-core` never imports React or touches the DOM; adapters are the only tool-specific surface.
  - **The two non-obvious mechanisms**, with rationale and issue links (per `10 §9`): the **`@azx/source` export condition**, and **injecting `createWorker`** rather than constructing a Worker. Say plainly that these look like mistakes and must not be "simplified."
  - **How to add a package** — copy the exports block, set `sideEffects`, peer-dep rules.
  - **Definition of done** — `./check.sh` green.

- [ ] **Step 2: Verify** — a fresh reader can go from clone to running playground using only `AGENTS.md`. Have a subagent with no prior context follow it and report where it got stuck.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: AGENTS.md conventions and architecture map"
```

---

### Task 11: CI

**Files:**

- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Workflow** — on push/PR: setup pnpm + Node 24, `pnpm install --frozen-lockfile`, `./check.sh`. Cache the pnpm store.

> The publishing gates from `10 §8` (`publint`, `attw`, pack-and-consume matrix) land in a later phase, once packages actually build. Add a TODO comment in the workflow pointing at `10 §8` so it isn't forgotten.

- [ ] **Step 2: Verify** — push the branch and confirm the workflow goes green.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "ci: typecheck, lint, format and test on push"
```

---

## Definition of done for Phase 0

- `pnpm install` clean, no peer warnings.
- `./check.sh` green.
- `pnpm --filter playground dev` boots and renders a value imported from `@azx/ribo-core`, with **HMR into library source** working.
- `AGENTS.md` gets a fresh reader from clone to running playground.
- CI green on the branch.

## Deliberately NOT in Phase 0

- **Turborepo** — nothing to cache yet; `pnpm -r` covers it. Add when build times justify it (`10 §9` names it the first thing to cut).
- **tsdown / Vite library-mode build configs** — no source to build yet; they arrive with Phase 1 (`ribo-core`) and Phase 5 (`ribo-ui`).
- **Changesets, publint/attw, the pack matrix** — nothing publishable yet.
- **RxDB, transformers.js, zod** — installed when the code that uses them arrives, not speculatively.
