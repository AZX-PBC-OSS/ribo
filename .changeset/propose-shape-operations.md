---
"@azx/ribo-extractor-openai": minor
---

**Adds `proposeShapeOperations` and `proposeExtractionShape` — the model-driven counterparts
to Stage 1's `deriveExtractionShape`.** Hand the model a plain zod schema and a chat client;
the model emits a `ShapeOperation[]` (`drop`, `retype`, `regroup`) and the existing applier
applies it — the same one a hand-written operation set would go through, so `assertShapeMapping`'s
invariants cover proposed shapes by construction.

How it lands on a working extraction at every failure mode:

- **A successful proposal returns the operations.** Hand-written and proposed shapes are
  interchangeable from the rest of the pipeline's perspective.
- **A proposal the applier refuses is repaired on the next turn.** One repair attempt by
  default; the applier's own precise refusal text becomes the user-turn feedback, the model's
  previous (rejected) answer becomes the assistant turn.
- **At exhaustion (no repair budget, or transport verdict repeats) the function returns `[]`.**
  A valid operation set, just unshaped; the applier accepts it as pure normalization and the
  extraction runs end-to-end. A thrown error was the alternative — friendlier to a
  newcomer this way, and ADR 0016 records the trade.

The cap NEVER reaches the model. Proposing as many or as few operations as warranted is the
model's call; the schema packing is `schemaExtractor`'s downstream concern. The directive
template carries a fixed phrase ("There is no cap on the number of operations") — asserted on by
test rather than a numeric substring, because a real schema's enum members contain numerals and
would false-positive.

The model sees the schema's leaves and kinds as a structured inventory the prompt carries:
paths, the closed set of leaf kinds (string, number, boolean, enum, literal), each leaf's
`.describe` text verbatim, and array membership. `walkLeafInventory` and `renderLeafInventory`
are exported for hosts composing their own prompts.

Cancellation and deadline are forwarded into each chat call — same discipline every other
call in this repo follows.

What this does **not** claim: a model's first-pass proposal on a fresh schema does not match
what the Snugg Pro pilot adapter produces, because the pilot's scoping was grown from real
fill-rate data (auditors who actually speak which fields, on 14 transcripts). A model that
sees only a schema cannot reproduce that.
