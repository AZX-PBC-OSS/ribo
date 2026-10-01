---
"@azx/ribo-core": minor
---

**The shape proposer's repair loop now commits every operation that applies and resumes from that
committed state.** After each attempt that parses, a commit rule folds the attempt's operations into
a committed set: every operation that applies is committed and never re-sent, culprits a refusal
names are withheld with their refuser, and an operation identical to a committed one is ignored
before validation. A turn that leaves refusals — or fails outright — is answered with a fresh
resume request: the system prompt, the field list as the committed operations left it (tagged
`[dropped]`, `[retyped → number]`, `[moved → …]` on the original paths), and one line per refusal.
No assistant turn is echoed back, so each turn stays about the size of the first however large the
proposal. The model replies with a delta of new operations only.

No API change: `proposeShapeOperations` and `proposeExtractionShape` keep their signatures and
return types, and the public contract holds — the function never throws on a model's output, and
the returned list always derives with zero refusals.

Behaviour changes, honestly stated:

- **A model replying with only the fixes no longer loses the rest.** The old loop accepted a valid
  one-operation repair answer as the whole set and discarded the survivors — measured at 446
  applied operations lost on a 448-operation proposal. Committed operations survive every path;
  the reply is a delta on top of them.
- **Transport exhaustion returns the committed set**, not `[]` — `[]` only when nothing has
  committed yet. Exhaustion with refusals outstanding also returns the committed set rather than
  the final proposal's survivors.
- **A repair turn's prompt is a fresh request** (system, tagged field list, feedback), not a
  growing conversation; the proposal directive gains one paragraph describing the tags and the
  new-operations-only reply.
