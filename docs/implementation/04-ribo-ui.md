# 04 — `@azx/ribo-ui-react` (Headless Hook Layer)

**Superseded design, corrected 2026-08 (R5).** This doc originally specified `@azx/ribo-ui` as a
styled component library — `CaptureControl`, `StatusIndicator`, a schema-driven `ReviewCard`
implementing a `ReviewPresenter` interface, CSS Modules compiled to `styles.css`. None of that
shipped. The headless-hook-layer decision
([R2 design](../roadmap/design/r2-headless-hook-layer-design.md) §7: "Not components. No markup, no
stylesheet, no `styles.css` subpath") replaced the plan before R2 was even built, and
`ReviewPresenter` itself has been deleted from `ribo-core` (R2 design §2.4) — review is now a status
in the outbox state machine, not a callback a UI implements. What actually shipped, and what this
doc now describes, is `@azx/ribo-ui-react`: a **headless React hook layer** — `RiboProvider` plus six
hooks over `ribo-core`'s engine. **No components beyond `RiboProvider`, no markup, no stylesheet**
(AGENTS.md §1, §3).

## What ships

| Export                  | Responsibility                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RiboProvider`          | Makes host-constructed `Recorder`/`Outbox`/`Connectivity` instances available to the hooks via context. The only component in the package — a context provider, not a rendering surface. |
| `useRecorder`           | Capture as React state: `phase`, `elapsedMs`, `level`/`scaledLevel`, `start`/`stop`/`pause`/`resume`/`toggle`, and (on `stop`) the enqueued `OutboxItem`.                                |
| `useOutboxItems`        | The outbox queue as live React state, filterable by an `OutboxQuery` (e.g. `{ status: "awaiting-review" }`).                                                                             |
| `useReview`             | Field-by-field review of one parked item — see below.                                                                                                                                    |
| `useConnectivity`       | The `offline` / `probing` / `online` connectivity state.                                                                                                                                 |
| `useWorkSafety`         | The one honest "is my work safe?" verdict, composed from `useOutboxItems`, `useConnectivity` and `useStoragePersistence`.                                                                |
| `useStoragePersistence` | The storage-persistence grant and quota estimate — the one hook with no core counterpart; it wraps `navigator.storage` directly.                                                         |

Every hook but `useStoragePersistence` reads its instance out of `RiboProvider`'s context by
default, and every hook accepts an explicit instance argument that bypasses the provider (what the
tests use) — see AGENTS.md §6.2 for the full breakdown, including why `useWorkSafety` alone has no
override argument.

## Review is a queue state, not a presenter

This doc originally specified core awaiting an injected `ReviewPresenter.present(draft):
Promise<T | null>`, implemented by a `ReviewCard` component. Neither survived, for two separate
reasons. The `T | null` shape was rejected at design time as too thin — all-or-nothing, and unable to
express "accepted, but I fixed the R-value," the single most common field outcome
(`ribo-core/src/review.ts`'s header, "Why this is not `present(draft)`"). The callback protocol
itself was rejected later, for an operational reason: the outbox relay processes items in strictly
ascending sequence, so a step blocked on a human `await` would stall every later recording behind
it, and a page reload mid-await drops the promise with nothing left to resolve (same file, "Review is
a queue state, not a callback"). `ReviewPresenter` has since been deleted from `ribo-core`.

What exists instead: `awaiting-review` is a real status in the outbox's state machine, deliberately
absent from `ACTIVE_OUTBOX_STATUSES` so the relay drains past a parked item rather than blocking on
it. A UI finds parked items with an ordinary query (`outbox.watch({ status: "awaiting-review" })`,
or this package's `useOutboxItems`), and **`Outbox.submitReview` is the only way out of
`awaiting-review`**, to `writing`.

`useReview(item, { valuesSchema })` is this package's hook onto that gate. `valuesSchema` is the
adapter's **patch** schema (`ToolAdapter.schema`), not the adapter itself — passed as an argument
rather than reached for, so this package touches nothing of `write` or `instructions` and stays
tool-agnostic. The hook walks it into one `ReviewField` per **leaf path**, not per top-level schema
key: Snugg Pro's 51 leaves nest under 7 groups, and the `health` group alone is 14 tests, so
top-level review would give an auditor one verdict for all 14 instead of one per test (`review.ts`'s
header has the full argument). That is the reuse payoff this doc always described; it is now
delivered by `buildReviewRequest` / `resolveReview` in `ribo-core`, not by a component iterating
`schema.shape`. A host accepts, edits or rejects each leaf by path and calls `submit()`, which
resolves a complete decision set through `resolveReview` before handing it to `Outbox.submitReview`.

There is no `ReviewCard` in this package. A host renders its own UI off `useReview`'s `fields`; the
current stand-in is the playground's `ReviewCard` (`playground/src/ReviewPanel.tsx`), which is
application code, not part of this package.

## Framework and build

**React.** `RiboProvider` and every hook are plain React; `react`/`react-dom` are
`peerDependencies` (`^18.3 || ^19`), never bundled. The package is built with **tsdown**, the same
tool as the other four publishable packages — [10 §3.1](10-build-and-packaging.md) has the toolchain
decision and why an earlier plan to build this package with Vite library mode did not survive the
headless-hook-layer decision. Vite is still in the repo (the playground, and the field app), but it
never builds this package.

## Dependency policy: `ribo-ui-react` stays lean — decided 2026-07-23

**No component library. Specifically, no Mantine.** This holds more strongly than originally
decided: the headless-hook-layer decision means the package ships no components to style at all, so
there is nothing for a component library, a styling framework or a CSS-in-JS runtime to attach to.
`sideEffects: false`, no `./styles.css` export, no stylesheet ever produced.

The reasoning behind the policy is unchanged: this package is **published into someone else's React
app** — Snugg Pro's own codebase is a stated eventual consumer — and a component library is not a
private implementation detail once it is in a published UI package. It would make the host install
Mantine, keep its version in step with ours, and wrap their tree in `MantineProvider` before a single
hook does anything useful. "Integrating your SDK means adopting your UI stack" is one of the ordinary
reasons an SDK gets refused at the door.

**Applications may use anything.** The `playground` and the field app ([06](06-field-app-helix.md))
are free to use Mantine, a state library, TanStack Query — whatever makes them good. The constraint
here is about what we impose on **other people's builds**, not about what we like.

**The option deliberately not taken:** a separate `ribo-ui-react-mantine` package — a styled
component set built on these hooks — could be added later for hosts that already run Mantine. That
stays available precisely _because_ this package has no rendering in it; it would be additive and
would not change `ribo-ui-react` at all. Not planned, just not foreclosed.

## The level meter's perceptual scaling lives in `useRecorder`

`RecorderState.level` from `ribo-core` is **raw RMS** ([03](03-ribo-core.md)). For ordinary speech
that number sits low enough that a bar whose width is `level * 100%` barely leaves the left edge —
it looks like a broken meter, not a quiet room.

This doc originally assigned that mapping to a `CaptureControl` component that was never built. It
is honoured anyway, just one layer down: `useRecorder` exposes both `level` (the honest RMS) and
`scaledLevel` (`Math.sqrt(level)` — monotonic, needs no floor, and what the playground arrived at
against a real microphone; see `use-recorder.ts`'s own comment on `scaleLevel`). A headless package
has no meter of its own to own the curve, so the hook owns it instead, and every consumer draws from
the same value rather than guessing at its own. The playground's `LevelMeter`
(`playground/src/RecordPanel.tsx`) draws its bar straight from `scaledLevel`, with no scaling of its
own.

Corollary for hosts that skip `useRecorder` and read `Recorder` directly: this is documented
consumer-facing behaviour, not a hidden trick — `level` and the `sqrt` mapping are both public, so a
host drawing its own meter can start from the same curve.

## Size & open items

- **Size:** designed as **M**; shipped smaller — six hooks and a provider, no components, no
  styles.
- **Open:** exact review UX (all fields on one card vs. progressive) is a host decision now, not
  one this package makes — the playground's reference `ReviewCard` shows every leaf on one card, but
  nothing in `useReview` forces that choice. How partial transcript is surfaced during capture
  remains open; nothing in `ribo-core` or `ribo-transcriber-ondevice` exposes a partial result today.
