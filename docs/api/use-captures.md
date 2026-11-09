# useCaptures

`useCaptures` is the capture queue as live React state: a `CaptureQuery` in, an observable
subscription to the storage out, held in state as `{ items, loading, error }`.

## When to reach for it

Reach for it in a React host that renders the queue — parked dictations, items awaiting their
session's review. Reach for [Sessions](/guide/sessions) for how the items got their statuses, and
the [React Hooks guide](/guide/react) for the provider wiring around it. Outside React, read
`storage.captures.watch` directly — this hook is a thin, carefully-defended wrapper over it.

## Usage

Type-checked only — calling the hook needs React's renderer, so this example is compiled but
never executed; its runtime behaviour is covered by the package's own browser tests.

<<< @/api/examples/use-captures.tsx#usage

## Options

`useCaptures(query?, storage?)` takes the storage's own `CaptureQuery` plus an optional
`Storage` override.

| Name      | Type           | Default                             | What it does                                                                                                                                                                                                                             |
| --------- | -------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`   | `CaptureQuery` | `{}` — everything in the collection | Status (one value or an array), `sessionId`, `limit`. Compared **by value**, not identity: a fresh object literal every render does not tear the subscription down, because the hook memoises on a canonical serialisation of the query. |
| `storage` | `Storage`      | the provider's                      | Override the storage for a subtree, or inject one in a test without a provider.                                                                                                                                                          |

The defaults live in the hook's source, not in an exported constant, so no example asserts them.

Source: `packages/ribo-ui-react/src/use-captures.ts`; the query-key serialisation from
`packages/ribo-ui-react/src/query-key.ts`.

## Return value

A `UseCapturesResult`:

- `items` — the matching captures, latest emission from `storage.captures.watch(query)`.
- `loading` — no emission has arrived yet. **Load-bearing, not cosmetic**: "reading the
  storage…" and "nothing in the queue" are different sentences, and conflating them flashes the
  empty state on every mount.
- `error` — the subscription's failure, or a synchronous throw from `watch()` itself (a
  malformed query, a closed collection), normalised to an `Error`. It is cleared when the next
  subscription starts, so it always describes the subscription it came from.

## Errors

Nothing is thrown out of render except the missing-instance case (the provider has no `storage`
and none was passed — the error names the fix). Storage and query failures land in `error` state:
a blank screen from an escaped effect-throw helps nobody, so the hook routes them to where a UI
can render them.

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/use-captures.tsx

## Related APIs

- [`useSessions`](/api/use-sessions) — the session-collection mirror of this hook, same design.
- [`useRecorder`](/api/use-recorder) — where the captures come from.
- [`RiboProvider`](/api/ribo-provider) — where the default `Storage` comes from.
- [`openStorage`](/api/open-storage) — the durability container behind it.

## Guides that use it

- [React Hooks](/guide/react) — the queue views this hook feeds.
- [Offline & Storage](/guide/offline-and-storage) — the durability model the watched collection
  lives in.

## Reference

- [`useCaptures`](/reference/@azx/ribo-ui-react/functions/useCaptures.html)
- [`UseCapturesResult`](/reference/@azx/ribo-ui-react/interfaces/UseCapturesResult.html)
- [`CaptureQuery`](/reference/@azx/ribo-core/interfaces/CaptureQuery.html) ·
  [`Capture`](/reference/@azx/ribo-core/type-aliases/Capture.html)
