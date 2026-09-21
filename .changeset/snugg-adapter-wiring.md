---
"@azx/ribo-adapter-snuggpro": minor
---

Wire the Snugg Pro HTTP writer into the adapter. `createSnuggProAdapter({ fetchImpl })`
returns a `ToolAdapter` whose `write` really writes: it bridges the whole patch to the
per-group writer (`write/writer.ts`), writing every group in the schema's order and
each collection group instance by instance. One record written resolves with its real
receipt (a vendor uuid for a collection); more than one resolves with the synthetic
`assessment:{assessmentId}`, which is not recoverable into the individual receipts —
that is why `toInstanceWriteStep`, one call per instance, is the supported composition.
An empty patch throws: it is a programming error, not a no-op.

The `stage` and `incentive` groups are refused with a `TerminalError` naming the group
and why, checked before any request so a mixed patch cannot half-write: `stage` would
move a real customer's workflow stage on a dictated sentence (an integer vocabulary
that exists only in the vendor spec's prose), and `incentive`'s create needs a template
uuid that is still captured as the spoken rebate name. Both keep extracting and
reviewing; only the write is refused.

`snuggProAdapter` stays exported as the factory called with no transport: everything
but `write` works off it, and `write` now rejects with a message naming
`createSnuggProAdapter({ fetchImpl })` as the fix. `readExistingRecords` is async and
reads the group's plural path through an injected `fetchImpl`, parsing the vendor JSON
with zod before it becomes `ExistingRecord`s for `rankCandidates` — the gateway signs,
so the read no longer belongs outside the SDK.
