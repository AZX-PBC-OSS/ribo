---
"@azx/ribo-core": minor
---

The review's link decision now reaches `adapter.write` through an optional
`WriteMetadata.linkTarget` — the uuid of the existing record a human linked the instance to at
review, to be updated rather than created. A missing or `null` decision means create, and the
member is omitted rather than passed as `undefined`.

`toInstanceWriteStep` reads the persisted `linkTargets` off the review outcome, aligned by
position with the same per-group array it already walks for `instanceKeys`, and passes each
instance's decision beside that instance's idempotency key. This is plumbing, not a behaviour
change: no shipped adapter honours the member yet, because Snugg Pro egress is not implemented
(gated on the Helix platform ask), so nothing is written differently today — and no adapter that
ignores the member breaks, because it is optional. The flip side of that optionality is on
adapters: one that supports updates but ignores `linkTarget` will silently create duplicates
once a host starts linking, so honouring it is a contract obligation the type cannot enforce.
