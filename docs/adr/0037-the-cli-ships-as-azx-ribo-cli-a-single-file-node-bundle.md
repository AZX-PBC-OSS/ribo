# 0037. The CLI ships as `@azx/ribo-cli`, one single-file Node bundle

Status: Accepted
Date: 2026-11-11

## Context

The schema-inspect command (`docs/roadmap/design/ribo-cli-schema-inspect-design.md`) is the first
piece of ribo that runs on a developer's machine rather than in their browser app. Every package in
the workspace so far is a browser library — `browser-library.json` or `react-library.json`, DOM
types, no Node built-ins — and the reserved-category table of AGENTS.md §6.1 has no row for a
command-line tool. Building the CLI as a browser package would be a lie about its runtime;
building it without a naming row would make the second CLI plasmid (`schema validate` is already
plausible) invent its category on the day it arrives.

The forces that shaped the decision:

- **The CLI is the repo's first Node-platform package.** It reads files and stdin, writes stdout
  and stderr, and exits with codes — none of which a browser library may assume. Its tsconfig
  base is `base.json` plus Node types, not `browser-library.json`, and the layering rules (no
  React, no DOM rendering) carry over unchanged.
- **It must run from a single file.** A developer installs one package and gets one bin. The
  bundle carries its dependencies inside: `zod` (the OpenAPI 3.0 conversion of ADR 0038) and
  `@azx/ribo-core` (`describeExtraction`, `walkLeafInventory` and the rest of the report's
  sources). A `node_modules` tree of peers at run time is the failure mode of shipping a bin as if
  it were a library.
- **Wiring stays through the core contracts, never a name.** The §6.1 rule that no code branches
  on a package name holds for the CLI like anywhere else; the category is documentation for
  humans.

## Decision

**The CLI ships as `@azx/ribo-cli`, bin `ribo`, built with tsdown as a single-file ESM bundle with
`zod` and `@azx/ribo-core` bundled inside it, on a Node platform base.** The AGENTS.md §6.1
naming table gains the row `ribo-cli` — command-line tools — with `@azx/ribo-cli` as its first
example; the row text lands with the package-creation ticket, because AGENTS.md describes what
exists.

The build stays on tsdown, the repo standard (AGENTS.md §6.2), configured for a single entry and
inlined dependencies. Node's major stays pinned the way the repo pins it (`.nvmrc` and
`engines.node`), so the bin's runtime floor is the workspace's floor.

## Consequences

What this buys: one installable artifact with one bin and no runtime peer story — the version
fields of the inspect report's JSON contract are read at bundle time from the carried
packages' `package.json` files, so the published bin never resolves `node_modules` to answer a
question about itself. The naming row makes the next CLI tool a variant of an existing category
instead of a new decision.

What it costs: the CLI is the first package that breaks the browser-library symmetry — its
tsconfig and ESLint scope differ from every sibling's, and anything shared with the browser
packages (core's contracts) must stay environment-free, which is a constraint on what core may
grow from then on. Bundling `@azx/ribo-core` inside the published artifact also means the CLI's
release cadence is coupled to the core version it was built against — the `coreVersion` field in
the report exists precisely so a reader can see which core produced their numbers.
