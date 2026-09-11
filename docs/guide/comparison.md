# Comparison

The question people arrive with is "why would I use this instead of Docling, or Mistral Document
AI, or just calling a structured-output API myself?"

For Docling and Mistral, the honest answer is that **it is not an either/or**. Those are document
parsers. They turn a file into text and layout. Ribo is the pipeline _above_ the parser — it starts
where they finish, and one of its own packages,
[`@azx/ribo-transcriber-managed-docs`](/reference/), is a hosted document-understanding API plugged
into Ribo's `Transcriber` seam.

So the real comparison is not Ribo against a parser. It is **Ribo against writing the six stages
after the parser yourself** — and against the platforms and libraries that already sell pieces of
that job.

That reframe is correct, but it is also easy to hide behind: an earlier version of this page
compared Ribo only against parsers and a raw API call, which meant every column was a layer Ribo
sits above and every layer Ribo actually competes at was left out. The table below fixes that. It
adds the document-AI platforms that already sell "documents → your schema, with citations and
review," and the DIY orchestration a competent team reaches for instead of a naive `fetch` loop —
and it is specific about what each does and does not do, including the rows where Ribo is the wrong
answer.

## Feature matrix

**Legend:** ✅ does this · 🟡 partially, or with meaningful caveats · 🚫 does not do this, by design
or otherwise · n/a not a meaningful question for that category. **Evaluated as of 2026-09-11** —
vendor products move; where a cell below is load-bearing, the prose after the table names a version,
a date, or links the vendor's own documentation rather than asserting it here.

A category column (Document parsers / Document-AI platforms / DIY orchestration) is not one
product: its cell reads ✅ or 🟡 if **at least one** named member does the row, not that every
member does — the prose beneath the table says which member backs which cell. And a DIY-
orchestration cell reflects what the library ships out of the box, not what a team could build on
top of it — crediting hypothetical builds would make almost every row buildable, and Ribo's own
rows above are held to what it does today, not what could be added to it.

|                                                    | Ribo | Document parsers | Document-AI platforms | DIY orchestration |
| -------------------------------------------------- | :--: | :--------------: | :-------------------: | :---------------: |
| Parses scanned, rotated or handwritten pages       |  🚫  |        ✅        |          ✅           |        🟡         |
| Ingests audio dictation                            |  ✅  |        🟡        |          🚫           |        🚫         |
| One extraction across mixed sources at once        |  ✅  |        🚫        |          🚫           |        🚫         |
| Target schema past a few hundred fields, one job   |  ✅  |        🚫        |          🟡           |        🚫         |
| Provenance checked against source, not self-report |  ✅  |        🟡        |          🟡           |        🚫         |
| Human review as a contract, not a screen           |  ✅  |        🚫        |          🟡           |        🚫         |
| Measured extraction accuracy published             |  🚫  |        🟡        |          ✅           |        🚫         |
| Installable today, no waitlist                     |  🚫  |        ✅        |          ✅           |        ✅         |
| Managed batch throughput                           |  🚫  |        🟡        |          ✅           |        🚫         |
| Zero-ops hosting                                   |  🚫  |        🟡        |          ✅           |        🚫         |
| Capture, queue and review survive with no network  |  ✅  |        🚫        |          🚫           |        🚫         |
| Transcription and extraction run fully offline     |  🟡  |        🟡        |          🟡           |        🚫         |
| Data need never leave the device                   |  ✅  |        🟡        |          🟡           |        🚫         |
| Runs in a browser with no server                   |  ✅  |        🚫        |          🚫           |        🟡         |
| Durable queue, survives reload and offline         |  ✅  |        🚫        |          🚫           |        🚫         |
| Writes back into a system of record                |  ✅  |        🚫        |          🚫           |        🚫         |
| The parser is swappable                            |  ✅  |       n/a        |          n/a          |        n/a        |

Read the last row as the point of the whole table: for Ribo the parser is a dependency you choose,
and **Docling or Mistral can be that choice**.

**Document parsers**: Docling, Mistral Document AI, LlamaParse, and Unstructured. Parsing — turning a
file into text, layout, or discrete elements — is the core job all four share; where one goes
further (Mistral's schema-driven annotation, Unstructured's audio partitioner), the per-row prose
below says which.

**Document-AI platforms**: Reducto, LandingAI ADE, Extend, LlamaIndex's LlamaExtract, and the cloud
trio — Azure AI Document Intelligence, Google Document AI, AWS Textract. Azure is worth naming on
its own: this repo already sits beside Azure AI Speech for transcription, so leaving Azure Document
Intelligence out of this table would read as avoidance rather than scope. (LlamaParse and
Unstructured sit with the parsers above, not here — see below for why.)

**DIY orchestration**: Instructor, and LangChain's or LlamaIndex's extraction chains. This is what
"call a structured-output API yourself" actually looks like on a team that knows what it's doing —
schema validation and automatic retries around the raw call — not the unstructured `fetch` loop an
earlier version of this page implicitly compared against.

### The rows Ribo loses to a document parser

**Ribo does not parse documents.** It delegates. `@azx/ribo-transcriber-pdfjs` extracts a PDF's
existing text layer and carries an explicit `no-text-layer` guard that refuses the document rather
than guessing — because it cannot OCR. If your input is a photographed page or a scan, you need a
real parser in front of Ribo, and Docling and Mistral are both good at that in ways Ribo has no
ambition to be.

**Docling wins on offline parsing and privacy too.** It is a local library; nothing has to leave the
machine. Those two rows are real, and if parsing is the whole of your problem, Docling alone is a
better answer than Ribo plus Docling.

**Mistral Document AI does more than parse.** It supports schema-driven annotation with
bounding-box grounding, which is genuinely in the same territory as Ribo's provenance envelope —
hence 🟡 rather than 🚫 on that row. The differences are that the schema still has to fit in one
request, and that a bounding box tells you _where the model looked_, not that the quote it returned
is actually present in the source text. Those are real distinctions, not large ones.

**LlamaParse and Unstructured stay parsers too.** LlamaParse turns a file into clean, structured
markdown for a downstream pipeline to consume; recent versions accept a target output shape, but
that is about consistent formatting across a corpus, not a hundreds-of-fields schema with a
citation-checked value per leaf. Unstructured partitions a file — or, via its `partition_audio` step,
a recording — into typed elements (`Title`, `NarrativeText`, and so on) for a RAG pipeline to chunk
and embed. That audio step is why "ingests audio dictation" reads 🟡 rather than 🚫 for this
category, but the transcript it produces never joins a document inside one schema-driven extraction —
which is what "one extraction across mixed sources at once" actually asks, and both of them are 🚫
there like every other tool in this comparison.

### The rows Ribo loses to a document-AI platform

This is the category that contests Ribo's actual claims, and it is the one an earlier version of
this page omitted entirely.

**They publish an accuracy number. Ribo doesn't.** Reducto's Deep Extract reports 99.6% precision,
99.6% recall and 99.3% leaf accuracy on a 225-document benchmark run by micro1, an outside
evaluator, and published in Reducto's own writeup of the results (see
[Reducto's benchmark writeup](https://reducto.ai/blog/reducto-leads-benchmark-complex-document-extraction)).
LandingAI and Extend publish their own numbers on their own document sets. This is the row an
evaluator most wants, and Ribo's honest answer is 🚫 — see
["What is not measured"](#what-is-not-measured) below.

**They are a hosted service you can point volume at — usually.** No queue to run, no concurrency
pool to size, no fallback ladder to write. That is a genuine cost of Ribo's shape, not just a virtue
of it — "no capacity to authenticate" (below) means the host has to supply that credentialed
transport itself, where a platform's answer is "send us the document." But "hosted" isn't universal
in this category either: Azure Document Intelligence ships containers for its Read, Layout and
custom-model endpoints, and Reducto, LandingAI and Extend all advertise VPC or on-prem enterprise
tiers on top of their default hosted offering. Self-hosting one of these is available, at the same
ops cost Ribo imposes by default — which is why "data need never leave the device" reads 🟡, not 🚫,
for this category; most customers use the hosted default, but the option exists for the ones who
can't.

The same tiers go further than data residency, which is why "transcription and extraction run fully
offline" reads 🟡 here too, not 🚫: Reducto's air-gapped deployments ship as offline update bundles
with no external network access at runtime; LandingAI documents an on-premises option for air-gapped
environments as well; and Azure's disconnected containers run with no connectivity at all once a
license file is downloaded during an initial connected session — the same shape as Ribo's own
on-device engines caching model weights while online and then running without one. The
enterprise-agreement and commitment-tier gate in front of that capability is a real cost, but it is
the same kind of cost this page already credits Ribo's own on-device path for clearing, not a
categorical absence of the capability — so marking it 🚫 here while marking the row below 🟡 on the
same evidence would be the page failing its own standard.

**Several already do citations.** Reducto's extraction API anchors each field to a source-text
region and ships a confidence-plus-grounding wrapper per value (see
[Reducto's citation docs](https://llms.reducto.ai/json-schema-extraction-with-citations)); LandingAI's
Gen2 release ties every extracted value to the span it was read from and flags values the model
inferred rather than copied (see
[LandingAI's Gen2 announcement](https://landing.ai/blog/introducing-agentic-document-extraction-gen2)).
LlamaExtract, LlamaIndex's dedicated extraction product (distinct from the LlamaParse listed under
parsers above), returns a citation and the model's stated reasoning for every extracted field when
`cite_sources` is turned on.
Whether every vendor's citation is checked against the source text the way `isSpanGrounded` checks
one, rather than only self-reported by the model that produced it, is not published for most of
them — which is why the matrix row above reads 🟡, not ✅, for this whole category. Azure AI
Document Intelligence's custom models return a confidence score and a bounding region per field, but
Microsoft's own guidance is about interpreting that confidence, not about verifying the field's text
against the source (see
[Azure's accuracy-and-confidence guide](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/accuracy-confidence?view=doc-intel-4.0.0)) —
closer to Ribo's `confidence` than to its `sourceSpan` check.

**Review, where it exists, is a screen — not a gate that Ribo's is proven to be.** Several of these
platforms ship a review UI. Whether submission there is blocked until every field carries an
explicit decision — the way `resolveReview` blocks it here, via `completenessIssues` throwing a
`ReviewValidationError` for any leaf with none — isn't published for most of them, so the matrix
marks this 🟡 rather than claim parity either way.

**None of them write into a system of record.** Reducto's Edit endpoint writes corrected values back
into the document itself — filling a PDF or DOCX form's fields, cells and checkboxes — which is a
real capability, but it targets the document, not a separate backend the way Ribo's `ToolAdapter`
targets Snugg Pro. The rest return structured JSON over an API or webhook and leave wiring that
output into a downstream system to the caller, the same integration work this page's own
DIY-orchestration column is held to elsewhere. No vendor in this category was found advertising a
built-in connector that writes an extracted field into an external system of record, so this row
reads 🚫, not 🟡.

### The rows Ribo loses to DIY orchestration

Instructor wraps an LLM client with Pydantic (or a TypeScript equivalent) and gets you automatic
retries when the response fails schema validation — genuinely useful, and genuinely not what Ribo
is for (see [Instructor's own docs](https://python.useinstructor.com/)). LangChain and LlamaIndex's
extraction helpers do the same job with a different ergonomic. All three are **installable today**,
which Ribo is not yet, and none of them carry a queue, a review contract, or a write-back step to
maintain — because none of them attempt one. What they validate is shape and type; none of them
check a claimed citation against source text, because none of them ask the model for one.

None of them ship an offline or on-device story out of the box either — the matrix marks "runs
fully offline" and "data need never leave the device" 🚫 for this column, not 🟡, because pointing
one at a locally-hosted model is a real build, the same kind of build Ribo's own on-device engines
are, and this page doesn't credit a competitor for work nobody has done yet.

## The differences that are hard to reproduce

Ranked by how much work they would take to rebuild.

### 1. The target schema does not fit in one call

The deepest difference, and the only one backed by measurement here.

A system of record we build against exposes **837 distinct writable fields** — the honest size of a
schema that covered its whole write surface. Provenance makes the problem worse, not better:
enveloping a leaf replaces its one key with a `{ value, confidence, sourceSpan }` object, so the
**schema** grows by **four** properties where the patch declared one — the leaf's own key, plus
`value`, `confidence`, and `sourceSpan`.

A separate, larger snapshot shows how bad the ceiling gets. Walking every field the same API can
_return_ — a different surface from what Ribo writes, spanning every read-only rollup and computed
total the API exposes rather than just what the write endpoints accept — a snapshot taken
2026-08-06 counted **1,326 leaves**, which envelope to **~5,360 properties against a documented
5,000-property structured-output ceiling** and **~1,490 enum values against a 1,000-value ceiling** —
over both at once, before any question of extraction quality arises. That snapshot is illustrative
of scale, not current: the spec has drifted since, and the 1,326 figure was never re-derived against
a fresher one. It is not slow or expensive at that size. It is refused.

The ceilings also differ by vendor, and the tightest one isn't in anyone's published documentation.
Our own probing — one deployment, one route, one dev token — found one model family rejecting any
response schema with more than 16 nullable unions, which, at two per enveloped leaf, works out to
eight fields per call; two groups in our pilot schema already exceed that. Whether 16 is that model
family's own documented limit or this route's translation of it is not established here — what is
established is that it is model-family-specific on the identical route, since an otherwise-identical
schema shape is accepted without complaint by another model family.

Ribo partitions the schema on nullable-union count, runs the calls concurrently against a bounded
pool, runs a follow-up pass over leaves that abstained despite quoting evidence, and reassembles one
result. None of that is a wrapper around an API call; it is the thing that makes the API call
possible.

See [Schema at Scale](/guide/schema-at-scale) for the mechanism. Full working:
[Extraction schema scale](/deep-dives/schema-scale).

### 2. Provenance you can falsify

Every leaf arrives as `{ value, confidence, sourceSpan }`, and `isSpanGrounded` checks that span
against the source text. An invented citation is caught by string comparison — no human, no second
model, no judgement. [Provenance](/guide/provenance) covers the envelope and the check in full.

The unit of citation is a tuned parameter, not an afterthought, because it changes accuracy. On a
wide table in a real report, per-**cell** citations came back **37% fabricated**; per-**row**
citations on the same table came back **14 of 14 verbatim**. A group can therefore declare its
granularity as `leaf` (the default), `row`, or `none`. Per-cell provenance on a 67-row × 9-column
table also costs 603 citations that no reviewer will ever click, and forced the group to split
across two calls to deliver them. (This is a measurement of citation fidelity — whether the quote is
real — not of whether the value beside it is correct; see
["What is not measured"](#what-is-not-measured) below and the full working in
[Provenance: Measured](/deep-dives/provenance-measurement).)

A confidence score cannot be checked. A quote can.

### 3. Review as a contract

`buildReviewRequest` turns an extraction into flat dotted leaf paths, each carrying **its own zod
schema**, so a review UI renders the right editor and validates the edit without importing anything
tool-specific. Every leaf needs an explicit decision — accepted, edited, or rejected, grounded or
not — before a submission is allowed through; a leaf with no decision is indistinguishable from one
the reviewer never saw. The session parks at `awaiting-review`, and the relay drains past it rather
than stalling.

Reproducing the screen is a week. Reproducing the contract — leaf-level addressing, per-leaf
schemas, a durable gate on decision completeness — is where the time actually goes, and it is the
part you discover you got wrong after you have built the screen.

### 4. Offline as a property of the architecture

A capture is durable from the moment it exists. The pipeline is two persisted state machines rather
than a promise chain: a recording runs `queued → transcribing → transcribed`, and a session runs
`open → extracting → awaiting-review → writing → done`, each with a resting-and-retryable `failed`
distinct from a terminal `dead`. Retries back off and survive a reload. The app shell and any
on-device model weights are cached before they are needed.

This durability holds unconditionally — capture, the queue and review survive with no network
regardless of which transcriber or extractor a session used. Running the transcription and
extraction stages themselves with no network at all is narrower: it requires the on-device engines
specifically, and on-device extraction quality is not currently measured (see
["What is not measured"](#what-is-not-measured)). This is not a feature. It is a constraint that has
to be present from the first commit, and retrofitting it means rewriting the pipeline.

### 5. Any source, one extraction

A session joins several captures — an invoice PDF, a load-calculation report, the reviewer's
dictation — into one transcript with per-capture attribution, and extracts across all of them at
once. No document parser or document-AI platform above accepts dictation as an input (Unstructured's
own audio partitioner is the one exception, and even it only produces a separate transcript, never
one joined to a document); no speech API accepts a PDF.

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
transport. That is what makes these packages safe to drop into someone else's application — and it
is also why Ribo cannot offer managed batch throughput or zero-ops hosting the way a document-AI
platform can: the host still has to stand up and pay for that credentialed transport itself.

**Data need never leave the device.** On-device transcription and on-device extraction mean the
recording and the document can stay on the machine that captured them. For a lot of buyers that is
the entire procurement conversation, and it is not available from any hosted API.

## Use something else when

- **You are batch-processing documents on a server, with no review loop and no offline
  requirement.** Use a document-AI platform, or Docling if parsing is the whole job — Ribo's queue,
  review contract and write-back are pure overhead for that case.
- **Your schema fits in one call and no human checks the output.** Reach for Instructor or a
  LangChain/LlamaIndex extraction chain, not a raw `fetch` loop — every abstraction here is a cost
  you are not recovering.
- **You need a published extraction-accuracy number today.** Ribo does not have one. Several
  document-AI platforms do; evaluate against those numbers directly rather than against this page's
  argument.
- **You need managed batch throughput or zero-ops hosting.** Ribo requires the host to supply a
  credentialed transport and run the queue; a document-AI platform is built to take both off your
  hands.
- **Your hard problem is parsing degraded scans.** Buy a parser. Optionally put Ribo above it.
- **You are not in a browser, or not in TypeScript.** Ribo is a browser-side TypeScript library and
  has no server-side or Python story.

## What is not measured

Two things this page does not claim, because they are not currently true:

**Extraction accuracy has no current number.** The annotated corpus that produced earlier figures is
written in a field vocabulary the adapter no longer uses, so the acceptance gate deliberately
refuses to emit a score rather than emit a meaningless one — see
[Extraction: Measured](/deep-dives/accuracy) for the state of that gate. The measurements cited
above are about _provenance behaviour_ — citation fidelity and call counts — not about how often a
field is right, and there is no groundedness-specific review gate either: review requires an
explicit decision on every leaf, whether that leaf is grounded or not.

**Transcription accuracy is measured on clean audio only.** `whisper-base.en` runs at roughly 6×
real time with 8.0% word-error rate — but that is against authored text-to-speech audio with no
noise, mic handling, disfluency or cross-talk. It is a floor, not a field forecast. Word-error rate
against real field speech is not yet measured. See
[Transcription: Measured](/deep-dives/transcription-measurement).
