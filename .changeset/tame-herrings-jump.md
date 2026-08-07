---
"@azx/ribo-core": minor
---

Export `stripOptionalNullable`.

The one primitive a review UI needs to render an editor off a `ReviewField.schema` and could not
otherwise get without reaching into `/src/...`: stripping a patch leaf's `.optional()`/`.nullable()`
wrappers to find its real kind. `enveloped()` and `buildReviewRequest` already used this internally;
it is now public so a UI does not have to re-implement the same walk against zod's raw API and risk
disagreeing with core about what counts as a wrapper.
