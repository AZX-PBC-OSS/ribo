# @azx/ribo-ui-react

The **headless React hook layer** over `@azx/ribo-core`'s engine: `RiboProvider` plus six hooks —
`useRecorder`, `useOutboxItems`, `useReview`, `useConnectivity`, `useWorkSafety`,
`useStoragePersistence` — and nothing else. No components beyond `RiboProvider`, no markup, no
stylesheet: rendering is the host's job, these hooks only wire the core engine's state into React.
It is the `react` variant of the `ribo-ui-*` category (AGENTS §6.1); a differently-styled
implementation of the same hooks could land later as a sibling variant.

**The host owns instance lifetime, not this package.** `RiboProvider` takes host-constructed
engine instances (`Recorder`, `Outbox`, `Connectivity`) as-is and does not construct, memoize, or
close any of them — a provider that did would silently keep a stale instance alive after a host
swapped one out, or leak the real one it replaced. Every hook also takes an explicit override
argument for the same instance, for tests and for a host that wants to bypass the provider
entirely — with one exception: `useWorkSafety` has no override of its own (it composes
`useOutboxItems`, `useConnectivity` and `useStoragePersistence` internally) and so can only be used
under a `RiboProvider`.

## Installation

```bash
pnpm add @azx/ribo-ui-react @azx/ribo-core react react-dom
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **`RiboProvider`** — makes host-constructed engine instances (`RiboInstances`: `recorder`,
  `outbox`, `connectivity`) available to every hook below. `value` is passed through unchanged and
  not memoized here; hold it in a stable place (a module singleton, or `useMemo` in the host).
- **`useRecorder`** — the capture state machine (`idle` → `recording` → `paused` → …) as React
  state, with `start`/`pause`/`resume`/`stop`.
- **`useOutboxItems`** — a live, filterable view of the durable offline queue (`Outbox.watch`), for
  a card that lists items at a given status (`awaiting-review`, say).
- **`useReview`** — field-by-field review of one parked item: `buildReviewRequest` /
  `resolveReview` from core, wired to per-item React state (`decisionOf`, `accept`, `edit`,
  `reject`, `untouched`, `submit`, `discard`). Takes the adapter's `valuesSchema` and, optionally,
  its per-group `requiredOnCreate` declaration — no `ToolAdapter` import needed.
- **`useConnectivity`** — the `offline`/`probing`/`online` model as React state.
- **`useWorkSafety`** — the one honest "is my work safe?" verdict, composed from the outbox,
  connectivity and storage-persistence hooks so every host renders the same answer.
- **`useStoragePersistence`** — the `navigator.storage` persistence grant and quota estimate,
  shared across every caller through one module-level store, so granting persistence in one
  component is visible to `useWorkSafety`'s verdict without a re-read.

## Minimal example

```tsx
import { RiboProvider, useOutboxItems, useReview } from "@azx/ribo-ui-react";
import { snuggProAdapter, snuggValuesSchema } from "@azx/ribo-adapter-snuggpro";

function ReviewCard({ item }) {
  const { fields, accept, submit } = useReview(item, {
    valuesSchema: snuggValuesSchema,
    requiredOnCreate: snuggProAdapter.requiredOnCreate,
  });
  // Render `fields` however this host likes — there is no component to inherit here.
  return null;
}

function ReviewPanel() {
  const { items } = useOutboxItems({ status: "awaiting-review" });
  return items.map((item) => <ReviewCard key={item.id} item={item} />);
}

function App() {
  // The host owns lifetime, above React.
  const outbox = useOutbox(); // however this host constructs/holds its Outbox
  return (
    <RiboProvider value={{ outbox }}>
      <ReviewPanel />
    </RiboProvider>
  );
}
```

See the [API Reference](../../docs/reference/) (generated) for the full surface.
