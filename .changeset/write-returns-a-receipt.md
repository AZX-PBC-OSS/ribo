---
"@azx/ribo-core": major
"@azx/ribo-adapter-snuggpro": minor
---

`ToolAdapter.write` resolves with `{ receipt }`, not `{ uuid }`

`uuid` was a host tool's word for its own identifiers sitting in a tool-agnostic
contract. Core already models a receipt as an opaque string everywhere it
persists one — `receipts`, `recordReceipt`, `mergeReceipts` — and only the write
contract named it after Snugg Pro's response field.

The name also made honest adapters lie. A Snugg Pro singleton endpoint returns
no identifier at all, so its adapter synthesises one, and returning
`singleton:basedata:588613` from something typed `uuid` needed a comment
apologising for itself. When a type forces you to document that its values are
not what it is called, the type is wrong.

Migration: destructure `receipt` instead of `uuid` from `write`'s result. The
value is unchanged, and core still never parses it.
