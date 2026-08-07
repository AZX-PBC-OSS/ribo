import type { ReactElement, ReactNode } from "react";

import { RiboContext, type RiboInstances } from "./context.js";

/**
 * Makes host-constructed engine instances available to the hooks.
 *
 * ```tsx
 * // the host owns lifetime, above React
 * const recorder = getRecorder();
 * const outbox = await getOutbox();
 *
 * <RiboProvider value={{ recorder, outbox }}>
 *   <App />
 * </RiboProvider>
 * ```
 *
 * `value` is passed through unchanged and is **not** memoized here — the host owns
 * the object's identity, and a provider that memoized it would silently keep a
 * stale instance after a host swapped one out. Hold it in a stable place (a module
 * singleton, or `useMemo` in the host) rather than building it inline in render.
 */
export function RiboProvider({
  value,
  children,
}: {
  readonly value: RiboInstances;
  readonly children: ReactNode;
}): ReactElement {
  return <RiboContext.Provider value={value}>{children}</RiboContext.Provider>;
}
