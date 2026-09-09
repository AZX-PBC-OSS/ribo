---
"@azx/ribo-core": minor
---

Export `joinSessionTranscript` from the queue barrel. It joins every
transcribed recording belonging to a session, in capture order, excluding
discarded/dead ones — `createRelay` already used it internally to build the
extractor's input text, but a host had no public way to assemble that same
combined transcript for its own purposes (e.g. showing a reviewer the full
dictation behind a session). No behavior change: same function, now reachable
without reaching past the package's own exports.
