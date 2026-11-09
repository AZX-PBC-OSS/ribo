# useWorkSafety

`useWorkSafety` is the one honest answer to "is my work safe?", composed for React: it reads the
storage through [`useCaptures`](/api/use-captures) and [`useSessions`](/api/use-sessions), the
persistence grant through [`useStoragePersistence`](/api/use-storage-persistence), and
connectivity through [`useConnectivity`](/api/use-connectivity), then runs core's
`summarizeWork` → `workSafety`.

## When to reach for it

Reach for it in a React host that must tell an auditor whether their unsynced work can be lost —
a banner, a pre-flight warning. Reach for [`createConnectivity`](/api/connectivity) for the
verdict's classification itself (the gradient with a hard edge), which this hook composes but
does not change.

## Usage

Type-checked only — calling the hook needs React's renderer, so this example is compiled but
never executed; its runtime behaviour is covered by the package's own browser tests and the e2e
suite.

<<< @/api/examples/use-work-safety.tsx#usage

## Options

`useWorkSafety()` takes no options — and deliberately **no override arguments**, unlike every
other hook in the package. It composes its three inputs internally rather than taking their
instances, so there is nothing for a caller to override; the consequence is that it can only be
used under a [`RiboProvider`](/api/ribo-provider), never bypassed the way a test can bypass the
others. Composition lives here, once, because "every presenter classifies identically" is the
whole reason the classification logic lives in core.

Source: `packages/ribo-ui-react/src/use-work-safety.ts`.

## Return value

A `UseWorkSafetyResult`:

- `safety` — the verdict, a `WorkSafety` discriminated union (`level`, `reason`, and the counts
  and details behind it). **`undefined` when it cannot be computed honestly** — while `loading`
  or after a storage read `error`. Never a benign default: `useCaptures` yields an empty array
  both before its first emission and after a watch failure, and an empty array classifies as
  `safe`/`nothing-captured` — so a defaulted verdict would announce the auditor's work is safe
  precisely when we have failed to look at it.
- `work` — the `WorkOnDevice` facts behind the verdict (`summarizeWork`'s output), or `undefined`
  on the same terms.
- `loading` / `error` — why there is no verdict, when there is none. Distinct from each other.
- Capture health, when a [`CaptureCoordinator`](/api/create-capture-coordinator) is on the
  provider, feeds the stalled-capture branch of the verdict; absent, it is simply not consulted.

## Errors

Nothing throws. A storage read failure lands in `error` — and takes the verdict with it, rather
than degrading to a guess.

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/use-work-safety.tsx

## Related APIs

- [`useStoragePersistence`](/api/use-storage-persistence) — the persistence grant input.
- [`useConnectivity`](/api/use-connectivity) — the link-state input.
- [`useCaptures`](/api/use-captures) · [`useSessions`](/api/use-sessions) — the storage inputs.
- [`createCaptureCoordinator`](/api/create-capture-coordinator) — the optional capture-health
  input.

## Guides that use it

- [React Hooks](/guide/react) — where the verdict is rendered.
- [Offline & Storage](/guide/offline-and-storage) — the durability model the verdict classifies.

## Reference

- [`useWorkSafety`](/reference/@azx/ribo-ui-react/functions/useWorkSafety.html)
- [`UseWorkSafetyResult`](/reference/@azx/ribo-ui-react/interfaces/UseWorkSafetyResult.html)
- [`workSafety`](/reference/@azx/ribo-core/functions/workSafety.html) ·
  [`summarizeWork`](/reference/@azx/ribo-core/functions/summarizeWork.html)
- [`WorkSafety`](/reference/@azx/ribo-core/type-aliases/WorkSafety.html) ·
  [`WorkOnDevice`](/reference/@azx/ribo-core/interfaces/WorkOnDevice.html)
