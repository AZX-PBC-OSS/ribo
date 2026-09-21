---
"@azx/ribo-adapter-snuggpro": minor
---

Add `prunePersistedValues` — prune a persisted review outcome down to the keys
`snuggValuesSchema` still declares.

A field-set change strands sessions that are already stored: the write step parses
`reviewed` with the adapter's strict schema, so a persisted leaf the schema no longer
declares fails the parse, throws a `TerminalError`, and the relay marks the session
`dead` on the first attempt. `prunePersistedValues(outcome.fields)` returns a new
record holding only the keys the schema still declares — a top-level group key that
is no longer a group, and a leaf key a group's shape no longer declares, are dropped;
each element of a collection group is pruned individually, with array length and
order preserved. Every surviving value is passed through untouched, `null` included
(a `null` means "write this field empty", never "leave this out").

The keep-set is walked off `snuggValuesSchema` on every call rather than a hardcoded
list of removed names, so the function needs no edit when the field set moves again.

**Wiring is the host's** — the function is deliberately not called anywhere in the
workspace. Which leaves a group keeps is adapter knowledge, and
`@azx/ribo-storage-rxdb` must not depend on a sibling adapter package, so a host
runs it over a persisted session's `reviewOutcome.fields` once, before a write is
attempted.
