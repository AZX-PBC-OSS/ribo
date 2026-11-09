# createConnectivity and work safety

`createConnectivity(options)` builds the three-state connectivity model — `offline`, `probing`,
`online` — that replaces a lying `navigator.onLine` boolean with a probed, hysteretic answer.
`workSafety` and `summarizeWork` classify what is safe to lose: the one honest "is my work safe?"
answer, derived purely from state that already exists.

## When to reach for it

Reach for this page to look up the model's options and the verdict's shape. Reach for
[Offline & Storage](/guide/offline-and-storage) for why a boolean is the wrong shape here, and
the [React Hooks guide](/guide/react) for `useConnectivity` / `useWorkSafety`, the hooks that
read this model.

## Usage

Every ambient input is injected — the event source, the `navigator.onLine` reader, the probe, the
timer scheduler — which is what makes the model drivable with no network and no real clock:

<<< @/api/examples/connectivity.run.ts#usage

## Options

`createConnectivity(options)` takes `ConnectivityOptions`. The two timing defaults are exported
constants; the page quotes them from the example file rather than retyping, and the same file's
test run asserts the values the model arms (with the options omitted) against those exported
constants — so a source change that moves one fails the `test` stage:

<<< @/api/examples/connectivity.run.ts#defaults

| Name                | Type                      | Default                               | What it does                                                                                                                                                    |
| ------------------- | ------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindEvents`        | `ConnectivityEventBinder` | **required**                          | Source of raw online/offline transitions — handed one `onChange` callback, returns a cleanup. The field app wires this to `window`'s `online`/`offline` events. |
| `isOnline`          | `() => boolean`           | **required**                          | Reads link-layer state (`() => navigator.onLine`). `false` is trusted instantly; `true` is never trusted without a probe.                                       |
| `probe`             | `ConnectivityProbe`       | **required**                          | The reachability probe: resolve with an **ok** `Response` to report healthy; a non-ok response, a throw, or an abort all count as unreachable. Keep it cheap.   |
| `probeTimeoutMs`    | `number`                  | `DEFAULT_PROBE_TIMEOUT_MS` (above)    | Hard abort deadline for one probe — the number that makes an online-but-hanging endpoint resolve to `offline` fast.                                             |
| `stabilityWindowMs` | `number`                  | `DEFAULT_STABILITY_WINDOW_MS` (above) | The hysteresis: how long a probe must stay healthy before `online` is asserted. Going offline is instant; we are patient about success and never about failure. |
| `schedule`          | `ScheduleTimer`           | `setTimeout`/`clearTimeout`           | Timer seam, so tests inject a manual clock.                                                                                                                     |

`workSafety(work, persistence, connectivity, captureHealth?)` takes no options — it is a pure
classification. `summarizeWork(recordings, sessions?)` reduces the stores to the
[`WorkOnDevice`](/reference/@azx/ribo-core/interfaces/WorkOnDevice.html) facts the verdict reads.

Defaults are read from `packages/ribo-core/src/connectivity/connectivity.ts` and
`packages/ribo-core/src/connectivity/work-safety.ts`.

## Return value

`createConnectivity` returns a `Connectivity`: `state` (cheap, held), `subscribe` (immediate first
emission, then one per change, returning an unsubscribe handle), `start()` (idempotent — bind and
evaluate once) and `stop()` (unbind, cancel any in-flight probe and pending window, return to
`offline` — a stopped model is not measuring).

The model's three states are deliberate, and `probing` is not collapsible to a boolean: it is the
hysteresis made observable, and downstream renderers show it as "checking…".

`summarizeWork` returns `{ pending, dead, synced, awaitingReview, openSessions }` — sessions
drive `synced` (done) and the review/open counts; recordings in flight are pending work that has
not reached a session.

`workSafety` returns a discriminated union whose level is a gradient with a hard edge, in
precedence order:

- `{ level: "action-required", reason: "failed-permanently", dead }` — a dead item outranks
  everything; no amount of waiting fixes it.
- `{ level: "at-risk", reason: "not-persisted" | "capture-stalled", pending, persistence? }` —
  anything short of an outright `granted` persistence grant, or a stalled capture.
- `{ level: "protected", reason: "awaiting-sync" | "recording", pending, connectivity }` —
  on-device work, persisted, waiting to sync.
- `{ level: "safe", reason: "nothing-captured" | "all-synced" }` — no unsynced work on the device.
  **There is no path from on-device work to `safe`** — that is the type's own guarantee, not a
  discipline.

## Errors

None of these throw. An unwell probe (hang, throw, non-ok response, abort) resolves to
`offline` — that is the contract, and the probe timeout is what makes it total.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the timing defaults
quoted under Options.

<<< @/api/examples/connectivity.run.ts

## Related APIs

- [`createRelay`](/api/relay) — the consumer: it drains on the edge into `online`, never on the
  raw browser event.
- [`useConnectivity`](/api/use-connectivity) and [`useWorkSafety`](/api/use-work-safety) — the
  hook layer over this model.

## Guides that use it

- [Offline & Storage](/guide/offline-and-storage) — why the boolean was replaced, and how the
  model is wired to the queue.
- [React Hooks](/guide/react) — the hooks that read it.

## Reference

- [`createConnectivity`](/reference/@azx/ribo-core/functions/createConnectivity.html)
- [`Connectivity`](/reference/@azx/ribo-core/interfaces/Connectivity.html) ·
  [`ConnectivityOptions`](/reference/@azx/ribo-core/interfaces/ConnectivityOptions.html) ·
  [`ConnectivityState`](/reference/@azx/ribo-core/interfaces/ConnectivityState.html) ·
  [`ConnectivityStatus`](/reference/@azx/ribo-core/type-aliases/ConnectivityStatus.html) ·
  [`ConnectivityProbe`](/reference/@azx/ribo-core/type-aliases/ConnectivityProbe.html)
- [`workSafety`](/reference/@azx/ribo-core/functions/workSafety.html) ·
  [`summarizeWork`](/reference/@azx/ribo-core/functions/summarizeWork.html) ·
  [`WorkSafety`](/reference/@azx/ribo-core/type-aliases/WorkSafety.html) ·
  [`WorkOnDevice`](/reference/@azx/ribo-core/interfaces/WorkOnDevice.html) ·
  [`StoragePersistence`](/reference/@azx/ribo-core/type-aliases/StoragePersistence.html)
- [`DEFAULT_PROBE_TIMEOUT_MS`](/reference/@azx/ribo-core/variables/DEFAULT_PROBE_TIMEOUT_MS.html) ·
  [`DEFAULT_STABILITY_WINDOW_MS`](/reference/@azx/ribo-core/variables/DEFAULT_STABILITY_WINDOW_MS.html)
