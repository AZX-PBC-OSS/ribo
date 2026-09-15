# Per-Group Composition

[Schema at Scale](/guide/schema-at-scale) ends with a schema partitioned into groups, one call each.
The preset that runs those calls — `perGroupExtractor` — treats every group alike: one model, one
strategy, and nothing per-group beyond the instructions text it can vary. Real schemas are not
uniform like that. One group keeps failing schema validation and needs a second look; another is a
wide table a cheaper model handles fine; a third would benefit from a focused second pass over the
leaves it got wrong rather than a blind re-roll. This page answers the question those cases pose:
**twenty groups, and one of them needs different treatment — what do you do?**

The answer is not an options bag on the preset with twenty dials. It is composition: the preset is
two public steps, and you intervene between them.

## The plan is public, not internal

`perGroupPlan` returns the exhaustive per-key map of default entries the preset would run — a
`singleShotExtractor` per group — **plus the projected targets those entries were built from**:

```ts
import { groupedExtractor } from "@azx/ribo-core";
import { perGroupPlan } from "@azx/ribo-extractor-openai";

const plan = perGroupPlan({ target, chat, model });
// plan.groups  — the exhaustive per-key map of default entries
// plan.targets — the projected targets those entries were built from, key for key

// The preset itself is this line and nothing more:
const preset = groupedExtractor({ target, groups: plan.groups });
```

Both maps are plain values: a host can read them, log them, assert on them in a test, and spread
them. A grouped schema yields the per-key arm of the map, and a test can enumerate it directly —
`Object.keys(plan.groups)` names the groups the preset will run, including each partitioned piece's
shared key. (The map type is a union whose other arm, keyed `""`, is the non-grouped fallback
described below; narrowing on `""` discards it for a grouped schema.)

`perGroupExtractor` is nothing more than `groupedExtractor` over `plan.groups` — the preset exists
so the common case stays one call, not because the plan is hidden. Exporting it is the whole
mechanism: if building the map were internal, "the defaults everywhere except one group" would mean
reconstructing the other nineteen entries by hand; nobody would, and per-group capability would go
unused.

## One group, different treatment: `overrideGroups`

`overrideGroups(plan, overrides)` applies the defaults everywhere except the keys you name, and
returns the **full** map — untouched keys are reference-equal to the plan's, so the result goes
straight into `groupedExtractor`'s `groups`:

```ts
import { groupedExtractor } from "@azx/ribo-core";
import { perGroupPlan, overrideGroups, schemaRetryExtractor } from "@azx/ribo-extractor-openai";

const plan = perGroupPlan({ target, chat, model });

const extractor = groupedExtractor({
  target,
  groups: overrideGroups(plan, {
    // The health-and-safety group misses its schema often enough that a blind
    // re-roll wastes a whole entry; telling the model WHAT failed fixes it cheaply.
    health: (entry, groupTarget) =>
      schemaRetryExtractor({ base: entry, target: groupTarget, chat, model }),
  }),
});
```

An override function receives the group's default `entry`, the `target` it was projected from, and
the piece `index`, and its return replaces that piece. Wrapping is the common shape — the default
entry stays, and a combinator sits around it — but nothing forces that: a replacement that ignores
`entry` and builds from `target` swaps the strategy outright.

`overrideGroups` also checks its keys: an override the plan doesn't carry is a compile error for a
TypeScript caller (the overrides object is keyed by the schema's own top-level keys) and a
construction-time throw naming the key for a JS caller. The construction-time coverage check in
`groupedExtractor` below is the second net.

## The override runs per piece

A group whose leaves exceed the nullable-union cap is **partitioned** — split into several calls
that share one top-level key, so the response still lands under one property
([Schema at Scale](/guide/schema-at-scale) explains why; the Snugg Pro `health` group is exactly
such a one). An override that silently applied to only the first piece would be worse than none:
the second piece would go out on the default path, and the group's treatment would depend on how it
happened to partition.

So the override function is applied **per piece**. Its `entry` is that piece's default extractor,
its `target` that piece's projected target — already narrowed to exactly the leaves the piece asks
for — and `index` the piece's position within the group. A wrapper maps over the pieces naturally;
a replacement that maps over `target` keeps the partitioning intact. A partitioned group's
`plan.targets[key]` is an array, index-aligned with its pieces, so an override can tell which piece
it is looking at.

```ts
overrideGroups(plan, {
  health: (entry, pieceTarget, index) =>
    schemaRetryExtractor({ base: entry, target: pieceTarget, chat, model }),
});
// runs twice for a two-piece health group — each piece wrapped, each narrowed
// to its own leaves
```

## What the combinator owns

`groupedExtractor` (`@azx/ribo-core`) is the run-owner inside which every one of these entries runs.
It owns the work that is genuinely cross-group, so no override has to re-implement any of it:

- **Coverage, checked at construction.** Every top-level key of `target.extractionSchema` must be
  named in `groups`, and no key outside it may be — a missing group would otherwise surface as a
  second-parse failure after every call has been paid for.
- **Scheduling.** A bounded pool (default concurrency 4) over the flattened entries, a partitioned
  group's pieces among them.
- **Retry.** The unit of retry is the group entry's `extract()` — so a wrapper inside a retried
  group is retried with it — with jittered backoff up to a budget derived from the entry count.
  `TerminalQueueError` is never retried.
- **Sibling abort.** One group's terminal failure aborts the run: in-flight siblings are cancelled
  and no further entry starts. The caller's own `signal` is combined with that controller, not
  replaced by it.
- **The second trust-boundary parse.** Each entry parses its own response against its piece schema;
  the merged whole is then parsed against the full `extractionSchema`. The second parse is not
  redundant — it catches a merge that produced a shape no single entry would have.
- **One `normalize`, summed usage.** The model-free normalize pass runs once on the merged result;
  `usage.calls` sums what the entries reported.

Progress is reported through the same `onUnit` hook as every other strategy, as one `GroupUnit` per
entry carrying `key`, `part`, `parts`, and `attempt` — a partitioned group's pieces report
`part: 1, parts: 2`, and a consumer does not need two code paths for "one" and "several".

## Hand composition: `projectTarget`

Plan-then-override covers "the defaults, except." The layer underneath is public too, for a host
that wants to compose the map by hand. `projectTarget(target, key, options)` narrows a full target
to one group: the schema becomes the one-key strict object the model is constrained to, the few-shot
examples are projected to that key, and `options.instructions` replaces the instructions when the
group needs its own:

```ts
import { projectTarget, singleShotExtractor } from "@azx/ribo-extractor-openai";

const hvacTarget = projectTarget(target, "hvac", {
  instructions: "Extract HVAC systems. A house may have several.",
});

const hvacEntry = singleShotExtractor({ target: hvacTarget, chat, model });
```

`options.leafKeys` and `options.singleton` reproduce a partitioned piece's narrowing — the same
shapes `perGroupPlan` builds — and a projected target can be handed to _any_ strategy: a
`gapFillExtractor`, a `schemaRetryExtractor`, or one you wrote. It is also the tool you use to build
a replacement from inside an override without touching the other nineteen groups.

Two edges of the map are worth knowing. A group entry can be an **ordered list** of extractors —
that is what a partitioned group is — and a map whose only key is `""` declares the
**non-grouped fallback**: one entry covering the whole schema, the shape the preset yields when the
target isn't an object of groups. The fallback cannot be combined with per-key entries; either the
schema has groups or it doesn't.

## Next

[Arbitration & Fallback](/guide/arbitration) covers composing whole extractors — this page's map
included — into ladders and races. [Provenance](/guide/provenance) covers the granularity knob that
decides how expensive each of these calls is, and [Review](/guide/review) picks up once the merged
result lands.
