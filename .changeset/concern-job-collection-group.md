---
"@azx/ribo-adapter-snuggpro": minor
---

Adds `concern` — the first job-collection resource beyond `basedata`'s own sub-resources (doc 20 §5.7) — as a new per-instance array group, carrying both of the endpoint's fields (`concernSummary`, `concernDetail`). Instance identity rides the roster's discriminator mechanism, keyed on the concern's subject rather than a natural name field.
