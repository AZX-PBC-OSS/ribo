---
"@azx/ribo-cli": patch
---

Adds the guarded case writer the corpus proposal and review work will build on:
`writeCaseExpected` edits an existing case.json's `expected` map and nothing else — every other
member and key order survives, the result must re-parse as a case, an add-only mode refuses to
change or drop an existing entry, and publication is a temp file then a rename, so a failed write
leaves the original bytes intact with no stray file.
