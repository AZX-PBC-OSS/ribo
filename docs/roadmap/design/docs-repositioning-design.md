# Docs repositioning: a structured-extraction SDK that happens to accept voice

**Date:** 2026-09-10
**Status:** Approved, not started.

## 1. Context

Every front door in this repo opens with the same sentence: _"Ribo is a reusable **voice-capture
SDK** for field data collection."_ It appears in `README.md`, `docs/index.md`'s hero, `AGENTS.md`
§1 and `docs/roadmap/index.md`'s preamble. It was accurate through Phase 4.

It is no longer what the library is. The evidence is in the tree, not in ambition:

- `CaptureItem` is a union of `AudioCapture` and `DocumentCapture`. Two of the four transcriber
  packages (`ribo-transcriber-pdfjs`, `ribo-transcriber-managed-docs`) never touch audio.
- The session layer speaks text. `joinSessionTranscript()` returns `{ text, recordingIds }` and has
  no idea whether audio was involved, which is precisely why the document tranche reused
  `Extractor`, `Extracted<T>`, `isSpanGrounded`, `ExtractionTarget`, arbitration and the review
  contract **untouched**.
- **Extraction, review and write have moved off the recording entirely and onto the session.** The
  recording outbox now runs `recording → queued → transcribing → transcribed` and stops; a
  recording is finished from the relay's perspective once it is text. A second, separate machine
  runs `open → extracting → awaiting-review → writing → done` on the session. The split is the
  repositioning stated structurally: the half of the pipeline that produces text knows what a
  microphone is, and the half that produces reviewed structured data does not.
- The weight of the codebase has moved to the extraction side: `split-schema`, `per-group`,
  `gap-fill`, `inventory`, `instance-ladder`, `enveloped`, `provenance`, `review`, arbitration on
  both the transcriber and extractor seams. Capture is now one step of the pipeline, not its
  organising idea.

Meanwhile the published site is almost entirely promises. As of this date **eighteen of the
twenty-one** published pages are `::: info Content coming` stubs — every page under `guide/` and
`capabilities/`, all four under `offline-first/`, four of five deep dives, and two of three design
pages. The three that are not stubs are `docs/index.md` (a hero and four feature cards),
`deep-dives/real-audio` and `design/releasing`; the generated accuracy page and the typedoc
reference sit outside the count. So this is not an editing pass over stale prose: it is mostly
net-new writing, and the reframe is the cheap part.

A prior planning record exists at `phases/docs-site.md`; it built the scaffold this design fills.

### Three places the prose has already drifted from the code

Found while planning this pass, and recorded because they change what the rewrite has to do. In
every case the code is right and the prose is stale:

- **The pipeline is two state machines, not one.** `AGENTS.md` §1, `README.md` and the roadmap all
  describe a single `queued → transcribing → extracting → awaiting-review → writing → done`. The
  real `OUTBOX_STATUSES` is `recording, queued, transcribing, transcribed, failed, dead, discarded`
  and the real `SESSION_STATUSES` is `open, extracting, awaiting-review, writing, done, failed,
dead`. `awaiting-review` is absent from `ACTIVE_SESSION_STATUSES`, not from
  `ACTIVE_OUTBOX_STATUSES`; on the recording side it is `transcribed` that is absent.
- **The review methods are session methods.** `Outbox.submitSessionReview` and
  `Outbox.reopenSessionForReview`, alongside `openSession` / `closeSession` / `watchSessions`. The
  roadmap's `submitReview` and `reopenForReview` do not exist.
- **`toExtractStep` does not exist.** The barrel exports `toSessionExtractStep`.

The rewrite therefore corrects rather than merely reframes, and the plan's standing instruction is
that when prose and source disagree, the source wins.

### The question that had to be answered first

Before rewriting anything: **why would anyone use Ribo instead of Docling, Mistral Document AI, or
an LLM's structured-output mode directly?** The answer on hand — _"you only have an LLM and no full
API access"_ — is true of the Helix deployment and useless as positioning. It describes our
constraint, not the reader's problem, and it frames Ribo as a thing you settle for.

The real answer is that the question is a category error, and §3 makes it the site's most important
page.

## 2. Decision 1 — Ribo is a structured-extraction SDK; voice is one capture kind

**Decision:** the docs describe what the library is **today**, generally: a browser-side,
offline-first pipeline that takes any capture — dictation, PDF, and later a photo — through
parse → schema-scaled extraction → verifiable provenance → human review → write-back into a system
of record.

Snugg Pro demotes from _the subject_ to _the reference adapter and worked example_. Home-energy
audits stop being the frame and become one illustration among several; the heat-pump quote reviewer
(invoice PDF + ACCA Manual J + dictation, joined into one session) is the second, and it is the one
that shows why the source stopped mattering.

**Why "today" and not "heading toward":** every claim above is already shipped and gated. Nothing in
the reframe requires a feature that does not exist. The things that _are_ incomplete — write-back,
extraction measurement, npm publication — are handled by §5 rather than by softening the pitch.

## 3. Decision 2 — the docling/Mistral answer is a reframe, and it gets its own page

**Decision:** a `Guide/Comparison` page, modeled on TanStack Table's and TanStack Query's comparison
pages, including their willingness to mark themselves down.

The reframe it leads with: **Docling and Mistral Document AI are not alternatives to Ribo — they are
things you plug into it.** `ribo-transcriber-managed-docs` is already, in AGENTS.md's own words, "a
hosted document understanding API behind the host's transport." A document parser hands you a
document. Ribo is the pipeline above the parser, and the pipeline is where the work is.

Seven differentiators, ordered by how defensible each one is. Each must be stated with in-repo
evidence, not asserted:

1. **Real schemas do not fit in one model call.** This is the deepest and the only measured one.
   Doc 16's caps: measured against a spec snapshot, the combined job schema enveloped to ~5,360
   properties against a documented 5,000 cap and ~1,490 enum values against a 1,000 cap — over
   both, by margins later spec drift cannot close. Doc 21's finding: one model family rejects any
   response schema past 16 nullable unions, which two existing groups already exceed. **Two
   caveats the pages must carry:** doc 16's headline ~1,326-leaf count is stale (doc 20 records the
   drift, and notes `allJobData` spans the read-only surface too), so lead with the current 837
   writable fields instead; and doc 21 says outright that whether the 16 is the vendor's limit or
   the route's translation of it "is not established", so attribute it as our own measurement.
   "Pass your JSON schema to the API" does not survive contact with a system of record. The
   decomposition machinery is the product.
2. **Provenance that is checked, not claimed.** `isSpanGrounded` verifies the quote appears verbatim
   in the source and marks the leaf ungrounded when it does not. That is falsifiability, against a
   model's self-reported confidence. The supporting measurement already exists: per-cell citations
   came back 37% fabricated on a Manual J, and per-row spans came back 14/14 verbatim.

   **Correction (found executing Task 6):** an earlier draft of this bullet said "review will not
   accept a submission until every ungrounded leaf is actioned". There is no groundedness-specific
   gate in `review.ts`. The real gate is `completenessIssues`: **every** leaf needs an explicit
   decision, grounded or not, and `resolveReview` rejects a submission that omits one. Groundedness
   rides along as `isGrounded` / `groundedness` on each `ReviewField` so a UI can prioritise the
   suspicious ones — the playground's `ReviewPanel` does gate on ungrounded leaves, but that is an
   app-level choice, not a core guarantee. The true claim is stronger and simpler; pages must make
   it and not the invented one.

3. **Review is a stage with a contract, not a UI written afterwards.** Flat dotted leaf paths, each
   `ReviewField` carrying its own leaf schema so a UI renders and validates off the schema with no
   adapter knowledge. R1.5 exists because getting this wrong is the default: review used to address
   top-level keys and collapse the whole health matrix — eleven tests, at the time R1.5 fixed it —
   into one verdict. (Today's schema has more; do not attach the current count to the R1.5
   anecdote.)
4. **Offline-first is not retrofittable.** Durable outbox from the moment of capture, two state
   machines (recording and session) with resting-and-retryable `failed` states distinct from a
   terminal `dead`, backoff, connectivity, work-safety, cached shell and weights, eviction
   handling. A hosted document API is a network call, which is the one thing unavailable in a
   basement.
5. **One pipeline, mixed sources, one session.** No parser accepts dictation; no STT vendor accepts
   a PDF. The unification is the product, and it is the reason "voice" stopped being the noun.
6. **Engine plurality behind a measured seam.** `capability()`, `firstCapable`,
   `fallbackTranscriber`, `hedgedTranscriber`, and on the extractor side `fallbackExtractor`, `raceExtractor`
   and `ExtractionArbiter`. The on-device transcriber measures the device's real-time factor at
   `prime()` and can therefore report `too-slow` — before that gate existed, a slow device always
   reported `ready` and the fallback was unreachable at any threshold. Selection is made from a
   measurement, not from config.
7. **It ends in a write, not in JSON.** `ToolAdapter`, the `schema.parse` trust boundary installed
   by `toWriteStep`, instance write receipts. Extraction that terminates as JSON on screen is a
   demo.

The deployment constraint that prompted the original question stays, but split into three and with
two of them reframed as capabilities rather than limits: **there is no compute plane** (a Python
library with native deps has no server to run on, on a static host); **no credential ever reaches
the client** (every plasmid has, deliberately, no capacity to authenticate — it takes an endpoint
and an injected `fetch`, which is what makes these packages safe to ship into any host); and **data
need never leave the device** (the on-device transcription and extraction path).

### The matrix, and the rows Ribo loses

Columns: Ribo, Docling, Mistral Document AI, LLM structured outputs used directly. Rows cover
scanned/rotated/handwritten parsing, audio ingestion, mixed-source sessions, target schemas past a
few hundred leaves, source-verified provenance, a review contract, working with no network,
write-back to a system of record, keeping data on-device, and swapping the parser.

**Ribo must lose the parsing row outright.** It does not parse; it delegates, and
`ribo-transcriber-pdfjs` carries a `no-text-layer` guard precisely because it cannot OCR. The page
closes with an explicit "use something else when…" block: server-side batch extraction over a pile
of PDFs, a schema small enough for one call with no human in the loop, best-in-class parsing of
degraded scans, or a Python stack. A comparison page without losing rows reads as marketing, and
the ✅s stop being believable.

## 4. Decision 3 — a TanStack-shaped IA; `Capabilities/` dissolves into `Guides/`

**Decision:** adopt TanStack's split — a short opinionated on-ramp, then one concept per guide page,
then a generated reference — in place of the current Guide / Capabilities / Offline-first / Deep
Dives / Reference / Design nav.

| Section        | Pages                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Guide**      | Overview · Motivation · Comparison · Installation · Quick Start · Important Defaults                                                                                       |
| **Guides**     | Captures & Sources · Sessions · Extraction · Schema at Scale · Provenance · Review · Write-back · Offline & the Outbox · Arbitration & Fallback · React Hooks · Typesafety |
| **Deep Dives** | Feasibility · Transcription: Measured · Extraction: Measured · Real Field Audio · The Snugg Pro Data Model                                                                 |
| **Reference**  | typedoc, unchanged                                                                                                                                                         |
| **Design**     | Decisions · Contributing · Releasing                                                                                                                                       |

**One directory, two sidebar groups.** Both the on-ramp and the concept pages live under
`docs/guide/`; the sidebar splits them into "Getting Started" and "Guides". A sibling `guides/`
directory next to `guide/` was considered and rejected — two paths one character apart are a
permanent source of wrong links, and TanStack itself groups both under a single prefix. This also
removes the need for a `Guides/` landing page, which §11 had left open.

Three specifics carried over from TanStack on purpose:

- **`Important Defaults`.** TanStack Query's best page. State the surprising defaults where a reader
  meets them rather than where they cause an incident: `"leaf"` provenance granularity, Dexie as the
  outbox storage, `firstCapable`'s sequential preference order, retry and backoff behaviour, and the
  fact that a **session** parks at `awaiting-review` and only `Outbox.submitSessionReview` moves it
  on. (This sentence originally said "an item" and `submitReview`, committing both of the drift
  errors §1 catalogues; corrected here rather than silently, because it is the spec Task 5 writes
  the Important Defaults page from.)
- **Guides split hard from Reference.** Guides explain why and carry code that runs; the typedoc
  output stays the exhaustive surface. No guide page duplicates a signature the reference already
  generates — it links.
- **`Typesafety` as a headline page**, not a footnote. The derived-schema story (one declared values
  schema, an extraction envelope derived from it) is genuinely the interesting part.

**`Capabilities/` is removed, not redirected.** Its three content pages become three of the eleven
guide pages. Every inbound link is internal — `guide/core-loop.md`, the section's own index, and the
nav — and nothing is published to npm, so no external link can depend on those URLs. Redirects would
additionally require emitting real files, because the Helix static host matches request paths
exactly and falls back to `index.html`; that is not worth doing for four stubs.

`Offline-first/`'s four pages fold into the `Offline & the Outbox` guide plus the existing deeper
pages, which keep their URLs.

**Schema at Scale and Provenance are the two pages that carry the repositioning.** They are the
moat, they are measured, and no competitor product has an equivalent page. They are written first.

## 5. Decision 4 — honesty rails

Three facts complicate an evaluator-facing pitch. Each gets stated plainly rather than elided;
disclosure is what makes the rest credible.

**Nothing is published to npm.** R4 is not done, there is no `.npmrc`, and `publishConfig.access` is
`restricted`. Every code example is nonetheless written the way a real consumer would write it,
importing from the package name. `Installation` opens with a short factual note that the packages
are not yet on npm and names R4 as the tracking item, followed by a clone-and-run path. The docs are
correct the day R4 lands and cost nothing to update. No "coming soon" badges.

**Extraction quality is not currently measured.** Transcription is: approximately 6× real time at
8.0% WER on clean authored audio. Extraction is not, because the spike corpus is annotated in the
superseded snake_cased vocabulary and the acceptance gate deliberately refuses to emit meaningless
numbers. The site says exactly that, and leads instead on what does not need a benchmark: span
grounding is checkable per field at runtime, and the 37%-fabricated-per-cell-citation finding is a
real measured result about provenance design. The superseded ≈0.5%-hallucination and 75-of-75-enum
figures are **not** quoted, with or without a caveat — they would be requoted without it.

**Write-back is gated.** The `ToolAdapter` seam and the trust boundary are real and documented as
real; the live Snugg Pro write is stated as gated on the Helix egress signing ask, named, and
linked.

**No page ships with a `::: info Content coming` block.** A page that cannot yet be written honestly
does not appear in the nav.

## 6. Decision 5 — keep `Transcriber`, explain it once

`Transcriber<DocumentCapture>` parsing a PDF is not transcription in any ordinary sense, and every
page of the new docs has to live with the word.

**Decision:** keep the interface name. The docs use the code's vocabulary, and one paragraph early
in `Captures & Sources` reframes it — a `Transcriber` turns any capture into citable text; audio was
merely the first kind — and the docs never apologise for it again.

**Why not a docs-only synonym:** a reader who greps the API for "source" or "reader" finds a name
nobody used, and the prose de-syncs from the generated reference. **Why not rename the interface:**
that is a breaking change and a code change, out of scope for a documentation pass. The tension is
recorded on the `Design/Decisions` page as considered and closed, so it is not re-litigated — and if
it is ever reopened, pre-1.0 is the window.

## 7. What changes where

| Area                                             | Change                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/index.md`                                  | Hero, tagline and all four feature cards rewritten to the §2 framing                                                                                              |
| `docs/guide/*`                                   | The whole guide: six Getting Started pages plus eleven concept pages, one directory, two sidebar groups. `getting-started`, `core-loop` and `outbox` are replaced |
| `docs/capabilities/*`                            | Removed; content absorbed into the Guides group                                                                                                                   |
| `docs/offline-first/*`                           | Index folds into the outbox guide; the three deeper pages keep their URLs and get real content                                                                    |
| `docs/deep-dives/*`                              | Four stubs written; the generated accuracy page gains the §5 disclosure                                                                                           |
| `docs/design/*`                                  | Decisions and Contributing written; Releasing already real                                                                                                        |
| `docs/.vitepress/config.ts`                      | `nav`, `sidebar` and the site `description` follow the new IA                                                                                                     |
| `README.md`                                      | Reframed to §2; the "what works today" and architecture tables refreshed against the current nine packages                                                        |
| Nine package `README.md`s                        | One template: what it is, when to reach for it, one composition example, a link to its guide page. `ribo-transcriber-managed-docs` gets its first                 |
| `AGENTS.md` §1, `docs/roadmap/index.md` preamble | Retire "reusable voice-capture SDK". Internal, but they are what every future contributor and agent reads first                                                   |

`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md` are reviewed for voice-specific framing
and otherwise left alone.

## 8. Definition of done

**`./check.sh` does not cover this work.** Per AGENTS.md §7, `pnpm docs:build` is a separate CI step,
and it is the one that catches typedoc entry points, broken `{@link}` targets and VitePress build
failures. The bar is therefore both, plus two checks specific to this change:

- `./check.sh` green (Prettier formats markdown at 100 columns, so `format:check` gates the prose).
- `pnpm docs:build` green.
- **A link audit.** Removing `capabilities/` and adding pages under `docs/guide/` invalidates
  existing internal links; every internal link in `docs/` and every repo-relative link in the
  README set must resolve. (This bullet said "adding `guides/`" before §4 settled on a single
  `guide/` directory; there is no `guides/`.)
- **A grep for `Content coming` over `docs/` returns nothing**, and a grep for "voice-capture SDK"
  returns nothing outside historical phase records.

The two greps are the must-fail checks: both currently fail, and both passing is the observable
signal that the pass is complete rather than partially applied.

## 9. Sequencing

Four tranches, each independently shippable and each leaving the site in a coherent state.

1. **Positioning.** `docs/index.md`, Overview, Motivation, Comparison, the accuracy disclosure and
   the `capabilities` nav removal, `README.md`, `AGENTS.md` §1, roadmap preamble. This is the
   tranche that answers the original question and the one worth reviewing hardest.
2. **The on-ramp.** Installation, Quick Start, Important Defaults, Typesafety.
3. **Evidence, then the concept guides.** The schema-scale and provenance deep dives first —
   everything downstream cites them and they had no published home — then Provenance and Schema at
   Scale, which carry the moat, then the hardened Comparison page, then Captures & Sources,
   Sessions, Extraction, Arbitration, Review, Write-back, Offline & the Outbox, React Hooks.
4. **Cleanup.** The deep-dive stubs, the design pages, nine package READMEs, the doc-comment audit
   behind the generated Reference, and the deletion of `capabilities/` behind a link audit.

**Revised after external review.** A cross-family review of the plan found nine factual errors and
two structural gaps. Two items moved out of tranche 4 into tranche 1 (the accuracy disclosure and
the `capabilities` nav removal, both of which left the site self-contradicting for the fifteen
tasks in between); two were added (deep dives to hold the moat evidence, which §11's
"full working linked" resolution had assumed already existed, and an audit of the doc comments
`pnpm docs:api` regenerates the Reference from — a surface neither must-fail grep reaches).

## 10. Out of scope, recorded so it is not rediscovered

- **Renaming `Transcriber`.** §6. A code change, and a breaking one.
- **Re-annotating the spike corpus** so extraction quality can be measured. It is the blocker behind
  §5's disclosure, it is manual, and it is tracked as an open question in the roadmap. The docs
  describe the gap; they do not close it.
- **Unblocking write-back.** Gated on the Helix egress ask.
- **Publishing to npm.** R4.
- **Runnable embedded examples.** TanStack ships sandboxes per example; Ribo's equivalent is
  `playground/`, which the docs link to. Building a sandbox harness is its own tranche.
- **Devtools.** TanStack Query's devtools have no Ribo counterpart. Not proposed here; noted only so
  the absence is deliberate.
- **Rewriting `docs/implementation/*`.** Excluded from the site by `srcExclude`, and R5 already owns
  correcting the docs that newer decisions falsified.

## 11. Resolved while planning

Both questions this design opened with are now closed, and are recorded here rather than deleted so
the reasoning survives.

- **~~Does the Guides section need a landing page?~~ Moot.** Collapsing to one `docs/guide/`
  directory with two sidebar groups (§4) removes the question: there is one section index, which is
  the Overview. An index page over eleven guides would only have become a second, staler table of
  contents.
- **~~How much Comparison-page evidence is inline versus linked?~~ One line per row inline, full
  working linked.** The schema-cap numbers and the fabricated-citation measurement are the
  persuasive content and have to be visible on the page, but a comparison that becomes an essay
  stops being scannable. Each matrix row carries one line of evidence; the deep dive carries the
  method.

## 12. Open question

- **`RESTING_SESSION_STATUSES`.** `session-schema.ts` notes that the constant naming `done` and
  `dead` may no longer earn its current name, and leaves the rename to a follow-up. Whatever it is
  called when the Offline & the Outbox guide is written is what that page should use; this design
  does not resolve it.
