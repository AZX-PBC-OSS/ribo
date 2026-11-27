---
"@azx/ribo-cli": patch
---

The spend estimate's retry multiplier names `--max-retries` and shows the sum it came from
(`retries ×3 (1 + --max-retries 2)`), the `--max-retries` option help states its default and that
the estimate multiplies by one plus it, and the spend doc's Retries bullet names the flag and
default and notes the multiplier overcounts for single-shot rungs in the safe direction.
