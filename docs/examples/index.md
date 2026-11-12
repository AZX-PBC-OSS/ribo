# Examples

The `examples/` folder at the repo root holds small, private pnpm workspace
projects — one idea each. Every one is credential-free: it runs in CI against
the same doubles the tests use (`scriptedChat`, `FakeTranscriber`,
`FakeExtractor`, in-memory storage), so no page on this site can show code that
has never executed. A snippet include (`<<<`) on a guide or API page pulls its
code from an example file, and the generalised example check
(`scripts/check-api-examples.mjs`, a `docs:build` stage) keeps every include's
path and region real and every example file referenced.

| Example                   | Idea                                                                                                         | `@azx/ribo-*` packages | Backs                                                                                                 | Source                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `example-no-key-pipeline` | Provenance is checkable with no model — one credential-free capture → transcribe → extract → span-check arc. | `@azx/ribo-core`       | [Quick Start](/guide/quick-start), [Provenance](/guide/provenance), [Provenance API](/api/provenance) | [examples/no-key-pipeline](https://github.com/AZX-PBC-OSS/ribo/tree/main/examples/no-key-pipeline) |

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
assertions. Here is the no-key-pipeline example's complete export, pulled live
from `examples/` — outside this docs site's root — by a VitePress snippet
include:

<<< @/../examples/no-key-pipeline/no-key-pipeline.run.ts#complete-export

This include is the standing proof that snippet includes reach outside the docs
root (`@` resolves to `docs/`, so `@/../examples/...` lands at the repo root).
The **no-key-pipeline example owns that proof**: deleting its file turns this
page's build red, the same way the example check turns a dangling include red.
