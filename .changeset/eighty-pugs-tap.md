---
"@azx/ribo-ui-react": minor
---

The headless hook layer is real: six hooks and a provider over core's engine.

`RiboProvider` carries host-constructed instances (`recorder`, `outbox`, `connectivity`) through
context; every hook but one resolves its dependency through them, or through an explicit override
argument for tests and for a host that owns more than one instance. `useWorkSafety` is the exception:
it composes `useOutboxItems`, `useConnectivity` and `useStoragePersistence` internally and takes no
override of its own, so it can only be used under a `RiboProvider`. A missing instance **throws a
named error** rather than returning `undefined` — a hook that returned `undefined` here would surface
as a crash several frames away in a consumer's component, which is the worst version of this bug.

- `useRecorder` — capture, including the `pause`/`resume` Phase A added, plus a `scaledLevel` the
  hook owns because raw RMS for speech barely leaves the left edge of a meter and every consumer
  would otherwise invent its own curve.
- `useOutboxItems` — a live RxDB query with honest `loading` and `error` states.
- `useReview` — field-level review over flat dotted leaf paths, so a human can accept one leaf and
  correct its neighbour. `submit()` both throws and exposes per-leaf `errors`.
- `useConnectivity`, `useStoragePersistence` — the two ambient signals a field app needs.
- `useWorkSafety` — composes the above into "is it safe to wipe this device".

**Two properties worth knowing, because both are load-bearing and neither is obvious.**

`useSubscribed` (internal) adapts core's push sources to React state, and deliberately does **not**
use `useSyncExternalStore`. That hook requires a referentially stable snapshot, while `Recorder.state`
allocates a fresh object per read and recomputes `elapsedMs` from `performance.now()` — so it never
stabilizes and React re-renders forever. The accepted tradeoff is that this gives up tearing
protection under concurrent rendering; for a level meter and a connectivity badge a torn frame is not
observable. Its contract is that `subscribe` must be referentially stable (`useCallback` keyed on the
instance): an inline arrow loops forever, and a `[]`-keyed one silently keeps subscribing to the old
instance after a swap. Both halves are pinned by tests.

`useWorkSafety` reports `undefined` — never a default — while the outbox query is loading or has
errored. An empty outbox summarizes to `pending: 0`, which classifies as **safe**, so defaulting
would announce safety at exactly the moment the hook has failed to look. That is the same class of
bug Phase A fixed when un-reviewed recordings reported `pending: 0`, but worse, because it would
survive a total read failure.

Tested in real Chromium via `vitest-browser-react`, including under `<StrictMode>` — which the
playground renders in and the test harness does not enable by default.
