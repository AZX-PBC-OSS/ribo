# Design Decisions

This page records the decisions that shape Ribo, for anyone deciding whether to adopt it or send a
pull request. Each one looks arguable in isolation. Each is closed, and the reasoning sits next to it
so it doesn't get relitigated every time someone new reads the code.

## The shape: a reusable core, thin per-tool adapters

Ribo is built as a **reusable engine plus a thin adapter per host tool**, not a one-off integration.
The core holds the pipeline — capture, transcribe, session-join, extract, review, write — and knows
nothing about any particular system of record. An adapter is declarative: a schema, extraction
instructions, and a `write` function.
[`ribo-adapter-snuggpro`](/reference/ribo-adapter-snuggpro/src/) is the one adapter that exists
today; adding a second host tool means writing a new adapter package, never teaching the core about
it.

**Extraction lives in the core, not in the adapter.** An adapter supplies _what_ to extract (a zod
schema) and _how to write it_; it never contains its own extraction logic. This keeps the cost of a
new adapter low and keeps host-specific knowledge — field names, quirks, selectors — out of the
core, which every adapter shares.

**Transcription is a pluggable strategy, not a fixed engine.** On-device WASM, a managed STT
service, and a document transcriber all satisfy the same `Transcriber` interface, and a caller
chooses between them by capability, not by branching on source type. See
[Captures & Sources](/guide/captures-and-sources) for how that plays out across capture kinds.

## `Transcriber`: the name stays (considered and closed)

Calling a PDF parse "transcription" is a stretch, and the docs considered a softer synonym —
"source", "reader" — and rejected it.

**The name stays.** The docs use the code's own vocabulary and explain it once, early in
[Captures & Sources](/guide/captures-and-sources): a `Transcriber` turns any capture into citable
text, and audio was just the first capture kind.

**Why not a synonym.** A reader who greps the API for "source" or "reader" would find a name nobody
in the codebase uses, and prose built around that synonym would drift out of sync with the
generated [Reference](/reference/) the moment the interface changed under it. **Why not rename the
interface itself** — that is a breaking change to a public contract, and out of scope for a
documentation pass regardless of how the name reads.

## ESM-only, no CJS build

Every published package is ESM-only (`"type": "module"`, no CommonJS build). The alternative —
dual-publishing both a CJS and an ESM build — invites the dual-package hazard: two module instances
of the same package loaded side by side, disagreeing about identity. That failure mode is fatal for
a library that carries React context, because a consumer can end up with a provider from one
instance and a consuming hook from the other, silently returning defaults instead of the provided
value. ESM-only sidesteps the hazard entirely rather than working around it.

## "Headless" is a layering rule, enforced by ESLint

`ribo-core`, `ribo-adapter-snuggpro` and `ribo-extractor-openai` are **browser libraries**, not
environment-agnostic ones: `MediaRecorder`, `IndexedDB`, `fetch`, `Blob`, `AudioContext` and `Worker`
are all expressly allowed, and all three packages' TypeScript configs include the DOM lib so those
types resolve. What is excluded is _rendering_ — a React import, or a reach for `document` or
`window`. That is a **layering** distinction, not an environment one, and it is enforced
accordingly: ESLint's `no-restricted-imports` blocks `react`/`react-dom` and `no-restricted-globals`
blocks `document`/`window`, both scoped to exactly those three packages. Reaching for either means
the code is rendering or querying a page, which belongs in `@azx/ribo-ui-react`.

An earlier version of this rule tried to enforce the same boundary by omitting the DOM lib from
those packages' TypeScript configs. That was wrong: it confused _type availability_ with _layering_,
and it blocked the very browser APIs the engine exists to use.

## The `@azx/source` export condition defaults to `dist/`

Every publishable package's `exports` block sets a custom, namespaced `@azx/source` condition ahead
of `types`/`default`, pointing at `./src/index.ts`. Only this workspace turns that condition on (via
`customConditions` in TypeScript and `resolve.conditions` in Vite/Vitest), which gives in-repo
consumers instant HMR straight into library source while everyone outside the workspace resolves to
the built `dist/` artifact.

The alternative — swapping `exports` to point at `src/` by default and rewriting it to `dist/` at
publish time via `publishConfig` — was rejected because the two approaches fail in opposite
directions. Defaulting to `src/` means a broken or skipped rewrite ships raw, uncompiled TypeScript
to a host app that cannot consume it. Defaulting to `dist/`, as Ribo does, means the worst case of a
broken condition is that a consumer gets the correct, already-built artifact and simply loses the
in-repo HMR convenience. The failure modes are asymmetric; the safe one is the default.

## `createWorker` is injected; library code never constructs a `Worker`

The on-device transcriber runs real inference in a Web Worker, but no published package ever writes
`new Worker(...)` or a bundler-specific `?worker` import. Instead, a consumer supplies a
`createWorker` factory, and the package ships the worker script itself as a plain published entry
point that the consumer's own bundler can see.

This exists because of an open Vite bug: a library-mode `?worker` import emits an absolute path that
404s in a _consumer's_ production build — a failure that passes every check this repo can run and
only appears in the host's own build output. Every workaround short of injection trades that failure
for a different one (inlining the whole worker as base64, breaking the module's MIME type, or
depending on how a downstream bundler resolves relative asset paths). Injection is what libraries in
the same position — duckdb-wasm, ffmpeg.wasm — already do.

## Durability sits behind a port, and core owns no engine

`openStorage({ backend })` takes a storage backend and has no default, because every default would
be wrong somewhere. `@azx/ribo-core` depends on `rxjs` and `zod`: it owns the contracts and every
piece of domain logic and could not construct an RxDB backend if it wanted to. The production one is
`openRxdbBackend()` from `@azx/ribo-storage-rxdb`; tests use `createMemoryBackend(name)`.

The port is roughly fourteen mechanical operations over three collections, with a **closed set of
three finders** rather than a query language — the domain only ever asks three questions, so a
backend implements three named finders and indexes them however it likes. Nothing resembling a query
selector crosses the boundary.

What makes an implementation real is not the types but six behavioural obligations no signature can
express, published as an executable conformance kit at `@azx/ribo-core/testing`. Two backends pass
it today.

**This was deferred once**, on the reasoning that a contract with one implementation locks in that
implementation's shape while pretending not to. That reasoning was sound and its premise has not
changed — no second _production_ backend is planned. What changed is the motive: the port exists so
core's contracts stop naming RxDB types, so a host can declare a store without reaching through to
RxDB, and so the vocabulary describes what the subsystem is. The guard against the original
objection is that there are two implementations from the first commit, both held to the same kit.

---

Read [Contributing](/design/contributing) for the definition of done, or [Releasing](/design/releasing)
for the versioning policy.
