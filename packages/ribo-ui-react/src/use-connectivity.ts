import type { Connectivity, ConnectivityState } from "@azx/ribo-core";
import { useCallback } from "react";

import { useRiboInstance } from "./use-ribo-instance.js";
import { useSubscribed } from "./use-subscribed.js";

/**
 * The current {@link ConnectivityState} — the three-state `offline`/`probing`/`online`
 * model, not `navigator.onLine`.
 *
 * State only. `Connectivity.start()` and `stop()` bind and unbind an event source,
 * which is lifecycle and stays the host's — the same reason `RiboProvider` does not
 * construct instances. A host that has not called `start()` will see the model's
 * initial state and no transitions, which is the honest result rather than a hook
 * quietly starting something it does not own.
 */
export function useConnectivity(connectivity?: Connectivity): ConnectivityState {
  const instance = useRiboInstance("connectivity", connectivity);
  // `subscribe` must stay referentially stable across renders — see
  // useSubscribed's doc comment. `Connectivity.state` allocates a fresh object
  // on every read, so an unmemoized arrow here would re-subscribe every render
  // and never stop: the effect's `[subscribe]` dependency would change every
  // commit, and the source's immediate delivery-on-subscribe would hand back an
  // object that is never `Object.is`-equal to the last one.
  const subscribe = useCallback(
    (listener: (state: ConnectivityState) => void) => instance.subscribe(listener),
    [instance],
  );
  return useSubscribed(subscribe, () => instance.state);
}
