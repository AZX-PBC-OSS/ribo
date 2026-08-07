# AGENTS.md

Working notes for anyone — human or agent — changing code in this repo. Read this before your
first edit.

## 1. What this repo is

Ribo is a reusable **voice-capture SDK** for field data collection: record a dictation, transcribe
it (on-device WASM or a managed STT service), extract structured fields from the transcript, let a
human review and accept them, then write the result back into a host tool through a thin per-tool
adapter. The first target is home-energy audits in Snugg Pro.

**Status: Phases 0–4 built — a working capture → transcribe → extract → review pipeline.**
`@azx/ribo-core` holds the contracts and the engine: the provenance envelope (`extractedSchema`,
`isSpanGrounded`), `Recording` / `Transcript`, the `Transcriber` contract (capability reporting,
`firstCapable` selection, a `FakeTranscriber` double), the `Extractor<F>` seam (`toExtractStep`,
`FakeExtractor`), `ToolAdapter<F, C>`, the review contract (`buildReviewRequest`, `resolveReview`),
and the offline-first outbox/relay state machine
(`queued → transcribing → extracting → writing → done`) with connectivity and work-safety.
`@azx/ribo-transcriber-ondevice` runs real WASM Whisper on-device; `@azx/ribo-adapter-snuggpro` is
the real Snugg Pro `ToolAdapter`; `@azx/ribo-extractor-openai` is the tool-agnostic single-shot
managed-LLM extractor (its OpenAI-compatible transport and the single-shot strategy). `ribo-ui-react`
is still a `PACKAGE_NAME` stub — it builds, but populating it as a headless hook layer is a
separate task. **Write-back is scaffolded but gated** on a Helix platform ask (egress HMAC
signing — `docs/implementation/13-helix-platform-asks.md`). The consuming **field app lives in a
separate repo** and is not built here; the `playground/` app is this repo's stand-in for a consumer.

Background reading: [implementation proposal](docs/implementation/00-overview.md) and
[project roadmap](docs/roadmap/index.md) (design specs and per-phase plans). §1 above
summarises the architecture and current status.

## 2. Commands

Requires **Node >= 24** and **pnpm 10.34.5** (pinned via `packageManager`; `corepack enable` will
honor it). The Node major is also pinned in **`.nvmrc`** (`24`) so `nvm use` / `fnm use` picks it
up; `engines.node` in the root `package.json` is the enforcing copy — keep the two in sync. Every
command below is run from the repo root and has been verified against this tree.

```bash
pnpm install                          # bootstrap the workspace
./check.sh                            # THE "am I done?" signal — see §7 for the full stage list
pnpm build:packages                   # build all five publishable packages (tsdown)
pnpm target:refresh                   # regenerate the syntax floor from browserslist
pnpm --filter playground dev          # dev server on http://localhost:5173
pnpm vitest run packages/ribo-core    # one package's tests (path filter, not --filter)
pnpm --filter @azx/ribo-core typecheck # one package's typecheck
```

The two `--filter` arguments above look inconsistent but are both correct: `--filter` takes a
**package name**, and the playground's `name` field is literally `playground` (it is private and
unscoped), while the libraries are scoped `@azx/*`. Not a typo.

Root scripts, if you need a stage on its own: `pnpm typecheck` (runs each package's own
`typecheck` in parallel), `pnpm lint`, `pnpm format:check`, `pnpm build:packages` (the five
library builds), `pnpm build:app` (the playground's production build), `pnpm build` (both,
in order), `pnpm check:resolve`, `pnpm check:pkg`, `pnpm target:refresh`, `pnpm test`.

Three of the root scripts **write to the working tree** and are not safe to run for information:
`pnpm format` (Prettier `--write`), `pnpm lint:fix` (ESLint `--fix`), and `pnpm target:refresh`
(regenerates `packages/build-config/src/target.generated.ts`). Use `pnpm format:check` and
`pnpm lint` when you only want to know.

Notes:

- Individual packages have **no `test` script**. Vitest is configured once at the root
  (`vitest.config.ts`) and discovers `packages/*/src/**/*.test.{ts,tsx}`; select a subset with a
  path argument as shown above. (Each package still carries `"vitest": "catalog:"` in
  `devDependencies` — see §6 for why that is not cruft.)
- `pnpm typecheck` prints `Scope: 8 of 9 workspace projects`: the nine are the root plus the eight
  members, and `pnpm -r` excludes the root. Of those eight, only **seven** actually run a
  typecheck — `packages/tsconfig` ships JSON only and defines no `typecheck` script. A package
  without that script is silently absent from the gate (§6).
- The playground consumes **every** library **from TypeScript source**, so editing
  `packages/ribo-core/src/index.ts` hot-updates the page with no build step. If that stops
  working, suspect the `@azx/source` condition (§5) rather than Vite.
- There is intentionally **no `.npmrc`** yet — nothing is published, and the private registry host
  is still an open item (`10 §10`). Every dependency today resolves from the public registry.

## 3. Architecture map

Four tiers. Dependencies only ever point **inward toward `ribo-core`**: `ribo-ui-react`,
`ribo-adapter-snuggpro` and `ribo-extractor-openai` each depend on `ribo-core` and never on each
other; the field app composes them. Nothing depends on the field app.

| Tier                         | Location                         | Responsibility                                                                                                                |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@azx/ribo-core`             | `packages/ribo-core`             | Headless engine: capture state machine, transcription, extraction, leaf-path review, queue/write. No React, no DOM rendering. |
| `@azx/ribo-ui-react`         | `packages/ribo-ui-react`         | React hooks over the core engine — recorder, review. (The `react` variant; still a stub.)                                     |
| `@azx/ribo-adapter-snuggpro` | `packages/ribo-adapter-snuggpro` | The **only** tool-specific surface: Snugg Pro field mapping and write-back.                                                   |
| `@azx/ribo-extractor-openai` | `packages/ribo-extractor-openai` | Tool-agnostic extractor plasmid: single-shot managed-LLM extraction over an OpenAI-compatible transport.                      |
| Field app                    | **separate repo**                | The deployed Helix app that composes these packages. Not built here.                                                          |

Supporting, non-published: `packages/tsconfig` (`@azx/tsconfig`, the shared compiler options) and
`playground/` (a Vite app that imports **every** published package, so its production build is a real
composition check of the whole workspace). CI runs that production **build** via `./check.sh`; it
never starts or loads the app, so there is **no runtime smoke test yet** — bundling and module
resolution are gated, actual behavior in a browser is not.

Design docs, one per tier: [`03-ribo-core.md`](docs/implementation/03-ribo-core.md) ·
[`04-ribo-ui.md`](docs/implementation/04-ribo-ui.md) ·
[`05-adapter-snuggpro.md`](docs/implementation/05-adapter-snuggpro.md) ·
[`06-field-app-helix.md`](docs/implementation/06-field-app-helix.md). Build and packaging rules
live in [`10-build-and-packaging.md`](docs/implementation/10-build-and-packaging.md) — the
authority for everything in §5 and §6 below.

## 4. Conventions

- **ESM-only.** `"type": "module"` everywhere, no CJS build. Dual-publishing invites the
  dual-package hazard, which is fatal for a React library carrying context
  ([`10 §3`](docs/implementation/10-build-and-packaging.md)).
- **Small, focused files.** One clear responsibility per file; prefer adding a file over growing
  one. Keep functions small too — if a function needs a section comment, it wants to be two
  functions.
- **zod at the boundaries.** Anything crossing a trust boundary (STT responses, extraction output,
  adapter input, persisted records) is parsed with a zod schema, not cast. Inside a boundary,
  plain types.
- **"Headless" means no React and no DOM _rendering_ — not "no browser APIs".** `ribo-core` and
  `ribo-adapter-snuggpro` are browser libraries: `MediaRecorder`, `IndexedDB`, `fetch`, `Blob`,
  `AudioContext` and `Worker` are expressly allowed, and both packages extend
  `@azx/tsconfig/browser-library.json` (`lib: ["ES2023", "DOM", "DOM.Iterable"]`) so those types
  exist. The boundary is a **layering** rule, so it is enforced in `eslint.config.mjs`, not by
  `lib`: `no-restricted-imports` blocks `react`/`react-dom` and their subpaths, and
  `no-restricted-globals` blocks `document` and `window`, both scoped to exactly those two
  packages. Reaching for `document`, `window` or a React import means you are rendering or
  querying the page — that belongs in `ribo-ui-react`. (Note `window.fetch(...)` trips the rule while
  `fetch(...)` does not; use the bare global.) This replaces an earlier, wrong mechanism —
  omitting the DOM lib from `base.json` — which confused type availability with layering and
  blocked the very APIs the engine exists to use.
- **Adapters are the only place tool-specific knowledge lives.** No Snugg Pro field names, quirks
  or selectors in `ribo-core` or `ribo-ui-react`. A second host tool must be a new adapter package and
  nothing else. R1.5 (`docs/roadmap/design/r1.5-field-shape-contracts-design.md`) makes this
  stronger than it used to be: review now addresses flat dotted leaf paths, and each
  `ReviewField` carries its own leaf's zod schema, so a review UI renders and validates entirely
  off that schema — it needs **no adapter import at all**. That is the payoff of splitting
  `ToolAdapter`'s single field-shape type parameter into a writable patch (`V`) and a derived
  extraction envelope (`Enveloped<V>`).
- **`import type`** for type-only imports (`verbatimModuleSyntax` + an ESLint rule enforce it).
- **Public entry points only** across packages — import `@azx/ribo-core`, never
  `@azx/ribo-core/src/...`.
- Formatting is Prettier's (`.prettierrc.json`: semicolons, double quotes, trailing commas, 100
  columns). Do not hand-format; run `pnpm format`.

## 5. Non-obvious mechanisms — do not "simplify" these

**Read this section before changing any build, tsconfig or `exports` config.** Each item below
looks like a mistake or an over-complication at a glance. Each is load-bearing, and each is the
kind of thing that gets tidied away on a quiet afternoon and breaks published consumers weeks
later ([`10 §9`](docs/implementation/10-build-and-packaging.md)).

### 5.1 The `@azx/source` export condition

Every publishable package's `exports` block looks like this, in this order:

```jsonc
{
  ".": {
    "@azx/source": "./src/index.ts", // only our workspace sets this
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js",
  },
}
```

**What it does.** `@azx/source` is a custom export condition that only _this_ workspace turns on.
It is wired in three kinds of place, and they must stay in sync:

1. `customConditions: ["@azx/source"]` in `packages/tsconfig/base.json` (TypeScript),
2. `resolve.conditions: ["@azx/source"]` in `playground/vite.config.ts` (Vite) and in
   `vitest.config.ts` (Vitest),
3. `--conditions=@azx/source` for any plain-Node script we add later.

That gives us instant HMR straight into library source in-repo, while everyone outside the
workspace gets `dist/`.

**`vitest.config.ts` sets `resolve.conditions` twice — do not "tidy" either away without reading
this.** It appears once at the top level and once inside the single `unit` project. **Vitest 4
projects do not inherit the root `resolve` block**, so the top-level copy governs nothing that the
projects do; the project-level copy is the one with any chance of being load-bearing. Keep the
project-level entry; the root-level one is at best documentation.

**Verified caveat (probed 2026-07-23, Vitest 4.1.10):** neither copy actually resolves a
cross-package import today. A test importing `@azx/ribo-core` by name fails with _"Failed to
resolve entry for package"_ under the current config, because node-environment tests go through
Vite's **SSR** pipeline, which reads `ssr.resolve.conditions` — the working form is
`ssr: { resolve: { conditions: ["@azx/source"] } }` **inside the project**. Nothing fails today
only because every test imports its own module by relative path. Expect to fix this the moment a
test crosses a package boundary; until then, treat "Vitest resolves to source" as unproven.

**Why not just swap `exports` at publish time via `publishConfig`?** Because the failure modes are
asymmetric. With a `publishConfig` swap alone, `exports` **defaults to `src/`** and publishing
rewrites it — so if the rewrite ever fails to happen, we ship raw TypeScript to a host app that
cannot compile it. With the condition, `exports` **defaults to `dist/`** and only we opt into
source; the worst case is that someone gets the correct built artifact. Default-to-safe wins. The
`publishConfig` block stays as redundancy (we publish with pnpm, which honors it — npm's CLI
ignores `exports` overrides in `publishConfig` entirely).

**Why not the bare `development` condition, which already exists?** Because **Vite sets
`development` by default in dev mode**. A published package carrying a `development` branch would
have a _third-party host's_ dev server resolve into our TypeScript source. The condition must be
namespaced so that only we can turn it on.

Also note `"types"` must come **before** any JS condition in the block — publint enforces this,
and getting it wrong silently breaks consumer type resolution.

**Subpath exports.** One subpath exists beyond `.`: `@azx/ribo-transcriber-ondevice/worker`
(§5.2). All five packages build (`pnpm build:packages`), so `dist/index.js`, `dist/index.d.ts`
and `dist/worker.js` all exist and **both** branches of the five root `exports` plus the
`./worker` subpath resolve — which is what `pnpm check:resolve` asserts on every `./check.sh`
run. `@azx/ribo-ui-react` no longer has a `./styles.css` subpath: it is a headless hook layer
and ships no stylesheet, so the subpath was removed along with `sideEffects: ["*.css"]`.

**The condition no longer fails loudly.** Before the packages built, deleting
`resolve.conditions` from `playground/vite.config.ts` hard-failed the build on a missing
`dist/index.js`. Now it resolves quietly to the built artifact: HMR into library source dies, CI
stays green, and nothing announces it. `pnpm check:resolve`
(`scripts/assert-source-condition.mjs`) is the gate that replaces that lost property, and it
asserts **both** directions — with the condition to `src/`, without it to `dist/`. Deleting
`customConditions` from `packages/tsconfig/base.json` lost the same property for the same reason
(`dist/*.d.ts` now exists): a local run with a warm `dist/` silently typechecks against built
declarations instead of source — CI still catches it, because typecheck runs before any build on a
clean checkout.

### 5.2 Inject `createWorker`; never construct a Worker in library code

The worker lives in `@azx/ribo-transcriber-ondevice` (Phase 3); as of Task 1 its `src/worker.ts`
is a stub and the real inference lands in Tasks 2–3 — but the rule applies from the first line of
worker code written.

Our **library packages** must **never** use `new Worker(...)` reached via a bundler-specific
import, and **never** `import Worker from './worker?worker'`. Instead the consumer supplies a
factory:

```ts
export interface RiboOptions {
  createWorker?: () => Worker; // THE supported path
  wasmPaths?: string; // ORT runtime files — must stay same-origin
  modelBaseUrl?: string; // weights, fetched at runtime, never bundled
}
```

**Why.** Vite's library-mode worker bug ([vitejs/vite#15618](https://github.com/vitejs/vite/issues/15618))
is still open: a `?worker` import emits an absolute path that **404s in the consumer's app, in
production only** — i.e. it passes every check we run and fails at the host. Every workaround is
worse: `?worker&inline` base64s the whole whisper worker into the main chunk, `?url` breaks MIME
type and inner imports, and `base: './'` is fragile across host bundlers. tsdown/rolldown likewise
has no first-class worker support. So the worker ships as a **plain published entry**
(`@azx/ribo-transcriber-ondevice/worker`) and the consumer constructs it in their own build context, where their
bundler can see it. This is exactly what duckdb-wasm and ffmpeg.wasm do.

A best-effort default (`new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`)
is fine as a fallback, provided it throws an actionable error pointing at `createWorker` when it
fails. Full rules: [`10 §4`](docs/implementation/10-build-and-packaging.md).

### 5.3 The playground's three tsconfigs, and `tsc -b --force`

`playground/` has `tsconfig.json`, `tsconfig.app.json` and `tsconfig.node.json`. This is not
redundancy:

- `tsconfig.app.json` — browser source (`src/`). Extends `@azx/tsconfig/react-library.json`.
  Deliberately **no `"types": ["node"]`**: nothing under `src/` may reach for Node built-ins.
- `tsconfig.node.json` — the single file `vite.config.ts`, which runs in Node. Needs
  `"types": ["node"]` (Vite 8's `.d.ts` files reference `node:http`, `NodeJS.*` and `Buffer`) and
  `"lib": ["ESNext"]` (rolldown's types use `Symbol.asyncDispose`, absent from the base's ES2023
  lib). Both widenings are scoped to this one file precisely so `base.json` can stay the
  environment-free root of the config chain — no `types`, no DOM, nothing assumed about where the
  code runs (§6).
- `tsconfig.json` — a **solution config** with `"files": []` that only references the other two.

Hence `"typecheck": "tsc -b --force"` rather than `tsc --noEmit`. **A plain `tsc --noEmit` against
a solution config with `files: []` checks nothing and exits 0** — a green typecheck that verified
zero files. `-b` (build mode) follows the `references`; `--force` skips the `.tsbuildinfo`
incremental cache so CI and `check.sh` can never report a stale pass. The referenced projects need
`"composite": true` for `-b` to work, which is why it is set in both leaf configs.

### 5.4 Exact-pinned catalog versions, and two deliberate holds

`pnpm-workspace.yaml` has a `catalog:` block with **exact versions and no carets**. Packages
reference `"catalog:"` rather than a range. That makes every upgrade a deliberate, reviewable,
one-line change in one file, and guarantees a single React version across the workspace (one of
the stacked defenses against duplicate React). **Do not "modernize" these into carets, and do not
invent version numbers** — resolve the latest compatible version at install time and pin what you
actually got.

Two entries are held back on purpose. Both have comments in the file; do not bump them without
reading the comment:

- **`typescript: "6.0.3"`** — TypeScript 7 is GA, but `typescript-eslint@8.65.0` declares a peer
  range of `>=4.8.4 <6.1.0`, so **TS 7 is not lintable yet**. Per
  [`10 §9`](docs/implementation/10-build-and-packaging.md), TS 7 is a fast-follow, not a day-one
  dependency; nothing in the design needs it. Revisit when typescript-eslint ships TS 7 support.
- **`@types/node: "24.13.3"`** — `@types/node` majors track Node majors, and `engines.node` is
  `>=24`. A newer major would type APIs this repo cannot rely on at runtime.

The file also ends with a **`NOTE (pnpm 11 upgrade)`** comment block listing settings to add when
we move to pnpm 11 (`dedupePeerDependents`, `strictPeerDependencies`, `minimumReleaseAge` and
`minimumReleaseAgeExclude: ["@azx/*"]` — the last two because pnpm 11 defaults
`minimumReleaseAge` to a day, which would hide our own freshly published canaries from
`pnpm add`). Read it before touching `pnpm-workspace.yaml` for a version bump; it is easy to
scroll past.

### 5.5 The outbox storage is injectable — and that is the whole seam (Level 1)

`openOutbox({ storage })` takes an optional `RxStorage<unknown, unknown>` and threads it through
`openOutboxDatabase` → `createRxDatabase`. **It defaults to `getRxStorageDexie()`**, so every
existing caller is byte-for-byte unchanged; the default is a lazily-evaluated factory, so a caller
that injects its own engine never even constructs a Dexie storage. `removeOutboxDatabase` takes the
same optional storage and must be handed the **same** engine the database was opened with — RxDB's
`removeRxDatabase` deletes through the storage's own on-disk layout, so a memory-opened database
cannot be removed via Dexie and vice versa.

This is the cheap, high-value seam: a host chooses where the outbox lives — memory
(`rxdb/plugins/storage-memory`) for fast, browser-free tests, Dexie for the browser field app, a
React-Native/SQLite `RxStorage` the day the app leaves the browser — **without touching the
`Outbox` class or its durability logic**. The memory path is exercised by
`packages/ribo-core/src/queue/outbox-memory.test.ts` (a node `unit` test, since memory storage needs
no IndexedDB). The Dexie durability test in `outbox.browser.test.ts` stays on real IndexedDB on
purpose — memory storage would fake the very persistence it proves.

**This is Level 1 by design, and stops here deliberately.** `Outbox` stays a concrete class over
RxDB. Extracting a formal `Outbox` interface plus a storage conformance-test kit ("Level 2") and a
`ribo-storage-*` plasmid (§6.1) is deferred until a genuinely non-RxDB backend is real — writing the
interface now would be a contract with exactly one implementation, which locks in RxDB's shape while
pretending not to.

## 6. How to add a package

### 6.1 The `ribo-<category>-<variant>` naming scheme

Packages are named `ribo-<category>-<variant>`, published under the `@azx/` npm scope (kept
deliberately — do not propose a rename). The **category is documentation for humans**; nothing in
code ever depends on it. Wiring is always through the core contracts — `Transcriber`, `Extractor`,
`Outbox`, `ToolAdapter` — never by matching or parsing a package name. A host composes plasmids by
constructing them and handing them to the engine, so renaming a package could never change what
runs. If you ever find code branching on a package name, that is the bug.

Reserved categories:

| Package              | Category                       | Examples / status                                      |
| -------------------- | ------------------------------ | ------------------------------------------------------ |
| `ribo-core`          | Contracts + headless engine    | the one everything depends inward on                   |
| `ribo-ui-*`          | UI component sets              | `ribo-ui-react` (recorder, review UI — still a stub)…  |
| `ribo-transcriber-*` | Transcriber plasmids           | `ribo-transcriber-ondevice`, `ribo-transcriber-azure`… |
| `ribo-extractor-*`   | Extractor plasmids             | `ribo-extractor-openai` (single-shot managed LLM)…     |
| `ribo-adapter-*`     | Per-tool `ToolAdapter`s        | `ribo-adapter-snuggpro`…                               |
| `ribo-storage-*`     | Storage plasmids (`RxStorage`) | `ribo-storage-rxdb-dexie`… — **reserved, not created** |

`ribo-storage-*` is reserved but empty. Storage is injected today as a raw `RxStorage` through
`openOutbox({ storage })` (§5.5), which needs no package; a dedicated storage plasmid waits on the
Level-2 `Outbox` interface (also §5.5), to be introduced only when a genuinely non-RxDB backend is
real.

### 6.2 The package skeleton

Copy an existing package (`packages/ribo-core` is the plainest) and change the name. The specifics
that matter:

```jsonc
{
  "name": "@azx/<pkg>",
  "version": "0.0.0",
  "license": "MIT",
  "type": "module",
  "sideEffects": false, // or ["*.css"] — see below
  "files": ["dist"], // only dist is published
  "exports": {
    ".": {
      "@azx/source": "./src/index.ts", // FIRST
      "types": "./dist/index.d.ts", // before any JS condition
      "default": "./dist/index.js", // defaults to dist — the safe direction
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
  "scripts": { "typecheck": "tsc --noEmit", "build": "tsdown" },
  "devDependencies": {
    "@azx/tsconfig": "workspace:*",
    "typescript": "catalog:",
    "vitest": "catalog:",
    "tsdown": "catalog:",
    "publint": "catalog:",
    "@arethetypeswrong/core": "catalog:",
    "@azx/build-config": "workspace:*",
  },
}
```

Checklist:

- **`sideEffects`** — `false` for anything headless. **`["*.css"]` for any package that ships a
  stylesheet**; a flat `false` lets the host app's bundler tree-shake the stylesheet away entirely.
- **React is `peerDependencies` + `devDependencies`, never `dependencies`.** Peer range
  `^18.3 || ^19`, and **never `catalog:` in the peer range** — the host's React version is not
  ours to pin. Mirror it in `devDependencies` as `catalog:` so the workspace has one copy. (Is
  that peer range the right floor? Open question — see `docs/open-questions.md`.)
- **Depending on another workspace package: peer + dev if the instance is shared, plain
  `dependencies` if it is not.** Same duplicate-instance reasoning as React. If a consumer will
  hold `ribo-core` objects (a `Controller`, a `ReviewPresenter`) and hand them to _your_ package,
  you and they must be looking at **one** copy of core — so declare
  `"@azx/ribo-core": "workspace:^"` in `peerDependencies` and mirror it in `devDependencies` as
  `"workspace:*"` (peers are not installed for you; the dev entry is what makes the workspace link
  exist for typecheck and tests). This is what `ribo-ui-react` does: its hooks will hold core's
  `Controller` / `ReviewPresenter` instances and hand them back across the boundary. The
  distinguishing test is **runtime object-identity sharing**, not "leaf vs. not": if a consumer
  hands core's runtime objects to your package, use `peerDependencies` + `devDependencies`
  (`ribo-ui-react`); if your package only references core's **types** — even when those types
  appear in its own emitted declarations — a plain `"dependencies": { "@azx/ribo-core": "workspace:^" }`
  is right. That type-only case still needs `dependencies` (not `devDependencies`): a consumer's
  TypeScript must resolve core's `.d.ts`, and devDependencies are never installed for consumers.
  `ribo-adapter-snuggpro`, `ribo-extractor-openai` and `ribo-transcriber-ondevice` are all
  plain-`dependencies` — they import core type-only and exchange plain data (`Recording`,
  `Transcript`), not class instances with identity. Use `workspace:^` for the published-facing
  declaration (pnpm rewrites it to `^<version>` on publish, and Changesets keeps the three libs in
  lockstep) and `workspace:*` for dev-only links.
- **`@azx/tsconfig` must be in `devDependencies`** as `workspace:*`. Easy to forget because the
  package is only referenced from `tsconfig.json` — and we have already shipped this bug once.
  Without it, `extends: "@azx/tsconfig/base.json"` fails to resolve.
- **`"vitest": "catalog:"` in `devDependencies` even though the package has no `test` script.**
  Not cruft: the colocated `src/*.test.ts` files `import { test } from "vitest"`, and that import
  must type-resolve during the package's **own** `tsc --noEmit`. Tests still _run_ only from the
  root Vitest config.
- `tsconfig.json` extends one of three, with `"include": ["src"]`:
  - `@azx/tsconfig/base.json` — environment-free (no DOM, no `types`). For code that must not
    assume a runtime at all.
  - `@azx/tsconfig/browser-library.json` — adds `DOM` + `DOM.Iterable`, no JSX. **The default for
    engine and adapter packages**; `ribo-core` and `ribo-adapter-snuggpro` both use it. Headless
    is enforced by ESLint, not by `lib` (§4).
  - `@azx/tsconfig/react-library.json` — `browser-library.json` plus `"jsx": "react-jsx"`. For
    packages that render (`ribo-ui-react`, and the playground's app config).
- **Add the `"typecheck"` script** (`tsc --noEmit`). `pnpm -r --parallel typecheck` only runs in
  packages that _define_ it, so a package without one is **silently absent** from the gate — it
  will never fail, and never be checked.
- **Add a `tsdown.config.ts`** that spreads `sharedTsdown` from `@azx/build-config` and declares
  only its own `entry` in **object form**. Do not inline build settings — the shared base is what
  keeps one syntax target across all five packages.
- **Add the four build devDependencies**: `tsdown`, `publint` and `@arethetypeswrong/core` as
  `catalog:`, and `@azx/build-config` as `workspace:*`. All four are per-package because pnpm does
  not hoist: `pnpm run build` resolves the `tsdown` binary from the package's own
  `node_modules/.bin`, and tsdown resolves its optional peers the same way.
- Add `src/index.ts` and a colocated `src/index.test.ts`. Root Vitest picks it up automatically;
  no per-package test script.
- If the playground should consume it, add it there as `workspace:*` and import it from
  `playground/src/App.tsx` — that is what makes it part of the CI build.
- Finish with `pnpm install` (registers the new workspace member) then `./check.sh`. `packages/*`
  is already a workspace glob, so pnpm discovers the directory with no config edit — but discovery
  is not the same as coverage: the `typecheck` script above is what gets it into the gate.

## 7. Definition of done

**`./check.sh` is green.** It runs typecheck → lint → format:check → build:packages → resolve →
build:app → pkg:gates → test and prints a PASS/FAIL summary; CI runs the same script, so there is
no second bar to clear. Run it before you claim a task is finished, and paste the summary line
rather than asserting success.

The two build stages are `build:packages` (tsdown produces every publishable `dist/`, running
publint and attw in-build) and `build:app` (the playground's production Vite build, the only gate
that exercises Vite's resolver, the `@azx/source` condition, the JSX transform, React dedup and
real bundling — `tsc` sees none of that). So most §5 breakage is caught by `./check.sh` alone.
Note what it still does **not** do: the app is compiled, never executed. There is no runtime
smoke test.

If you touched anything under §5, `./check.sh`'s **resolve** stage already verifies source-first
resolution end to end, in both directions, for all five packages — that is what
`scripts/assert-source-condition.mjs` does, and it is a gate rather than a manual step. To run it
alone:

```bash
pnpm build:packages && pnpm check:resolve
```

The old recipe — grepping `playground/dist/assets/*.js` for `@azx/ribo-core` — no longer proves
anything. It worked only because `dist/` did not exist, so a bundle containing library strings
could only have come from `src/`. Now both are possible, which is precisely why the resolve stage
exists.

To watch the dev server resolve into source by hand:

```bash
pnpm --filter playground dev &
curl -s http://localhost:5173/src/App.tsx | head -3   # expect /@fs/.../packages/ribo-core/src/index.ts
```

`curl http://localhost:5173/` is **not** a check — the HTML is a shell with an empty `<div
id="root">`; React fills it in the browser. Confirming the page visually renders the three package
names is a **manual browser step**, and the only way to observe the app actually running.
