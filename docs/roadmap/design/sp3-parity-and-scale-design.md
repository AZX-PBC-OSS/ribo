# SP3 — Parity and scale: two lifts across the seam, and one long-input story

**Date:** 2026-09-17
**Status:** **PARTIALLY BUILT — the long-input story is settled; the two lifts still require
revision.** Two adversarial reviews found 21 defects, several of which invalidate a section
rather than correct it. They are enumerated in §10 at the bottom, with the section each one
breaks. Of that set, §4.3 (`chunkedExtractor`) has since been **built and its findings F2, F6,
F7, F9 and F14 resolved** — §4.3 is rewritten to the shape implemented, and the rest of the
draft above it is kept unedited so the findings can be read against what they refer to. §4.1
(`hedgedExtractor`), §4.2 (`raceTranscriber`) and §4.4 (`annotatingCombiner`) remain unbuilt
and require revision before they are.
**Question answered:** "What are the generally useful meta-extractors?" — SP3 of four: the
combinators that exist on one side of the transcribe/extract seam and not the other, plus the ones
that make a long input tractable.
**Depends on:** `phased-extraction-design.md` (SP1, which records this scope),
`sp2-judging-combinators-design.md` (SP2, whose injected-policy discipline this follows),
`extractor-arbitration-design.md` (the arbiter contract and the shared concurrent engine),
`managed-transcription-design.md` §5.3 (`hedged`'s resolution rules and the RTF delay policy).
**Scope:** SP3 of four. SP4 (the agentic layer) is separate.

---

## 1. The answer, before the argument

**Two combinators exist on one side of the transcribe/extract seam and have no counterpart on the
other, and nothing in the library makes a long input tractable.** A caller who wants a hedged
extraction, or a raced transcription, or to extract from a transcript longer than a context window,
writes it themselves — and the last of those is not a small thing to write correctly.

**Recommendation: four combinators, and one deliberate deferral.**

- **`hedgedExtractor`** — start a primary extraction, and if it has not finished within a delay,
  start a hedge and take whichever finishes first. The counterpart of `hedged`.
- **`raceTranscriber`** — start every transcriber at once and let a policy decide which transcript
  to take. The counterpart of `raceExtractor`.
- **`chunkedExtractor`** — split a long transcript, extract from each chunk, merge the results
  under a caller-supplied policy.
- **`annotatingCombiner`** — a `TranscriptCombiner` that records where each part landed in the
  joined text, so a consumer can map a region of the combined transcript back to the capture that
  produced it.
- **`chunkedTranscriber` is deliberately NOT built.** §4.5 records why: it is the only member of
  this set that is not text or policy manipulation, and building it in core would either put a
  codec there or reduce to an interface the host fills in anyway.

**Neither lift is a port, and that is the main finding of this design.** Both look mechanical and
neither is. `hedged` justifies two of its five resolution rules on the grounds that **audio must not
leave the device**; a transcript reaching an extractor has already been produced, so that argument
does not transfer and the tie-break has to be re-derived (§4.1). `raceExtractor` is built on the
shared concurrent engine with an `ExtractionArbiter`; the transcriber side deliberately does not
share that module, and the reason is recorded in the arbitration guide — so `raceTranscriber` needs
its own small policy type rather than a reused engine (§4.2).

**And one fact governs everything here: the shared concurrent engine never cancels a loser.**
`createConcurrentExtractor` forwards the caller's `ExtractOptions` unchanged to every candidate and
constructs no `AbortController` of its own. A losing lane therefore runs to completion and bills in
full. That is tolerable in `raceExtractor`, where every lane was going to run anyway; it is _the
whole cost question_ for a hedge, whose entire value proposition is "usually you only pay for one"
(§4.1, §5.1).

## 2. Evidence the problem is real

### 2.1 The seam is asymmetric, and the asymmetry is not by design

Transcription has `firstCapable` (sequential selection) and `hedged` (two lanes, delayed second).
Extraction has `fallbackExtractor` (sequential), `raceExtractor` (N lanes, simultaneous) and
`compositeExtractor`. So:

| Pattern             | Extraction          | Transcription  |
| ------------------- | ------------------- | -------------- |
| Sequential ladder   | `fallbackExtractor` | `firstCapable` |
| All lanes at once   | `raceExtractor`     | **missing**    |
| Delayed second lane | **missing**         | `hedged`       |

Nothing in either design argues for the gaps. They are the order the two sides happened to be
built in.

### 2.2 The options bags have drifted apart

`ExtractOptions` gained `deadline` (absolute epoch ms) in SP1. `TranscribeOptions` carries `signal`
and a plugin-storage handle, and **no deadline**. A raced transcription therefore cannot offer the
per-lane deadline a raced extraction can, and `raceTranscriber` must not pretend otherwise. This is
named here because the obvious symmetry argument — "give it the same options as `raceExtractor`" —
is wrong on this point and would produce an option the transport cannot honour.

### 2.3 Nothing makes a long input tractable

There is no chunking anywhere in the extraction path. A transcript longer than the model's context
window fails, or silently truncates inside a transport, and the library offers no vocabulary for
"do this in pieces and put the pieces back together."

The repo already has the two things that make the extraction half cheap. `isSpanGrounded(span,
text)` checks a span against **the one canonical text**, so a value found in a chunk that is a
literal substring of the whole still grounds against the whole — chunked extraction is span-safe for
free, with no span rewriting and no offset arithmetic. And `mapExtractedLeaves` is the
structure-preserving leaf walk a merge needs, already in core since SP2.

### 2.4 Combination throws away where everything came from

`createDefaultTranscriptCombiner` joins per-capture texts, optionally prefixing each with a
`===== CAPTURE seq:N kind:K id:I =====` marker so a model can attribute a value to a capture. The
marker is the only attribution channel, it is in-band text, and it is opt-in because turning it on
changes what every extractor sees.

Meanwhile the combined transcript's `annotations` bag is **empty by construction** — the default
returns `{}`, and `TranscriptCombiner<In, Out>` carries two type parameters precisely so the output
bag cannot claim to be any input's. A consumer that wants to know which capture a region of the
joined text came from has exactly one option today: parse the in-band markers back out of the text
it was told not to rely on.

## 3. What these cannot mean

**`hedgedExtractor` cannot mean "retry faster".** A hedge starts a _second, different_ extractor
against the same transcript. Starting the same one twice is a retry with extra steps, and
`retryExtractor` already exists.

**`raceTranscriber` cannot reuse `ExtractionArbiter`.** The arbitration guide records why the
transcriber siblings use a parallel vocabulary rather than a shared module: a `Transcript` carries
no field map to stamp a strategy onto, and the transcriber error vocabulary
(`UnsupportedItemError`, `TranscriberUnavailableError`) is not the extractor's. Reusing the type
would force `ExtractionResult` shapes onto a seam that has none.

**`chunkedExtractor` cannot mean "summarise then extract".** That is a different, lossy strategy
whose output cannot be span-grounded against the original text, which is the property this whole
library is built on. Chunks are **literal substrings**, or grounding breaks and nothing downstream
can tell.

**`chunkedExtractor` cannot promise a value that straddles a boundary.** If a fact is stated across
a chunk edge, no chunk contains it and no merge policy can invent it. Overlap reduces the odds; it
does not close them. §5.2 states the accepted loss.

**`annotatingCombiner` cannot smuggle a part's annotations through.** `annotated-transcript.ts` is
explicit that "annotations do not survive combination" and that state needing to cross that seam
belongs in plugin-scoped storage. This design does not reverse that. What it adds is a fact **the
combination itself computes and no input part could know**: the offset range each part occupies in
the joined text. An input's own bag is still not a channel through combination (§4.4).

## 4. Design

### 4.1 `hedgedExtractor` — REVISED

> Rewritten after review. Resolves F3, F4, F8, F12 and F16; the draft this replaces got the rule
> count, the cancellation mechanism and the instrument all wrong.

**Shape.** `hedgedExtractor(primary, hedge, options): Extractor<F>` with a required `delay` (ms, or a
function of the transcript returning ms), an injectable `scheduleTimer`, and `onHedge`.

**What it does not carry, against `hedged`.** No capability probe, no TTL, no cache, no `now` for
capabilities. `Transcriber` has a `capability()` contract; `Extractor` is documented as "a plain
builder, not a capability contract". Nothing to probe. It returns a plain `Extractor<F>`.

**All eight of `hedged`'s rules, mapped — the draft inventoried five.** `hedged.ts` documents eight,
and three were never considered for whether they transfer:

| `hedged`                                                            | Transfers?                 | Here                                                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Primary settles before the timer → primary, hedge never invoked  | yes                        | Rule 1, unchanged. The case the combinator exists for                                                                                                                                 |
| 2. Timer fired, primary first → primary, hedge discarded            | yes, **strengthened**      | Rule 2 — and the hedge is **cancelled**, not merely discarded                                                                                                                         |
| 3. Timer fired, hedge first → hedge                                 | yes, strengthened          | Rule 3 — the primary is cancelled                                                                                                                                                     |
| 4. Both already resolved → primary (privacy tie-break)              | outcome yes, **reason no** | Rule 4. Nothing analogous to "audio left the device" applies; the primary wins because the caller named it first and a tie-break must be deterministic. Deterministic, not principled |
| 5. Primary throws `TranscriberUnavailableError` → hedge immediately | **narrowed**               | Rule 5. There is no extractor analogue of "this engine cannot serve this item". Only a **non-cancellation** primary rejection dispatches the hedge early                              |
| 6. Ordinary primary error after hedge succeeded → hedge's result    | yes                        | Rule 6                                                                                                                                                                                |
| 7. Both throw → primary's error propagates                          | yes                        | Rule 7. The primary's is the more actionable                                                                                                                                          |
| 8. Primary not `ready` → no race, straight delegation               | **no analogue**            | Dropped. Readiness is a capability concept and `Extractor` has none                                                                                                                   |

**Rule 0, which the draft lacked entirely: a cancellation is not a rejection.** The relay aborts the
extract step's signal on timeout, so a caller abort arrives as a primary rejection — and the draft's
"any primary rejection dispatches the hedge" would have fired a hedge into an already-aborted signal.
`isCancellation(reason, callerSignal)` is consulted first and the cancellation propagates untouched,
with no hedge dispatched. `timeout-extractor.ts` states the same precedence: the caller's
cancellation wins, and misreporting a user's cancel would be a lie in the direction that hides a
user action.

**Cancellation needs a controller PER LANE.** The draft said the combinator "constructs its own
`AbortController`… and aborts the loser" — one controller can only abort _both_. Each lane gets its
own, composed with the caller's signal via **`AbortSignal.any`, never `??`** — the trap
`grouped-extractor.ts` documents and `timeout-extractor.ts` names. The winner's controller is left
alone; the loser's is aborted.

**Every discarded promise gets a rejection handler**, or a losing failure surfaces as an unhandled
rejection — `hedged.ts` states this and the draft omitted it. And a loser's abort rejection must
never surface as the run's result: `isCancellation` answers true for anything named `AbortError`
even while the caller's signal is intact, so a leaked loser rejection would report a **successful**
run as cancelled and the relay would re-queue and re-bill it.

**Deadline narrowing, which the draft never mentioned.** `timeoutExtractor` already implements the
discipline: the effective deadline is `Math.min` of any inherited one and the combinator's own, an
inherited deadline already past rejects immediately without calling the inner extractor, and the
effective deadline — not the caller's — is what reaches the inner extractor. A hedge is never
dispatched past the effective deadline: a call that cannot finish in time is pure cost.

**`onHedge` fires at SETTLEMENT and carries the winner.** The draft fired it at dispatch "win or
lose", at which point win-or-lose is unknowable — so the instrument §5.1 relies on to decide whether
this combinator earns its cost could not answer that question. `ExtractionHedgeEvent` carries
`winner: "primary" | "hedge" | undefined` (undefined when both failed). Positional rather than
engine ids, because this combinator takes two bare extractors and has no ids to name — which
separates fire rate from win rate just as well.

**Usage.** The winner's usage is returned; `strategy` is not stamped, there being no ids to stamp
with. **The loser's usage is not added**, resolving F16: `usage` describes the result that was
returned, as it does in every other combinator, and a cancelled lane's partial usage would make the
number mean something different here than everywhere else. The true cost of hedging is measured by
counting `onHedge` fires, which is what that event is for.

### 4.2 `raceTranscriber` — REVISED

> Rewritten after review. Resolves F1, F13 and F15. The draft proposed building a vocabulary that
> already exists.

**The policy vocabulary is NOT new, and the draft was backwards about it.**
`transcription-arbitration.ts` already ships `TranscriptionArbiter`, `TranscriptionArbiterInput`,
`TranscriptionArbiterVerdict`, `TranscriptionOutcome`, `applyTranscriptionVerdict` and the default
`unsupportedFallsThrough`; `fallbackTranscriber` composes them. That file's own doc says `outcomes`
is in settlement order "so a future concurrent combinator would not need to change the vocabulary" —
it was shaped for exactly this. §3's claim that `raceTranscriber` "needs its own small policy type"
is withdrawn, and §2.1's table should list `fallbackTranscriber` in the transcription column.

**Shape.** `raceTranscriber(transcribers, options): CompositeTranscriber` — a composite, like
`hedged` and `firstCapable`, because a host's download screen renders from `capabilities()`.

**One new default, not two.** `acceptFirstTranscript` is withdrawn: `unsupportedFallsThrough`
already accepts the first success and, at exhaustion, prefers a retryable error over a terminal one
— a refinement worth keeping rather than reimplementing. It stays the default.

`preferEngineOrder(ranking)` is the one addition, and it earns its place because **a race breaks an
assumption the ladder relies on**. Under a sequential ladder, settlement order _is_ preference
order, so "first success" means "best success". In a race a worse engine can settle first, so the
existing default would accept whichever engine happened to be fastest. A factory closing over the
ranking, because `TranscriptionArbiterInput` carries outcomes and `exhausted` and no preference
order.

**Mid-run behaviour, which the draft left to the implementer (F15).** `preferEngineOrder` returns
`continue` while any better-ranked candidate is unsettled, accepts the best-ranked success once no
better one can arrive, and at exhaustion accepts the best-ranked success or gives up with the first
error. Every "keep going" branch must sit **after** the exhaustion check —
`transcription-arbitration.ts` carries a comment about the version that got this backwards and died
with a `TypeError` instead of the real error.

**Capability gating before the race.** An `unavailable` transcriber is excluded rather than raced to
a rejection. This matters beyond cost: dispatching to a managed engine means uploading the audio,
and an engine that cannot serve the item should not receive it.

**The capability cache is the one honest cost (F13).** It is a private member of
`FirstCapableTranscriber`, and `hedged` already had to duplicate it. `raceTranscriber` makes three,
so this wave extracts it into a shared module and uses it — leaving `firstCapable` and `hedged` on
their own copies, which changes no shipped behaviour and leaves the duplication declining rather
than growing.

**Losers are cancelled**, via the same per-lane `AbortSignal.any` composition as §4.1. Transcription
is the more expensive seam; a race that cannot cancel is worse here than for extraction.

**No deadline option**, per §2.2 as corrected by F5: `TranscribeOptions` has no such member, so
offering one would be an option no transport honours.

### 4.3 `chunkedExtractor`

> **Status: BUILT** — this section describes the shape as implemented
> (`chunk-policy.ts`, `merge-policy.ts`, `merge-chunk-results.ts`, `chunked-extractor.ts`),
> rewritten after the findings in §10 were filed; it is no longer the draft F2, F6, F7, F9
> and F14 were found against. §4.1, §4.2 and §4.4 remain the draft.

**Shape.** `chunkedExtractor(inner, options): Extractor<Enveloped<V, P>>`, with `target`, a
`chunk` policy, an optional `merge` policy, and an optional `alignInstances` matcher.

**Chunks are an exact partition of the canonical text** — contiguous, non-overlapping,
covering every character, in order. This is the load-bearing constraint, and it is what makes
the whole combinator cheap: a span a model quotes from a chunk is a verbatim quote from the
whole transcript, so `isSpanGrounded` keeps working with no span rewriting and no offset
arithmetic (F7's honest half — grounding is verbatim presence; which occurrence a repeated
span came from is not claimed). It is also what makes the stated-empty rule honest: "every
chunk said none" is only a claim about the document if the chunks _are_ the document.

**The partition check is the load-bearing part, not the splitter** (F6). An earlier draft
verified chunks with a per-chunk `text.includes(chunk)` — a membership test that says nothing
about **coverage**: a chunker that drops a paragraph, repeats a chunk, or skips a region
passes it on every chunk while silently losing whatever was in the gap, and `text.includes("")`
is true, so an empty chunk passes and dispatches a model call on empty text. The built check
(`assertExactPartition`) walks a cursor instead: each chunk must equal
`text.slice(cursor, cursor + chunk.length)`, and at the end the cursor must equal
`text.length` — one pass rejecting gaps, overlaps, reordering, duplication, chunks that stop
short, and (by a dedicated check the walk cannot make on empty text) empty chunks, each
rejection naming the offending index. The check runs on every `extract`, before any model
call. Overlapping chunks are deliberately NOT allowed in this wave: they would duplicate
instances, which only an identity matcher can clean up, and that combination wants its own
measurement before it ships.

**The chunk policy is caller-supplied**, taking the transcript and returning an ordered list
of chunks; the shipped `splitOnBudget(maxChars)` splits on a character budget at paragraph
then sentence boundaries, then — only when a single sentence exceeds the budget — at a word
boundary, never mid-word, with separators staying with the preceding chunk so the pieces
concatenate back to exactly the text. Core does not know the model's context window, so the
budget is a required argument rather than a guess inside a default. `maxChars` is a target,
not a guarantee: a single token longer than the budget has no word boundary to split at and
splitting mid-word is forbidden, so it comes back as one over-budget chunk — better than
throwing, which would make a legitimate document entirely unextractable over one long word.
Empty text yields zero chunks from the splitter, and the combinator answers that by delegating
to the inner extractor once, on the empty text — zero calls and a merge over nothing would
invent a result, and whatever the inner extractor does with empty input is its decision to
make.

**The merge follows ADR 0001 exactly.** For each scalar leaf path, the policy receives the
path and the envelopes the chunks produced for it, and returns an **index** — so a merge
policy cannot fabricate a value, a confidence, or a citation. One arm, not two: unlike a
consensus arbiter there is no `contested` state, because chunks are sequential passages of one
document rather than competing samples of one question. Two policies ship: `firstCommitted`
(the default — earlier text is usually the primary description, a later mention a passing
reference) and `lastCommitted` (right when later text supersedes earlier, such as a correction
dictated after the fact). Both land on sample 0 when no chunk committed — the first null
envelope, its citation preserved.

**Collections concatenate; they are never merged by index** (F2). `rooms[0]` in chunk 0 and
`rooms[0]` in chunk 5 are different rooms, and a positional merge splices different entities
into one — a room that was never described, with two verbatim citations from different parts
of the document, passing every downstream check. The built walk (`mergeChunkResults`)
concatenates arrays in chunk order instead: three chunks describing five rooms produce five
rooms, in document order. Optional cross-chunk instance alignment (`alignInstances`) uses the
`InstanceMatcher` vocabulary instance identity landed: an incoming instance is compared
against instances accepted from **earlier chunks only** and merges into the first the matcher
calls `"same"`, which keeps its position; `"different"` and `"unknown"` both append; instances
from the _same_ chunk are never compared — the model saw both in one region and distinguished
them. Greedy, not transitive clustering: one wrong `"same"` under union-find collapses three
instances and makes the outcome depend on comparison order, while greedy's worst case is a
duplicate review can see and remove. **No shipped matcher can exercise the align path, and
that is structural rather than a gap**: `contradictionMatcher` never returns `"same"` by
design, and with chunks an exact partition two chunks can never quote the same span — the one
piece of positive evidence core could read does not exist across disjoint regions. Sameness
here is host knowledge, always.

**Leaf granularity is refused at construction**, per ADR 0003, for the same reason: the merge
walks per-leaf envelopes and a `"row"` group would merge nothing while returning a result that
looks merged.

**Usage sums across chunks, and `engine`/`strategy` are omitted** — same rule and same reason
as `consensusExtractor`. Token members sum only across chunks that reported them and are
omitted entirely if any chunk omitted one, per ADR 0005's absent-is-not-zero discipline. `raw`
is dropped: it describes one producer's run, and here there are N. `statedEmptyGroups` is
merged by two rules, in order: a group **any** chunk populated loses the claim entirely
("there are none of these" meant none _in that region_); otherwise the **earliest** chunk's
stated span is kept — not unanimity, which would lose a true claim the moment one chunk is a
single-shot extractor emitting no roster at all.

**A chunk that fails is a failed run, not a missing sample** — the opposite of
`consensusExtractor`, and the contrast is worth stating. Consensus's candidates are redundant:
three samples of the same thing, so two are still evidence. Chunks are **disjoint**: a failed
chunk means a region of the document was never read, and returning a result that silently
omits whatever was in it is the worst available outcome. The rejection propagates the inner
error **unchanged — not wrapped** (F9): ADR 0002 classifies by _who failed_, and the inner
error already encodes that. A `ChunkFailedError` wrapper would erase the classification every
`isTransientFailure` and `TerminalError` check downstream depends on, and turn a terminal
failure into a relay retry loop. The cost — the error does not say which chunk failed — is
accepted and documented rather than traded away quietly. A caller who wants partial results
composes `retryExtractor` per chunk, which is exactly what that combinator is for.

**Chunks run sequentially, and there is no concurrency option.** They are not redundant
samples racing to be first; they are N× the calls of one pass (§5.3), and firing forty at a
rate-limited transport at once is how a caller discovers their quota. A bounded pool would
also need a sibling-abort policy on failure — `consensusExtractor` deliberately does not abort
siblings, `groupedExtractor` deliberately does — and an option with no test and no stated
abort semantics is worse than none. The caller's whole options bag is forwarded to every
chunk, deadline unnarrowed: the deadline is absolute epoch milliseconds precisely so it
survives composition, and a chunk that starts after it has passed is the inner extractor's to
reject. Each chunk carries the original `annotations` bag unchanged — annotations describe the
capture, not the region.

**Known limit, recorded rather than fixed (F14):** no per-chunk resumption. One transient
failure at chunk 40 discards 39 paid successes and the relay re-runs all 40. Real, and not
solved here.

### 4.4 `annotatingCombiner`

**Shape.** `annotatingCombiner(options): TranscriptCombiner<In, PartRanges>`, where the output
annotations bag carries, per part, the `[start, end)` offset range it occupies in the joined text
plus whatever identifying keys that part's own bag carried under the reserved `capture.` prefix.

**Why this does not reverse the "annotations do not survive combination" decision.** That decision
says an input part's bag is not a channel _through_ combination — state that has to reach an
extractor from a transcriber belongs in plugin-scoped storage, which is keyed by capture and
survives a reload. This combinator does not carry a part's bag through. It computes a **new** fact
that no input could have known, because it is a property of the combination: where each part landed
once the texts were joined. The `capture.` keys it copies are identifiers, not payload — the minimum
needed to say _which_ part a range belongs to.

**It composes with the default rather than replacing it.** Offsets depend on exactly how the texts
were joined, including whether capture markers were inserted, so computing them separately from the
joining is how they go wrong. `annotatingCombiner` wraps a joining policy (the default, with its
`markCaptures` option) and records the ranges that joining actually produced.

**Offsets are into the joined text, and include any marker.** A range therefore covers the marker
that introduces its part, not just the part's own text. Stated because the alternative — ranges that
skip the markers — is defensible, produces non-contiguous coverage, and would be a silent trap for a
consumer slicing the text.

### 4.5 `chunkedTranscriber` — deliberately not built

The scope recorded in SP1 lists it alongside `chunkedExtractor` as "one story: long inputs." On
inspection they are not one story, and this is the deferral's whole argument.

`chunkedExtractor` chunks `AnnotatedTranscript.text` — a plain string, in core, with no
capability requirement. `chunkedTranscriber` would chunk a `CapturePayload`, and:

- **A `Recording` is metadata only.** The audio bytes are not on it; they live in storage keyed by
  `id`. Splitting audio means fetching and decoding the blob, which puts a codec in core.
- **On-device transcription has no timestamps to split on.** The transformers.js path exposes
  timestamps only for Whisper; the default engine has none. So a split cannot be aligned to speech
  and would cut mid-word.
- **A document is split by page, not by time** — a completely different operation on a completely
  different payload branch.

The two escape routes both fail on inspection. Building it in core with an injected `split` function
means core orchestrates `split → transcribe each → combine` and contributes nothing else: the host
writes the only hard part, and the wrapper is four lines a host can write in place. Building it
where the codec already lives — `@azx/ribo-transcriber-ondevice` — is real work with real value, and
is a design of its own about windowing, overlap and how a windowed transcript reassembles without
duplicating speech across a boundary.

**Deferred, with the reason recorded, rather than built thin.** `annotatingCombiner` is what makes a
future windowed transcriber tractable, so the useful half of this story does land here.

## 5. What this cost, stated plainly

### 5.1 A hedge is a cost multiplier whenever it fires

Rules 2 and 3 both dispatch two extractions. Cancellation limits the waste but does not eliminate it
— a cancelled call may already have been billed in full by the provider, and core cannot know. The
combinator is worth it only when the primary's tail latency is genuinely bad and the hedge is
genuinely cheaper or faster; `onHedge` exists so a host can measure how often it fires and find out
whether that is true. Nothing in this design measures it.

### 5.2 A fact straddling a chunk boundary is lost

No merge policy can recover a value no chunk contained. The default chunker splits on paragraph and
sentence boundaries to make it unlikely, and an overlap option makes it less likely still at
proportional cost, but the loss is real and unbounded in the general case. A caller extracting from
long documents should expect chunking to be slightly worse than a single pass that fit, not
equivalent to it.

### 5.3 Chunking multiplies calls by the chunk count

N chunks is N times the calls of a single pass, and unlike consensus that multiplier is not optional
— it is the point. Composing `chunkedExtractor` inside `consensusExtractor` multiplies both. The
file headers say so; `budgetExtractor` is the detector that catches it having happened.

### 5.4 `raceTranscriber` has no deadline

Per §2.2. A caller wanting one wraps each lane in whatever their transport offers, or adds `deadline`
to `TranscribeOptions` — which is a seam change across every transcriber implementation and is not
in this scope.

## 6. What changes where

| Where                                             | Change                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/ribo-core/src/hedged-extractor.ts`      | New: `hedgedExtractor`, `HedgedExtractorOptions`, `ExtractionHedgeEvent`                          |
| `packages/ribo-core/src/race-transcriber.ts`      | New: `raceTranscriber`, `RaceTranscriberOptions`                                                  |
| `packages/ribo-core/src/transcription-arbiter.ts` | New: `TranscriptionArbiter`, `TranscriptionOutcome`, `acceptFirstTranscript`, `preferEngineOrder` |
| `packages/ribo-core/src/chunked-extractor.ts`     | New: `chunkedExtractor`, `ChunkedExtractorOptions`, `ChunkPolicy`, `splitOnBudget`                |
| `packages/ribo-core/src/merge-policy.ts`          | New: `MergePolicy`, `firstCommitted`, `lastCommitted`                                             |
| `packages/ribo-core/src/annotating-combiner.ts`   | New: `annotatingCombiner`, `PartRange`, `PartRanges`                                              |
| `packages/ribo-core/src/index.ts`                 | Exports for all of the above, pinned in `index.test.ts`                                           |
| `docs/guide/arbitration.md`                       | `hedgedExtractor` beside the judging layer; `raceTranscriber` in the transcriber siblings section |
| `docs/guide/extraction.md`                        | A chunking section — the substring constraint and the merge policy                                |
| `docs/guide/captures-and-sources.md`              | `annotatingCombiner` beside the default combiner                                                  |
| `docs/adr/`                                       | One ADR per decision this design settles, at the end                                              |

Nothing existing changes behaviour. `raceExtractor`'s inability to cancel a loser is **named here
and not fixed** — fixing it changes the behaviour of shipped code and belongs in its own change with
its own reasoning, not smuggled into a parity sub-project.

## 7. Sequencing

1. **Wave 1 — `hedgedExtractor`.** Self-contained, and the cancellation machinery it needs is what
   wave 2 reuses.
2. **Wave 2 — `TranscriptionArbiter` and `raceTranscriber`.** The policy type first, then the
   combinator over it.
3. **Wave 3 — `MergePolicy` and `chunkedExtractor`.** The policy and its two defaults, then the
   combinator; the substring check and the propagating-chunk-failure rule are the pins that matter.
4. **Wave 4 — `annotatingCombiner`.** Independent of waves 1–3; could run in parallel if useful.
5. **Wave 5 — guides, ADRs, changeset.**

Implementation plans are written to the scratchpad and **not committed**; the decisions land as ADRs
in wave 5.

## 8. How this could be wrong

- **The hedge never fires, or always fires.** If the primary's tail is tight, `hedgedExtractor` is
  dead weight; if it is terrible, the hedge fires every time and the combinator is a
  double-bill with extra steps. `onHedge` is the instrument and nothing here reads it. The cheapest
  refutation is wiring it in the playground against the managed strategy and counting.
- **Nobody wants a raced transcription.** The privacy posture that makes `hedged` opt-in applies
  more strongly to a race: racing an on-device engine against a managed one sends the audio every
  time, which is exactly what `firstCapable`'s design avoids. `raceTranscriber` may be a combinator
  whose only honest use is racing two managed engines, which is a narrow case.
- **Chunking may not be the right answer to long inputs at all.** The alternative is a
  router-and-per-group pass over a partitioned schema, which R3 already built for schema size and
  which cuts calls along a different axis. If long transcripts in practice come with large schemas,
  the per-group path may already handle the real case and chunking is solving a problem that does
  not occur alone.
- **The offset ranges may have no consumer.** `annotatingCombiner` is justified by a future windowed
  transcriber and by attribution that does not rely on in-band markers. If the marker convention
  turns out to be what every consumer actually uses, the bag is unread machinery.
- **Whether the loser's usage should be reported** (§4.1) is genuinely undecided. Reporting it makes
  a hedge's true cost visible, which is the honest thing; omitting it keeps `usage` describing the
  result that was returned, which is what every other combinator does. This design does not settle
  it and the wave plan must.

## 9. Must-fail tests

- A hedge that fires and loses is **cancelled** — the primary wins and the hedge's signal is
  aborted. An implementation forwarding the caller's options unchanged fails this.
- The primary settling before the timer means the hedge is **never dispatched**: assert its
  `extract` was not called at all, not merely that its result was discarded.
- A primary rejection dispatches the hedge **immediately**, without waiting out the delay.
- `raceTranscriber` excludes an `unavailable` engine from the race rather than racing it to a
  rejection.
- A `chunk` policy returning a string that is not a substring of the canonical text is **refused**,
  naming the offending chunk — the pin that keeps grounding intact.
- A chunk that rejects fails the whole extraction. An implementation that drops it and merges the
  rest passes every other test here and is wrong.
- A merge policy naming an out-of-range index throws rather than clamping (ADR 0001's runtime half).
- A leaf committed by chunk 3 and null in chunks 1 and 2 is committed in the merged result — the
  pin that a null does not beat a value under `firstCommitted`.
- `annotatingCombiner`'s ranges **slice back to the parts**: for every part, the joined text sliced
  by its recorded range contains that part's text. With `markCaptures` on and off.
- Construction against a `"row"` target throws for `chunkedExtractor`.

---

## 10. Review findings — what is wrong with everything above

Two adversarial reviews, one unguided and one directed, against the draft in §1–§9. Every factual
claim below was verified against source. Ordered by how much of the design each one invalidates.

### 10.1 Findings that invalidate a section

**F1 — §4.2 and §6 propose building types that already exist.** `transcription-arbitration.ts`
already defines `TranscriptionArbiter`, `TranscriptionArbiterInput`, `TranscriptionArbiterVerdict`,
`TranscriptionOutcome`, `applyTranscriptionVerdict` and the default `unsupportedFallsThrough`;
`fallbackTranscriber` composes them. That file's own doc says `outcomes` is in settlement order
"so a future concurrent combinator would not need to change the vocabulary" — the vocabulary was
built _for_ `raceTranscriber`. §3's claim that it "needs its own small policy type" is backwards,
§6's "New:" row is wrong, and §2.1's table omits `fallbackTranscriber` from the transcription
column entirely. **`raceTranscriber` is much smaller than §4.2 describes**: reuse the arbiter and
`applyTranscriptionVerdict`, add concurrent scheduling, capability gating and loser cancellation.
The proposed `acceptFirstTranscript` is redundant with `unsupportedFallsThrough`, which also
prefers a retryable error over a terminal one at exhaustion. Only `preferEngineOrder` earns a new
default, and it earns it precisely because a race breaks the ladder's settlement-order ==
preference-order identity.

**F2 — §4.3's index-based leaf merge is unsound for any schema with a collection.**
**RESOLVED** — the merge is now align-then-merge, built in
`packages/ribo-core/src/merge-chunk-results.ts`: collections concatenate by default (three
chunks describing five rooms produce five rooms, pinned by test), an optional
`InstanceMatcher` merges across chunks with anchors keeping first-accepted position, and the
same-chunk pairs are never compared. The splice case (a name from one chunk, a size from
another, one fabricated room) is pinned as two rooms. See the rewritten §4.3.

ADR 0001's index encoding is sound for consensus because every candidate samples the same document, so
`rooms[2]` means the same room in each. Chunks sample **disjoint regions**, so `rooms[0]` in chunk 0
and `rooms[0]` in chunk 5 are different rooms. Demonstrated by running the repo's own
`mapExtractedLeaves` over three chunks describing five rooms: `firstCommitted` returns two rooms
and silently discards three. Worse, where one chunk abstains on a leaf, the merge **splices two
rooms into one** — "living room / 200 sqft", with both citations verbatim and grounded, so
`isSpanGrounded` passes, `validateExtractor` accepts, and a reviewer sees a plausible room that was
never described. This was the reason instance identity became a first-class core concept
(`instance-identity.ts` — `InstanceFacts`, `InstanceMatcher`, `contradictionMatcher`), and the
chunk merge became align-then-merge, as described above.

**F3 — §4.1's resolution rules are incomplete, and the source has eight, not five.** `hedged.ts`
documents rules 1–8; this draft inventoried five and never decided whether 6 (primary errors after
the hedge succeeded), 7 (both throw → primary's error) or 8 (primary not ready → straight
delegation) transfer. The source also states a requirement this draft omits: "every discarded
promise has a rejection handler attached, or a losing failure surfaces as an unhandled rejection."
Separately, §4.1's rule 4 fires the hedge on _any_ primary rejection where `hedged`'s rule 5 fires
only on `TranscriberUnavailableError` — a real divergence, stated nowhere. **A caller abort is a
primary rejection**, so as written an aborted run dispatches a hedge into an already-aborted signal.

**F4 — §4.1's cancellation mechanism cannot do what its own rules require.** One `AbortController`
shared by both lanes can only abort _both_; selective loser cancellation needs a controller per
lane composed with the caller's signal via `AbortSignal.any`, which `timeout-extractor.ts` already
settled. Compounding: `isCancellation` returns true for any error named `AbortError` even while the
caller's signal is intact, so a leaked loser rejection would report a **successful** run as
cancelled, and the relay's "aborted is deliberately left retryable" posture would re-queue and
re-bill it.

### 10.2 Findings that correct a claim

**F5 — §2.2 overclaims the deadline asymmetry.** `ExtractOptions.deadline` is a whole-run absolute
deadline forwarded identically to every lane, not a per-lane one. The real asymmetry is narrower:
`TranscribeOptions` has no deadline member at all.

**F6 — §4.3's substring check verifies membership, not coverage.** **RESOLVED** —
`packages/ribo-core/src/chunk-policy.ts` replaces the membership test with a positional
cursor walk (`assertExactPartition`): each chunk must equal `text.slice(cursor, cursor +
chunk.length)` and the cursor must finish at `text.length`, rejecting gaps, overlaps,
reordering, duplication and short coverage in one pass, with an empty chunk caught by a
dedicated check the walk cannot make on empty text. The combinator runs it before any model
call. Original finding: `text.includes(chunk)` says
nothing about whether the chunks _cover_ the document. A chunker that drops a paragraph, repeats a
chunk, or skips a region passes every check and silently loses data. Also `text.includes("")` is
true, so an empty chunk passes the gate and dispatches a model call on empty text. The invariant
must be positional: chunks in order, each at or after the previous chunk's start, jointly covering
`[0, text.length)` — which is what was built.

**F7 — §2.3's "span-safe for free" is true for grounding and overclaims attribution.**
**RESOLVED** by documentation, in the rewritten §4.3: the claim is narrowed to grounding, and
occurrence identity is stated as not claimed (grounding is verbatim presence, not occurrence
identity). Original finding: A span
quoted from a substring chunk always grounds, because `isSpanGrounded` is a pure `includes` against
the one canonical text. But a span occurring several times in the document grounds while saying
nothing about _which_ occurrence, and a chunked run is more likely to have quoted it from a chunk
lacking the disambiguating context. Grounding is verbatim presence, not occurrence identity.

**F8 — §4.1's `onHedge` fires at dispatch, so it cannot report a winner.** §5.1 and §8 both lean on
separating hedge fire rate from hedge win rate to decide whether the combinator is worth keeping.
As specified the instrument cannot answer the question it exists for. `hedged` fires at settlement
with a `winner` field for exactly this reason.

**F9 — §4.3 never classifies a chunk failure as terminal or transient.** **RESOLVED** —
`packages/ribo-core/src/chunked-extractor.ts` dissolves the question rather than answering it:
it does not classify a chunk
failure at all, it propagates the inner error **unchanged, by identity**, so the inner error's
own classification (a transport failure transient, unparseable model output terminal) is what
downstream sees. ADR 0002's rule ("classify by who failed") is honoured by not touching who
failed. Original finding: it said a chunk rejection
propagates and stopped there, walking into the fork the ADR records — always transient turns one
chunk's blip into a full-price retry of the whole run; always terminal stops a
run whose transport is fine.

**F10 — §4.4 denies and performs the same reversal.** The argument that offsets are a new fact the
combination computes is sound. But the design also copies each part's `capture.` keys into the
output bag, which is exactly what `annotated-transcript.ts` forbids and what
`TranscriptCombiner<In, Out>`'s second type parameter exists to prevent. Own it as an ADR or drop
it. Separately: with `markCaptures` off the default joins with `" "`, and those separators belong
to no part, so coverage is non-contiguous; an empty part has no defensible range; and §9's
slice-back test passes even when a range points at the wrong copy of two identical parts.

**F11 — §4.5's justification for keeping `annotatingCombiner` is a rationalisation.**
`Transcriber.transcribe` returns **one** `Transcript` per call, so a windowed transcriber reassembles
internally and never presents windows as parts to a `TranscriptCombiner`. The codec argument for
deferring `chunkedTranscriber` is sound; the claim that "the useful half of this story does land
here" is not. Justify `annotatingCombiner` on attribution alone, or defer it alongside.

**F12 — §4.1 never mentions `ExtractOptions.deadline`.** `timeoutExtractor` already implements the
narrowing discipline (take `Math.min`, reject immediately if already past). A hedge delay that
outlives the caller's deadline dispatches a call that cannot succeed.

### 10.3 Findings worth recording but not blocking

**F13** — §4.2's "reused rather than reimplemented" has no mechanism: the capability TTL cache is a
private member of `FirstCapableTranscriber`, and `hedged` already had to duplicate it.
`raceTranscriber` would be copy three unless a shared helper is extracted, which contradicts §6's
"nothing existing changes behaviour."

**F14** — §5.3 counts the N× chunk multiplier but not its amplification: one transient failure at
chunk 40 discards 39 paid successes, and the relay's retry re-runs all 40. **RESOLVED by
stating the cost, not by solving it** — the rewritten §4.3 records "no per-chunk resumption"
as a known limit of `chunkedExtractor` in its file header and its own body, and the plan's out
of scope list carries it. Real, recorded, not solved.

**F15** — §4.2's two proposed defaults never specify mid-run behaviour on a first error before
exhaustion. Three readings are defensible and one makes the new default indistinguishable from the
existing one.

**F16** — §4.1 does not say whether a cancelled loser's usage is reported. Reporting it makes a
hedge's true cost visible; omitting it keeps `usage` describing the returned result, as every other
combinator does. Genuinely undecided.

### 10.4 Found during this review, unrelated to SP3

Two wiring gaps in the shipped R1.6 Task 11 instance-identity feature, both pre-existing:

- **`rankCandidates` and `HVAC_IDENTIFYING_FIELDS` were absent from the
  `@azx/ribo-adapter-snuggpro` barrel**, so no consumer outside the package could call either,
  while that feature's changeset states the package "provides `rankCandidates`". **Fixed** as part
  of the instance-identity work on this branch.
- **`linkTargets` is computed, validated, persisted and never read by any write step.**
  `instance-write-step.ts` reads `outcome.instanceKeys` and never `outcome.linkTargets`, so the uuid
  a human chose has no path into `adapter.write` and every instance is written as a create. **Not
  fixed** — it wants its own change.
