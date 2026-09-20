# Extraction

A session's transcript — [Sessions](/guide/sessions) covers how several captures become one — is
text plus context about where it came from, until something turns it into fields a system of record
can accept. An `Extractor<F>` is that something: the one seam that calls a model, and the only thing
that changes when you swap a fake for a real engine, or one real engine for another.

## The `Extractor<F>` seam

```ts
import type { AnnotatedTranscript, Extractor, ExtractionResult } from "@azx/ribo-core";

interface Extractor<F> {
  extract(transcript: AnnotatedTranscript, options?: ExtractOptions): Promise<ExtractionResult<F>>;
}
```

One method, and it never sees a `CapturePayload`, a `Recording`, or a `DocumentCapture` — only the
joined transcript a session assembles. An extractor that took a capture would have to know whether
the words came from a microphone or a scanner, and nothing about turning text into fields cares.
This is the same structural split [Sessions](/guide/sessions) describes, from the other side.

The input is an `AnnotatedTranscript`, not a bare string. Its `text` is the one canonical string
that extracted spans are checked against — what the model quotes from and what `isSpanGrounded`
checks against, exactly as it always has. Around it sits an open `annotations` bag: a document
transcriber's page boundaries or table structure, the relay's per-capture metadata under the
reserved `capture.` prefix — whatever the upstream stages produced. The bag is deliberately left
schema-free until a real transcriber produces real annotations, and it does not affect grounding:
`isSpanGrounded(span, transcript.text)` is the same check it always was.

`ExtractionResult<F>` carries the parsed `fields`; an optional `raw` payload kept for debugging; a
`usage` block (calls made, token counts, and which `engine` and `strategy` produced the result —
covered from the composition side in [Arbitration & Fallback](/guide/arbitration)); and an optional
`statedEmptyGroups`, for a roster-based strategy's explicit "none of these" answers per group.

## Run options: cancellation is part of the contract

The trailing `options` bag currently carries one member, `signal?: AbortSignal` — the same optional
trailing object `Transcriber.transcribe` takes, so the two run-context contracts do not drift. The
relay passes a signal that it aborts when the extraction step's timeout fires, so a hung model
call is cancelled rather than left running behind the rejection; a host driving an extractor by hand
can pass its own. Each transport states what it does with the signal in its own docs — the
fetch-based ones abort the in-flight request, the on-device engine cancels between phases without
killing the model session — and an implementation that cannot honour it must say so plainly rather
than accept it and ignore it. A cancelled extraction rejects rather than returning a partial
result, and **both** extraction routes classify that abort as retryable on purpose — the on-device
engine rejects with `ChatError.aborted` just as the managed one does. The abort is caller-initiated,
and a host that cancels on a deadline may well succeed on a later attempt with a fresh one. (The
transcription side makes the opposite call — see [Captures & Sources](/guide/captures-and-sources).)

## `ExtractionTarget`: the field knowledge an extractor needs

```ts
type ExtractionTarget<V extends Record<string, unknown>, P = NoProvenance> = Pick<
  ToolAdapter<V, unknown, P>,
  "name" | "extractionSchema" | "instructions" | "examples"
>;
```

It is the slice of a `ToolAdapter` extraction actually touches: the enveloped schema to constrain
the model against, plus the instructions and few-shot examples that shape the prompt — `write` and
the connection context are left out, because writing back is a separate concern an extractor never
needs to know about. A `ToolAdapter<V, C, P>`'s full shape satisfies `ExtractionTarget<V, P>`
structurally, so the same adapter object you hand to a write step is the one you hand to an
extractor — no second, extraction-only object to keep in sync.

## `toSessionExtractStep`: wiring an extractor into the relay

```ts
import { toSessionExtractStep } from "@azx/ribo-core";

const sessionExtract = toSessionExtractStep(myExtractor);
```

The name says `Session`, not `Extract`, on purpose: extraction runs once per **session**, against
the joined transcript from every capture that belongs to it, never once per recording — see
[Sessions](/guide/sessions) for why that line sits where it does. `toSessionExtractStep` is the
one-line adapter between an `Extractor<F>`'s `ExtractionResult<F>` and the relay's own
`SessionExtractStep` shape, so wiring a strategy into the queue is a one-line change to
`RelayOptions.sessionExtract`, with no change to the relay itself.

## `FakeExtractor`: driving the pipeline with no model

```ts
import { FakeExtractor, toSessionExtractStep } from "@azx/ribo-core";

const extractor = new FakeExtractor({
  company: { value: "Acme", confidence: 1, sourceSpan: "Acme" },
});
const sessionExtract = toSessionExtractStep(extractor);
```

`FakeExtractor` returns fixed fields instead of calling anything, and records every transcript it
was handed on `.calls` — the extraction-side parallel of `FakeTranscriber`. It is what lets the
relay, the test suite, and the playground drive capture → transcribe → extract → review → write end
to end with no network and no API key; [Quick Start](/guide/quick-start) builds that pipeline from
scratch with it.

## The two real extractors

### `@azx/ribo-extractor-openai`: the managed-LLM strategies

`singleShotExtractor` is the built default: one structured-output chat call per extraction, its
response parsed against the target's `extractionSchema`. It needs a `ChatClient` to actually talk to
a model, and this package ships two. They are different transports, not two endpoints of one.

- **`openAiChat`** is the OpenAI-compatible transport: it POSTs to `${baseUrl}/chat/completions`
  with bearer auth and reads `choices[0].message.content`, the shape any OpenAI-compatible endpoint
  speaks.
- **`helixChat`** serves the Helix platform's own provider-neutral `/_api/llm/chat` route and is not
  OpenAI-compatible. The wire shape is different too — a flat `{ model, content, stopReason, usage }`
  body rather than an OpenAI `choices` array, and a system message becomes a top-level `system` field
  rather than a message in the array.

Both satisfy the same `ChatClient` interface, so `singleShotExtractor` (and every strategy built on
top of it) is written against the interface and never against either transport's wire shape. Which
one a host constructs is a deployment choice, not a code branch.

```ts
import { singleShotExtractor, openAiChat } from "@azx/ribo-extractor-openai";

const extractor = singleShotExtractor({
  target: { name: "contact", extractionSchema, instructions: "Extract the caller's details." },
  chat: openAiChat({ apiKey, baseUrl }),
  model: "gpt-4o-mini",
});
```

A real target schema does not fit through one call, though — `singleShotExtractor` alone is where a
real system of record's field count runs into a structured-output API's own limits.
[Schema at Scale](/guide/schema-at-scale) is the full mechanism for how this package's other
exports — `splitExtractionSchema`, `perGroupExtractor`, `instanceLadder`, `gapFillExtractor` — get a
real schema through in several calls instead of one; this page does not restate it. The package also
ships two wrappers that sit around any base extractor: `schemaRetryExtractor` catches a
`SchemaParseError` and re-asks the model once, telling it in-band what failed validation (see
[Arbitration & Fallback](/guide/arbitration) for why that error is retryable and recognisable), and
`gapFillExtractor` makes one bounded follow-up call over leaves that abstained despite quoting
evidence. Where those wrappers shine per group rather than over the whole schema is
[Per-Group Composition](/guide/per-group).

### `@azx/ribo-extractor-ondevice`: `threePhaseExtractor`

`threePhaseExtractor` runs the same `Extractor<F>` seam over the platform's on-device Language
Model instead of a managed endpoint — no network once the model is available. It makes three
distinct calls per group — presence, span, and classify — not a single-shot call split into three
retries: a single combined call produced a degenerate whitespace-repetition failure mode on this
model class that retrying the same call could never fix. Splitting the ask brought on-device
source-span fidelity to 100% grounded. Like the managed extractors, it reads its schema from
`ExtractionTarget.extractionSchema` and knows nothing about any one host adapter.

## Phased composition: a multi-pass strategy is a list of phases

Three strategies — `gapFillExtractor` and `scopedInstanceExtractor` in `@azx/ribo-extractor-openai`,
`threePhaseExtractor` in `@azx/ribo-extractor-ondevice` — look like three bespoke orchestrators.
They are not — each is a preset over one combinator, `phasedExtractor`
(`@azx/ribo-core`), that runs a list of **phases** in order. You meet this machinery when you wire
one of those presets together by hand, extend one with a pass of your own, or write a fourth
multi-pass strategy — which is now a phase list rather than a hand-rolled loop.

### What a phase is

A phase is a value with three functions, built with `phaseBuilder<V, P>()`:

- **`plan(draft, ctx)`** returns this pass's work items, narrowed from the state the previous
  phases accumulated. It is **synchronous and pure**, and that is a constraint with a purpose: a
  phase that needs I/O to decide its work does that I/O in an earlier phase's `run` — inventory →
  fill is exactly that shape — and keeping `plan` sync is what makes every narrowing rule testable
  with a plain object and no model.
- **`run(item, draft, ctx)`** does one unit of work — the only async member, and opaque to the
  engine. It assembles its own messages and calls whatever transport it wants, including several
  calls in one `run`.
- **`merge(draft, outcomes)`** folds the batch back into the draft. It takes the whole batch rather
  than one result at a time because some interpretations span a group's outcomes — and it owns
  **every** write to the draft. `run` is handed the draft to read and must not write through it:
  items within a phase run concurrently, so a mutating `run` races its siblings.

### What the engine owns

Everything that is not "what to ask": scheduling each phase's items through a bounded pool
(default concurrency 4, a phase may declare its own), per-item retry, cancellation, a deadline
carried to every item, the `onUnit` progress stream, usage accumulation summed from every phase
output, and the closing parse of the merged fields against `target.extractionSchema` — the trust
boundary. A phase author writes what to ask and nothing else.

One precision, because a wrong mental model here sends you looking for a member that does not
exist: **nothing slices the deadline.** Every phase's context receives the same effective deadline
— the run's step timeout, narrowed by any deadline the caller passed in. What is divided per phase
is the input to the retry-budget derivation — remaining time over remaining phases — which decides
how many retries each phase gets, not how much time it gets.

### The draft, and the three-state leaf

Between phases, state lives on the `PhaseDraft`: `fields` fill progressively as a deep partial of
the enveloped shape, `statedEmptyGroups` and `raw` ride along, and `notes` is the cross-phase
channel for everything else — a roster, a per-group presence map.

A leaf's `value` under the deep partial reads `T | null | undefined`, and the three states are
load-bearing: `undefined` means **not yet asked**, `null` means **asked, and the answer was null**.
That distinction is the anti-hallucination rule — "the model was never asked" and "the model
answered nothing" are different claims about the transcript. Keep it apart when you write a merge:
the first merge helper anyone reaches for collapses it with `?? null`, and that merge has silently
destroyed the distinction. If phases share scratch data, its key is branded — `noteKey<T>(id)` —
so two phases cannot silently clobber one key or read one at the wrong type, while the key stays a
plain string at runtime.

### `requires` / `produces`, checked at construction

A phase declares which note keys it `requires` and which it `produces`, and a mis-wired list fails
at construction — before the first call is paid for, with the missing key and the phase id named.
Order matters: a key produced by a later phase does not satisfy an earlier phase's requirement.

### The three strategies are now presets over it

`gapFillExtractor` became a base `extractorPhase` followed by `gapFillPhase`;
`scopedInstanceExtractor` became `inventoryPhase` then `fillPhase`; `threePhaseExtractor` became
four phases — presence, span, classify and a wrapped-classify pass over whatever the transport
could not answer bare. **Their option names held; two of the three changed their observer's unit
type.** `GapFillOptions` and `ScopedFillOptions` used to be declared over the strategy-specific
unit types and are now over `PhaseUnit`, so a handler written against the old type receives events
its type did not name; `ThreePhaseExtractorOptions` was already over `PhaseUnit` and did not
change. This is why those ports declared major versions — do not expect the events to be the ones
they were.

Three further gap-fill changes are host-visible: the no-candidates passthrough path now emits the
base phase's `start`/`done` pair where it previously emitted nothing; the per-event `candidates`
count is gone; and returned objects are no longer reference-equal to the base extractor's, because
the closing parse rebuilds every object (values are unchanged — deep equality holds).

### A phase says whether it seeds the draft

`requires`/`produces` cover the **notes** a phase reads and writes. They do not cover the _fields_,
and one phase needs them: `gapFillPhase` re-asks about leaves an earlier phase left abstained, so it
needs a draft somebody populated. There is no note key for that.

Two optional flags close it:

```ts
seedsDraft?: boolean;    // this phase's merge can populate an empty draft's fields
requiresDraft?: boolean; // this phase only does useful work over a populated one
```

`validatePhases` rejects a list where a `requiresDraft` phase has no earlier `seedsDraft` one —
`[gapfill]` alone, or `[inventory, gapfill]`. Order matters, and a seeder later in the list does not
help.

**Why this is worth a construction-time error.** Without it the list runs, plans nothing, and dies
at the closing parse — every group key is required, so a draft missing them is rejected. That
failure is **retryable**, so the relay re-runs the whole list and re-spends every earlier phase's
calls, repeatedly. Failing at construction is free.

`fill`, `presence` and a lifted `extractorPhase` seed. `gapfill` requires. `inventory` declares
neither: it writes `[]` entries for groups the roster called empty, which is scaffolding rather than
extracted data.

### Running a phase twice

A second `fillPhase` used to be a no-op that overwrote the first — its `plan` reads the roster and
the transcript, never the draft. `narrowToAbstained: true` makes it skip jobs whose leaves are
already committed, so `[inventory, fill, fill({ narrowToAbstained: true })]` re-asks only about what
the first pass missed.

The granularity is the **job**, not the leaf: a job with any uncommitted leaf is planned in full.
Leaf-level narrowing is what `gapFillPhase` does.

Every phase factory also takes an optional `id`, defaulting to its usual one, because
`validatePhases` rejects duplicates and a list using a kind twice needs to name them apart.

### What you cannot do: scope a phase to some groups

Targeting a subset of groups is not available, and will not be. The extraction schema requires
**every** top-level group key — that is the anti-hallucination rule, which forces a model to emit an
explicit `null` rather than omit a field — and a phase's merge writes only the groups it ran jobs
for. A scoped fill therefore leaves the other keys absent and the run fails at the parse.

The distinction against `narrowToAbstained` is exact: narrowing skips work that is **already done**,
so those keys are already in the draft; scoping would skip work that was **never done**.

### Which phases you can actually compose

`gapFillPhase`, `inventoryPhase`, `fillPhase` and `rosterNoteKey` are exported from
`@azx/ribo-extractor-openai`'s barrel. The on-device strategy's four phases are **not** exported —
they live under an internal directory and the package's entry point exposes only the preset — and
this repo forbids deep imports. Compose from what is actually available rather than assuming every
preset's pieces are public. `extractorPhase(id, extractor)`, from `@azx/ribo-core`, lifts any
existing `Extractor` into a one-item phase, in any package.

### Failure policy: `onItemFailure`

When one of a phase's items fails, the phase's `onItemFailure` decides what that means:
`"abort"` fails the run and cancels the in-flight siblings; `"skip"` hands the failed outcome to
`merge` to interpret. It is the one policy decision every phase author makes, and "interpret" is
not one rule — the ported on-device strategy nulls a leaf's span when presence fails and keeps it
when classify fails, two readings of "this item failed" inside one strategy. A cancellation
overrides the policy either way: a caller cancelling (signalled, or thrown as a branded
cancellation) rejects the whole run, in both policies, because a skip that swallowed a
cancellation would resolve with all-null fields — indistinguishable from a document that said
nothing.

### `describeItem`

The engine cannot see inside your items — `run` is opaque — so it cannot know what group a unit
of work belongs to. `describeItem(item)` supplies the `key` (and optionally `leaf` and the
scoped-fill coordinates) the `PhaseUnit` events carry; **without it, every progress event carries
an empty key.** If you want a progress stream a reviewer can read, this is not optional.

### `produces` is checked twice

Construction is not the only check. The declared `produces` keys are verified again at each phase
boundary at runtime, against what the phase's `merge` actually wrote — because a phase that
declares a key and writes it only conditionally is a silent liar, and the condition that bites is
exactly the realistic one (a roster-driven contribution written only when the roster found
instances). Expect a mid-run throw naming the phase and the key, not a construction error.

### A declared `maxRetries` is a request, not a promise

The engine derives each phase's retry share from the time remaining at that phase's boundary — the
same remaining-time-over-remaining-phases division as the deadline paragraph above — and may run
the phase with fewer retries than it declared. This is why the on-device preset sets the numbers it
does (a device-sized per-call ceiling, no retry delay): with the managed defaults, a dozen-leaf
classify phase at `concurrency: 1` derives to zero retries, and that preset is inexplicable
without the derivation.

### A worked example

A two-phase list with a real narrowing between them — a scan pass that asks which top-level groups
the transcript discusses, then a fill pass that asks only about the discussed groups:

```ts
import { noteKey, phaseBuilder, phasedExtractor } from "@azx/ribo-core";

// The cross-phase channel: group key -> did the scan find it discussed at all?
const discussed = noteKey<Record<string, boolean>>("discussed");
const define = phaseBuilder<V>(); // your adapter's writable patch type

const scan = define({
  id: "scan",
  produces: [discussed], // written unconditionally — see "checked twice" above
  describeItem: (group) => ({ key: group }),
  plan: () => groupKeys, // one item per group; the first pass has nothing to narrow against
  run: async (group, _draft, ctx) => ({
    // Your prompt assembly and chat call, elided. `ctx.transcript.text` is the
    // one canonical string; `ctx.signal` is the caller's cancellation.
    value: await scanGroup(group, ctx.transcript.text, ctx.signal),
    usage: { calls: 1 },
  }),
  merge: (draft, results) => {
    const map = { ...draft.notes.get(discussed) };
    for (const r of results) {
      if (r.outcome === "result") map[r.item] = r.output.value;
    }
    return { ...draft, notes: draft.notes.set(discussed, map) };
  },
});

const fill = define({
  id: "fill",
  requires: [discussed],
  describeItem: (group) => ({ key: group }),
  // THE NARROWING: only the groups the scan marked discussed get a call.
  plan: (draft) => groupKeys.filter((key) => draft.notes.get(discussed)?.[key] === true),
  run: async (group, _draft, ctx) => ({
    value: await extractGroup(group, ctx.transcript.text, ctx.signal),
    usage: { calls: 1 },
  }),
  merge: (draft, results) => {
    const fields = { ...draft.fields };
    for (const r of results) {
      if (r.outcome === "result") fields[r.item] = r.output.value;
    }
    return { ...draft, fields };
  },
});

const extractor = phasedExtractor({ target, phases: [scan, fill] });
```

Everything you do not see — the pool, the retries, the sibling abort, the deadline, the unit
events, the usage sum, the closing parse — is the engine's.

## Extraction quality is not currently measured

**There is no current number for how often an extracted value is correct.** The
annotated corpus this repo's acceptance gate would score against
(`spikes/extraction-snuggpro/ground-truth/`) is written in a field vocabulary the Snugg Pro adapter
no longer uses, so `packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts` deliberately refuses
to emit a score against it rather than publish one that no longer means anything. Every citation
figure elsewhere in these docs — the 37%/14-of-14 numbers in [Provenance](/guide/provenance), the
per-group call counts in [Schema at Scale](/guide/schema-at-scale) — is a measurement of _citation
fidelity_: whether a quoted span is really in the source. None of it says whether the value beside
that span is the right one. See [Extraction: Measured](/deep-dives/accuracy) for the last run
recorded before the gate started refusing, kept as a worked example of how the gate scores a
transcript, not as a claim about current accuracy.

## Next

[Arbitration & Fallback](/guide/arbitration) covers composing more than one of the extractors above
into a strategy ladder, a race, or a capability-selected roster.
[Schema at Scale](/guide/schema-at-scale) covers partitioning a real schema across calls,
[Per-Group Composition](/guide/per-group) covers giving one group its own extractor once it is
partitioned, and [Provenance](/guide/provenance) covers the envelope every one of these extractors
fills in.
