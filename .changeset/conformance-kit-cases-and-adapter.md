---
"@azx/ribo-core": minor
---

**The conformance kit is split into cases and a runner adapter.** `@azx/ribo-core/testing` gains `defineStorageConformanceCases(subject, expect)` — the suite as a list of named `ConformanceCase` objects, each with a `run`, containing no runner vocabulary at all — and `registerStorageConformanceCases(label, cases, runner)`, the thin `describe`/`it` adapter that registers them. `runStorageConformance` keeps its signature and composes the two, so existing call sites are unchanged; the case bodies are moved verbatim.

A third party writing a backend can now map the case list onto any runner in a few lines, or run a single case directly from a debug script with no runner in the process. The case bodies' assertions are unchanged — `expect` stays injected, and the bespoke thrown errors stay.
