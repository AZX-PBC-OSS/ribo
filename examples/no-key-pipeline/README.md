# example-no-key-pipeline — the no-key pipeline, end to end

One idea: **provenance is checkable with no model.** A single credential-free
arc — parse an `AudioCapture`, transcribe it with `FakeTranscriber`, derive the
extraction schema with `enveloped`, extract with `FakeExtractor`, then assert
every committed citation is verbatim in the transcript — with no key, no
network and no model anywhere.

This is the example the Quick Start guide renders: its code is pulled into
`docs/guide/quick-start.md` and `docs/guide/provenance.md` by VitePress snippet
includes, and the runner (`examples/run-examples.test.ts`) executes its export
in the `unit` project on every `./check.sh` run, so the front door of the docs
can never show code that has not run.

It is also the copyable skeleton for a new example package: `"private": true`,
its own `typecheck` script, `@azx/ribo-core` and `@azx/tsconfig` as
`workspace:*` devDependencies, and its runnable code in a `*.run.ts` at the
package root whose exports are zero-argument functions ending in
`node:assert/strict` assertions. Example packages carry no `*.test.ts` files —
the root runner is the only one.
