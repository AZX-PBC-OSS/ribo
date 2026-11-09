# useConnectivity

`useConnectivity` reads the current `ConnectivityState` — the three-state
`offline`/`probing`/`online` model, not `navigator.onLine` — as React state.

## When to reach for it

Reach for it in a React host rendering a status badge or gating an upload button. Reach for
[`createConnectivity`](/api/connectivity) for the model itself — its options, its probe, its
hysteresis — which this hook does not configure; reach for the
[Offline & Storage guide](/guide/offline-and-storage) for why a boolean was the wrong shape.

## Usage

Type-checked only — calling the hook needs React's renderer, so this example is compiled but
never executed; its runtime behaviour is covered by the package's own browser tests.

<<< @/api/examples/use-connectivity.tsx#usage

## Options

`useConnectivity(connectivity?)` takes one optional override and nothing else — **state only**.
`Connectivity.start()` and `stop()` bind and unbind the event source, and that is lifecycle,
which stays the host's: a model whose `start()` has never run sits at its initial state and
reports no transitions, which is the honest result rather than a hook quietly starting something
it does not own.

| Name           | Type           | Default        | What it does                                                                  |
| -------------- | -------------- | -------------- | ----------------------------------------------------------------------------- |
| `connectivity` | `Connectivity` | the provider's | Override the model for a subtree, or inject one in a test without a provider. |

Source: `packages/ribo-ui-react/src/use-connectivity.ts`.

## Return value

A `ConnectivityState` — `status` (`"offline" | "probing" | "online"`) plus the detail the state
carries. `probing` is the hysteresis made observable: the model is patient about success and
never about failure, and a renderer shows `probing` as "checking…".

One accepted wrinkle: if the `connectivity` argument itself changes between renders, the render
that receives the new instance paints the old instance's last value for one frame. Inherent to
the subscription primitive, and acceptable for a status badge.

## Errors

None. A missing instance throws (the error names `createConnectivity` and both ways to supply
it); the model's own probe failures resolve to `offline` inside the model and never reach this
hook as a throw.

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/use-connectivity.tsx

## Related APIs

- [`createConnectivity`](/api/connectivity) — the model: options, probe, hysteresis, and the
  work-safety classification built on it.
- [`useWorkSafety`](/api/use-work-safety) — the consumer that composes this hook with storage and
  persistence.
- [`RiboProvider`](/api/ribo-provider) — where the default model comes from.

## Guides that use it

- [React Hooks](/guide/react) — the badge and the gating this hook feeds.
- [Offline & Storage](/guide/offline-and-storage) — why the boolean was replaced, and how the
  model is wired to the queue.

## Reference

- [`useConnectivity`](/reference/@azx/ribo-ui-react/functions/useConnectivity.html)
- [`Connectivity`](/reference/@azx/ribo-core/interfaces/Connectivity.html) ·
  [`ConnectivityState`](/reference/@azx/ribo-core/interfaces/ConnectivityState.html) ·
  [`ConnectivityStatus`](/reference/@azx/ribo-core/type-aliases/ConnectivityStatus.html)
