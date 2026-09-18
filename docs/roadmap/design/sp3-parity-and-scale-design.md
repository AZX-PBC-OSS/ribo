# SP3 — Parity and scale: two lifts across the seam, and one long-input story

**Date:** 2026-09-17
**Status:** Draft — not reviewed, no implementation started.
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

### 4.1 `hedgedExtractor`

**Shape.** `hedgedExtractor(primary, hedge, options): Extractor<F>`, with `delay` (required — a
number of milliseconds, or a function of the transcript returning one), an injectable
`scheduleTimer`, and an `onHedge` notification that fires once when the hedge is dispatched, win or
lose.

**What it does NOT carry, compared to `hedged`.** No capability probe, no TTL, no capability cache,
no `now`. `Transcriber` has a `capability()` contract and `hedged` caches it; `Extractor` is
documented as "a plain builder, not a capability contract — strategy choice here is configuration."
Nothing to probe, so nothing to cache. It returns a plain `Extractor<F>`, not a composite with a
roster.

**The delay is a function of the transcript, not of a recording.** `hedged`'s
`HedgeDelayPolicy` reads a `Recording`'s duration and a host-supplied real-time factor. The
extraction analogue is transcript length, which the combinator _can_ see — but core has no model of
how long an extraction takes, exactly as it has no model of what a real-time factor is. So the
policy is a caller-supplied function and core ships no default delay. A required option with no
default is the honest encoding of "we cannot know this for you."

**Resolution rules.** Four, and the numbering deliberately does not match `hedged`'s five:

1. Primary settles before the timer fires → **primary**. The hedge is never dispatched and never
   billed. This is the case the combinator exists for.
2. Timer fired, primary settles first → **primary**, and the hedge is **cancelled**.
3. Timer fired, hedge settles first → **hedge**, the primary is **cancelled**, `onHedge` has
   already fired.
4. Primary rejects → the hedge takes over, dispatched immediately if the timer has not yet fired.
   A primary rejection is not a reason to wait out the remaining delay.

**Cancellation is the design, not a detail.** This combinator constructs its own `AbortController`,
passes its signal to both lanes (composed with the caller's, so a caller abort still reaches both),
and aborts the loser the moment a winner is known. Without that, rule 2 and rule 3 each bill two
extractions and the hedge is a pure cost multiplier — which is what building it on
`createConcurrentExtractor` would produce, since that engine forwards the caller's options unchanged
and constructs no controller (§2, verified). `hedgedExtractor` therefore does **not** reuse the
shared concurrent engine; it is a bespoke two-lane object, and the reason is exactly this.

**The tie-break is toward the primary, and the justification is weaker than `hedged`'s.** State it
plainly: `hedged` breaks a tie toward the primary because the alternative sent audio off the device,
a real and asymmetric harm. Nothing analogous holds here — both lanes see the same transcript. The
primary wins a tie because it is the lane the caller named first and because a tie-break must be
deterministic, not because it is better. A caller who wants the other order swaps the arguments.

**Usage.** The winner's usage is returned with `strategy` unset by this combinator — it does not
stamp, because it has no strategy ids to stamp with (`raceExtractor` takes them as part of each
candidate; this takes two bare extractors). Whether the _loser's_ usage is added is the one open
question in this section: a cancelled lane made real calls and a caller may well want to know. §8
records it.

### 4.2 `raceTranscriber`

**Shape.** `raceTranscriber(transcribers, options): CompositeTranscriber`. It returns a composite,
not a bare `Transcriber`, because `hedged` and `firstCapable` both do and a host's download screen
renders from `capabilities()`.

**Its policy type is its own.** `TranscriptionArbiter` — a function from the settled outcomes so
far, plus an `exhausted` flag, to accept / continue / give up. Structurally parallel to
`ExtractionArbiter` and deliberately a separate type, per §3. Two defaults ship:
`acceptFirstTranscript` (take the first success; give up with the first error at exhaustion) and
`preferEngineOrder` (wait for a better-ranked engine to settle even after a worse one succeeded, up
to exhaustion).

**No deadline option**, per §2.2. `TranscribeOptions` has no such member, so offering one would be
an option no transport honours. The caller's `signal` reaches every lane.

**Capability gating happens first.** An `unavailable` transcriber is not raced — it is excluded
before the race starts, using the same cached probe `firstCapable` uses, so a race of three
engines on a device where two are unavailable is a race of one rather than two guaranteed
rejections. This is the one piece of `firstCapable`'s machinery that `raceTranscriber` does reuse,
and it is reused rather than reimplemented.

**Losers are cancelled**, via the same controller-composition as §4.1. Transcription is the more
expensive of the two seams — a managed transcription of a long recording is a real bill and a real
upload — so a race that cannot cancel is worse here than it is for extraction.

### 4.3 `chunkedExtractor`

**Shape.** `chunkedExtractor(inner, options): Extractor<Enveloped<V, P>>`, with `target`, a `chunk`
policy, and an optional `merge` policy.

**Chunks are literal substrings of the canonical text.** This is the load-bearing constraint, and
it is what makes the whole combinator cheap: a span a model quotes from a chunk is a verbatim quote
from the whole transcript, so `isSpanGrounded` keeps working with no span rewriting, no offset
arithmetic, and no chance of a citation that grounds against a chunk but not against the document.
A `chunk` policy that returns anything other than substrings is a caller bug the combinator checks
for and refuses — cheap to verify (`text.includes(chunk)`), and catastrophic to miss.

**The chunk policy is caller-supplied**, taking the transcript and returning an ordered list of
substrings, with a shipped default that splits on a character budget at paragraph then sentence
boundaries and never mid-word. Core does not know the model's context window, so the budget is a
required argument to the default rather than a guess inside it.

**The merge policy follows ADR 0001 exactly.** For each leaf path, the policy receives the path and
the envelopes the chunks produced for it, and returns an **index** — so a merge policy cannot
fabricate a value, a confidence, or a citation, any more than a consensus policy can. The reasoning
is identical and so is the encoding; SP2's mistake is not repeated here. Two defaults:
`firstCommitted` (the first chunk that committed a non-null value wins; ties to the earlier chunk)
and `lastCommitted` (the last wins — right when later text supersedes earlier, such as a correction
dictated after the fact).

**Leaf granularity is refused at construction**, per ADR 0003, for the same reason: the merge walks
per-leaf envelopes and a `"row"` group would merge nothing while returning a result that looks
merged.

**Usage sums across chunks, and `engine`/`strategy` are omitted** — same rule and same reason as
`consensusExtractor`. Token members sum only across chunks that reported them and are omitted
entirely if any chunk omitted one, per ADR 0005's absent-is-not-zero discipline.

**A chunk that fails is a failed run, not a missing sample** — the opposite of
`consensusExtractor`, and the contrast is worth stating. Consensus's candidates are redundant: three
samples of the same thing, so two are still evidence. Chunks are **disjoint**: a failed chunk means
a region of the document was never read, and returning a result that silently omits whatever was in
it is the worst available outcome. So a chunk rejection propagates. A caller who wants partial
results composes `retryExtractor` per chunk, which is exactly what that combinator is for.

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
