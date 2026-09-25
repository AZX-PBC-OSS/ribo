---
"@azx/ribo-adapter-snuggpro": minor
"@azx/ribo-core": minor
---

Bring the inventory roster under the structured-output route's depth cap.

The route rejected `rosterSchema` on every inventory pass (`nest <= 12
levels`), and because a 400 is terminal the caller fell through to the next
tier without an error. `distinguishedBy` is now a plain string: a group's
first candidate carries `""` rather than `null`, and every later candidate
still needs a non-empty span. Roster fixtures using `null` must change to
`""`.

`serializedNestingDepth` (`@azx/ribo-extractor-openai`) now counts depth
the way the route does: raw JSON nesting, with `anyOf` arms and array indices
as levels, probed against the live route (12 passes, 13 is rejected). It used
to count only `properties` descents, which reported the rejected roster as
shallower than every accepted piece, so every depth guard built on it was
vacuous. Its numbers are larger in the new unit, and `describeExtraction`'s
reported depths change with it. The roster and every partitioned per-group
piece are asserted against `SCHEMA_NESTING_DEPTH_CAP` with it. See ADR 0025.
