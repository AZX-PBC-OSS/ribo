---
"@azx/ribo-extractor-systemone": minor
---

Add `systemOnePresencePhase(options)` — the presence phase over a System One client, a sibling
of core's per-group `presencePhase` that asks every leaf of every group in ONE batched
`ask` call: one `noul` question per leaf (id = the leaf's dotted path, state = the transcript
text), each answer's yes-probability thresholded into core's presence map under core's
`presenceNoteKey`. More leaves than `batchSize` split across sequential requests; leaves unset
means one call, since the client batches internally anyway.

The three behaviours core's presence phase makes contractual are reproduced through core's own
exported helpers (`extractGroups`, `nullEnvelope`, `wrapGroupEntry`, `phaseBuilder`) rather than
a second copy: `plan` is never empty (batches are fixed at construction and ignore the draft);
`merge` seeds every group with a full null envelope — for failed batches as well as successful
ones — so a group whose map is all-false still appears in the fields and the closing
trust-boundary parse accepts the result; and a collection group's entry is wrapped as a
one-element array through `wrapGroupEntry`, an object group's left bare.

The default threshold is 0.2 — deliberately below the natural 0.5 midpoint and below the
measured boundary. The two answer populations overlap, so no threshold separates them, and the
costs are asymmetric: a false negative silently drops a field every later phase will refuse to
look at, while a false positive costs one wasted question. The measured boundary for the lowest
correctly-present leaf sat exactly ON the leaf — no margin — so the default keeps a margin
below it, erring toward recall. A test pins the default below 0.3 so raising it fails loudly.
