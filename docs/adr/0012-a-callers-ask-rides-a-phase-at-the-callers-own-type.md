# 0012. A caller's ask rides a phase at the caller's own type

Status: Accepted
Date: 2026-09-20

## Context

The phase vocabulary asks the model against the adapter's extraction schema and folds
envelopes into the draft. The one kind that departs from that — `inventoryPhase` — is the
close cousin that shows what was missing: its `run` calls a **caller-supplied callable**,
and its merge writes a typed `Roster` to a note key, no envelopes at all. But there the
note key and its value type are fixed by the library and the caller supplies the whole
function, so putting a host's own question — its own schema, its own result type, its own
note key — into a phase list meant writing the chat call, the zod-to-JSON-schema
rendering and the trust-boundary parse by hand. And a deterministic transform between two
model phases had no slot at all: the two existing deterministic positions are each
phase's own `merge` and the engine's single global `normalize`.

## Decision

`computePhase` and `askPhase` join the shipped kinds in core, over a shared fold
vocabulary: a **fold** is a phase's typed write into the draft — the caller's own
whole-draft transform, at the caller's value type.

`computePhase` is the deterministic slot: no model call, no I/O, one marker item, the
caller's fold at the draft's type. `askPhase` is one model call against the **caller's**
zod schema: the request's structured output is rendered from it, the response is parsed
against it at the same trust boundary the managed phases cross (`completeOrClassify` →
`assertStopFinishReason` → `parseJsonContent` → `parseWithSchema`), and the parsed answer
goes where the caller says — under a caller's `NoteKey<T>`, or folded into the draft at
the answer's type. `T` unifies across `z.ZodType<T>` and `NoteKey<T>` in one options
object, so the schema is written once and the key, the fold and the later read all follow
it. The cross-phase handoff itself is not new: the notes bag and its branded keys are the
shipped channel, and `rosterNoteKey` already crosses packages through `demandNote` with
the brand intact.

Neither kind declares a `requires` of its own — a caller's question and a deterministic
fold have no shipped provider — so the option is the whole list, with no default to
replace (ADR 0008).

## Consequences

**A host composes its own question beside the shipped kinds without writing transport
plumbing.** The brand's invariance is what makes the type flow safe rather than merely
convenient: a slot widened to `unknown` refuses a `NoteKey<Answer>` at the call site, so
a wrong widening is a compile error where the phase is constructed, not a runtime
surprise. That is also why `askPhase` is curried like `phaseBuilder` — TypeScript fills
the tail of a partial type-argument list from its DEFAULT rather than inferring, so a
single-call `askPhase<V>({...})` would widen every ask and refuse every branded key; the
curry fixes `V` and infers `T` at the inner call.

**There is deliberately no per-fold key-set guard.** An earlier draft made a caller fold
that drops a top-level `fields` key throw a `TerminalError`. Rejected, three ways:

- The fold is deterministic; **its input is not.** Whether a fold drops a key depends on
  what earlier sampled phases wrote, so the same fold is a hard failure on one run and
  fine on the next — "a retry provably reproduces it" is not provable.
- The invariant is already enforced, globally, at the closing parse, and
  `SchemaParseError` is transient **on purpose**: a list reaching the parse incomplete
  fails there retryably, as ADR 0008's consequences record as accepted behaviour. A
  per-fold rule re-implements a weaker local copy of that and upgrades it to a dead
  session — the loss the retry classifier's default-true rule exists to prevent.
- It forbids a correct list. `[compute(clears a contested group), ask(its own question
about it), compute(folds the answer back)]` is type-correct and complete at the parse;
  a per-fold guard kills it at the first phase.

The obligation is documented on both kinds' folds instead — a fold must leave the draft
completable by the phases after it, and the closing parse is where that is checked. The
idea will look attractive again; this paragraph is the record to reopen.

**A boundary the cousins now define.** `computePhase` does no I/O — a caller-supplied
callable that calls out belongs in `askPhase`, and `inventoryPhase` is not rewritten to
compose either. The call conventions deliberately differ too: `inventoryPhase` reports a
call for the caller's function it runs; the compute kind reports none, because it makes
none.

The cost is a permanently wider public surface — the kind factories, their options, the
sink union, the fold type and the moved parse chain are all supported API and a
compatibility commitment, the same cost ADR 0010 accepted for the seam move this
continues.
