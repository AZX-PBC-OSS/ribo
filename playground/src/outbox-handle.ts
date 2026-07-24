import { openOutbox, type Outbox } from "@azx/ribo-core";

/**
 * @file One {@link Outbox} per page load, shared by every component and
 * deliberately never closed.
 *
 * Two things want to open a second database over the same IndexedDB name, and
 * both produce the same confusing RxDB "database already exists" error:
 *
 * 1. **React StrictMode**, which mounts every effect twice in development. A
 *    promise-valued module singleton makes the second mount await the first
 *    open instead of starting another one.
 * 2. **Vite HMR**, which replaces module instances without reloading the page.
 *    Editing a component only fast-refreshes that component, so this module is
 *    not re-run and the singleton survives — but editing *this* file, or
 *    anything it imports, does re-run it. `import.meta.hot.data` is carried
 *    from the retiring module instance to its replacement, so the handle is
 *    stashed there and picked back up rather than reopened.
 *
 * Closing on `hot.dispose` would be the other way to avoid stacking, and is
 * worse: the replacement module can start opening before the close settles, so
 * the fix reintroduces the very error it exists to prevent. Carrying the handle
 * has no race at all.
 */

interface HotData {
  outbox?: Promise<Outbox>;
}

const hotData = import.meta.hot?.data as HotData | undefined;

let handle: Promise<Outbox> | undefined = hotData?.outbox;

/**
 * The shared outbox, opening it on first call.
 *
 * Returns the *promise* rather than awaiting it here so that two callers racing
 * during StrictMode's double mount share one open, and so this module has no
 * top-level await.
 */
export function getOutbox(): Promise<Outbox> {
  handle ??= openOutbox();
  if (hotData) hotData.outbox = handle;
  return handle;
}
