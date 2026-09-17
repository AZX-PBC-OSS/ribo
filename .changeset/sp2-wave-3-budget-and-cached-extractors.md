---
"@azx/ribo-core": minor
---

Two extraction combinators, both thin wrappers over the `Extractor` seam.

`budgetExtractor` wraps one extractor and throws `BudgetExceededError` when a returned result's usage exceeds a caller-set ceiling (`maxCalls`, `maxPromptTokens`, `maxCompletionTokens`, `maxTotalTokens` — the total sums prompt + completion only, since the cache token members describe where the prompt tokens came from). It is a detector, not a governor: it reports a spend it cannot prevent, and it is honest around ONE strategy — wrapped around a ladder it sees only the winning rung's usage, so put it inside a ladder, around each rung. The error extends `TerminalError`, so under the shipped default arbiter an overspend falls through to the next rung instead of becoming a retry loop.

`cachedExtractor` memoises an extractor's result under a key derived from the transcript text and the WHOLE extraction target — name, instructions, examples and the extraction schema — because instructions and examples are the prompt, so a changed example is a miss. The store is injected (an in-memory `Map` by default; no persistence is built in). Failures are never cached, neither a cache read nor a write can fail the extraction, and a hit rewrites `usage` to `calls: 0` — the run that served it made no model calls.
