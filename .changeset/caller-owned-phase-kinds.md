---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": patch
---

The caller-owned phase kinds: `computePhase` and `askPhase`, beside the shipped ones in
`@azx/ribo-core`.

`computePhase` is the mid-list deterministic slot — no model call, no I/O, no usage; one
marker item (the engine skips a merge whose plan was empty, so the marker is what makes
the fold load-bearing) and the caller's fold at the draft's type. The fold type itself is
new shared vocabulary: `PhaseFold<V, P, T>`, how a phase's merge writes a typed value
into the draft, the same shape for both kinds.

`askPhase` is one model call against the caller's OWN zod schema — the request's
structured output rendered from it, the response parsed against it at the same trust
boundary the managed extractors cross, and the parsed answer going where the caller
says: under a caller's `NoteKey<T>`, or folded into the draft at the answer's type. `T`
unifies across `z.ZodType<T>` and `NoteKey<T>` in one options object, and the brand's
invariance makes a wrong widening a compile error at the call site. The factory is
curried — `askPhase<V>()({...})` — because TypeScript fills the tail of a partial
type-argument list from its default rather than inferring, which would widen every ask.
There is deliberately no per-fold key-set guard: a fold must leave the draft completable
by the phases after it, and the closing parse — transiently — is where that is checked
(ADR 0012).

The managed-completion call-and-parse chain (`completeOrClassify`,
`assertStopFinishReason`, `parseJsonContent`) moved from
`@azx/ribo-extractor-openai`'s `extraction-common` into core beside the chat seam, so
`askPhase` composes the same chain its managed cousins do; the openai package re-exports
it, and its public surface is unchanged.
