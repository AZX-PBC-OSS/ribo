---
"@azx/ribo-extractor-systemone": minor
---

Add `@azx/ribo-extractor-systemone` — scaffold for System One-backed extraction strategies, with
its first module: `enumMembersAt(schema, path)`, which answers "what enum members may this leaf
hold?" for a leaf of an extraction schema.

The walk steps through a collection group's ELEMENT schema for a numeric segment — an index
addresses data, not the schema, and every element shares one schema — and reads the enum off the
envelope's `value` member, returning members in declaration order, or `null` when the leaf is
not an enum or the path does not resolve. `null` rather than a throw, because its callers ask
exploratory questions about arbitrary paths; the gap-fill walk in `@azx/ribo-extractor-openai`
throws for the same case only because its candidates came from data already parsed against the
schema. The walk is a local copy of that one, not an import — a dependency between the two leaf
packages is a direction the architecture rules out, and moving the walk into core is a separate,
scheduled refactor.

The System One extraction phase and a verification combinator land in later tasks; the package
is registered with typedoc and the pack-and-consume scratch app now so they arrive in an
already-gated tree.
