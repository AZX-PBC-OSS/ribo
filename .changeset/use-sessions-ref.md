---
"@azx/ribo-ui-react": patch
---

`useSessions` passes the whole query through, so `ref` actually filters.

`SessionQuery` gained `ref` when the session started owning what it is for, and `Outbox.watchSessions` honours it — but the hook dropped it. It built its memo key from a hand-listed set of fields (`status`, `limit`) and then rebuilt the query by parsing that key back, so the key was the sole definition of what a query is: anything not enumerated was discarded on the way to the outbox. `useSessions({ ref })` therefore returned every session on the device, and callers filtered client-side.

The key is now derived from the query rather than enumerated (`query-key.ts`), so a field added to `SessionQuery` is carried through on the day it is declared. `useOutboxItems` used the same pattern — correct today only because it happened to list all three of `OutboxQuery`'s fields — and moves to the same helper.

Keys are sorted, so the same query assembled in a different field order still memoises to one subscription rather than tearing it down and rebuilding it, and `undefined` values are dropped so an explicitly-absent field and an omitted one agree.
