# 0025. A roster candidate's absent span is an empty string, not null

Status: Accepted
Date: 2026-09-22

## Context

The structured-output route rejects a response schema that `nest[s]` more than 12 levels, with a
400 naming the cap. `@azx/ribo-adapter-snuggpro`'s inventory roster was rejected on every attempt.
A 400 is terminal, so `terminalFallsThrough` dropped the caller to the next tier: a host using
`scopedInstanceExtractor` never got the inventory pass, and no error surfaced.

Nothing caught it because nothing measured depth in the route's units. `serializedNestingDepth` in
`@azx/ribo-extractor-openai`, and the adapter's cap suite built on it, counted only `properties`
descents, which is OpenAI's documented limit. By that count the roster is 2 levels deep and every
per-group piece is 3. **The measure and the thing it measured were wrong in the same direction:** it
ranked the one schema the route rejects as shallower than every schema it accepts. That is why two
guards and two test suites stayed green over a schema the route rejected on every attempt. Probing the live route with synthetic
schemas settled what it actually counts: **raw JSON nesting of the serialized document**, a scalar
counting as 1. A flat one-property schema was rejected for a nested array inside an `enum` value.
Depth 12 passes and 13 is rejected. In those units the roster measured 13, and the partitioned
per-group pieces measure exactly 12.

Every `.nullable()` renders as `anyOf: [{…}, {type: "null"}]` and costs two levels. The roster's
deepest path stacked three unions: the group (candidates, or `{ stated: "none" }`), the candidate
(current, or excluded with a span), and `distinguishedBy: z.string().nullable()`.

Splitting the roster into smaller calls would not help, because depth is per path, not cumulative.

## Decision

**`distinguishedBy` is a plain string, and `""` means "no separating span".** A group's first
candidate carries `""`. The group refinement requires every later candidate's span to be
non-empty, the same invariant `null` used to express. The instructions tell the model to emit
`""`, and the scoped-fill prompt treats `""` as "first instance".

This takes the roster from 13 to 12. It was the smallest change that kept both unions. The
alternatives each gave something up:

- Collapsing the candidate union into one object with a nullable `eligibilitySpan` also saves two
  levels. But "an excluded candidate must quote its exclusion" would then hold only in a
  post-parse refinement, and constrained decoding would stop enforcing it.
- Restructuring the group union into an object with a candidates array and a nullable
  `statedNone` swaps two `anyOf` levels for two `properties` levels and saves nothing.

**`serializedNestingDepth` counts in the route's units.** It now measures raw JSON nesting, and a
test pins it to the probed verdicts. The library still carries no provider's cap (ADR 0015): the
adapter's `SCHEMA_NESTING_DEPTH_CAP` is compared against it, and the roster and every partitioned
per-group piece are asserted under that cap. `describeExtraction` reports depth through the same
function, so its numbers change unit with it.

## Consequences

- A live probe on 2026-09-22 confirmed the verdicts: the old roster gets the depth 400, the new one
  returns 200. With the real instructions, the model emitted `""` for each group's first candidate
  and a verbatim span for the second.
- `""` is a substring of every transcript, so any span-grounding check must treat it as "absent",
  never as a grounded quote.
- **Nothing emitted here has headroom.** The roster's deepest path is now the excluded variant's
  `eligibility` enum values, at 12. The per-group pieces are also at 12. One more nullable on any
  of those paths fails the build, and the fix is structural, not a cap bump. Do not reintroduce
  `.nullable()` on `distinguishedBy` to make the schema read more naturally. That is exactly the
  change the depth test exists to stop.
- A consumer holding roster fixtures with `distinguishedBy: null` must change them to `""`.
