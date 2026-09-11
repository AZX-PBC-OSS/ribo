---
"@azx/ribo-core": patch
---

Decode HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, and numeric forms) inside `spanGroundedness`'s near-miss normalizer. This prevents entity-only differences between a source span and the transcript from being classified as `ungrounded`. The verbatim `isSpanGrounded` tier is unchanged.
