---
"@azx/ribo-core": patch
"@azx/ribo-cli": patch
"@azx/ribo-adapter-snuggpro": patch
---

`presenceNarrowedExtractor`'s fill phase now honours the same split caps the per-group strategy honours. It previously sent exactly one value-extraction call per group with present leaves, however large the group's narrowed schema — so under a byte-capped route (the Helix vendor cap of 32,768 serialized characters on the real Snugg Pro schema) it could send an over-cap call the per-group path would have partitioned, and the route refused it. The fill now narrows first and then splits each group's narrowed schema through the same `splitExtractionSchema` the per-group plan partitions with: `presenceFillPhase` (and the preset, which forwards it) takes `maxNullableUnionsPerGroup` (same default, `MAX_NULLABLE_UNIONS_PER_CALL`) and `maxSerializedCharsPerGroup` (same pass-through, off when absent). One fill item per piece, so a failed piece nulls only its own leaves under `onItemFailure: "skip"`, and a collection group's pieces zip back by instance index — presence still decides which leaves, never how many instances. Narrowing runs before the split, so a group with few present leaves still costs one call.

`ribo schema inspect`'s `presenceNarrowedAtMost` moves with the fix: it is now the group count (presence, one call per group always) plus the split's own grouped-piece count under the reported caps — the all-present worst case the agreement test pins, partition included — instead of the old `2 × groupCount`. The JSON contract's shape is unchanged, so `contractVersion` stays at 3.

The adapter's entry covers its new presence-narrowed cap test against the real schema and vendor cap — no runtime change.
