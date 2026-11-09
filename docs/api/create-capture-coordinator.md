# createCaptureCoordinator

`createCaptureCoordinator()` builds the shared handle through which
[`useRecorder`](/api/use-recorder) publishes the active capture session and
[`useWorkSafety`](/api/use-work-safety) reads its health.

## When to reach for it

It exists because a session created inside one hook cannot reach a sibling:
[`RiboProvider`](/api/ribo-provider) passes the host's instance object through unchanged and
deliberately constructs nothing, so mutating that object would notify nobody. Reach for it when
you want capture health in the work-safety verdict; absent a coordinator, `useWorkSafety` simply
does not consult capture health.

## Usage

Type-checked only — the coordinator bridges React rendering and a live capture session
(`MediaRecorder`, a microphone), so this example is compiled but never executed; its runtime
behaviour is covered by the package's own browser tests.

<<< @/api/examples/create-capture-coordinator.tsx#usage

## Options

`createCaptureCoordinator()` takes no options. **The host constructs it**, like every other
instance — the provider never creates one silently — and it is optional on
[`RiboProvider`](/api/ribo-provider)'s `value`: absent, there is no capture health and
`useWorkSafety` behaves as it does without it.

Source: `packages/ribo-ui-react/src/capture-coordinator.ts`.

## Return value

A `CaptureCoordinator`:

- `register(session)` — subscribes to the session's `health$` and makes it the active session;
  returns an unregister handle that ends the subscription, clears the active session and resets
  the health read. `useRecorder` calls this itself when it opens and closes a capture session —
  a host calls it only when driving a `CaptureSession` by hand.
- `active()` — the registered session, `undefined` between recordings.
- `health$` — the shared health stream, seeded with `undefined` and reset to `undefined` on
  unregister, so late subscribers never see a stale capture's health.

## Errors

None. Registering while a session is already active simply replaces it — the recorder owns one
capture at a time, and the stale registration's handle becomes a no-op cleanup.

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/create-capture-coordinator.tsx

## Related APIs

- [`useRecorder`](/api/use-recorder) — the producer: it registers the recorder's active session.
- [`useWorkSafety`](/api/use-work-safety) — the consumer: it reads `health$` into the verdict.
- [`RiboProvider`](/api/ribo-provider) — where the host hands the coordinator to the hooks.
- [`CaptureSession`](/api/capture-session) — the lifecycle whose health this coordinator carries.

## Guides that use it

- [React Hooks](/guide/react) — where the coordinator sits in the wiring.

## Reference

- [`createCaptureCoordinator`](/reference/@azx/ribo-ui-react/functions/createCaptureCoordinator.html)
- [`CaptureCoordinator`](/reference/@azx/ribo-ui-react/interfaces/CaptureCoordinator.html)
- [`CaptureHealth`](/reference/@azx/ribo-core/type-aliases/CaptureHealth.html)
