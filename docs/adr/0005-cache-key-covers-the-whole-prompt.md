# 0005. An extraction cache key covers the whole prompt, and a hit reports zero calls

Status: Accepted
Date: 2026-09-17

## Context

Re-running an identical extraction costs full price — development iteration, accuracy sweeps, and a
relay retry after a non-extraction failure all re-issue the same request. Memoisation is obvious.
Getting the key wrong is not obvious, and it fails silently.

A cache keyed on the transcript alone serves a result computed against **different instructions,
examples or schema**. That result parses cleanly, carries plausible provenance, and is wrong, and
nothing downstream can detect it. A cache that can serve wrong data is worse than no cache.

Two further details decide correctness rather than tidiness. Object key insertion order must not
change the key, or the cache misses at random and the bug presents as a performance problem. Array
order **must** change it — `examples` is few-shot ordering, so a serialiser that "stabilises"
arrays makes two different prompts collide, reintroducing the exact failure the key exists to
prevent.

## Decision

Key on the transcript **text** plus the instructions, examples and schema. Sort object keys;
recurse into array elements positionally. Digest with SHA-256, prefixed `v1:` so a later change to
the recipe cannot serve keys computed under the old one.

The key is derived from `transcript.text` and nothing else on the transcript — annotations carry
per-capture ids that vary between captures, so digesting the whole object would silently kill the
cache for re-dictated text.

A **hit reports `calls: 0`**, keeping the stored `engine` and `strategy` and dropping the token
members.

Failures are never cached, and neither a read nor a write may fail the extraction: a read that
throws degrades to a miss, and a write that throws is swallowed after the result is already in hand.

## Consequences

The cache is safe to point at a persistent store, not just an in-process map.

`calls: 0` matters beyond tidiness. That usage is what `budgetExtractor` reads and what
`toSessionExtractStep` forwards to the session, so returning the stored count would book a spend
that never happened and make composition order — `budget(cached(x))` versus `cached(budget(x))` —
change what a host is told.

The cost is that the key is expensive to compute relative to a naive one, and that a caller who
wants looser matching must supply their own `keyFor`. A `keyFor` that throws propagates rather than
degrading to a miss: unlike a cache fault, nothing has been paid for yet, so failing loudly is free.

See `docs/roadmap/design/sp2-judging-combinators-design.md` §4.4.
