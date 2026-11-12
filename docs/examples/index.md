# Examples

The `examples/` folder at the repo root holds small, private pnpm workspace
projects — one idea each. Every one is credential-free: it runs in CI against
the same doubles the tests use (`scriptedChat`, `FakeTranscriber`,
`FakeExtractor`, in-memory storage), so no page on this site can show code that
has never executed. A snippet include (`<<<`) on a guide or API page pulls its
code from an example file, and the generalised example check
(`scripts/check-api-examples.mjs`, a `docs:build` stage) keeps every include's
path and region real and every example file referenced.

| Example         | Idea                                                                                                                                               | `@azx/ribo-*` packages | Backs                                 | Source                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `example-smoke` | The scaffolding skeleton every example copies — no idea of its own. It proves the `examples/*` wiring end to end and owns the include proof below. | `@azx/ribo-core`       | This page (the anatomy snippet below) | [examples/smoke](https://github.com/AZX-PBC-OSS/ribo/tree/main/examples/smoke) |

::: warning About the source links
Every source link is built uniformly as
`https://github.com/AZX-PBC-OSS/ribo/tree/main/<path>` from the in-repo path —
a folder renders as that folder's GitHub tree page, a file as the file's page.
Two facts are not smoothed over: the rendered URL is **not** covered by the
docs build's dead-link check (which covers in-docs links only — the in-repo
path half is what the example check verifies), and the repo's GitHub visibility
is **internal**, so readers outside the org cannot open the links.
:::

## Anatomy of a runnable example

A runnable example is a `*.run.ts` file at an example package's root whose
every named export is a zero-argument function ending in `node:assert/strict`
assertions. Here is the smoke package's whole body, pulled live from
`examples/` — outside this docs site's root — by a VitePress snippet include:

<<< @/../examples/smoke/smoke.run.ts#smoke-opens-and-closes

This include is the standing proof that snippet includes reach outside the docs
root (`@` resolves to `docs/`, so `@/../examples/...` lands at the repo root).
The **smoke package owns that proof until the no-key-pipeline example lands**,
at which point — and only then — the smoke package is deleted and this include
is retargeted in the same change, so the proof always has an owner.
