# Releasing

Ribo's releases are managed with [Changesets](https://github.com/changesets/changesets), configured
in `.changeset/config.json`. This page is the versioning policy; the authoritative maintainer
checklist lives in the "Releasing" section of
[`CONTRIBUTING.md`](https://github.com/AZX-PBC-OSS/ribo/blob/main/CONTRIBUTING.md) at the repo root, and
the two are kept consistent.

::: warning Nothing is published yet
Publishing infrastructure is **not wired**: there is no `.npmrc`, the private registry is still an
open item, and nothing has been published. The versioning and changelog machinery below is ready;
the final `changeset:publish` step is dormant until a registry is chosen.
:::

## Independent versioning

Each publishable package versions independently — no `fixed` or `linked` groups. A change to one
package bumps only that package and its dependents; it never drags an unrelated package along.

A release target is any package under `packages/*` whose `package.json` doesn't set
`"private": true` — check there rather than trusting a count here, since this list grows as packages
are added. As of this writing that's nine packages, all under the `@azx/` scope and all currently
`0.0.0`: `ribo-core`, `ribo-ui-react`, `ribo-transcriber-ondevice`, `ribo-extractor-openai`,
`ribo-extractor-ondevice`, `ribo-adapter-snuggpro`, `ribo-transcriber-managed`,
`ribo-transcriber-managed-docs`, and `ribo-transcriber-pdfjs`.

The private `playground` app, `@azx/tsconfig` (build-only compiler config), and
`@azx/build-config` (shared build config) are all `private: true` and excluded from versioning and
publishing entirely.

## Semver while pre-1.0

Every package is `0.x`, and we follow the 0.x reading of semver literally:

- **A MINOR bump may break** — new features and breaking changes both land as minors.
- **A PATCH is fixes only.**
- There is no stability promise below 1.0.

**`1.0` is the contract-stability commitment.** A package's first `1.0.0` is the point at which we
start treating its public surface as a contract and reserve breaking changes for major bumps. Bumping
a package to `1.0.0` is a per-package decision, not a routine bump.

## The `ribo-core` peer-range policy

Only `@azx/ribo-ui-react` takes `@azx/ribo-core` as a **peer** dependency — the shared-instance
case, where a consumer holds core's runtime `Recorder`/`Storage`/`Connectivity` objects and hands
them to the package, so both must see one copy of core. `@azx/ribo-transcriber-ondevice`,
`@azx/ribo-extractor-openai` and `@azx/ribo-adapter-snuggpro` all depend on `@azx/ribo-core` as a
plain `dependencies` entry instead, because none of them holds onto a shared core instance with
that kind of cross-boundary identity — see `AGENTS.md` §6.2 for the full criterion and why it's
runtime object-identity sharing, not "leaf vs. not." That peer declaration uses `workspace:^`,
which pnpm rewrites to a caret range (`^<version>`) at publish time. The caret (rather than the
exact `workspace:*` link) means an **in-range** core release does not force consumers to pull a new
plasmid. Type-only and test-only devDependencies on core stay `workspace:*` — they never ship, so
an exact link is fine.

A core release is therefore a **deliberate, coordinated event, not a silent transitive bump**: when
`@azx/ribo-core` changes, Changesets flags each package that peers on it and proposes a bump for it
in the same release (a peer dependency is a contract, so the default proposal is a major bump of the
dependent). Those proposed bumps are the signal that a core change is rippling outward — review them.

## Everyday workflow

```bash
pnpm changeset            # author a changeset: choose packages, bump level, and summary
pnpm changeset:version    # consume pending changesets: bump versions, propagate, write changelogs
pnpm changeset:publish    # publish — DEFERRED: no registry/.npmrc yet, do not run
```

Author one changeset per logical change and commit its `.changeset/*.md` file alongside the code it
describes. At release time `changeset:version` turns the accumulated changesets into version bumps and
`CHANGELOG.md` entries in a single pass. The changelog generator is the built-in
`@changesets/cli/changelog`, which needs no `GITHUB_TOKEN`. `access` is `restricted` until the
registry is chosen.
