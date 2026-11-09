# API

Hand-written lookup pages for Ribo's public APIs — one page per API, not per package. The
generated [API Reference](/reference/) is the exhaustive layer: every symbol, regenerated from
source on every docs build. These pages are the selective layer: what an API is for, what it
costs, what it throws — and every code example on them is compiled, and where possible executed,
by CI.

## Page template

Every page follows the same section order, in full:

1. **What it is** — one or two sentences.
2. **When to reach for it** — and when to read a guide instead.
3. **Usage** — the opening code snippet: a named region of the page's checked example file,
   pulled in with a VitePress region snippet import. Never hand-written.
4. **Options** — a table: name, type, default, what it does. Defaults come from source, not
   memory: a default the page states is quoted from a named `#region` of the example file,
   snippet-pulled into this section, and stated in prose (see the example contract below for how
   that is kept honest).
5. **Return value.**
6. **Errors** — naming the exported error classes.
7. **Full example** — the whole example file imported, with its execution status stated
   ("runs in CI" or "type-checked only").
8. **Related APIs.**
9. **Guides that use it.**
10. **Reference** — a link to the symbol's TypeDoc page.

The full signature is never written out on a page: the TypeDoc link is the exhaustive layer, and
nothing on a page is unchecked prose pretending to be a signature.

## The example contract

Examples live under `docs/api/examples/` — one file per example on a page — and are imported with
VitePress's `<<<` snippet syntax: a named `#region` of the file for the usage snippet, the whole
file for the full example. Examples run with no credentials and no network: chat-based examples
drive `scriptedChat`, and the seams use `FakeExtractor` and `FakeTranscriber`.

A **runnable** example is named `*.run.ts`. Every named export of such a file is a zero-argument
function that ends in `node:assert/strict` assertions on exactly the outcomes the page prose
claims — an example that only prints is not allowed. A runner executes every export in the
Vitest `unit` project on every `test` run, so a source change that breaks what a page says breaks
the `test` stage.

An example that needs a browser-only global (`MediaRecorder`, IndexedDB, a Worker scope, React
rendering) is a plain `.ts`/`.tsx` file without the `.run` suffix: it is type-checked but never
executed, and its page says so. The words "type-checked only" on such pages are not a courtesy —
a script checks every page that imports a non-run example for the statement.

### Resolution

`docs/` is not a workspace member, so package-name imports resolve through the root
`package.json`'s `workspace:*` devDependency links to the `@azx/*` packages — through each
package's real `exports` map under the `@azx/source` condition, the same path the playground and
the package test suites use, for both `tsc` (the examples tsconfig extends the shared base, which
sets `customConditions`) and the Vitest `unit` project (`ssr.resolve.conditions`). Deep imports
such as `@azx/ribo-core/src/...` do not resolve at all — the `exports` map does not admit them —
so importing through public entry points only is enforced by resolution, not by convention.

One import per publishable package, in the one file that proves the mechanism. Type-checked
only — this file is never executed; it exists so a broken `exports` block, a renamed barrel
export or a lost source condition fails the docs build for every package at once.

<<< @/api/examples/workspace-resolution.ts

### Reference links

Every page links the symbol's generated TypeDoc page. The confirmed URL shape is
`/reference/@azx/<package>/<kind>/<Symbol>.html`, where `<kind>` is one of `classes`,
`interfaces`, `functions`, `type-aliases` or `variables` (for exported constants) — for example
`/reference/@azx/ribo-core/interfaces/Transcriber.html`. Links keep their `.html` extension:
`cleanUrls` is `false` and the hosting setup matches request paths to files exactly.

## Pages

- [`Transcriber`](/api/transcriber) — the transcription contract: capability, transcription, and
  the three kinds of failure.
- [`Recorder`](/api/recorder) — microphone capture: negotiated containers, released streams, and
  a mid-capture failure that is surfaced, not banked.
- [`OnDeviceTranscriber`](/api/ondevice-transcriber) — on-device Whisper-family transcription:
  explicit priming, capability from the Cache API, worker wiring.
- [`ManagedTranscriber`](/api/managed-transcriber) — Azure Fast Transcription behind the host's
  transport, with no capacity to authenticate.
- [`PdfjsTranscriber`](/api/pdfjs-transcriber) — pdf.js document transcription, `Blob` in.
- [`ManagedDocsTranscriber`](/api/managed-docs-transcriber) — managed document transcription,
  the managed rung of a document ladder.
- [Choosing and composing transcribers](/api/composing-transcribers) — `firstCapable`,
  `fallbackTranscriber`, `raceTranscriber`, `hedged`, `restrictToKind`, and which one when.
- [Live transcription](/api/live-transcription) — utterance-level preview during recording; the
  `LiveTranscriber` seam and its tail/commit segments.
- [`CaptureSession`](/api/capture-session) — one live recording against storage: chunked
  ingestion, finalize, abort — and startup recovery for the recordings a dead tab left behind.
- [`Extractor`](/api/extractor) — the extraction contract: one annotated transcript in, parsed
  fields plus usage out, and the bridge to the relay.
- [`singleShotExtractor`](/api/single-shot-extractor) — the built strategy: one structured-output
  chat call over the target's schema.
- [`ChatClient` and chat transports](/api/chat-transports) — the transport seam, the two managed
  dialects, the on-device transport, the typed error, and the scripted double.
- [Test doubles](/api/test-doubles) — `FakeExtractor`, `FakeTranscriber`, `scriptedChat`: the
  whole pipeline, credential-free.
- [Phased extraction](/api/phased-extraction) — `phasedExtractor` and the phase vocabulary:
  write a multi-pass strategy as a list of narrowing steps, never a bespoke loop.
- [Presence narrowing](/api/presence-narrowing) — the opt-in preset that fills only the groups
  presence marked present; the presence phase is a parameter.
- [Schema at scale](/api/schema-at-scale) — the split, the dry run, the per-group plan and
  override layer, and the shape derivation: the whole split-and-per-group family on one page.
- [`groupedExtractor`](/api/grouped-extractor) — the run-owner combinator over per-key groups:
  coverage, scheduling, retry, sibling abort, merge.
- [Provenance](/api/provenance) — `enveloped`, the per-leaf envelope, the span check in three
  tiers, and the grounding census.
- [Review](/api/review) — `buildReviewRequest` and `resolveReview`: what a reviewer is shown,
  what they report back, and what the gate before a write enforces.
- [`ToolAdapter`](/api/tool-adapter) and the write steps — the one place tool-specific knowledge
  lives, and the trust boundary before a write.
- [`snuggProAdapter`](/api/snuggpro-adapter) — the real adapter: two field schemas, a refusing
  write until the host's transport arrives.
- [`createRelay`](/api/relay) — the foreground queue: transcribe, extract, write, retry, die.
- [`openStorage`](/api/open-storage) — the durability container over a backend, with no default
  backend.
- [The StorageBackend port](/api/storage-port) — the contract a backend implements, and the
  conformance kit that makes the obligations executable.
- [`createConnectivity`](/api/connectivity) and work safety — the three-state link model and the
  "is my work safe?" verdict.
- [`RiboProvider`](/api/ribo-provider) — the one context: host-constructed instances in, hooks
  served, nothing constructed or memoized by the provider itself.
- [`useRecorder`](/api/use-recorder) — capture as React state, with stop() that rethrows and
  start() that does not.
- [`useCaptures`](/api/use-captures) — the capture queue as live state, with a load-bearing
  `loading` and a by-value query comparison.
- [`useSessions`](/api/use-sessions) — the session-collection mirror of `useCaptures`.
- [`useConnectivity`](/api/use-connectivity) — the three-state model as state; lifecycle stays
  the host's.
- [`useStoragePersistence`](/api/use-storage-persistence) — the persistence grant and quota, one
  module-level store, `denied` means refused.
- [`useWorkSafety`](/api/use-work-safety) — the withheld-until-honest verdict, composed once.
- [`createCaptureCoordinator`](/api/create-capture-coordinator) — the shared handle between the
  recording hook and the work-safety verdict.
- [`fallbackExtractor`](/api/fallback-extractor) and the arbitration wrappers — ladders, races,
  arbiters, and the retry/timeout/hedge/consensus/cache/budget family.
- [`corroborateExtractor`](/api/corroborate-extractor) — the second judging combinator: a System
  One verdict per committed leaf, a terminal rejection, a ladder that falls through.
- [`useReview`](/api/use-review) — field-by-field review of one parked session as React state;
  the schema as an argument, never the adapter.
