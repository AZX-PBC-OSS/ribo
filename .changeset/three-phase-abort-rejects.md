---
"@azx/ribo-extractor-ondevice": minor
---

An aborted `threePhaseExtractor` run now rejects instead of resolving with
all-null fields. The abort's throw used to be swallowed by the group-level
catch, which nulls a failed group's leaves and moves on — right for an
extraction failure, and indistinguishable-from-nothing for a cancellation.

The catch now tells the two apart (`isCancellation`: the caller's signal fired,
or the transport rejected with `ChatError.aborted`) and rethrows a
cancellation. Every retry loop (phases 0 and 1, bare classify, wrapped
classify) also checks the signal before starting an attempt, so an aborted run
neither makes nor counts phantom retries — `usage.calls` no longer inflates.
