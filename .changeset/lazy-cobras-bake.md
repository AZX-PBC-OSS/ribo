---
"@azx/ribo-core": patch
---

Export `BuildReviewRequestOptions` from the package barrel.

`buildReviewRequest` (its second parameter's type) was public, but the options type
itself was not re-exported from `./index.js` — an external caller could call the
function but could not name the type of what it was passing in.
