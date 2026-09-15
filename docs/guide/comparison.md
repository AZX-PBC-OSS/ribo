# Comparison

The question people arrive with is "why would I use this instead of Docling, or Mistral Document
AI, or just calling a structured-output API myself?"

For Docling and Mistral, the answer is that **it is not an either/or**. Those are document
parsers. They turn a file into text and layout. Ribo is the pipeline _above_ the parser — it starts
where they finish, and one of its own packages,
[`@azx/ribo-transcriber-managed-docs`](/reference/), is a hosted document-understanding API plugged
into Ribo's `Transcriber` seam.

So the real comparison is not Ribo against a parser. It is **Ribo against writing the six stages
after the parser yourself** — and against the platforms and libraries that already sell pieces of
that job.

The table below compares Ribo against document parsers, the document-AI platforms that already sell
"documents → your schema, with citations and review," and the DIY orchestration a team reaches for
instead of a raw `fetch` loop — including the rows where Ribo is the wrong answer.

## What we measured

Everything below this heading came out of Ribo's own `spanGroundedness`, pointed at a competitor
and then at ourselves. The harnesses that ran it were one-off scripts, not committed;
[Native Extraction: Measured](/deep-dives/native-extraction) is the full record.

### The test

One real Manual J report (Wrightsoft, 24pp). One 126-field schema written for that document, so
neither side is being asked about fields the page cannot answer. Two ways to fill it:

- **Native** — Mistral Document AI's one-call `document_annotation`: OCR and structured output in
  a single request.
- **Flatten-then-extract** — Mistral's OCR markdown, then Ribo's own extractor over that text.

The OCR is held constant across both, so what is being compared is the extraction step and not two
page parsers. Both sides get the same pinned span instruction. Five runs each. Every `sourceSpan`
is checked for verbatim presence in the text that arm's model actually saw.

### The result

|                            | mean verbatim | worst run | best run |
| -------------------------- | :-----------: | :-------: | :------: |
| Mistral native, one call   |     82.3%     |   65.4%   |  95.0%   |
| Ribo, flatten-then-extract |   **92.7%**   |   91.8%   |  92.5%   |

The ten-point gap is the least interesting number here, and it is the one most likely to be stale
by the time you read it — a model update could close it next month.

**The spread is the finding.** Same document, same schema, same prompt: one run cites its sources
correctly 95% of the time and another 65% of the time. Nothing about the request changed. The
`temperature` parameter is rejected by that endpoint (`422 extra_forbidden`), so this is not a knob
you can turn down. A single benchmark run would have reported whichever number it happened to
draw, and been confident about it.

That is what a grounding check buys that an accuracy benchmark does not. Field values agreed
between the two arms 91% of the time. The disagreement was almost entirely in the **citations** —
and citations are what a reviewer needs and what nobody else checks.

### Our own number

Ribo's ungrounded rate on the same corpus is **7.0%** — about 26 of 370 checkable fields per run.

That is published for the same reason the rest is: a metric you only ever point at other people is
marketing. Two honest caveats on it. It is not a 7% fabrication rate — `spanGroundedness` is
stricter than "made it up," and the count includes values the model reformatted rather than
invented. And the same measurement found cases where a span was **perfectly grounded and the answer
was still wrong**: a real figure filed under the wrong field, a table's subtotal row extracted as
if it were another row. Grounding catches invention. It does not catch misreading, and anyone
telling you their citation check makes extraction correct is selling something.

### Where Mistral wins, unambiguously

It accepted a **467-field, 303 KB strict schema in a single call.** Ribo splits that schema into
roughly 59 calls, because the managed route it targets caps how many nullable unions one call can
carry. One request against fifty-nine is a real engineering advantage and it surprised us.

Two things temper it. Accuracy fell as the schema grew — 97.8% verbatim at 13 fields, 82.3% at 126,
75.1% at 467 — so the single call is doing less well the more you put in it. And the latency
advantage inverts: at 13 fields the one call is faster (41.6s against 49.5s), but at 126 fields
Ribo's parallel calls finish in 89s against 221s. One big serial request loses to several small
concurrent ones well before the schema gets large.

### What this does not show

One document, one document type, one vendor pairing. Mistral reports no token counts through this
endpoint, so cost is latency-only. Ribo's arm ran a Claude model at temperature 0 and Mistral's
temperature is not settable, so part of the stability difference is access to a knob rather than a
property of the models. And we adjudicated the disagreements ourselves, which is the weakest link
in any comparison written by one of the parties.

The harnesses behind these runs were one-off scripts wired to that corpus — real customer documents
we will not publish — and are not committed here.
[Native Extraction: Measured](/deep-dives/native-extraction) records the full method: the pinned
span instruction both arms received, the scoring tiers, and everything above we could not control
for. Rebuild it against your own documents; that is the only comparison that decides anything for
you.

## Feature matrix

**Legend:** ✅ does this · 🟡 partially, or with meaningful caveats · 🚫 does not do this, by design
or otherwise · n/a not a meaningful question for that category. **Evaluated as of 2026-09-11** —
vendor products move; where a cell is load-bearing, the prose after the table names a version, a
date, or links the vendor's own documentation.

A category column is not one product: its cell reads ✅ or 🟡 if **at least one** named member does
the row — the prose beneath the table says which. A DIY-orchestration cell reflects what the
library ships out of the box, not what a team could build on top of it; Ribo's own rows are held to
the same standard.

|                                                    | Ribo | Document parsers | Document-AI platforms | DIY orchestration |
| -------------------------------------------------- | :--: | :--------------: | :-------------------: | :---------------: |
| Parses scanned, rotated or handwritten pages       |  🚫  |        ✅        |          ✅           |        🟡         |
| Ingests audio dictation                            |  ✅  |        🟡        |          🚫           |        🟡         |
| One extraction across mixed sources at once        |  ✅  |        🚫        |          🚫           |        🚫         |
| Target schema past a few hundred fields, one job   |  ✅  |        🚫        |          ✅           |        🚫         |
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

For Ribo, the parser is a dependency you choose, and **Docling or Mistral can be that choice**.

**Document parsers**: Docling, Mistral Document AI, LlamaParse, and Unstructured. Parsing — turning a
file into text, layout, or discrete elements — is the core job all four share; where one goes
further (Mistral's schema-driven annotation, Unstructured's audio partitioner), the per-row prose
below says which.

**Document-AI platforms**: Reducto, LandingAI ADE, Extend, LlamaIndex's LlamaExtract, and the cloud
trio — Azure AI Document Intelligence, Google Document AI, AWS Textract. (LlamaParse and
Unstructured sit with the parsers above, not here — see below for why.)

**DIY orchestration**: Instructor, and LangChain's or LlamaIndex's extraction chains. This is what
"call a structured-output API yourself" looks like on a team that knows what it's doing — schema
validation and automatic retries around the raw call, not a raw `fetch` loop.

### The rows Ribo loses to a document parser

**Ribo does not parse documents.** It delegates. `@azx/ribo-transcriber-pdfjs` extracts a PDF's
existing text layer and carries an explicit `no-text-layer` guard that refuses the document rather
than guessing — because it cannot OCR. If your input is a photographed page or a scan, you need a
real parser in front of Ribo, and Docling and Mistral are both good at that in ways Ribo doesn't
try to be.

**Docling wins on offline parsing and privacy too.** It is a local library; nothing has to leave the
machine. Those two rows are real, and if parsing is the whole of your problem, Docling alone is a
better answer than Ribo plus Docling.

**Mistral Document AI does more than parse.** It supports schema-driven annotation with
bounding-box grounding, which is in the same territory as Ribo's provenance envelope —
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

**A figure exists for several of them — but none of the parser vendors published it themselves.**
RealDocBench, an academic benchmark for field-level QA on regulated documents, measured per-field
accuracy for multiple parsers on the same track: LlamaParse and Reducto came in around 89–90%,
Docling around 71.2% (see [RealDocBench](https://arxiv.org/pdf/2606.07401)). RealDocBench is
authored by Extend — one of the Document-AI platforms named in this comparison, whose own system
tops that same leaderboard — a stated conflict, not a hidden one, alongside a published
methodology. No parser vendor stands behind this number as its own; it's a third party's
measurement of all of them, which is why this row reads 🟡, not 🚫. Other benchmarks naming these
parsers (ParseBench and similar) measure parsing and layout fidelity, not schema-field
correctness — the same distinction drawn about Ribo's own numbers in
["What is not measured"](#what-is-not-measured).

**Hosting is split down the middle, not uniform.** Mistral Document AI, LlamaParse and Unstructured's
own Platform product are all hosted, metered services a team can point volume at without running
infrastructure; Docling ships only as a self-hosted library, with no managed offering from its
maintainers. That split — not a uniform answer either way — is why "managed batch throughput" and
"zero-ops hosting" both read 🟡, not ✅, for this category.

### The rows Ribo loses to a document-AI platform

This is the category that contests Ribo's actual claims most directly.

**They publish an accuracy number. Ribo doesn't.** Reducto's Deep Extract reports 99.6% precision,
99.6% recall and 99.3% leaf accuracy on a 225-document benchmark run by micro1, an outside
evaluator, and published in Reducto's own writeup of the results (see
[Reducto's benchmark writeup](https://reducto.ai/blog/reducto-leads-benchmark-complex-document-extraction)).
LandingAI and Extend publish their own numbers on their own document sets. Ribo doesn't have one —
see ["What is not measured"](#what-is-not-measured) below.

**At least one of them claims to have solved the schema-size problem outright.** LandingAI's own blog
post, titled ["Long Extraction Schemas Solved"](https://landing.ai/blog/agentic-extract-apis),
advertises no limit on field count, nesting depth, or character count in a schema. Reducto's
documentation is more circumspect about the same territory: it names hundreds-of-fields schemas and
deep nesting as a real accuracy risk it discloses rather than a hard cap. Neither of those vendor
claims is independently verified here. One member of the category, however, **was** measured:
Mistral Document AI accepted a 467-field, 303 KB strict schema in a single call, where Ribo splits
the same schema across roughly 59. That is why this row reads ✅ rather than 🟡 — it was 🟡 until we
measured it, and the measurement went against us.

Two qualifications, both ours and both in their favour only up to a point. Verbatim-citation
accuracy fell as that schema grew — 97.8% at 13 fields, 82.3% at 126, 75.1% at 467 — so accepting a
schema and doing well on it are different things. And a single serial call loses on wall-clock to
several concurrent ones surprisingly early: at 126 fields it was 221s against 89s. The row records
capability, which they have; the ["What we measured"](#what-we-measured) section records how it
performs, which is a separate question.

**They are a hosted service you can point volume at — usually.** No queue to run, no concurrency
pool to size, no fallback ladder to write. That is a genuine cost of Ribo's shape, not just a virtue
of it — "no capacity to authenticate" (below) means the host has to supply that credentialed
transport itself, where a platform's answer is "send us the document." But "hosted" isn't universal
in this category either: Azure Document Intelligence ships containers for its Read, Layout and
custom-model endpoints, and Reducto, LandingAI and Extend all advertise VPC or on-prem enterprise
tiers on top of their default hosted offering. Self-hosting one of these is available, at the same
ops cost Ribo imposes by default; most customers use the hosted default, but the option exists for
the ones who can't.

The same enterprise tiers also close the offline gap: Reducto ships air-gapped deployments as
offline update bundles, LandingAI documents an on-premises option, and Azure's containers run
disconnected once licensed — the same shape as Ribo caching its model weights while online. An
enterprise agreement is a real cost, but it is a price, not an absence, so "runs fully offline"
reads 🟡 here too.

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
them. Azure AI Document Intelligence's custom models return a confidence score and a bounding
region per field, but
Microsoft's own guidance is about interpreting that confidence, not about verifying the field's text
against the source (see
[Azure's accuracy-and-confidence guide](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/accuracy-confidence?view=doc-intel-4.0.0)) —
closer to Ribo's `confidence` than to its `sourceSpan` check.

**Review, where it exists, is a screen, not a gate.** Several platforms ship a review UI. Ribo
blocks submission until every leaf carries an explicit decision — `resolveReview` throws
`ReviewValidationError` for any leaf without one. Whether the platforms block the same way isn't
published for most of them, so the row reads 🟡 rather than claiming parity either way.

**None of them write into a system of record.** Reducto's Edit endpoint writes corrected values back
into the document itself — filling a PDF or DOCX form's fields, cells and checkboxes — which is a
real capability, but it targets the document, not a separate backend the way Ribo's `ToolAdapter`
targets Snugg Pro. The rest return structured JSON over an API or webhook and leave wiring that
output into a downstream system to the caller, the same integration work the DIY-orchestration
column below is held to. No vendor in this category was found advertising a
built-in connector that writes an extracted field into an external system of record, so this row
reads 🚫, not 🟡.

### The rows Ribo loses to DIY orchestration

Instructor wraps an LLM client with Pydantic (or a TypeScript equivalent) and gets you automatic
retries when the response fails schema validation — useful, and not what Ribo is for (see
[Instructor's own docs](https://python.useinstructor.com/)). LangChain and LlamaIndex's extraction
helpers do the same job with different ergonomics. All three are **installable today**,
which Ribo is not yet, and none of them carry a queue, a review contract, or a write-back step to
maintain — because none of them attempt one. What they validate is shape and type; none of them
check a claimed citation against source text, because none of them ask the model for one.

Both offline rows ask about transcription _and_ extraction together, and extraction is where these
libraries fall short. As the loader section below details, `langchain_community` does ship optional
local parsers for both scanned pages and audio, wired in the same way Ribo's own swappable engines
are. But none of these libraries ship a local extraction path the same way: `Instructor`, LangChain
and LlamaIndex's extraction helpers all wrap whatever LLM client the team configures, and pointing
that client at a locally-hosted model is a real build nobody has shipped — the build Ribo's own
on-device engines already represent. So "runs fully offline" and "data need never leave the device"
stay 🚫 for this column: the transcription half clears the loader bar below, but the extraction half
doesn't, and the row asks for both.

**They don't parse scans themselves, but they can call something that does.** LangChain ships an
optional `UnstructuredPDFLoader` (`strategy="ocr_only"`) and an `UnstructuredImageLoader`, both of
which hand the page off to Tesseract or Unstructured for OCR — a real capability, wired in by an
install flag, not built into the orchestration layer itself. That's why "parses scanned, rotated or
handwritten pages" reads 🟡 rather than 🚫 here: the library chooses someone else's parser the same
way Ribo does, but unlike Ribo, it ships that choice as an optional loader rather than a seam.

**The same is true of dictation, by the same standard.** `langchain_community` ships
`OpenAIWhisperParser`, `OpenAIWhisperParserLocal`, and `FasterWhisperParser` under
`document_loaders.parsers.audio` — optional parsers, wired into a `GenericLoader` the same way the
OCR loaders above are, that hand an audio file to Whisper (hosted, local, or the faster-whisper
reimplementation) and return a transcript. Holding "parses scanned pages" to 🟡 on an optional loader
and holding "ingests audio dictation" to 🚫 on an equivalent one would be applying two different
standards to identical wiring, so this row reads 🟡 too. It doesn't change "one extraction across
mixed sources at once," which stays 🚫: joining that transcript to a document inside one schema-driven
extraction is still work nobody ships, the same gap that keeps this row 🚫 for every other column.

**One of them runs in a browser out of the box.** LangChain.js explicitly supports browser
environments — an ESM build with Node-only APIs removed and browser-specific import paths — per its
own "Support for Multiple JS Environments" announcement. Its own docs pair that with a warning that
calling a model directly from client code exposes the API key, which is exactly the credential
exposure Ribo's transport is built to avoid; that gap is why this row stays 🟡 rather than becoming
✅.

## The differences that are hard to reproduce

Ranked by how much work they would take to rebuild.

### 1. The target schema does not fit in one call

The deepest difference, and the only one backed by measurement here.

A system of record we build against exposes **837 distinct writable fields** — the full write
surface of that API. Provenance makes the problem worse, not better: enveloping a leaf replaces its
one key with a `{ value, confidence, sourceSpan }` object, so the **schema** grows by **four**
properties where the patch declared one — the leaf's own key, plus `value`, `confidence`, and
`sourceSpan`.

A separate, larger snapshot shows how bad the ceiling gets: every field the same API can _return_,
not just what the write endpoints accept. A count taken 2026-08-06 found **1,326 leaves**, which
envelope to **~5,360 properties against a documented 5,000-property structured-output ceiling** and
**~1,490 enum values against a 1,000-value ceiling** — over both at once. The spec has drifted
since, so treat this as illustrative of scale, not current.

The ceilings also differ by vendor, and the tightest one isn't in anyone's published documentation.
Our own probing — one deployment, one route, one dev token — found one model family rejecting any
response schema with more than 16 nullable unions, which, at two per enveloped leaf, works out to
eight fields per call; two groups in our pilot schema already exceed that. Whether 16 is that model
family's own documented limit or this route's translation of it isn't established here; what is
established is that an otherwise-identical schema shape is accepted without complaint by another
model family on the same route.

Ribo partitions the schema on nullable-union count, runs the calls concurrently against a bounded
pool, runs a follow-up pass over leaves that abstained despite quoting evidence, and reassembles one
result. None of that is a wrapper around an API call; it is the thing that makes the API call
possible.

See [Schema at Scale](/guide/schema-at-scale) for the mechanism. Full working:
[Schema at Scale: Measured](/deep-dives/schema-scale).

### 2. Provenance you can falsify

Every leaf arrives as `{ value, confidence, sourceSpan }`, and `isSpanGrounded` checks that span
against the source text. An invented citation is caught by string comparison — no human, no second
model, no judgement. [Provenance](/guide/provenance) covers the envelope and the check in full.

The unit of citation is a tuned parameter, not an afterthought, because it changes accuracy. On a
load-calculation report, per-**cell** citations came back **37% fabricated** (17 of 46); per-**row**
citations on a separate report's 15-leaf, 14-row table came back **14 of 14 verbatim**. A group can therefore declare its
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

This holds whatever engine ran: capture, the queue and review survive with no network at all.
Running the transcription and extraction stages themselves with no network at all is narrower: it
requires the on-device engines specifically, and on-device extraction quality is not currently
measured (see
["What is not measured"](#what-is-not-measured)). This is not a feature. It is a constraint that has
to be present from the first commit, and retrofitting it means rewriting the pipeline.

### 5. Any source, one extraction

A session joins several captures — an invoice PDF, a load-calculation report, the reviewer's
dictation — into one transcript with per-capture attribution, and extracts across all of them at
once. No document parser, document-AI platform, or DIY chain above joins dictation to a document
inside one extraction (Unstructured's audio partitioner and LangChain's Whisper-backed audio parsers
can transcribe a recording in isolation, but neither joins it to a document); no speech API accepts a
PDF.

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

Two of these are usually framed as limitations; here they're capabilities.

**There is no server.** Ribo targets static hosting with a capability gateway. A Python library with
native dependencies has nothing to run on in that environment. It's a real constraint, and it
shaped the design.

**No credential ever reaches the client.** Every managed package is built with _no capacity to
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

Two things aren't true yet:

**Extraction accuracy has no current number.** The annotated corpus that produced earlier figures is
written in a field vocabulary the adapter no longer uses, so the acceptance gate deliberately
refuses to emit a score rather than emit a meaningless one — see
[Extraction: Measured](/deep-dives/accuracy) for the state of that gate. The measurements cited
above are about _provenance behaviour_ — citation fidelity and call counts — not about how often a
field is right, and there is no groundedness-specific review gate either: review requires an
explicit decision on every leaf, whether that leaf is grounded or not.

**Transcription accuracy is measured on clean audio only, and for a model that is no longer the
default.** The on-device path's previous default, `whisper-base.en`, ran at roughly 6× real time
with 8.0% word-error rate against authored text-to-speech audio with no noise, mic handling,
disfluency or cross-talk — a floor, not a field forecast even at the time. The current default,
Moonshine, has not yet been measured on this corpus, and word-error rate against real field speech
is not yet measured for either model. See
[Transcription: Measured](/deep-dives/transcription-measurement).
