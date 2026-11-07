# @azx/ribo-ui-react

The headless React hook layer over `@azx/ribo-core`'s engine: `RiboProvider` plus seven `use*` hooks
that wire the recorder, the capture queue, sessions, review, connectivity, and work-safety into React
state. It ships one component — the provider — and no markup or stylesheet.

## When to use it

Use it when your host app is React and you want the queue's state as hooks instead of re-deriving
it from `@azx/ribo-core` yourself — `useRecorder`, `useCaptures`, `useSessions`, `useReview`,
`useConnectivity`, `useWorkSafety`, `useStoragePersistence`.

Skip it if your host isn't React (go straight to `@azx/ribo-core`) or if you want a component
library — this package renders nothing; every panel is the host's own code built on these hooks.

## Composing it

```tsx
import { RiboProvider, useReview, useSessions } from "@azx/ribo-ui-react";

function ReviewCard({ session }) {
  // `valuesSchema` comes from whatever ToolAdapter package this host writes into,
  // e.g. `@azx/ribo-adapter-snuggpro`'s patch schema (an example adapter, not the only one).
  const { fields, accept, submit } = useReview(session, { valuesSchema: hostValuesSchema });
  // Render `fields` however this host likes.
  return null;
}

function ReviewPanel() {
  // Review is session-level, not recording-level — `awaiting-review` is a session status.
  const { items } = useSessions({ status: "awaiting-review" });
  return items.map((session) => <ReviewCard key={session.id} session={session} />);
}

function App({ storage }) {
  // The host owns instance lifetime, not this package: the provider carries the
  // already-opened `Storage` (and recorder/connectivity) rather than constructing them.
  return (
    <RiboProvider value={{ storage }}>
      <ReviewPanel />
    </RiboProvider>
  );
}
```

## Learn more

- Guide: [React Hooks](../../docs/guide/react.md)
- [Repo root](../../README.md)
