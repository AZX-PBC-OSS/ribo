---
"@azx/ribo-cli": minor
---

The schema-inspect report contract is v5: every nullable call count carries the reason it is null, present exactly when the count is null, and a non-null count carries none. The single-shot reason is rendered from core's single-shot exclusions with the measured value and limit; the presence-narrowed reason is stated beside the missing bound and the spend guard reads it from the report; the human rendering prints `not selected — ` for single-shot and `unavailable — ` plus the reason for the rest.
