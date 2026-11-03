---
"@azx/ribo-core": minor
---

**`presenceFillPhase` asks a collection group for its array.** Before, every group was projected
to a singleton, so a transcript describing three heating systems got one back and the rest were
silently dropped. Presence decides which leaves to ask about, never how many instances exist.
The fill now asks for the collection's array and replaces the seed's one-element array with the
returned instances, each carrying every leaf of the group (inactive leaves null). An empty array
keeps the seed's null instance: presence said the group was discussed, so an empty reply is a
model miss, not a stated "none".

Measured in spike 0012: the singleton fill lost 7 stated values per arm, all second and third
appliances. The array fill lost none. Flat groups are unchanged. `presenceNarrowedExtractor`
stays opt-in.
