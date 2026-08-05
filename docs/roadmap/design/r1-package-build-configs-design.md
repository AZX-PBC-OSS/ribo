# R1 — Package Build Configs — Design

**Date:** 2026-08-04
**Author:** AZX
**Status:** Approved for planning
**Task:** **R1** of the Voice-to-Text MVP design (`franklin-field-app`
`docs/roadmap/design/2026-07-28-voice-to-text-mvp-design.md`)
**Authority it implements:** [`10-build-and-packaging.md`](../../implementation/10-build-and-packaging.md)
(with one recorded deviation, §3.3)

---

## 1. Goal

The five publishable packages are **typecheck-only** today: `"typecheck": "tsc --noEmit"` and nothing
else. There is no build script, no `dist/`, and therefore nothing publishable. R1 makes all five
build a real ESM artifact with declarations, and proves that artifact is valid for a consumer.

R1 is the root of the MVP dependency graph — R2, R3, R4 and F1 all wait on it — so its scope is
deliberately "everything needed for a package to be _correct_", stopping short of actually
publishing it (R4).

### What R1 is not

- **Not publishing.** No `.npmrc`, no registry, no `publishConfig.access` change, no release-workflow
  activation. All R4.
- **Not the pack-and-consume tier.** The scratch-app matrix is R3, and remains the only test that
  exercises a real tarball in a real host build.
- **Not populating `@azx/ribo-ui-react`.** R2 owns the package's contents. R1 touches only its
  manifest, and only where the build forces it (§6).
- **Not a docs rewrite.** Doc 10 §3.1's Vite-library-mode mandate and doc 04's styled components are
  R5's to correct. R1 updates only the statements R1 itself makes false (§7).

---

## 2. Decisions

### 2.1 One build tool: tsdown for all five

Per the MVP design's R1 and against doc 10 §3.1, which splits tsdown for headless packages and Vite
library mode for `ribo-ui`. That split existed **solely** for the UI package's CSS Modules pipeline,
and MVP design §5.7 makes `@azx/ribo-ui-react` headless — no markup, no stylesheet. With no CSS to
compile, Vite library mode buys nothing and costs a second syntax target to keep in sync.

So: **tsdown for all five.** One tool, one target, no drift to police.

tsdown 0.22.14 is pinned **exact** (doc 10 §9 — it is pre-1.0 and ships several times a week; the
residual risk is API churn from healthy development, which pinning addresses). It declares
`typescript: "^5.0.0 || ^6.0.0 || ^7.0.0"`, so it is compatible with the catalog's held-back TS
6.0.3 (§5.4 of AGENTS.md explains the hold).

**Catalog additions**, all exact per AGENTS.md §5.4 — resolve each at install time and pin what you
actually get, rather than trusting the numbers here:

| Entry                    | Consumer                         | Note                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tsdown`                 | the five packages                | Exact, pre-1.0 (doc 10 §9).                                                                                                                                                                                                                            |
| `publint`                | tsdown's optional peer           | Peer range `^0.3.8`; latest observed 0.3.23.                                                                                                                                                                                                           |
| `@arethetypeswrong/core` | tsdown's optional peer           | Peer range `^0.18.1`. Note this is `core`, **not** the `cli` package.                                                                                                                                                                                  |
| `browserslist`           | the `target:refresh` script only | Already in the lockfile at 4.28.7, but reached transitively via `vite-plugin-pwa → workbox-build → @babel/preset-env`. Declare it explicitly rather than lean on that — the catalog's own rxjs comment records the Phase 1 zod incident as the reason. |

### 2.2 Per-package configs over a shared private base package

Each package gets its own `tsdown.config.ts` and a `"build": "tsdown"` script. Shared settings live
in a **new private workspace package, `@azx/build-config`** — `files: []`, never published, a
`devDependencies: workspace:*` of each of the five. This is exactly the pattern `@azx/tsconfig`
already establishes for compiler options, so it needs no new concept.

```
packages/build-config/src/index.ts     shared tsdown base + BROWSER_TARGET
packages/ribo-core/tsdown.config.ts     { ...sharedTsdown, entry: { index: "src/index.ts" } }
packages/ribo-transcriber-ondevice/tsdown.config.ts
                                        { ...sharedTsdown, entry: { index: …, worker: … } }
```

Rejected: a single root workspace-mode config (no package owns its own build, per-package debugging
means running all five, and one file has to know every package's entry layout). Rejected: five
standalone configs with settings inlined (five copies of the browser floor is the drift R1 exists to
remove).

**`@azx/build-config`'s module format is settled empirically, not assumed.** Each
`tsdown.config.ts` imports from it, so tsdown's own config loader has to resolve a **TypeScript
source file inside `node_modules`** (via the workspace symlink). tsdown bundles its config, so this
probably works — but if the loader declines to transpile a dependency's TS, the package ships plain
`index.mjs` with a hand-written `index.d.mts` instead. That is a small, contained fallback and it
changes nothing else in this design. See risk 6.

Ordering needs no task runner. `pnpm -r --filter "./packages/*" build` already respects topological
order via the existing `workspace:` deps — including `ribo-ui-react` → `ribo-core`, which is a peer
**and** a devDependency, and the dev entry is what puts it in the graph. Doc 10 §9 says cut
Turborepo first if the repo feels heavy; at five packages it earns nothing.

### 2.3 Shared build settings, and why each one

| Setting                             | Value                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`                          | `"browser"`                                                                    | tsdown defaults to `node`. All five are browser libraries (AGENTS.md §4).                                                                                                                                                                                                                                                                                                                                                         |
| `format`                            | `["esm"]`                                                                      | ESM-only is the package contract (doc 10 §3). **Never UMD** — `import.meta.url` is `undefined` there, silently breaking worker/WASM URL resolution (doc 10 §2.1).                                                                                                                                                                                                                                                                 |
| `dts`                               | tsc generator, `isolatedDeclarations` **off**, declaration maps **off**        | zod's `z.infer<typeof Schema>` cannot be emitted under isolated declarations — types are inferred from runtime values, which isolated declarations forbid. Doc 10 §3.1 records one real package hitting 374 errors. Declaration maps are off because their `sources` point at `../src/*.ts`, which `files: ["dist"]` and the tarball gate exclude — a consumer's "Go to Definition" would target a path absent from the package.  |
| `target`                            | `BROWSER_TARGET` (§3)                                                          | See §3. Must be explicit — see the footgun in §3.2.                                                                                                                                                                                                                                                                                                                                                                               |
| `deps.neverBundle`                  | deps + peerDeps (automatic), **plus** `/^react($\|\/)/`, `/^react-dom($\|\/)/` | A bare `"react"` does not match `react/jsx-runtime` and breaks consumer builds (doc 10 §3.1). tsdown deprecated the older `external` option.                                                                                                                                                                                                                                                                                      |
| `sourcemap`                         | `true`                                                                         | Cheap, and consumers debugging our code is the point.                                                                                                                                                                                                                                                                                                                                                                             |
| `minify`                            | `false`                                                                        | The host minifies. A minified library only obstructs their debugging.                                                                                                                                                                                                                                                                                                                                                             |
| `publint`                           | `{ strict: true }`                                                             | Optional tsdown peer, run in-build: a bad `exports` block fails the build that produced it. `strict` makes warnings and suggestions fatal, matching the `publint --strict` the replaced CI TODO specified (non-strict `true` leaves them non-fatal).                                                                                                                                                                              |
| `attw`                              | `{ profile: "esm-only", level: "error" }`                                      | ESM-only package; the default `strict` profile reports `No resolution (node10)` and `CJS resolves to ESM (node16-cjs)` failures that are expected here. `level: "error"` is required — tsdown's default `level: "warn"` with `failOnWarn: false` prints WARN and exits 0; only `error` sets `process.exitCode = 1`. `esm-only` suppresses only the node10/node16-cjs kinds; every other attw problem class is live and now fatal. |
| `experimental.resolveNewUrlToAsset` | **left off** (default)                                                         | Rolldown's own tracking issue says it "does not work well when bundling libraries". With it off, `new URL("./worker.js", import.meta.url)` passes through roughly verbatim — which is what we want, since native ESM and webpack 5 do their own static analysis of that pattern (doc 10 §3.1).                                                                                                                                    |

---

## 3. The syntax target

### 3.1 Generated from browserslist's Baseline query, committed

**tsdown does not read browserslist.** Verified by inspection of `dist/target-Bab3CUeB.mjs` in
tsdown 0.22.14 — `resolveTarget` accepts esbuild-style tokens (`chrome111`, `safari16.4`), a comma
string, an array, or the literal `baseline-widely-available`, and otherwise infers **only** from
`engines.node`. There is no `browserslist` import, no `.browserslistrc` read, no
`package.json#browserslist` read. Rolldown 1.2.0 likewise has zero references (its only dependencies
are `@oxc-project/types` and `@rolldown/pluginutils`). Vite 8 does not read browserslist either.

So the floor must be handed to tsdown as tokens. We **generate** them:

- `scripts/refresh-target.mjs`, run as the root script `pnpm target:refresh`, resolves
  `browserslist("baseline widely available")` — a query browserslist 4.28.7 supports natively —
  reduces the result to a minimum per browser family, maps family names to oxc tokens, and writes
  `packages/build-config/src/target.generated.ts`, **committed**, exporting `BROWSER_TARGET`. Its header
  records the query, the resolution date and the resolved `caniuse-lite` version, and marks the file
  generated so nobody hand-edits it.
- `packages/build-config/src/index.ts` re-exports `BROWSER_TARGET` as part of the shared base. Builds
  perform **zero** resolution.

This is the pattern Vite itself uses: its `ESBUILD_BASELINE_WIDELY_AVAILABLE_TARGET` carries the
comment _"The value is generated by `pnpm generate-target` script."_

**Why generate rather than use tsdown's `baseline-widely-available` token.** Both tsdown and Vite
hardcode the same snapshot, `["chrome111","edge111","firefox114","safari16.4","ios16.4"]` (verified
byte-identical in tsdown 0.22.14 and Vite 8.1.5 `chunks/node.js:610`). Resolved live on 2026-08-04,
Baseline widely-available is **`chrome121, edge121, firefox122, safari17.2, ios17.2`** — their
snapshot is roughly **ten Chrome majors stale**. Generating buys a floor ten majors newer, so
materially less downleveling, while still sitting inside Baseline's 30-month support window.

**Why generate-and-commit rather than resolve at build time.** Resolving during each build keeps the
policy live but makes the _published syntax floor_ move with whatever `caniuse-lite` the lockfile
holds, with nothing in any diff showing that it moved. Committing the generated tokens puts the floor
in a reviewable diff, keeps builds byte-reproducible across a `caniuse-lite` bump, and keeps
`browserslist` a devDependency of the **script** rather than a participant in the build.

Deliberately **no** CI staleness check. Regenerating is an intentional act, like
`update-browserslist-db`; a red build on every `caniuse-lite` bump is noise.

**The `and_chr` trap, worth recording.** `browserslist("baseline widely available")` returns
`and_chr 150` — Chrome Android is always current-only. Folding it into a per-family minimum would
yield `chrome150`, a wildly too-high floor that would break the very Surface-and-tablet fleet the
target exists to protect. `and_chr` and `and_ff` have no oxc token and must be **dropped**; desktop
Chrome and Firefox already bind the same syntax. The mapping is:

```
chrome → chrome   edge → edge   firefox → firefox   safari → safari   ios_saf → ios
and_chr, and_ff → dropped
```

Version ranges (`"18.5-18.7"`) take the low end, and comparison is numeric, not lexical — `"9"` must
not sort above `"17.2"`.

### 3.2 `target` must be set explicitly — the `engines.node` footgun

tsdown's only inference path is `resolvePackageTarget(pkg)`, which reads **`engines.node`** and
returns `node<min>`. None of the five packages declares `engines` today, so the target is currently
`undefined` and **no lowering happens at all**. If anyone later adds `engines: { node: ">=24" }` as
routine publishing metadata, tsdown silently starts targeting **`node24`** for five _browser_
libraries. `target` is therefore set explicitly in the shared config, with a comment naming this
hazard, regardless of which value we choose.

### 3.3 Recorded deviation from doc 10 §2.1

Doc 10 §2.1 sets a **support matrix**: Chromium current − 2, Safari current − 1 major, Chrome Android
current − 2. Baseline widely-available is a **more conservative** floor than that (Safari 17.2 versus
a current-minus-one in the 25/26 range).

We accept the looser floor deliberately, because the error directions are not symmetric: a syntax
floor **lower** than the real support matrix only costs bytes through extra downleveling, while a
floor **higher** than reality breaks a supported device — an auditor's tablet, in an attic, where we
cannot hot-fix them. §2.1's matrix remains the **support** policy; the generated tokens are the
**syntax** floor; the two are allowed to differ so long as the floor is the lower one.

**Measured 2026-08-04 (R1 implementation).** Built all five packages at the
generated Baseline floor and again at `["chrome138", "edge138", "safari18"]`
(roughly §2.1's matrix). The emitted JavaScript was **byte-identical** — this
codebase uses no syntax newer than the Baseline floor, so the looser floor costs
nothing and the question is closed. Re-measure only if a package starts using
notably newer syntax.

---

## 4. Build wiring

Root scripts split so a failure is attributable:

```jsonc
{
  "build:packages": "pnpm -r --filter \"./packages/*\" build",
  "build:app": "pnpm --filter playground build",
  "build": "pnpm build:packages && pnpm build:app",
}
```

`check.sh` gains stages in this order, replacing its single `build` stage:

```
typecheck → lint → format:check → build:packages → resolve → build:app → pkg:gates → test
```

`resolve` sits after `build:packages` for diagnostic clarity (§5.2 — NOT because `dist/` must
exist: `import.meta.resolve` does exports resolution without stat-ing the target), and before
`build:app` because a resolution failure explains most bundling failures that would follow it — the
same reasoning the existing script applies to putting `build` before `test`.

`ci.yml` needs no new steps: it runs `check.sh`. Its `TODO(phase-later)` block is deleted **except**
the pack-and-consume line, which stays as R3's marker. `changeset status` is added to CI only — it
needs `--since=origin/main` and a git remote, so it does not belong in a local `check.sh`.

---

## 5. Proving the artifact is valid

R1 includes the package-contract gates, not just the build. The deliverable of a build config is a
_valid publishable artifact_, and doc 10 §9 is explicit that these gates are the cheapest insurance
in the repo: "an engineer can change build config and find out in minutes — not from a host team
weeks later." `ci.yml`'s own TODO says to wire them "as soon as the packages actually build."

### 5.1 publint and attw run inside the build

tsdown declares optional peers on `publint ^0.3.8` and `@arethetypeswrong/core ^0.18.1`, so both run
as part of `pnpm build` rather than as a separate CI job. With `publint: { strict: true }` and
`attw: { level: "error" }`, a broken `exports` block FAILS the build that produced it — strictly
better than failing a later step. Note both settings are load-bearing: tsdown's default `attw` level
is `"warn"` with `failOnWarn: false` (prints WARN, exits 0), and non-strict `publint: true` leaves
warnings and suggestions non-fatal. Without `level: "error"` and `strict: true`, every attw/publint
problem is silently non-fatal.

**The known risk, to verify first.** The `@azx/source` condition points at `./src/index.ts`, which is
not in `files: ["dist"]`. Both tools may flag that as an exports-references-unpublished-file error.
The expected resolution is that packing via **pnpm** applies `publishConfig`, whose `exports` carry no
`@azx/source` branch — but this is a confirm-it-do-not-assume-it item, and it is the single most
likely thing to make R1 look broken on first run. If the tools cannot be pointed at the
publishConfig-resolved manifest, the fallback is to run them against a real `pnpm pack` output rather
than to suppress the rule.

### 5.2 The source-condition resolver assertion

R1 **removes an existing safety net**, and must replace it.

Today the `@azx/source` condition is protected by absence. AGENTS.md §7 verifies it with "`dist/`
does not exist yet, so a bundle containing these strings can only have come from `src/`", and if
someone deletes `resolve.conditions` from `playground/vite.config.ts` the build hard-fails on a
missing file. Once R1 produces `dist/`, that same deletion **silently resolves to `dist/index.js`**:
HMR into library source dies, CI stays green, and nobody finds out for weeks. That is precisely the
AGENTS.md §5 "tidied away on a quiet afternoon" failure mode, applied to the mechanism §5 warns about
most.

The replacement has two complementary checks. First, it asserts **both directions** of the
`exports` block with Node's own resolver — for five root exports plus the `./worker` subpath (six
targets total):

```
node --conditions=@azx/source -e '…import.meta.resolve("@azx/ribo-core")…'
  => …/packages/ribo-core/src/index.ts
node -e '…import.meta.resolve("@azx/ribo-core")…'
  => …/packages/ribo-core/dist/index.js
```

Second — and this is the check the first one cannot do — it loads the playground's Vite config
through Vite's own `resolveConfig` and asserts the resolved `resolve.conditions` includes
`@azx/source`. The Node assertions pass `--conditions` directly to Node and so bypass Vite entirely;
deleting `resolve.conditions` from `playground/vite.config.ts` (the exact regression this gate exists
to catch) leaves them green while playground HMR silently resolves libraries from `dist/`. The Vite
assertion fills that gap. `resolveConfig` is used rather than grepping the file because it reports
what Vite actually computes after config merging and plugins, not merely what the source text
happens to say.

The per-package assertions test the thing that actually matters — the `exports` block — are
bundler-independent, and catch a broken condition _and_ a broken default in one pass. The gate runs
after the `build:packages` stage for diagnostic clarity (a resolve failure reads better against a
built tree), NOT because `dist/` must exist: `import.meta.resolve` does exports resolution without
stat-ing the target, so the gate would pass identically on an unbuilt tree. File existence is covered
by publint in the build stage. So R1 both removes the old guard and installs a better one. It runs as
the `resolve` stage of `check.sh`, across five root exports plus the `./worker` subpath.

### 5.3 Tarball and duplicate-React gates

A `pkg:gates` script, run by `check.sh` so local and CI agree:

- `pnpm pack --dry-run` per package, asserting **no `.ts` file reaches any tarball**.
- Exactly one resolved React, detected by reading `node_modules/.pnpm` directly rather than parsing
  `pnpm ls react --depth=Infinity` output — the directory names ARE the resolved versions, so this
  cannot drift with a reporter change. One of doc 10 §5's stacked defenses against duplicate React.
- For every publishable package, if it depends on `react`/`react-dom` at all, they must appear in
  `peerDependencies` and NOT in `dependencies` — the manifest-level mistake that causes duplicate
  React in a _consumer's_ app (as opposed to the workspace-level count above, which a single catalog
  version makes impossible to detect locally).

---

## 6. Forced manifest change: `@azx/ribo-ui-react`

Not scope creep — the build makes the current manifest invalid. The package declares
`"./styles.css": "./dist/styles.css"` in both `exports` and `publishConfig.exports`, and
`sideEffects: ["*.css"]`. Under MVP design §5.7 the package is **headless**: no markup, no
stylesheet. So `dist/styles.css` will never be produced, and publint fails a subpath pointing at a
nonexistent file.

R1 therefore drops the `./styles.css` subpath from both blocks and sets `sideEffects: false`. This is
the consequence doc 10 §3.1 anticipated from the other direction — it warned against adding a
`@azx/source` branch for a stylesheet that does not exist yet; here the whole subpath goes.
Everything _inside_ the package stays R2's.

React stays `peerDependencies` at `^18.3 || ^19`, mirrored in `devDependencies` as `catalog:` — MVP
design §5.7 keeps this unchanged, and hooks are still React.

---

## 7. Docs R1 must correct

Only statements R1 itself falsifies. Doc 10 §3.1 (Vite library mode) and doc 04 (styled components)
are **R5's**, and R1 must not pre-empt them.

- **AGENTS.md §5.1** — "**No library is built yet** — there is no `dist/` for any package until the
  tsdown/Vite library builds land in a later phase" becomes false, as does the paragraph explaining
  that only the `@azx/source` branches resolve today. The `./styles.css` discussion is superseded by
  §6.
- **AGENTS.md §7** — the `grep -c '@azx/ribo-core' playground/dist/assets/*.js` verification is
  explicitly justified by `dist/` not existing, so it stops being a valid check. Replace it with the
  §5.2 resolver assertion, and note the new hazard.
- **AGENTS.md §2 and §6.2** — the command list and the package skeleton both need the `build` script
  and `@azx/build-config`; §6.2's checklist gains "add a `tsdown.config.ts`" alongside its existing
  "add the `typecheck` script" warning about silent absence from the gate.

---

## 8. Risks — verify empirically, do not reason

1. **publint/attw × the `@azx/source` condition** (§5.1). Highest-probability first-run failure.
2. **The transcriber's two entries share code.** `index` and `worker` both import `protocol.ts` and
   `config.ts`, so code-splitting hoists a shared chunk and `dist/worker.js` is **not**
   self-contained — it carries a sibling import. Doc 10 §3.1 accepts this for a `{type:"module"}`
   worker and says to build a separate tsdown config rather than fight chunking if a standalone file
   is ever needed. Verify the emitted import is relative and resolves from a consumer's
   `node_modules`.
3. **tsc-based dts sees the whole `include: ["src"]`** — including `prime.manual.ts`,
   `transcribe.manual.ts` and every `*.test.ts`. Confirm nothing but the declared entries reaches
   `dist/`, and that `assets.d.ts`'s `*.wav?url` ambient declaration does not leak into the published
   types.
4. **RxDB × Rolldown is _not_ covered by R1.** `rxdb` is externalized, so tsdown never transforms it.
   Doc 10 §2.1's requirement to smoke-test RxDB against Oxc — no decorator lowering, changed CJS
   `default` interop — lands on the _playground and field-app Vite builds_, not here. Recorded so
   nobody marks it closed.
5. **Serving from a non-root base path** (MVP design risk 3) is R3's to catch, not R1's. R1 produces
   the artifact; only a real host build exercises worker and WASM URL resolution under `/app/`.
6. **tsdown's config loader resolving a TypeScript workspace dependency** (§2.2). If it declines,
   `@azx/build-config` ships plain `index.mjs` + `index.d.mts`. Worth probing in the first task, since
   every other task imports from that package and a late discovery would touch all five configs.

---

## 9. Definition of done

`./check.sh` green, with its new stages, and the summary line pasted rather than asserted
(AGENTS.md §7). Concretely:

1. All five packages produce `dist/` with `index.js`, `index.d.ts` and sourcemaps;
   `ribo-transcriber-ondevice` additionally produces `worker.js` / `worker.d.ts`.
2. publint (strict) and attw (level: error) pass for all five.
3. The resolver assertion passes in **both** directions for five root exports plus the `./worker`
   subpath, and the playground's Vite `resolveConfig` includes `@azx/source`.
4. No `.ts` in any tarball; exactly one resolved React.
5. The playground still resolves to **source**, and its production build still passes — R1 must not
   change the primary dev loop.
6. AGENTS.md carries no statement R1 has made false.
