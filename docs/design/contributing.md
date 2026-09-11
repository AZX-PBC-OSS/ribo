# Contributing

Ribo is a pnpm workspace. Setup is **Node >= 24** and **pnpm 10.34.5** (`corepack enable` picks up
the pinned version). `pnpm install` bootstraps the workspace, and `pnpm --filter playground dev`
starts a dev server that composes every package from TypeScript source, so editing a package's
`src/index.ts` hot-updates the page with no build step.

The authoritative contributor guide lives in
[`CONTRIBUTING.md`](https://github.com/AZX-PBC-OSS/ribo/blob/main/CONTRIBUTING.md) at the repo root,
alongside [`AGENTS.md`](https://github.com/AZX-PBC-OSS/ribo/blob/main/AGENTS.md), the fuller working
guide, including the conventions and mechanisms that must not be simplified away. Read one or both
before your first pull request. This page covers the one thing the links don't: what "done" means.

## The definition of done, and its trap

```bash
./check.sh
```

`check.sh` is the everyday signal: typecheck, lint, format check, build, and test, printed as a
single PASS/FAIL summary. Run it before claiming a task finished, and paste the summary line rather
than asserting success.

**`./check.sh` is the everyday bar, but it is not the whole CI bar.** CI runs three further steps
that `check.sh` does not:

| CI step                                     | What it catches                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm docs:build`                           | broken doc links, generated-reference failures, a VitePress build failure |
| `pnpm changeset status --since=origin/main` | a changed publishable package with no changeset                           |
| `pnpm test:pack-and-consume`                | real tarballs, packed and installed into an app outside this repo         |

For an ordinary change, `./check.sh` really is enough, and the other three pass by construction. The
case where they do not is **adding, renaming, or removing a publishable package** — the
pack-and-consume tier keeps its own scratch app that has to list the package by name, and the
changeset tooling has to know a new or removed package exists. Run all four before pushing that kind
of change.

Getting this wrong once already cost a red CI: the working notes used to read "CI runs the same
script, so there is no second bar to clear" — and they were wrong.

## Two commands that write to the working tree

`pnpm format` (Prettier `--write`) and `pnpm lint:fix` (ESLint `--fix`) modify files in place and are
not safe to run just to check status — use `pnpm format:check` and `pnpm lint` when you only want an
answer.

## Conventions worth knowing before you send a diff

A handful of repo conventions are easy to trip over precisely because they look like they could be
simplified. [Design Decisions](/design/) records the reasoning behind the ones that most often come
up in review: the ESM-only build, the headless layering boundary enforced by ESLint, the
`@azx/source` export condition, worker injection, and the outbox storage seam. `CONTRIBUTING.md` and
`AGENTS.md` cover the rest — exact-pinned catalog versions, the export-surface tests on each
package's public barrel, and the rule that adapters are the only place tool-specific knowledge
lives.

For the versioning and release process itself, see [Releasing](/design/releasing).
