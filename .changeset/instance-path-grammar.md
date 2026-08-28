---
"@azx/ribo-core": minor
---

Add a shared field-path grammar with bracketed instance keys.

`field-path.ts` now exposes one builder (`buildFieldPath`) and one parser
(`parseFieldPath`) that share a single grammar. Paths are sequences of segments:
object keys joined by `.` and instance keys wrapped in `[...]`. The two segment
kinds are distinct at the type level (`FieldPathSegment`), so `resolveReview` cannot
silently treat `hvac[k3].hvacDuctLeakage` as an object key named `hvac[k3]`.

`childPath` keeps its existing object-key guard and now also rejects `[` in field
names, for the same reason it rejects `.`: a key that can impersonate a path
segment would address the wrong leaf. Integer-like keys are still rejected for
both object keys and instance keys, because array-index-shaped strings are hoisted
in JavaScript property order and would silently reorder a review card.

Round-tripping is guaranteed: build → parse → build yields the identical string.
This is the foundation for Task 6 (review enumerates instances from data) and
Task 7 (`resolveReview` reassembles arrays with a key → position remap).
