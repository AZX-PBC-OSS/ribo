---
"@azx/ribo-cli": minor
---

The package grows the eval runner (design §4): `runEval(corpus, chat, settings)` runs one arm over a
validated corpus and resolves with one result per case — the extraction's own `fields`, its `raw`
output and its `ExtractionUsage` (whose `calls` counts the retries), or the failure that ended the
case. The corpus enters only through `loadCorpus`: the runner reads no corpus files itself and
accepts no other corpus representation, so a run can never happen over a corpus that was not
validated. An arm is an ordered ladder of core's `single-shot`, `per-group` and `presence-narrowed`
strategies, optionally wrapped in the consensus modifier — the ladder is core's own
`fallbackExtractor` over `terminalFallsThrough`, and the modifier is core's `consensusExtractor`
over `unanimousValues`/`majorityValues`, so the runner holds no fall-through logic of its own. The
settings are one plain JSON-able object (the ladder, the model, the consensus count and policy, the
retry budget, the response cap, the split caps), passed in by the caller and stored verbatim by the
records ticket; an absent option is not forwarded, so the strategies' own defaults apply. The
prompt inputs are assembled from the corpus manifest: the instructions verbatim, the few-shot
examples translated from the manifest's flat dotted-path map into the extraction target's shape
(nested by group, each leaf enveloped), the `groupInstructions` map honoured per group, and the
field-descriptions mode forwarded.

`createOpenAiCompatibleChat` builds the backend client over `@azx/ribo-chat-openai` — the first
runtime dependency this package takes, inlined into the single-file bin like the rest (ADR 0037).
The refusals — an invalid settings object, a corpus holding a document case (document inputs are
deferred to the T11 spike's follow-up, and a partially-run corpus would measure nothing), a schema
the arm cannot drive, an example naming no leaf — fire before any model call and raise `EvalError`,
which extends the package's could-not-run class, so the exit-2 mapping T9b wires covers them.
