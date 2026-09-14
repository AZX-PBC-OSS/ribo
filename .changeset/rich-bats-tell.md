---
"@azx/ribo-core": major
"@azx/ribo-ui-react": major
---

Type `buildReviewRequest`'s `provenance` option against the values schema and validate it at runtime.

- `BuildReviewRequestOptions` and `useReview` are now generic over `valuesSchema`, so an unknown group key in `provenance` is a compile error.
- A JavaScript caller passing an unknown group key now gets the same `validateProvenance` error that `enveloped()` throws.
