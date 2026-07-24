# Releasing

Ribo's releases are managed with [Changesets](https://github.com/changesets/changesets), configured
in `.changeset/config.json`. This page is the versioning policy; the authoritative maintainer
checklist lives in the "Releasing" section of
[`CONTRIBUTING.md`](https://github.com/azx-pbc/ribo/blob/main/CONTRIBUTING.md) at the repo root, and
the two are kept consistent.

::: warning Nothing is published yet
Publishing infrastructure is **not wired**: there is no `.npmrc`, the private registry is still an
open item, and nothing has been published. The versioning and changelog machinery below is ready;
the final `changeset:publish` step is dormant until a registry is chosen.
:::

## Independent versioning

Each publishable package versions on its own line — there are no `fixed` or `linked` groups. A change
to one package bumps only that package and its dependents; it never drags an unrelated package along.

The five release targets, all under the `@azx/` scope and all currently `0.0.0`:

- `@azx/ribo-core`
- `@azx/ribo-ui-react`
- `@azx/ribo-transcriber-ondevice`
- `@azx/ribo-extractor-openai`
- `@azx/ribo-adapter-snuggpro`

The private `playground` app and `@azx/tsconfig` (build-only compiler config) are `private: true` and
excluded from versioning and publishing entirely.

## Semver while pre-1.0

Every package is `0.x`, and we follow the 0.x reading of semver literally:

- **A MINOR bump may break** — new features and breaking changes both land as minors.
- **A PATCH is fixes only.**
- There is no stability promise below 1.0.

**`1.0` is the contract-stability commitment.** A package's first `1.0.0` is the point at which we
start treating its public surface as a contract and reserve breaking changes for major bumps. It is a
deliberate, per-package statement — not a routine bump.

## The `ribo-core` peer-range policy

`@azx/ribo-ui-react` and `@azx/ribo-transcriber-ondevice` take `@azx/ribo-core` as a **peer**
dependency — the shared-instance case, where a consumer holds core objects and hands them to the
plasmid, so both must see one copy of core. Those peer declarations use `workspace:^`, which pnpm
rewrites to a caret range (`^<version>`) at publish time. The caret (rather than the exact
`workspace:*` link) means an **in-range** core release does not force consumers to pull a new plasmid.
Type-only and test-only devDependencies on core stay `workspace:*` — they never ship, so an exact
link is fine.

A core release is therefore a **deliberate, coordinated event, not a silent transitive bump**: when
`@azx/ribo-core` changes, Changesets flags every package that peers on it and proposes a bump for them
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
`CHANGELOG.md` entries in a single pass. The changelog generator is the built-in, tokenless
`@changesets/cli/changelog` (no `GITHUB_TOKEN` required), and `access` is `restricted` for now —
revisitable once the registry is chosen.
