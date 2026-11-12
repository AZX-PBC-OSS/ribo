# Examples

The `examples/` folder at the repo root holds small, private pnpm workspace
projects — one idea each. Every one is credential-free: it runs in CI against
the same doubles the tests use (`scriptedChat`, `FakeTranscriber`,
`FakeExtractor`, in-memory storage), so no page on this site can show code that
has never executed. A snippet include (`<<<`) on a guide or API page pulls its
code from an example file, and the generalised example check
(`scripts/check-api-examples.mjs`, a `docs:build` stage) keeps every include's
path and region real and every example file referenced.

| Example                         | Idea                                                                                                                                                                                                                                             | `@azx/ribo-*` packages | Backs                                                                                                                                                                                                                                                                                                                | Source                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `example-no-key-pipeline`       | Provenance is checkable with no model — one credential-free capture → transcribe → extract → span-check arc.                                                                                                                                     | `@azx/ribo-core`       | [Quick Start](/guide/quick-start), [Provenance](/guide/provenance), [Provenance API](/api/provenance)                                                                                                                                                                                                                | [examples/no-key-pipeline](https://github.com/AZX-PBC-OSS/ribo/tree/main/examples/no-key-pipeline)                                               |
| `example-durable-queue`         | The durable queue's host-observable half — watch a session reach `awaiting-review`, and prove the capture row is persisted before transcription runs, asserted from inside the transcription call.                                               | `@azx/ribo-core`       | [Sessions](/guide/sessions) (watch include), [Offline & Storage](/guide/offline-and-storage) (added include), [Important Defaults](/guide/important-defaults) (prose pointer); the drain itself is [Relay API](/api/relay) and [openStorage API](/api/open-storage), which this example links rather than re-teaches | [examples/durable-queue](https://github.com/AZX-PBC-OSS/ribo/tree/main/examples/durable-queue)                                                   |
| `example-review-gate`           | Nothing is written until a human resolves the review, stated positively — the relay writes zero while the session sits at `awaiting-review`, and exactly one write carrying the reviewed values follows `submitReview`.                          | `@azx/ribo-core`       | [Review](/guide/review) (contract and gate includes), [Write-back](/guide/write-back) (`toWriteStep` wiring include); the pure contract alone is [Review API](/api/review), the drain [Relay API](/api/relay), which this example links rather than re-teaches                                                       | [examples/review-gate](https://github.com/AZX-PBC-OSS/ribo/tree/main/examples/review-gate)                                                       |
| `example-ungrounded-rejected`   | A fabricated citation is refused, not corrected — an extractor quoting text absent from the transcript gets a terminal `ValidationRejectedError` whose census names the fabricated leaf by path.                                                 | `@azx/ribo-core`       | [Provenance](/guide/provenance) (rejection include), [Provenance API](/api/provenance)                                                                                                                                                                                                                               | [examples/ungrounded-rejected](https://github.com/AZX-PBC-OSS/ribo/tree/main/examples/ungrounded-rejected)                                       |
| `composing-transcribers.run.ts` | How transcribers compose into one engine — `firstCapable` preference order with skip reporting, `hedgedTranscriber` racing a fallback on an injected timer, `fallbackTranscriber` with an arbiter, and `restrictToKind` lifting a narrow engine. | `@azx/ribo-core`       | [Captures & Sources](/guide/captures-and-sources) (hedged-race and composition includes), [composing transcribers API page](/api/composing-transcribers)                                                                                                                                                             | [docs/api/examples/composing-transcribers.run.ts](https://github.com/AZX-PBC-OSS/ribo/tree/main/docs/api/examples/composing-transcribers.run.ts) |

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
