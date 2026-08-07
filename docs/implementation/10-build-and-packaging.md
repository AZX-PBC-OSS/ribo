# 10 — Build, Packaging & Repo Setup

Covers **this repo** — the Ribo SDK monorepo (five publishable packages). The field app lives in its own repo and consumes the published packages; that relationship is §6 below.

Backed by a 2026 best-practices review (monorepo/publishing, library build tooling, cross-repo dev workflow). Versions were verified live, not recalled.

## 1. Layout

```
ribo/
├── pnpm-workspace.yaml        # catalog + settings (pnpm 11 keeps settings HERE, not .npmrc)
├── .changeset/
├── packages/
│   ├── build-config/          # private shared tsdown config package (§2.2)
│   ├── ribo-core/
│   ├── ribo-ui-react/
│   ├── ribo-adapter-snuggpro/
│   ├── ribo-extractor-openai/
│   ├── ribo-transcriber-ondevice/
│   └── tsconfig/              # private shared tsconfig package
└── playground/                # private Vite app — THE PRIMARY DEV LOOP
```

Five publishable packages, not the three this diagram once showed — `ribo-extractor-openai` (Phase 4)
and `ribo-transcriber-ondevice` (Phase 3) both landed after this doc was written, and `ribo-ui`
became `ribo-ui-react` in R2. `build-config` and `tsconfig` are private, unpublished workspace
members (§2.2, §6.2). There is no `turbo.json`: Turborepo is discussed as an option in §2 and §9,
but nothing in this repo depends on it today. There is no `.npmrc` yet either — nothing is published
(AGENTS.md §2) — so the registry config it will eventually hold does not exist as a file to show
here.

`playground` is `"private": true` so no release tool ever publishes it.

## 2. Toolchain

| Concern         | Pick                                                               | Why                                                                                    |
| --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Package manager | **pnpm** workspaces + `catalog:`                                   | Matches Helix; catalogs rewrite to concrete ranges at pack time                        |
| Task runner     | **Turborepo 2.x** (`tasks`, not the removed `pipeline`)            | Caching; _optional at five packages — see §9_                                          |
| Library build   | **tsdown** for all five packages                                   | One tool, one syntax target, no drift to police — see §3.1 for the split this replaced |
| App build       | **Vite 8** (playground + field app)                                | Rolldown is now the default bundler; `rollupOptions` → **`rolldownOptions`**           |
| Types           | `tsc`-based dts via tsdown's `tsc` generator, all five             | zod's `z.infer` cannot survive `isolatedDeclarations`/oxc (see §3.1)                   |
| Tests           | **Vitest** (jsdom + browser mode)                                  | See §7                                                                                 |
| Versioning      | **Changesets**, independent versioning, no `fixed`/`linked` groups | Each package bumps on its own line — see [Releasing](../design/releasing.md)           |

### 2.1 The target platform baseline (decided 2026-07-23)

All five library builds compile down to one agreed floor. Previously there was none — only `target: "ES2023"` in the shared tsconfig, which is a _TypeScript downlevel_ setting, not a browser policy ([open questions §4](../open-questions.md)).

| Platform                  | Browser                          | Versions supported |
| ------------------------- | -------------------------------- | ------------------ |
| Windows — Surface tablets | Evergreen Chromium (Chrome/Edge) | current − 2        |
| iOS / iPadOS              | Safari                           | current − 1 major  |
| Android                   | Chrome                           | current − 2        |

**Assumed present, no polyfill and no defensive detection:** WebGPU, WASM SIMD, OPFS, IndexedDB, MediaRecorder, Web Workers, `crypto.randomUUID`, top-level await.

**Pin it in the one build tool.** All five packages build with tsdown, and share a single generated
target (`BROWSER_TARGET` in `packages/build-config/src/target.generated.ts`, produced by
`pnpm target:refresh` from the table above) via the `sharedTsdown` config each package's
`tsdown.config.ts` spreads. A second, independently-configured build tool — Vite library mode,
originally planned for `ribo-ui` — would have reintroduced exactly the drift this section used to
warn about; see §3.1 for why that plan did not survive the headless-hook-layer decision.

**What the baseline does _not_ settle:** performance. WebGPU being present says nothing about whether Whisper hits real-time on a phone GPU — that is [01](01-feasibility-spike.md)'s narrowed question, and it is why the managed-STT fallback stays. Nor does it settle `crossOriginIsolated`: `SharedArrayBuffer` depends on **host response headers**, not browser version (§4), so the single-threaded fallback stays regardless.

**Migration watch-outs from Vite 8 / Rolldown:** Oxc replaces esbuild as the transformer and **does not lower native decorators**; CJS `default`-interop rules changed. Smoke-test **RxDB** against both. Also: never ship a UMD build — `import.meta.url` is `undefined` there, which silently breaks worker/WASM URL resolution.

## 3. The package contract

Every published package: `"type": "module"`, **ESM-only** (Node 22/24 support `require(esm)`, and dual-publishing invites the dual-package hazard — fatal for a React lib with context).

### The source-first mechanism: a custom export condition

We want instant HMR into library source _inside_ this repo, and a proper `dist/` artifact for everyone else. We do that with a **namespaced condition only our workspace sets**:

```jsonc
{
  "exports": {
    ".": {
      "@azx/source": "./src/index.ts", // only our workspace sets this
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js",
    },
    "./worker": { "types": "./dist/worker.d.ts", "default": "./dist/worker.js" },
    "./package.json": "./package.json",
  },
  "publishConfig": { "exports": {/* same, minus @azx/source */} },
  "files": ["dist"],
}
```

Wired in three places: `customConditions: ["@azx/source"]` in the base tsconfig, `resolve.conditions` in Vite/Vitest, `--conditions=@azx/source` for any Node script.

**Why a custom condition rather than a `publishConfig` swap alone** — the failure modes are asymmetric. With `publishConfig` alone, `exports` _defaults to `src/`_ and publish swaps it; if the swap ever doesn't happen you ship **TypeScript source to a host app**. With the condition, `exports` _defaults to `dist/`_ and only we opt into source — the worst case is a consumer gets the correct built artifact. Default-to-safe wins. (`publishConfig` stays as redundancy since we publish with pnpm.) Also note npm's CLI ignores `publishConfig` export overrides entirely — only pnpm/Yarn honor them.

**Never use the bare `development` condition** for this: Vite sets it by default in dev, so a published package carrying it would have a _third-party host's_ dev server resolve into our source branch.

**Not every subpath needs a `@azx/source` branch, and getting the order wrong is asymmetrically
dangerous.** `@azx/ribo-transcriber-ondevice`'s `./worker` has one (`./src/worker.ts` exists, so dev
resolves into source like `.` does — this is what lets the playground exercise the worker without
building the package first). Today it is the only subpath beyond `.` across all five packages, and
every one of them carries a source branch — there is currently no live example of a subpath
_without_ one. (`@azx/ribo-ui`'s planned `./styles.css` would have been that example, mapping
straight to `./dist/styles.css` with no source branch because there was no source stylesheet to
resolve; it was never added, because `@azx/ribo-ui-react` shipped headless — no markup, no
stylesheet — before the subpath was ever needed.) The caution still applies to whatever subpath
comes next: adding a branch that points at a file we intend to create later inverts the usual
failure mode. `@azx/source` is **first in the condition order, so it wins the match**, and inside
this workspace the import would hard-fail on a nonexistent path — **broken in development, still
fine for published consumers**. That is the worst shape this bug can take, because the people who
can fix it are the only ones who see it, and CI's `build` stage (playground, source condition) would
go red for a packaging change that is correct for every real consumer. Add the branch **in the same
commit that creates the source file it points at**, never in advance. (`package.json` admits no
comments, so this reasoning has no other home.)

### Other required fields

- `"types"` **first** among conditions (publint enforces it). No `typesVersions`.
- `sideEffects`: `false` for all five packages — none ships a stylesheet or other side-effectful module, so every one is safely tree-shakeable in the host app.
- **No dependency the host has to adopt.** The rule the React peer range expresses generalizes: a published package must not make a host install, version-match or provider-wrap anything to render our components. `ribo-ui-react` goes further than "no styling framework, no CSS-in-JS runtime, no component library (no Mantine, decided 2026-07-23)": per the headless-hook-layer decision it ships **no components beyond `RiboProvider`, no markup and no stylesheet at all**, so there is nothing to render that a host didn't build itself. Applications (`playground`, the field app) are unconstrained; only published packages are. Full reasoning in [04](04-ribo-ui.md).
- React in **`peerDependencies` with a wide range** (`^18.3 || ^19`), mirrored in `devDependencies` as `catalog:`. **Never `dependencies`, never `catalog:` in the peer range** — the host's React version isn't ours to pin.
- Build must externalize React **by regex**: `[/^react($|\/)/, /^react-dom($|\/)/]`. A bare `'react'` misses `react/jsx-runtime` and breaks consumer builds.
- `ribo-core` and `ribo-adapter-snuggpro` compile with `"lib": ["ES2023", "DOM", "DOM.Iterable"]` (`@azx/tsconfig/browser-library.json`) — they are browser libraries and need `MediaRecorder`, `IndexedDB`, `fetch`, `Blob`, `AudioContext` and `Worker`. The headless constraint from [03](03-ribo-core.md) is **no React and no DOM _rendering_**, which is a layering rule, so it is enforced by ESLint (`no-restricted-imports` on react/react-dom, `no-restricted-globals` on `document`/`window`, scoped to those two packages), not by omitting the DOM lib. Omitting `lib.DOM` was tried and reverted: `lib` controls type availability, not layering.

### 3.1 Per-package build notes (verified 2026-07-22; reversed 2026-08-04 — see below)

**One tool for all five, reversed from an earlier split.** This section originally split the build:
tsdown for headless packages, Vite library mode for `ribo-ui`, on the reasoning that the repo needs
Vite anyway for the playground and the field app, so building `ribo-ui` with it added no new tool —
and Vite's CSS pipeline is the mature, years-proven one that tsdown's `@tsdown/css` (four months old
at the time, self-described experimental, `url()` asset resolution unimplemented) was not. `ribo-ui`
was going to ship CSS Modules compiled to one stylesheet, and a bundler gap was not a trade worth
making against the UI's design.

That split did not survive contact with the headless-hook-layer decision
([R2 design](../roadmap/design/r2-headless-hook-layer-design.md)): `@azx/ribo-ui-react` ships no
markup and no stylesheet, so there is no CSS to compile and Vite library mode buys nothing — only a
second syntax target to keep pinned in sync with tsdown's (§2.1)
([R1 design §2.1](../roadmap/design/r1-package-build-configs-design.md)). So: **tsdown for all
five**, sharing one config (`@azx/build-config`'s `sharedTsdown`, which every package's
`tsdown.config.ts` spreads and adds only its own `entry` to) and one generated syntax floor
(`BROWSER_TARGET`, §2.1). One tool, one target, no drift to police.

#### `ribo-core`, `ribo-adapter-snuggpro`, `ribo-extractor-openai`, `ribo-ui-react` — tsdown, single `index` entry

Four of the five packages have nothing package-specific to say about their build — which is the
point of the reversal above, `ribo-ui-react` included:

- **Declarations: the shared `tsc` generator**, `isolatedDeclarations` **off**. zod's `z.infer<typeof Schema>` cannot be emitted under `isolatedDeclarations`/oxc — types are inferred from runtime values, which isolated declarations forbid (one real package hit 374 errors).
- **Entries: single `index`.** None of the four has a worker entry. Use the object form (`{ index: 'src/index.ts' }`) anyway so output filenames stay stable; the array form leaves you trusting name derivation.
- **`ribo-ui-react` has no CSS pipeline because it has no CSS.** The headless-hook-layer decision means this package ships `RiboProvider` and six hooks, no components that render markup, and no stylesheet. `sideEffects: false` (not `["*.css"]`) and no `./styles.css` export follow directly from that — there was never a build-tool question here once the package went headless.

#### `@azx/ribo-transcriber-ondevice` — tsdown (worker build)

The one package with a second entry, because it is the one package with a worker:

- **Entries: use the object form** (`{ index: 'src/index.ts', worker: 'src/worker.ts' }`) so output filenames are stable for the `./worker` subpath export; the array form leaves you trusting name derivation.
- **Shared chunks:** code-splitting is on by default, so shared imports between `index` and `worker` hoist into a shared chunk — `dist/worker.js` is _not_ self-contained and carries a sibling import. Fine for a `{type:'module'}` worker; if we ever need a standalone worker file, build it as a **separate tsdown config** rather than fighting chunking.
- **Do not enable `experimental.resolveNewUrlToAsset`.** Rolldown's own tracking issue says it _"does not work well when bundling libraries."_ With the flag **off** (the default), `new URL('./worker.js', import.meta.url)` passes through roughly verbatim — exactly what we want, since native ESM and webpack 5 do their own static analysis of that pattern.

`ribo-ui-react` is the only one of the five with a React peer dependency at all, and its React
externalization is still guarded the same way for every package regardless: `deps.neverBundle:
[/^react($|\/)/, /^react-dom($|\/)/]` in the shared config (§8), because a bare `'react'` does not
match `react/jsx-runtime` and a missing regex breaks consumer builds.

## 4. WASM + Web Workers — non-negotiable rules

The sharpest packaging risk in the whole project. **Do not let a bundler own these assets.**

Vite's library-mode worker bug ([#15618](https://github.com/vitejs/vite/issues/15618)) is still open: a `?worker` import emits an absolute path that **404s in the consumer's app, production-only**. The workarounds all fail for us — `?worker&inline` base64s the whole whisper worker into the main chunk; `?url` breaks MIME and inner imports; `base: './'` is fragile across host bundlers.

The pattern that works is what **duckdb-wasm and ffmpeg.wasm** do — ship plain files, take URLs/factories as arguments:

1. **Worker is a first-class published entry** (`@azx/ribo-transcriber-ondevice/worker`), declared in `tsdown` `entry`. Never `?worker`.
2. **The consumer injects the worker factory**, in their build context where their bundler can see it:
   ```ts
   export interface RiboOptions {
     createWorker?: () => Worker; // documented as THE supported path
     wasmPaths?: string; // ORT runtime files — keep same-origin
     modelBaseUrl?: string; // weights, fetched at runtime
   }
   ```
   Keep a best-effort default (`new Worker(new URL('./worker.js', import.meta.url), {type:'module'})`) and throw an actionable error if it fails.
3. **Model weights are fetched at runtime, never bundled** — they're tens-to-hundreds of MB. Cache API, long-lived immutable headers ([09](09-offline-first.md)). Do **not** put weights in RxDB.
4. **Keep ORT `.wasm` runtime files same-origin, and set `wasmPaths` explicitly.** The default is a **jsDelivr CDN URL**, which breaks the offline guarantee outright _and_ trips a strict host CSP. Setting it explicitly also engages `useWasmCache`, which caches the runtime binary — worth having, since the binary is ~13 MB (Safari build) / ~24 MB (Chromium build) **[verified by inspection]** and is a real, frequently forgotten part of the one-time download alongside the model weights.
   - Model weights already land in the **Cache API under `transformers-cache`** by default — which is the design [09](09-offline-first.md) already wanted, so **no work is needed** to get it.

### 4.1 On-device transcription lives in its own package (research pass 2026-07-22)

Findings below are **[verified by inspection]** — unpacked published tarballs and read issue threads — unless marked otherwise.

- **`@huggingface/transformers` pulls `onnxruntime-node` and `sharp` as hard dependencies**, both with postinstall scripts. A consumer inherits both in their lockfile **even in a pure-browser app**. This is the packaging argument for keeping it out of `ribo-core` entirely and shipping the `OnDeviceTranscriber` as a **separate opt-in package** ([03](03-ribo-core.md)).
- **WebGPU and WASM backends are unavailable inside a Service Worker** ([transformers.js #787](https://github.com/xenova/transformers.js/issues/787), **still open**). **Dedicated Worker only.** This independently confirms the Phase 2.5 split in which the service worker owns **only the app shell** and the model path runs from page/worker context — two unrelated lines of reasoning arriving at the same boundary.
- **The old cross-origin `wasmPaths` worker bug is fixed** ([#1527](https://github.com/huggingface/transformers.js/issues/1527), PR #1558, landed before v4.0.0 stable) — so the note above is now about offline and CSP, not about worker construction throwing. But **the fix routes around the problem with blob URLs**, and a strict host CSP without `blob:` in `script-src`/`worker-src` will block it. **Record as a host-integration risk**: it is the host's header, not our code, and it fails at runtime in their environment ([06](06-field-app-helix.md)).
- **[vitejs/vite#15618](https://github.com/vitejs/vite/issues/15618) is still open**, so the published-worker-entry plan above remains the correct workaround. HF's own tutorial uses the app-only `?worker` pattern that breaks in library mode, so **we get no help from upstream docs** — anyone comparing our setup against the tutorial will think we over-engineered it.

### Platform ask: COOP/COEP — **downgraded to a lever, not a requirement (2026-07-22)**

Threaded WASM needs `SharedArrayBuffer`, which requires **`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` on the host page** — a library cannot set these.

**This is no longer a blocker.** ORT **silently degrades to a single thread** without cross-origin isolation — no crash, no error **[verified by inspection]** — which is the right failure mode for a library, and WebGPU needs no `SharedArrayBuffer` at all. So the headers buy **iOS performance** (the one platform now known to be WASM-only, [01](01-feasibility-spike.md)) and nothing else.

Ask for them as a **performance lever**, and say so plainly to the platform team rather than presenting a hard dependency we do not have ([06](06-field-app-helix.md)). Note also that **the libraries which _required_ these headers were disqualified precisely because a third-party host may refuse them** — accepting a hard COOP/COEP dependency now would re-import the risk we rejected those candidates over.

Regardless: **feature-detect `crossOriginIsolated` and surface the degraded mode** rather than silently running several times slower. **The size of that penalty for Whisper is [unmeasured]** — assume 2–4× and measure ([open questions §11](../open-questions.md)).

## 5. Dev loop

**Primary — the in-repo `playground/`.** One pnpm workspace means React is a **single instance by construction** rather than patched, and the source condition gives HMR straight into library code with no watch/build chain. It imports all five libraries, and its **production build** runs in CI on every PR (the `build` stage of `./check.sh`), so "do the libraries still resolve, typecheck and bundle inside an app" is a gate, not a vibe. What CI does **not** do is run the app: there is no runtime smoke test yet, so "does the library still _work_ in an app" remains a manual browser step until a browser-mode/E2E project exists (§7).

**Cross-repo — canary snapshot publishes.** CI publishes `0.0.0-canary-<ts>` under a `canary` dist-tag (never `latest`); the field app pins the **exact version**. This is the only mechanism that also serves the eventual third-party host, and it validates packaging on every PR.

```bash
pnpm changeset version --snapshot canary
pnpm changeset publish --tag canary --no-git-tag   # do NOT commit these bumps
```

**Escape hatch — `file:`, time-boxed, never committed.** pnpm's docs note `file:` hard-links, installs the linked package's deps, and resolves peers from the _consuming_ project — which is the React fix for free.

**Do not:**

- **`pnpm link`** — Node resolves from **realpath**, so `ribo-ui-react` binds _our_ React → two Reacts, broken hooks. Further restricted in pnpm 11.
- **Committed `pnpm.overrides` with local paths** — poisons the lockfile; CI installs then fail.
- **Verdaccio** — redundant given a private registry.

Add a CI check that fails if `file:`/`link:` appears in the field app's committed manifest.

### React duplication defenses (stacked, all cheap)

Peer+dev deps (never `dependencies`) · one React version via `catalog:` · `dedupePeerDependents: true` · `resolve.dedupe: ['react','react-dom','react/jsx-runtime']` in **both** playground and field app · React externalized by regex at build.

## 6. Publishing

- Changesets, **independent versioning** across the five libs — no `fixed` or `linked` groups, so a
  change to one package never drags an unrelated one along. `playground` and `@azx/tsconfig` are
  `private: true` and excluded from versioning entirely. See
  [Releasing](../design/releasing.md) for the authoritative policy and everyday workflow
  (`pnpm changeset` / `pnpm changeset:version` / `pnpm changeset:publish`); this predates that page and
  the `turbo run build lint:pkg test && changeset publish` release command it once described has no
  `lint:pkg` script or `turbo` behind it today. **Publish with pnpm, never npm**, whenever publishing
  actually happens.
- `.npmrc` (to be committed, no secrets, not yet written): `@azx:registry=…` +
  `//host/:_authToken=${AZX_NPM_TOKEN}`. Same file shape locally and in CI, once the registry is
  chosen — see [Releasing](../design/releasing.md)'s "Nothing is published yet" note and AGENTS.md §2.
- The third-party host needs a **read-only, scope-limited token** plus those two lines — the most common onboarding failure; document it.

> **pnpm 11 trap:** `minimumReleaseAge` now defaults to **1440 (one day)** — a canary published 30 seconds ago is **invisible to `pnpm add`**. Set `minimumReleaseAgeExclude: ['@azx/*']` in both repos.

## 7. Testing

| Tier                 | Environment                         | Scope                                                                           |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| Unit                 | node/jsdom                          | Pure logic: zod schemas, state machine, transcript post-processing              |
| Browser              | **Vitest browser mode, Playwright** | Anything touching **MediaRecorder, IndexedDB, Workers, WASM**                   |
| **Pack-and-consume** | scratch Vite / webpack / Next apps  | `pnpm pack` → install tarball → build → assert the worker spawns and WASM loads |

jsdom has no MediaRecorder, a shimmed IndexedDB, and doesn't faithfully simulate workers/WASM — mocking through it produces tests that pass while production is broken.

**The third tier is mandatory, not optional.** The source-condition playground _hides packaging bugs by design_ (it never touches `dist/`), and every WASM/worker failure mode is production-build-only. This is the highest-value test in the repo.

## 8. CI gates

`publint --strict` · `attw --pack .` · `pnpm changeset status` · `pnpm pack --dry-run` asserting no `.ts` in the tarball · `pnpm ls react --depth=Infinity` failing on >1 resolved copy · the pack-and-consume matrix.

## 9. Maintainability

This stack has a real complexity budget, and we should be honest about it — a five-package repo maintained by a very small team (the DRB's lone-wolf concern is live) can drown in tooling.

**What's load-bearing vs. optional.** The **package contract** (§3), the **WASM/worker rules** (§4), and the **CI gates** (§8) are load-bearing — they're what stops us shipping a broken artifact to a team we can't hot-fix for. **Turborepo is optional at five packages**: `pnpm -r` already respects topological order via `workspace:` deps, and Turbo buys caching for one config file. If the repo feels heavy, **cut Turborepo first**, then Storybook if we add it. Do not cut publint/attw/pack-test — they are the cheapest insurance here by a wide margin.

**We're adopting genuinely new tooling.** tsdown is **pre-1.0** (0.22.x, shipping multiple times a week, no published 1.0 roadmap), Vite 8/Rolldown landed March 2026, and **TypeScript 7 went GA in July 2026**. Mitigations: **pin exact versions** (not carets) for tsdown; keep the toolchain in the `catalog:` so upgrades are one-line and reviewable; and treat **TS 7 as a fast-follow rather than a day-one dependency** — the ecosystem (ESLint parser, editor plugins) typically lags a new major by weeks, and nothing in our design needs it.

**`@tsdown/css` never became relevant here.** It was the reason `ribo-ui` (now `ribo-ui-react`) was
slated for Vite library mode instead of tsdown: `@tsdown/css` was four months old, self-described
experimental, with `url()` asset resolution unimplemented, and a styled UI package would have needed
all of it. The headless-hook-layer decision removed the need before the split ever shipped —
`ribo-ui-react` has no CSS to compile, so tsdown's remaining job, headless multi-entry TypeScript, is
the only job any of the five packages needs from it, and it is tsdown's most settled use case.

**Longevity is not the concern.** tsdown is maintained by VoidZero (the Vite/Rolldown/Oxc company) and is slated to underpin Vite's own library mode — core infrastructure, not a side project. tsup's fate is a poor analogy: that was a solo-maintainer project. The residual risk is **API churn from healthy, rapid development**, not abandonment — which is what pinning addresses.

**What the split would have cost, avoided rather than merely managed:** two build-tool config styles
across the workspace, and a second syntax target to keep pinned in sync with tsdown's own (§2.1). One
tool now, so neither cost exists to pay.

**Two mechanisms here are non-obvious and will look like mistakes to a newcomer**: the `@azx/source` export condition, and injecting `createWorker` instead of just constructing a Worker. Both are load-bearing and both are the kind of thing someone "simplifies" on a quiet afternoon and breaks published consumers. Each needs a comment at the definition site plus a short `ARCHITECTURE.md` note explaining _why_, with a link to the issue that forced it.

**The guardrails are the maintenance strategy.** A small team can't hold packaging semantics in their head. The CI gates mean an engineer can change build config and find out in minutes — not from a host team weeks later.

**Keep the OSS surface swappable.** transformers.js, RxDB, and the STT vendor are all maintenance commitments. The design already puts each behind our own interface (`Transcriber`, `Queue`); keep it that way, so replacing one is a contained change rather than a refactor.

**Bus factor.** Bootstrap must be one command to a running playground, and the playground is the entry point for anyone new. That, plus the pack-test, is what makes this handoff-able — which matters given the staffing risk in [08](08-risks-and-sequencing.md).

## 10. Open items

- Confirm the private registry URL + token issuance path (and read-only tokens for the host team).
- Ask Helix for per-app COOP/COEP headers as an **iOS-performance lever** (§4) — and be ready to accept single-threaded-only, which is now the assumed baseline rather than the failure case.
- Confirm the host's CSP allows `blob:` in `script-src`/`worker-src` (§4.1), or find out the hard way at runtime.
- ~~Name and scaffold the separate on-device-transcriber package (§4.1) — the §1 layout still shows
  three publishable packages, and this makes four.~~ **Done, and overtaken.** `ribo-transcriber-ondevice`
  shipped in Phase 3; `ribo-extractor-openai` shipped in Phase 4 alongside it, so the count settled at
  **five**, not four. §1's layout now lists all five.
- Decide whether Storybook earns its place alongside the playground, or is deferred.
- Pin the initial tsdown/Vite/TypeScript versions and record them in the catalog.
- ~~Translate the §2.1 baseline into a concrete shared browserslist / per-tool `target`, and add a check that the two library builds agree on it.~~ **Done.** `pnpm target:refresh` (`scripts/refresh-target.mjs`) generates `BROWSER_TARGET` in `packages/build-config/src/target.generated.ts` from the §2.1 table, and every one of the five packages' `tsdown.config.ts` gets it from the same `sharedTsdown` object rather than declaring its own — there is one tool and one target now, not two builds that could disagree.
