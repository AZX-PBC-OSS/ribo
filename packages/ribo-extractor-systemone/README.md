# @azx/ribo-extractor-systemone

System One-backed extraction strategies for Ribo, over
[`@azx/ribo-systemone-managed`](../ribo-systemone-managed/README.md)'s client.

A System One model answers many independent typed questions about one text in a single request,
returning calibrated probabilities rather than prose. It has no primitive that fills a schema, so
it cannot replace an extractor — it sits in front of one and behind one.

## What's here

**`corroborateExtractor`** — the second judging combinator after `ribo-core`'s
`validateExtractor`, and the same shape: wrap an `Extractor`, take a census, hand it to a
synchronous policy, return the result by identity or throw a `TerminalError` so an arbitration
ladder falls through to the next rung. That makes an escalating cascade an ordinary ladder:

```ts
fallbackExtractor([corroborateExtractor(cheap, { target, client, policy }), expensive]);
```

It asks one `choice` per committed leaf — does the transcript `supports`, `contradicts`, or say
`says_nothing` about the value that was recorded — and the two failing verdicts stay
distinguishable on the census, because they invite different repairs. No consumer is required to
read that distinction.

**`rejectUncorroboratedCommitments(ratio)`** — the shipped policy. The ratio is **required and has
no default**: per-leaf scores are not stable enough to gate on individually, so the policy
thresholds the _share_ of committed leaves that failed, and no measurement yet justifies a
particular share. Choosing a policy and its ratio are imports, not flags.

**`systemOnePresencePhase`** — a sibling to `ribo-core`'s `presencePhase`, which asks one chat
call per group. This asks every leaf of every group in one request. Its threshold defaults
deliberately low, because a false negative is unrecoverable silent data loss while a false
positive costs one wasted item.

**`enumMembersAt`** — the schema walk both strategies need. A question that does not state a
leaf's enum members reads the schema's own encoding of what was said — a spoken duration recorded
as the band containing it — as a fabrication.

## Constraints worth knowing before you wire it up

- **Online only, and proxied.** The hosted System One endpoint sends no CORS headers for any
  origin, so a browser host must point the client at its own proxy. This is never the offline
  path.
- **Nothing here reaches a reviewer.** The judgement picks a processing rung; it does not annotate
  a review card. `docs/adr/0021-corroboration-is-a-judging-combinator-not-a-review-flag.md`
  records why, including the measurements that ruled the alternative out.
- **Provenance must be per-leaf.** `corroborateExtractor` refuses a `"row"` or `"none"` group at
  construction, like its sibling — the walk would otherwise count nothing while the result looked
  judged.

## Learn more

- [ADR 0020 — a package's second segment names an implementation](../../docs/adr/0020-a-packages-second-segment-names-an-implementation.md)
- [ADR 0021 — corroboration is a judging combinator](../../docs/adr/0021-corroboration-is-a-judging-combinator-not-a-review-flag.md)
- [Repo root](../../README.md)
