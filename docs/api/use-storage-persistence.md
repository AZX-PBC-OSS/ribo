# useStoragePersistence

`useStoragePersistence` reads the browser's storage-persistence grant and quota estimate into
React state, and asks for the grant on demand. It is the one hook in the package with no core
counterpart: it wraps `navigator.storage` directly and reads nothing from context.

## When to reach for it

Reach for it in a React host that shows or requests a persistence grant — usually through
[`useWorkSafety`](/api/use-work-safety), which consumes this hook to classify the verdict. Reach
for [Offline & Storage](/guide/offline-and-storage) for why the grant matters: an un-persisted
origin's storage can be evicted under pressure, taking captured dictations with it.

**Offline-first pointer:** the durability story this hook plugs into — what persists, what gets
evicted, and how the grant interacts with the relay — is [Offline & Storage](/guide/offline-and-storage);
the [offline-first](/offline-first/) section covers the serving and eviction machinery behind it.

## Usage

Type-checked only — calling the hook needs React's renderer and `navigator.storage`, so this
example is compiled but never executed; its runtime behaviour is covered by the package's own
browser tests.

<<< @/api/examples/use-storage-persistence.tsx#usage

## Options

`useStoragePersistence()` takes no options — there is nothing to override. It reads one global
resource (this origin's storage grant) through one module-level store, not context: a grant is a
property of the origin, not of a component, so every caller subscribes to the **same** snapshot
and a `request()` from one component is visible to every other immediately.

Source: `packages/ribo-ui-react/src/use-storage-persistence.ts`.

## Return value

A `UseStoragePersistenceResult`:

- `persistence` — `"granted"`, `"denied"`, `"unsupported"`, or `"unknown"`. Two distinctions are
  load-bearing: `unsupported` (no Storage API to ask) is not `unknown` (still asking), and
  **`denied` means refused, not "not yet granted"** — `persisted() === false` also describes an
  origin nobody has asked, so only a `persist()` call that resolved `false` reports `denied`.
- `estimate` — the browser's `StorageEstimate`, or `undefined` until one is read.
- `request()` — asks for the grant and resolves to the resulting state. A `persist()` that
  **throws** is not a refusal: it resolves to the best already-known state instead of
  publishing a manufactured `"denied"`. Concurrent calls are ordered so the most recently
  invoked one's result wins, whichever settles first (React StrictMode runs mount effects
  twice; without that ordering, timing could downgrade a real grant).
- `refresh()` — re-reads the grant and the estimate. A transient read failure never erases the
  last known value, and it never overrides an in-flight `request()`'s answer.

## Errors

Nothing throws. A missing Storage API reports `unsupported`; a thrown `persisted()`/`persist()`/
`estimate()` leaves the previously known value standing — a failed read is not an answer, and
publishing one would overwrite a known-good grant.

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/use-storage-persistence.tsx

## Related APIs

- [`useWorkSafety`](/api/use-work-safety) — the consumer: it composes this hook into the
  "is my work safe?" verdict.
- [`createConnectivity`](/api/connectivity) — the other ambient input the verdict reads.

## Guides that use it

- [React Hooks](/guide/react) — where the persistence panel sits in the wiring.
- [Offline & Storage](/guide/offline-and-storage) — the durability model the grant protects.

## Reference

- [`useStoragePersistence`](/reference/@azx/ribo-ui-react/functions/useStoragePersistence.html)
- [`UseStoragePersistenceResult`](/reference/@azx/ribo-ui-react/interfaces/UseStoragePersistenceResult.html)
- [`StoragePersistence`](/reference/@azx/ribo-core/type-aliases/StoragePersistence.html)
