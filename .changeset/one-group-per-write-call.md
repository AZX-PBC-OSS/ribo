---
"@azx/ribo-core": major
"@azx/ribo-adapter-snuggpro": minor
---

`toInstanceWriteStep` sends one group per `write` call

It batched every singleton group into a single call, which pushed a fan-out into
the adapter: the adapter received a patch spanning several endpoints, issued a
request per group, then had to collapse N receipts into the one string `write`
returns. It could only do that by inventing a marker identifying none of them —
a receipt a retry cannot address any record with, so the duplicates it existed
to prevent happened anyway.

Now every call is one group, so every receipt is the real one for the record it
wrote, and the synthetic marker is gone.

No singleton receipt is recorded any more. Nothing read `receipts.singleton`,
and a singleton endpoint is an upsert addressed by the job — re-sending rewrites
the same record and cannot duplicate — so there was nothing for it to protect.
`toWriteStep`, which writes one patch in one call, still records one.

`snuggProAdapter.write` now refuses a patch carrying more than one record,
naming `toInstanceWriteStep` as the composition that does not produce one.
