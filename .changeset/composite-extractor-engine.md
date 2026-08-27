---
"@azx/ribo-core": patch
---

Reimplement `compositeExtractor` over the shared `createSequentialExtractor` engine. Public signature, capability caching, TTL invalidation, and selection rules are unchanged. The new implementation delegates admission to the capability probe, arbitration to a first-result/first-error arbiter, and provenance stamping to the engine's `"engine"` key. Rule 5 (a selected extractor's error propagates untouched and the composite does not fall back) is now pinned by a dedicated test file.
