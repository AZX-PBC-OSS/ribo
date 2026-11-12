# 0039. The Snugg adapter generates its JSON Schema document in its own build

Status: Accepted
Date: 2026-11-13

## Context

ADR 0037/0038 gave the CLI an `inspectSchema` entry that takes a JSON Schema document in
OpenAPI 3.0 form — but no package published one. The only artifact in the repo that looks like
one (`@azx/ribo-adapter-snuggpro`'s hand-frozen test fixture) is draft-2020-12 form and marked
do-not-regenerate, so getting a document meant hand-rendering `snuggExtractionSchema` with
`z.toJSONSchema` each time — a step a caller will forget, and one whose output can drift from
the schema it claims to describe.

The alternatives each fail:

- **Hand-maintain a committed document.** Two sources of truth for one schema; the document
  drifts the first time someone edits `src/schema.ts` and forgets the file, and no gate can tell
  committed-but-stale from current.
- **Generate at publish time.** Publish is the one step least likely to be run locally and the
  one most able to hide a skipped generation behind a green tree; the artifact a consumer gets
  would not be the artifact a developer just tested.
- **Commit a generator output with a `--check` drift gate** (the `scripts/snugg-descriptions.mjs`
  pattern). That pattern exists for code-shaped derived files regenerated deliberately; a JSON
  document rendered from a zod schema has exactly one honest lifecycle — always regenerated from
  the schema, never staged or reviewed as its own artifact.

## Decision

**`@azx/ribo-adapter-snuggpro` renders `snuggExtractionSchema` to
`dist/extraction.schema.json` during its own build, with
`z.toJSONSchema(schema, { target: "openapi-3.0" })` — the `target` written literally in the
generator, never defaulted — and publishes the file at the `./extraction.schema.json` subpath.**

The rules that ride with the decision:

- **The zod module is the single source of truth.** The file is build output under the
  gitignored `dist/`, never committed, never hand-edited; a generation failure fails the build,
  so a missing artifact cannot ride a green one.
- **The target is explicit.** Zod's default rendering is draft-2020-12, whose `anyOf`-with-null
  nullability ADR 0038's converter refuses outright — and which `z.fromJSONSchema` would read
  back as unions, a different schema. An explicit target makes the artifact's form independent
  of zod's defaults and version.
- **The round-trip test is the staleness tripwire.**
  `packages/ribo-adapter-snuggpro/acceptance/schema-artifact-round-trip.test.ts` asserts the
  generated file and the live zod schema produce one identical `inspectSchema` report
  (fingerprint included). It reaches the CLI engine through a **dev-only** `@azx/ribo-cli`
  dependency — the workspace's first dev-cycle, the mirror of the CLI's existing dev-link to
  this adapter, sanctioned for this boundary by the CLI design doc §6; neither package's build
  consumes the link, and nothing CLI-side is in the adapter's published surface.
- **The CLI-side `snugg-round-trip.test.ts` stays.** It guards document-level equality inside
  the CLI suite (does zod's conversion round-trip at all); this ADR's test guards report-level
  equality over the published artifact (is the published file current and interchangeable).
  Different granularity, different questions.

## Consequences

What this buys: getting a JSON Schema document for the extraction schema is `pnpm add` plus an
import — no render step to remember; the published file cannot drift from the zod schema because
it is regenerated from it on every build; and the zod-bump tripwire demanded by ADR 0038's
semi-experimental `fromJSONSchema` warning is pinned by a test, not a habit.

What it costs: the adapter's build is two tsdown passes around the generator (the in-build
tarball checks must see the artifact, so the checked pass runs after generation), which doubles
that package's build time. The dev-dependency cycle is a real novelty a future reader will
notice before they understand it — this ADR is the explanation. And the artifact is only as
current as the last build: a consumer reading it from a stale checkout's `dist/` can see a
document one schema edit behind, which the round-trip test catches locally and the CLI's
fingerprint makes visible in any report.
