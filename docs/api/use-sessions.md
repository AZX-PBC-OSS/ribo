# useSessions

`useSessions` is the session collection as live React state — the session-collection mirror of
[`useCaptures`](/api/use-captures): a `SessionQuery` in, `{ items, loading, error }` out.

## When to reach for it

Reach for it in a React host that renders sessions — open sessions, ones awaiting review. Reach
for [Sessions](/guide/sessions) for the session state machine itself (`open → extracting →
awaiting-review → writing → done`, the resting `failed`, the terminal `dead`), and the
[React Hooks guide](/guide/react) for the provider wiring around it.

## Usage

Type-checked only — calling the hook needs React's renderer, so this example is compiled but
never executed; its runtime behaviour is covered by the package's own browser tests.

<<< @/api/examples/use-sessions.tsx#usage

## Options

`useSessions(query?, storage?)` takes the storage's own `SessionQuery` plus an optional
`Storage` override.

| Name      | Type           | Default                             | What it does                                                                                                                                                                                              |
| --------- | -------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`   | `SessionQuery` | `{}` — everything in the collection | Status (one value or an array), exact `ref`, `limit`. Compared **by value**, not identity — the same serialised-key memoisation `useCaptures` uses, so a fresh literal every render does not resubscribe. |
| `storage` | `Storage`      | the provider's                      | Override the storage for a subtree, or inject one in a test without a provider.                                                                                                                           |

The defaults live in the hook's source, not in an exported constant, so no example asserts them.

Source: `packages/ribo-ui-react/src/use-sessions.ts`; the query-key serialisation from
`packages/ribo-ui-react/src/query-key.ts`.

## Return value

A `UseSessionsResult`:

- `items` — the matching `SessionItem`s, latest emission from `storage.sessions.watch(query)`.
- `loading` — no emission has arrived yet; distinct from an empty session list, for the same
  reason `useCaptures`' is.
- `error` — the subscription's failure, or a synchronous throw from `watch()` itself, normalised
  to an `Error` and cleared when the next subscription starts.

## Errors

Nothing is thrown out of render except the missing-instance case (no `storage` on the provider
and none passed — the error names the fix). Storage and query failures land in `error` state.

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/use-sessions.tsx

## Related APIs

- [`useCaptures`](/api/use-captures) — the capture-collection mirror of this hook, same design.
- [`CaptureSession`](/api/capture-session) — the recording lifecycle inside one session.
- [`RiboProvider`](/api/ribo-provider) — where the default `Storage` comes from.

## Guides that use it

- [React Hooks](/guide/react) — the session views this hook feeds.
- [Sessions](/guide/sessions) — the state machine the watched rows move through.

## Reference

- [`useSessions`](/reference/@azx/ribo-ui-react/functions/useSessions.html)
- [`UseSessionsResult`](/reference/@azx/ribo-ui-react/interfaces/UseSessionsResult.html)
- [`SessionQuery`](/reference/@azx/ribo-core/interfaces/SessionQuery.html) ·
  [`SessionItem`](/reference/@azx/ribo-core/type-aliases/SessionItem.html)
