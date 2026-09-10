# Comparison

The question people arrive with is "why would I use this instead of Docling, or Mistral Document
AI, or just calling a structured-output API myself?"

For Docling and Mistral, the honest answer is that **it is not an either/or**. Those are document
parsers. They turn a file into text and layout. Ribo is the pipeline _above_ the parser — it starts
where they finish, and one of its own packages,
[`@azx/ribo-transcriber-managed-docs`](/reference/), is a hosted document-understanding API plugged
into Ribo's `Transcriber` seam.

So the real comparison is not Ribo against a parser. It is **Ribo against writing the six stages
after the parser yourself.**

That said, a reframe is easy to hide behind, so the table below is specific about what each tool
does and does not do — including the rows where Ribo is the wrong answer.

## Feature matrix

**Legend:** ✅ does this · 🟡 partially, or with meaningful caveats · 🚫 does not do this, by design
or otherwise.

|                                              | Ribo | Docling | Mistral Document AI | Structured outputs, direct |
| -------------------------------------------- | :--: | :-----: | :-----------------: | :------------------------: |
| Parses scanned, rotated or handwritten pages |  🚫  |   ✅    |         ✅          |             🟡             |
| Ingests audio dictation                      |  ✅  |   🚫    |         🚫          |             🚫             |
| One extraction across mixed sources at once  |  ✅  |   🚫    |         🚫          |             🚫             |
| Target schema past a few hundred fields      |  ✅  |   🚫    |         🚫          |             🚫             |
| Provenance verified against the source text  |  ✅  |   🚫    |         🟡          |             🚫             |
| Human review as a contract, not a screen     |  ✅  |   🚫    |         🚫          |             🚫             |
| Works with no network                        |  ✅  |   ✅    |         🚫          |             🚫             |
| Data need never leave the device             |  ✅  |   ✅    |         🚫          |             🚫             |
| Runs in a browser with no server             |  ✅  |   🚫    |         🚫          |             🟡             |
| Durable queue, survives reload and offline   |  ✅  |   🚫    |         🚫          |             🚫             |
| Writes back into a system of record          |  ✅  |   🚫    |         🚫          |             🚫             |
| The parser is swappable                      |  ✅  |   n/a   |         n/a         |            n/a             |

Read the last row as the point of the whole table: for Ribo the parser is a dependency you choose,
and **Docling or Mistral can be that choice**.

### The rows Ribo loses, stated plainly

**Ribo does not parse documents.** It delegates. `@azx/ribo-transcriber-pdfjs` extracts a PDF's
existing text layer and carries an explicit `no-text-layer` guard that refuses the document rather
than guessing — because it cannot OCR. If your input is a photographed page or a scan, you need a
real parser in front of Ribo, and Docling and Mistral are both good at that in ways Ribo has no
ambition to be.

**Docling wins on offline parsing and privacy too.** It is a local library; nothing has to leave the
machine. Those two ✅s in its column are real, and if parsing is the whole of your problem, Docling
alone is a better answer than Ribo plus Docling.

**Mistral Document AI does more than parse.** It supports schema-driven annotation with
bounding-box grounding, which is genuinely in the same territory as Ribo's provenance envelope —
hence 🟡 rather than 🚫 on that row. The differences are that the schema still has to fit in one
request, and that a bounding box tells you _where the model looked_, not that the quote it returned
is actually present. Those are real distinctions, not large ones.

## The differences that are hard to reproduce

Ranked by how much work they would take to rebuild.

### 1. The target schema does not fit in one call

The deepest difference, and the only one backed by measurement here.

A system of record we build against exposes **837 distinct writable fields**. Provenance makes this
worse rather than better: wrapping each leaf in `{ value, confidence, sourceSpan }` roughly triples
the property count. Measured against a snapshot of that specification, the combined job schema came
to **~5,360 properties against a documented 5,000-property ceiling, and ~1,490 enum values against a
1,000-value ceiling** — over both, by margins too large for subsequent drift in the spec to close.
It is not slow or expensive at that size. It is refused.

The ceilings also differ by vendor. Our own probing found one model family rejecting any response
schema with more than **16 nullable unions** — which, at two per enveloped leaf, is **eight fields
per call**. Two groups in our pilot schema already exceed that.

Ribo partitions the schema on nullable-union count, runs the calls concurrently against a bounded
pool, runs a follow-up pass over leaves that abstained despite quoting evidence, and reassembles one
result. None of that is a wrapper around an API call; it is the thing that makes the API call
possible.

Full working: [Extraction schema scale](/deep-dives/).

### 2. Provenance you can falsify

Every leaf arrives as `{ value, confidence, sourceSpan }`, and `isSpanGrounded` checks that span
against the source text. An invented citation is caught by string comparison — no human, no second
model, no judgement.

The unit of citation is a tuned parameter, not an afterthought, because it changes accuracy. On a
wide table in a real report, per-**cell** citations came back **37% fabricated**; per-**row**
citations on the same table came back **14 of 14 verbatim**. A group can therefore declare its
granularity as `leaf` (the default), `row`, or `none`. Per-cell provenance on a 67-row × 9-column
table also costs 603 citations that no reviewer will ever click, and forced the group to split
across two calls to deliver them.

A confidence score cannot be checked. A quote can.

### 3. Review as a contract

`buildReviewRequest` turns an extraction into flat dotted leaf paths, each carrying **its own zod
schema**, so a review UI renders the right editor and validates the edit without importing anything
tool-specific. The session parks at `awaiting-review`, the relay drains past it rather than
stalling, and an explicit submission is the only way forward.

Reproducing the screen is a week. Reproducing the contract — leaf-level addressing, per-leaf
schemas, a durable gate — is where the time actually goes, and it is the part you discover you got
wrong after you have built the screen.

### 4. Offline as a property of the architecture

A capture is durable from the moment it exists. The pipeline is two persisted state machines rather
than a promise chain: a recording runs `queued → transcribing → transcribed`, and a session runs
`open → extracting → awaiting-review → writing → done`, each with a resting-and-retryable `failed`
distinct from a terminal `dead`. Retries back off and survive a reload. The app shell and any
on-device model weights are cached before they are needed.

This is not a feature. It is a constraint that has to be present from the first commit, and
retrofitting it means rewriting the pipeline.

### 5. Any source, one extraction

A session joins several captures — an invoice PDF, a load-calculation report, the reviewer's
dictation — into one transcript with per-capture attribution, and extracts across all of them at
once. No parser accepts dictation. No speech API accepts a PDF.

### 6. Engine selection from a measurement

Transcribers report what they can do _right now_. The on-device engine measures the device's actual
real-time factor when it primes, which is what lets it report `too-slow` and hand off to a managed
engine — before that measurement existed, a slow device always reported ready and the fallback was
unreachable at any threshold. `firstCapable`, `fallbackTranscriber` and `hedged` compose engines;
`fallbackExtractor` and `raceExtractor` do the same for extraction strategies.

### 7. It ends in a write

A `ToolAdapter` is the only place tool-specific knowledge lives. `toWriteStep` installs the one
place a schema is parsed before a write; per-instance writes derive idempotency keys and resume
after a partial failure.

## Three properties of running in the browser

Worth stating separately, because they are usually described as limitations and two of them are
capabilities.

**There is no server.** Ribo targets static hosting with a capability gateway. A Python library with
native dependencies has nothing to run on in that environment. This is a genuine constraint and it
shaped the design.

**No credential ever reaches the client.** Every managed plasmid is built with _no capacity to
authenticate_: it takes an endpoint and an injected `fetch`, and the credential lives in the host's
transport. That is what makes these packages safe to drop into someone else's application.

**Data need never leave the device.** On-device transcription and on-device extraction mean the
recording and the document can stay on the machine that captured them. For a lot of buyers that is
the entire procurement conversation, and it is not available from any hosted API.

## Use something else when

- **You are batch-processing documents on a server.** No review loop, no offline requirement, no
  write-back — Ribo is pure overhead. Use Docling.
- **Your schema fits in one call and no human checks the output.** Call a structured-output API
  directly. Twenty lines, and every abstraction here is a cost you are not recovering.
- **Your hard problem is parsing degraded scans.** Buy a parser. Optionally put Ribo above it.
- **You are not in a browser, or not in TypeScript.** Ribo is a browser-side TypeScript library and
  has no server-side or Python story.

## What is not measured

Two things this page does not claim, because they are not currently true:

**Extraction accuracy has no current number.** The annotated corpus that produced earlier figures is
written in a field vocabulary the adapter no longer uses, so the acceptance gate deliberately
refuses to emit a score rather than emit a meaningless one. The measurements cited above are about
_provenance behaviour_ — citation fidelity and call counts — not about how often a field is right.

**Transcription accuracy is measured on clean audio only.** `whisper-base.en` runs at roughly 6×
real time with 8.0% word-error rate — but that is against authored text-to-speech audio with no
noise, mic handling, disfluency or cross-talk. It is a floor, not a field forecast. Word-error rate
against real field speech is not yet measured. See
[Transcription: Measured](/deep-dives/transcription-measurement).
