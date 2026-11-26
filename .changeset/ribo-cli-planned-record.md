---
"@azx/ribo-cli": minor
---

Persist runner-issued semantic plan fingerprints in planned eval settings while keeping run records
at contract version 1. Caller settings omit the runner-owned member, strict record reads enforce
planned identity without changing existing non-planned records, and planned execution refuses
before any model call until its execution path is available.
