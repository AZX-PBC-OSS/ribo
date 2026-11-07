# Contributing to Ribo

Thanks for working on Ribo. This is the short version; [`AGENTS.md`](AGENTS.md) is the full working
guide — the architecture map, the commands, and the non-obvious mechanisms that must not be
"simplified". Read it before your first edit.

## Setup

Ribo is a pnpm workspace. You need:

- **Node >= 24** — the major is pinned in `.nvmrc` (`nvm use` / `fnm use` picks it up), and enforced by
  `engines.node` in the root `package.json`. Keep the two in sync.
- **pnpm 10.34.5** — pinned via `packageManager`; `corepack enable` honors it.

```bash
pnpm install                  # bootstrap the workspace
pnpm --filter playground dev  # dev server on http://localhost:5173
```

The `playground/` app is this repo's stand-in for a consumer; it composes all packages from TypeScript
source, so editing a package's `src/index.ts` hot-updates the page with no build step.

## The one "am I done?" signal

```bash
./check.sh
```

`check.sh` runs every gate in order — **typecheck → lint → format:check → build → docs → test** — and
prints a PASS/FAIL summary. CI runs the same script, so there is no second bar to clear. Run it before
you claim a task is finished, and paste the summary line rather than asserting success.

Two things it does **not** do: the `build` stage compiles the playground but never executes it (there is
no runtime smoke test), and the browser test binary is a separate install
(`pnpm exec playwright install chromium`).

Two root scripts **write to the working tree** and are not safe to run for information: `pnpm format`
(Prettier `--write`) and `pnpm lint:fix` (ESLint `--fix`). Use `pnpm format:check` and `pnpm lint` when
you only want to know.

## Conventions that bite

- **The headless boundary.** `@azx/ribo-core` and `@azx/ribo-adapter-snuggpro` are headless: **no React
  and no DOM _rendering_** — but browser APIs (`MediaRecorder`, `IndexedDB`, `fetch`, `Blob`,
  `AudioContext`, `Worker`) are expressly allowed. This is a **layering** rule, enforced in
  `eslint.config.mjs` (not by omitting the DOM lib): `no-restricted-imports` blocks `react`/`react-dom`,
  and `no-restricted-globals` blocks `document`/`window`, scoped to those two packages. Reaching for a
  React import or `document` means you are rendering — that belongs in `@azx/ribo-ui-react`.

- **Exact catalog pinning.** `pnpm-workspace.yaml` has a `catalog:` block with **exact versions and no
  carets**; packages reference `"catalog:"`. Every upgrade is a deliberate, reviewable, one-line change.
  Do not "modernize" these into carets, and **do not invent version numbers** — resolve the latest
  compatible version at install time and pin what you actually got. Some entries are held back on purpose
  (e.g. `typescript`, `@types/node`) with a comment explaining why; read it before bumping.

- **The export-surface tests.** Each package's public barrel (`src/index.ts`) **re-exports only** — it
  defines nothing. A test pins the exact list of runtime exports (`ribo-core/src/index.test.ts`), and
  `contracts.test.ts` composes the whole vocabulary through the entry point. Adding or removing a public
  export is a deliberate edit to that list, never an accident during a refactor. Import public entry
  points only (`@azx/ribo-core`, never `@azx/ribo-core/src/...`).

- **The `@azx/source` condition.** Every publishable package's `exports` sets a custom `@azx/source`
  condition (first, before `types`/`default`) pointing at `./src/index.ts`. Only _this_ workspace turns
  it on (via `customConditions` in the shared tsconfig and `resolve.conditions` in Vite/Vitest), so
  in-repo consumers get instant HMR into source while everyone outside gets `dist/`. The block
  **defaults to `dist/`** — the safe direction. If source-first resolution stops working, suspect this
  condition before Vite. Do not reorder the block: `types` must come before any JS condition.

- **Other conventions:** ESM-only (`"type": "module"`, no CJS build); zod at trust boundaries, plain
  types inside; small focused files; `import type` for type-only imports; adapters are the only place
  tool-specific knowledge lives. Formatting is Prettier's — don't hand-format, run `pnpm format`.

## Releasing

Releases are managed with [Changesets](https://github.com/changesets/changesets), configured in
`.changeset/config.json`, and run by `.github/workflows/release.yml`. Releases are **versioned and
tagged, not published**: there is no `.npmrc` and no registry yet (`AGENTS.md` §2), so a release is
a set of `<name>@<version>` git tags and GitHub releases, and nothing reaches npm.

**Independent versioning.** Each publishable package versions on its own line — there are no `fixed`
or `linked` groups. A change to `@azx/ribo-adapter-snuggpro` bumps only that package (and its
dependents); it never drags `@azx/ribo-core` along. A release target is any package under
`packages/*` that doesn't set `"private": true` — check there rather than trusting a count here. As
of this writing that's thirteen packages, all `@azx/`-scoped: `ribo-core`,
`ribo-ui-react`, `ribo-transcriber-ondevice`, `ribo-chat-openai`, `ribo-chat-helix`,
`ribo-extractor-ondevice`, `ribo-extractor-systemone`, `ribo-adapter-snuggpro`,
`ribo-transcriber-managed`, `ribo-transcriber-managed-docs`, `ribo-transcriber-pdfjs`,
`ribo-storage-rxdb` and `ribo-systemone-managed`.

The non-publishable packages are excluded from versioning and publishing entirely: the private
`playground` app, `@azx/tsconfig` (build-only compiler config), and `@azx/build-config` (shared
build config), all `private: true`. Changesets skips private packages by default;
`privatePackages: { version: false, tag: false }` makes that explicit in the config.

**Semver, and what pre-1.0 means here.** Every package is `0.x`. While pre-1.0 we follow the 0.x
reading of semver literally: **a MINOR bump may break** (features and breaking changes both land as
minors) and **a PATCH is fixes only** — there is no stability promise below 1.0. **`1.0` is the
contract-stability commitment**: a package's first `1.0.0` is where we start treating its public
surface as a contract and reserve breaking changes for major bumps. Cutting a `1.0` is a deliberate,
per-package statement, not a routine bump.

**So a breaking change is a `minor` changeset, not a `major` one.** Changesets takes `major`
literally: on a `0.x` package it means `1.0.0`. Choose `major` only when you mean to cut that
package's `1.0`.

**The `ribo-core` peer-range policy.** Only `@azx/ribo-ui-react` takes `@azx/ribo-core` as a
**peer** dependency — the shared-instance case, where a consumer holds core's runtime objects and
hands them to the plasmid, so both must see one copy of core (`AGENTS.md` §6.2 has the full
criterion: runtime object-identity sharing, not "leaf vs. not"). `@azx/ribo-transcriber-ondevice`,
`@azx/ribo-chat-openai`, `@azx/ribo-chat-helix` and `@azx/ribo-adapter-snuggpro` all depend on `@azx/ribo-core` as a
plain runtime `dependency` instead, for that reason. The peer declaration uses `workspace:^`, which
pnpm rewrites to a caret range (`^<version>`) at publish time; the caret (rather than the exact
`workspace:*` link) means an **in-range** core release does not force consumers to pull a new
plasmid. Type-only and test-only devDependencies on core (and the adapter's dev-only dependency on
`@azx/ribo-chat-openai`) stay `workspace:*` — they never ship, so an exact link is fine.

A core release is therefore a **deliberate, coordinated event, not a silent transitive bump**: when
`@azx/ribo-core` changes, Changesets flags every package that peers on it and proposes a bump for
them in the same release (a peer dependency is a contract, so the default proposal is a major bump of
the dependent). Review those proposed bumps — they are telling you a core change is rippling outward.

**Everyday workflow.**

```bash
pnpm changeset            # author a changeset: choose the packages, the bump level, write the summary
pnpm changeset:version    # consume pending changesets: bump versions, propagate to dependents, write
                          #   CHANGELOG.md entries — then commit the result
pnpm changeset:publish    # publish to the registry — DEFERRED: no registry/.npmrc yet, do not run
```

Author one changeset per logical change and commit its `.changeset/*.md` file alongside the code it
describes.

**Cutting a release.** You don't run `changeset:version` by hand. Each push to `main` with pending
changesets makes the Release workflow open or refresh a "chore: version packages" PR, which runs
`changeset:version` for you. Merging that PR is the release: the next run finds nothing pending,
runs `changeset tag`, and pushes a `<name>@<version>` tag and a GitHub release for each package it
bumped. The version PR is opened by `GITHUB_TOKEN`, which does not trigger CI, so close and reopen it
(or push to its branch) to get checks before merging. To publish once a registry exists, swap the
workflow's `publish-script` for `pnpm changeset:publish`. The changelog generator is the built-in, tokenless
`@changesets/cli/changelog` — no `GITHUB_TOKEN` required. `access` is `restricted` for now,
revisitable once the registry is chosen.

## Docs

The docs site and the generated API reference: `pnpm docs:dev` serves the site, `pnpm docs:build`
emits the static site, and `pnpm docs:api` regenerates the API reference from each package's public
barrel via TypeDoc. `docs:build` is a `check.sh` stage, so a dead doc link fails the everyday gate —
no separate CI step builds the docs.

The site is hosted on Helix as `ribo-docs` (`https://ribo-docs.azx.helix.azxlabs.io`). Every push to
`main` builds it and uploads a **preview** (`.github/workflows/helix-deploy.yml`, connected with
`helix ci init`; it needs no secret). A preview is not live until someone promotes it, in the
portal or with `helix promote <n>`; Helix refuses to promote from CI. `pnpm docs:deploy` uploads a
preview from your machine, for checking a change before it merges.
