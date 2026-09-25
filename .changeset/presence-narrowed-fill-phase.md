---
"@azx/ribo-core": minor
---

Add `presenceFillPhase` and the `presenceNarrowedExtractor` preset — the managed
path's presence narrowing (ADR 0028).

`perGroupExtractor` sends one call per top-level group carrying that group's full
leaf set, for every group, whether or not the transcript mentions it. This phase
reads the presence note a presence phase wrote and makes one value-extraction
call per group with **at least one present leaf**, over a `projectTarget`-narrowed
target carrying exactly the active leaves. A group whose leaves are all absent
yields no item and therefore no call.

That is only sound because the presence phase **seeded** every group key into the
draft with a full null envelope: the closing trust-boundary parse requires every
top-level key, so a skipped group survives it on the seed's work rather than this
phase's. ADR 0009 rejected unseeded scoping for exactly that reason, and ADR 0028
records why seeding converts it into a narrowing. The `requires: ["presence"]`
default is what makes a misordered list fail at construction, naming the phase,
instead of at the parse naming a missing key.

Measured on spike 0011, over spike 0008's corpus: group-level presence skips
42.9% of extraction calls with zero groups lost, across a 0.30-wide threshold
plateau; leaf-level presence drops 81.4% of the schema with zero leaves lost.
Those fractions are over the 5 groups the corpus covers, not all 20.

**The projection is singleton**, and that is a real limitation rather than a
detail: the seed wraps a collection group's one instance in a one-element array
and the merge writes into exactly that instance, so a second instance has nowhere
to land. `perGroupExtractor` remains the multi-instance strategy.

Ships **opt-in**. Nothing existing is rewired, no default changes, and the preset
takes the presence phase as a parameter — core's chat-backed `presencePhase` or
the System One one — rather than importing one, so no new package dependency
appears. ADR 0028 records that the narrowed pipeline should not become anyone's
default until an end-to-end run measures what narrowing does to extraction
accuracy, which is unmeasured.
