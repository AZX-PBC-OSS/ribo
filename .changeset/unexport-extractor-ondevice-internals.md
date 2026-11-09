---
"@azx/ribo-extractor-ondevice": minor
---

Remove `WHITESPACE_LOOP_THRESHOLD` and `isLoopingOutput` from the public barrel — loop detection is an implementation detail of the on-device extractor. If you relied on one, open an issue.
