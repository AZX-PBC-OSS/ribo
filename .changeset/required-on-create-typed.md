---
"@azx/ribo-core": major
"@azx/ribo-adapter-snuggpro": patch
---

`RequiredOnCreate` is typed against the adapter's value schema instead of being
`Record<string, readonly string[]>`, so a typo in a group or leaf name is a compile error rather
than a declaration that silently marks nothing.

Leaf names resolve against the group's own shape: a collection group's element type, a singleton
group's own keys, and for a top-level leaf the group key itself.

`RequiredOnCreateMap` is the loose runtime shape kept for `review.ts`, which walks the schema
before it has a `V` to check against.
