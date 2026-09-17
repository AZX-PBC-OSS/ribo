# React Hooks

`@azx/ribo-core` has no idea React exists. `@azx/ribo-ui-react` is what TanStack calls a framework
adapter for its own query and table packages: the engine underneath is framework-free, and this
package is one binding over it — `RiboProvider` plus a set of hooks that wire core's recorder,
storage and connectivity into React state. A Vue or Svelte binding, if one is ever needed, is a new
package written against the same core contracts. Nothing about capture, extraction, provenance,
review or write-back would change to support it.

## Headless: a provider and hooks, nothing that renders

`ribo-ui-react` ships no components beyond `RiboProvider`, no markup, and no stylesheet — its
`package.json` has no `./styles.css` subpath and no `sideEffects` entry for one. The playground's
panels (`RecordPanel`, `QueuePanel`, `ReviewPanel`, `WorkSafetyPanel`) are the playground's own code,
built on these hooks; none of it ships from this package. What a card
looks like, whether it uses CSS modules or Tailwind or inline styles, whether a meter is a `<div>` or
a `<canvas>` — all of that is the host's call, every time.

## The provider carries instances; it never constructs them

`RiboProvider`'s `value` prop is a `RiboInstances` — a `recorder`, an `storage`, a `connectivity`, a
`captureCoordinator`, a `liveTranscriber`, every field optional — and the provider does nothing with
it but hand it down through context unchanged:

```tsx
// the host owns lifetime, above React
const recorder = getRecorder();
const storage = await getStorage();

<RiboProvider value={{ recorder, storage }}>
  <App />
</RiboProvider>;
```

It never calls `openStorage()` or constructs a `Recorder` itself. The obvious alternative — a provider
that opens storage for you — looks more convenient right up until it isn't. React StrictMode's
double mount would open a second backend over the same database name and start a second
`Recorder` on a second microphone stream. Vite HMR replaces a module without reloading the page,
which a provider-owned instance has no way to survive. A host that needs a stable instance across
both — the playground keeps one behind a module singleton with `import.meta.hot.data` carry-over —
can fix that itself. A provider that pulled an async open into React's render tree would ship the
hazard inside the SDK, where nothing downstream of it could fix it. Lifetime stays with the host; the
provider is a pipe, not an owner.

`value` is passed through unmemoized for the same reason: memoizing it here would let the provider
silently keep serving a stale instance after the host swapped one out. Hold `value` in a stable
place — a module singleton, or a `useMemo` in the host — rather than building it inline in render.

## Hooks over one engine

Every hook resolves its instance from context, or from an explicit override argument for tests and
multi-instance hosts; a hook that needs an instance the provider wasn't given throws at first render
rather than failing silently later. From the barrel (`packages/ribo-ui-react/src/index.ts`):

| Hook                    | Wraps                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `useRecorder`           | `Recorder` — phase, level, `start`/`stop`/`toggle`, durable enqueue on stop                                                        |
| `useCaptures`           | `Storage.watch` — live recordings by query, as React state                                                                         |
| `useSessions`           | `Storage.watchSessions` — live sessions by query, the session-collection mirror of `useCaptures`                                   |
| `useReview`             | [`buildReviewRequest`/`resolveReview`](/guide/review) — a review card's full state machine: decide, edit, link an instance, submit |
| `useConnectivity`       | `Connectivity` — the `offline`/`probing`/`online` state, not `navigator.onLine`                                                    |
| `useWorkSafety`         | `summarizeWork` + `workSafety`, composed over storage, sessions, storage persistence and connectivity                              |
| `useStoragePersistence` | `navigator.storage` directly — see below                                                                                           |

Alongside them, `createCaptureCoordinator` is a factory, not a hook: it builds the shared handle
`useRecorder` publishes an active `CaptureSession` through and `useWorkSafety` reads capture health
back from. It exists because `RiboProvider` passes instances through unchanged rather than
constructing or wiring them together — a session created inside `useRecorder` has no way to reach a
sibling hook on its own, so the coordinator is the one thing the host builds and hands to both sides
of that gap. It is optional; without one, `useWorkSafety` simply has no capture-health input.

## `useReview` takes a schema, not an adapter

The hook's signature is `useReview(session, { valuesSchema, ... })` — an adapter's plain `ToolAdapter.schema`,
the same `z.ZodObject` [Typesafety](/guide/typesafety) and [Review](/guide/review) already cover, not
a `ToolAdapter` itself. That is a deliberate narrowing, not an oversight: a review card needs to walk
a `ZodObject` to render fields and validate edits, and a `ToolAdapter` would also hand it `write` and
`instructions` that a review UI has no business touching. The payoff is bigger than least privilege,
though — `ribo-ui-react` imports nothing from any adapter package, anywhere in its source. Swap
`@azx/ribo-adapter-snuggpro` for a different tool's adapter and every hook in this package still
compiles and runs unchanged, because none of them ever named it.

`useReview` mirrors what `resolveReview` actually enforces: the gate is decision completeness, not
groundedness, not a check that an ungrounded leaf was corrected first. See [Review](/guide/review)
for the full argument. `ReviewField.isGrounded` and `groundedness` ride along on every field so a UI
can prioritize — the playground's own `ReviewPanel` disables its submit button while an untouched,
ungrounded leaf remains — but that is application-level policy built on top of `isGrounded`, not a
guarantee `useReview` makes for you.

## `useStoragePersistence`: the one hook with no core counterpart

Every other hook in the table above wraps something `@azx/ribo-core` already exports —
a `Recorder`, an `Storage`, a `Connectivity`. `useStoragePersistence` doesn't: it wraps
`navigator.storage` directly and reads nothing out of `RiboInstances` or context at all. It returns
core's `StoragePersistence` vocabulary (`granted` / `denied` / `unknown` / `unsupported`, distinguishing
"refused" from "not yet asked") because that's the shape `workSafety` wants as an input, but the grant
and the quota estimate themselves come straight from the browser API, behind one shared module-level
store so every caller — a storage panel and `useWorkSafety` both — sees the same answer instead of
independent, driftable copies.

## Installing

```bash
pnpm add @azx/ribo-ui-react
```

Check `packages/ribo-ui-react/package.json` for the current ranges rather than assuming them: React
and React DOM are **peer** dependencies (not plain ones), and `@azx/ribo-core` is a peer too — because
`RiboProvider`'s `value` carries your app's own `Recorder` and `Storage` instances across the package
boundary, your app and `ribo-ui-react` have to resolve to one copy of core, or those instances stop
being `instanceof` what the hooks expect. See [Installation](/guide/installation) for the full
peer-dependency rationale, which applies here unchanged.

## Next

**[Review](/guide/review)** covers the contract `useReview` is built on in full — the
`ReviewRequest`/`ReviewOutcome` shapes, instance-identity linking, and exactly what `resolveReview`
does and doesn't enforce.

**[Offline & Storage](/guide/offline-and-storage)** covers the two state machines
`useCaptures`, `useSessions` and `useWorkSafety` are all reading a live view of.
