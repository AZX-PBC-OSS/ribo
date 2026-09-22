# 0016. The shape-operation proposer is one-shot with one repair attempt, not a multi-turn move loop

Status: Accepted
Date: 2026-09-21

## Context

Wave 2's last piece: a model proposes the operations the Stage 1 applier would apply. The applier already refuses every malformed set at construction with the offending path named — and that text, fed back as conversation feedback on the next turn, lets a model revise. The alternatives on the table:

- **One-shot, no repair.** Fastest; the model gets one attempt. A model that mistypes a path produces no usable shape.
- **One-shot + repair up to a small budget.** Default `maxRepairAttempts: 1`. Each repair is a real, paid model call. At exhaustion, the function returns `[]` (a valid operation set, just unshaped) — friendlier to a newcomer and defensible to a reviewer because the applier still produces a working artifact.
- **Multi-turn move loop with live-applied operations.** Permanent API; builds the same shape incrementally, with the applier's per-attempt refusals driving the next turn's feedback. Bigger surface; more chances to bind instructions to live schema state; more tests to keep a model and a schema coherent.

There were two secondary questions to lock at the same time:

- **What does exhaustion look like?** A thrown error surfaces a "the model couldn't help" verdict — clean, but blocking for a newcomer. A `[]` return keeps the pipeline open with an unshaped derivation that runs without operations. Wave 2 picked `[]`, with the trade written plainly below.
- **Should the cap reach the model?** A spike that disclosed the provider cap in the prompt got a fragmented partition for it — the model produces something close to but not exactly a cap-respecting set, and the post-condition would `assertShapeMapping` it down. Cap-aware is `schemaExtractor`'s job, AFTER the proposal. So no, the cap never reaches the model.

## Decision

The proposer is **one-shot with one repair attempt by default** — the smallest count that lets the proven retry pattern run. Repair budget is configurable (`maxRepairAttempts`), defaults to `1`, and the cost is recorded: each repair is one model call.

**Exhaustion returns `[]`. Always.** A thrown error is not on the table; the function's only return paths are the proposed array or `[]`. The argument for `[]` is a newcomer: handing them a working extraction either way is the goal the wave locked ("someone hands Ribo a plain zod schema they wrote or generated and gets a working extraction"). Throwing on exhaustion would block that goal on a model verdict the newcomer can't directly inspect.

**Amendment (by ADR 0024):** exhaustion returns the final proposal's _surviving operations_ — `[]` only when nothing survived, and on the two transport-exhaustion exits where no proposal arrived. The partial applier the amendment rests on also changes what a repair turn carries: every refusal the applier found, not the first. The newcomer argument is unchanged — the surviving subset is the same "working extraction either way" property, held more often.

**Transport verdicts (refusal, truncation, content filter) get one repair chance, not zero.** A refusal repeats on the same input, and a truncation clips at the same point — both are (mostly) terminal. The proposer still spends one repair attempt because a second transport verdict is the unambiguous signal that the budget should yield `[]` rather than spend calls pointlessly. That costs one extra model call at the unhappy path, which is small.

**Amendment (scoping, not change):** "transport verdict" here means a _model verdict_ against THIS input — `ChatError.refusal` or `ChatError.unsupported`, and `assertStopFinishReason`'s `length` / `content_filter` reclassification. Transient transport blips (5xx, 429, dropped connection, malformed response body) are retried silently with backoff by `retryAsync` over the chat-call step and do **not** consume a repair attempt; their exhaustion also returns `[]`, but without spending the repair budget. The chat-call retry layer is owned by `retryAsync` (the same helper `retryExtractor` and `validateExtractor` compose), with default `maxRetries: 2` equivalent to three attempts.

**The model never sees the cap.** The directive template carries a fixed phrase ("There is no cap on the number of operations") and a regex asserts on it directly — not on a number — because a real schema's enum members contain numerals and would false-positive a substring check. The cap is the chat transport's and `schemaExtractor`'s downstream concern, not the proposer's.

**Cancellation and deadline are forwarded into each chat call.** The proposer spreads the caller's options bag whole — same discipline `schema-retry.ts` and `gap-fill.ts` follow — and the test pins signal AND deadline reaching both the initial attempt and any repair.

## Consequences

**A `[]` result has to be defensible.** Producing an empty shape does not "look like" a model failure from the host's perspective — the artifact's `mapping.provenance`, `requiredOnCreate`, etc. are all valid; only the operations set is empty. A host that wants to surface the failure has to wrap `proposeShapeOperations` and check the operations array. The domain meaning is "unshaped derivation" rather than "no model help yet" — a real distinction worth naming.

**The "schedule a model by hand" alternative is now mostly absent.** A host that wants the multi-turn loop can build one on top of the proposer — the inner seam is `proposeShapeOperations + deriveExtractionShape`, and a third iteration on top is `Extractor`‑shaped. But the policy lives here, in one file, and the multi-turn design would have to argue with the existing pinned behaviour, not against a void.

**The operations are a closed SET, but the model can propose any combination.** `ShapeOperation`'s discriminated union is the wire-level contract; `proposedOperationsSchema` mirrors it. Widening the set in one widens it in the other, and the wave's decision to keep the set closed (no `markCollection`, no union beyond `string→number`) is unchanged.

**Repair text is the applier's own error message verbatim.** The composability check is `deriveExtractionShape` itself, so the refusal text a repair turn sends back is whatever the applier already names — a `drop` that names `"vessel.typoLeaf"` is met with the same precise path-named refusal a hand-written operation meeting would parse on. No special-purpose error formatter was introduced.

**The closed overlap means a Stage 1 invariant covers the proposed path.** Whatever is true of a hand-written operation set (assertions, refusals, post-conditions) is also true of a proposed one: nothing has a second code path, nothing bypasses `assertShapeMapping`, and the property tests in `shape-properties.test.ts` already cover proposed shapes by construction. The `proposeShapeOperations` tests pin this in `proposer — the closed overlap with deriveExtractionShape`.
