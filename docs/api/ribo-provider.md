# RiboProvider

`RiboProvider` makes host-constructed engine instances — a `Recorder`, a `Storage`, a
`Connectivity`, a `CaptureCoordinator`, a `LiveTranscriber` — available to every hook in
`@azx/ribo-ui-react` through one context. It renders nothing but the subtree it is given; there
are no other components in the package.

## When to reach for it

Every React host wires one `RiboProvider` at the root, once. Reach for this page to look up what
goes in `value` and what the provider does with it; reach for the
[React Hooks guide](/guide/react) for the full wiring flow, and for
[Installation](/guide/installation) for the peer-dependency rationale — the host's instances and
`ribo-ui-react`'s hooks must resolve to **one copy of `@azx/ribo-core`**, or the objects stop
being `instanceof` what the hooks expect.

## Usage

Type-checked only — rendering needs React and the instances hold browser globals, so this example
is compiled but never executed; its runtime behaviour is covered by the package's own browser
tests.

<<< @/api/examples/ribo-provider.tsx#usage

The rule the provider is built around: **it carries instances; it never constructs them.**
Lifetime lives above React, with the host — StrictMode's double mount and Vite HMR would
otherwise pull an async `openStorage()` or a second microphone stream into the render tree, and a
consumer cannot fix that from inside the SDK.

## Options

`value` is the one prop that matters; `children` is the subtree. There are no defaults to quote —
both props are required, and `value` is passed through unchanged, **not memoized** (source:
`packages/ribo-ui-react/src/RiboProvider.tsx`). Hold the instances object in a stable place — a
module singleton, or `useMemo` in the host — rather than building it inline in render.

| Field of `value`     | Type                 | Required | What it does                                                                                                                                                       |
| -------------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recorder`           | `AnyRecorder`        | no       | The microphone capture engine. Required by `useRecorder` unless that hook is handed one directly.                                                                  |
| `storage`            | `Storage`            | no       | The durability container (`openStorage`). Required by `useRecorder` with its default `enqueue: true`, and by `useCaptures` and `useSessions`.                      |
| `connectivity`       | `Connectivity`       | no       | The three-state link model (`createConnectivity`). Required by `useConnectivity`.                                                                                  |
| `captureCoordinator` | `CaptureCoordinator` | no       | The shared handle `useRecorder` publishes the active capture session through and `useWorkSafety` reads capture health from. Built by `createCaptureCoordinator()`. |
| `liveTranscriber`    | `LiveTranscriber`    | no       | Optional live-preview engine. When supplied and ready, recording opens a live session whose segments land on the storage row's `preview` field.                    |

Every field is optional on purpose: a host using only capture must not be forced to open a
database. Each hook resolves the one field it needs and **throws if it is absent**, naming the
missing key and how to construct one.

## Return value

A React element wrapping `children` in the context. Nothing else — no refs, no imperative
handle.

## Errors

The provider itself throws nothing. The hooks under it throw when a needed instance is missing:
the error names the key, the constructor to call, and the two ways to supply it (via
`RiboProvider value` or as the hook's direct argument). An empty context — no provider at all —
fails identically to an empty provider, because the context's default is `{}`, not `undefined`.

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/ribo-provider.tsx

## Related APIs

- [`useRecorder`](/api/use-recorder), [`useCaptures`](/api/use-captures),
  [`useSessions`](/api/use-sessions), [`useConnectivity`](/api/use-connectivity) — the hooks that
  read `value`.
- [`createCaptureCoordinator`](/api/create-capture-coordinator) — the one instance the host
  builds from this package rather than core.
- [`openStorage`](/api/open-storage) — the durability container behind `value.storage`.
- [`createConnectivity`](/api/connectivity) — the model behind `value.connectivity`.

## Guides that use it

- [React Hooks](/guide/react) — the wiring flow this provider is step one of.

## Reference

- [`RiboProvider`](/reference/@azx/ribo-ui-react/functions/RiboProvider.html)
- [`RiboInstances`](/reference/@azx/ribo-ui-react/interfaces/RiboInstances.html)
- [`AnyRecorder`](/reference/@azx/ribo-ui-react/type-aliases/AnyRecorder.html)
