---
"@azx/ribo-cli": minor
---

Add `ribo eval --plan` with shared reviewed-plan loading, early freshness and construction
refusals, and runner-derived plan identity in version-1 records. Planned spend now uses core's
cap-sensitive dry-run call counts and actual projected prompts, compare enforces planned identity,
and the accuracy page displays that identity without changing ordinary eval startup or comparison
axes.
