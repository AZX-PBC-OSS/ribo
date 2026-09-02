---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

Extraction usage — the strategy, the call count and the token totals — is persisted on the session.

`ExtractionResult.usage` already carried `calls`, `engine` and `strategy`, and `toSessionExtractStep` returned `{ fields, engine }` and dropped the rest. So the strategy that won a ladder never reached the session document, and nothing anywhere recorded what an extraction cost. From a deployed device the questions "which tier produced this draft", "how many calls did it take" and "is the prefix cache being hit" were all unanswerable.

`ChatUsage` gains `cachedPromptTokens` and `cacheCreationPromptTokens`. Both transports populate them: `helixChat` was already parsing the route's `cacheReadInputTokens`/`cacheCreationInputTokens` and discarding them for want of somewhere to put them, and `openAiChat` now reads `prompt_tokens_details.cached_tokens`. The two counts stay separate because they are priced differently and mean opposite things — a cache write is the cost of the first call with a given prefix, a read is the saving on every one after it.

`ExtractionResult.usage` is now the named `ExtractionUsage` type and carries the four token totals, summed across every call of a run including retries. `singleShotExtractor`, `perGroupExtractor` and `scopedInstanceExtractor` accumulate them.

`ExtractStepResult` gains `usage`, and the session document gains `extractionUsage` — optional, so no stored data needs transforming.

**The sessions collection goes to `version: 1` with an identity migration strategy.** An optional addition still needs the bump: RxDB validates the declared schema against the one the collection was created with, so adding a property at the same version fails at `addCollections` with `DB6` — a database that will not open, on every launch. `SESSION_MIGRATION_STRATEGIES` is `{ 1: (doc) => doc }`, matching the reasoning `OUTBOX_MIGRATION_STRATEGIES` records for its own identity steps.

An absent total means no call reported it; `0` means calls reported it and none hit. The two are never collapsed: for the cache counts that is the difference between "we cannot tell" and "the cache is not working".

Known gap: the instance ladder's inventory pass is a caller-supplied function returning a roster rather than a completion, so its tokens do not reach the extractor. `usage.calls` counts it; the token totals understate by one call until that seam carries usage too.
