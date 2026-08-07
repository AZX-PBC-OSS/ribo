import { useContext } from "react";

import { RiboContext, type RiboInstances } from "./context.js";

/** What a host has to do to supply each instance, quoted back to them in the error. */
const HOW_TO_SUPPLY: Record<keyof RiboInstances, string> = {
  recorder: "new Recorder() from @azx/ribo-core",
  outbox: "await openOutbox() from @azx/ribo-core",
  connectivity: "createConnectivity({ … }) from @azx/ribo-core",
};

/**
 * Resolves one engine instance: an explicit `override` if given, else the
 * provider's.
 *
 * Throws rather than returning `undefined`, and the message names the missing key
 * and how to make one. The alternative is a `TypeError` on a property of
 * `undefined`, several frames deep, in a component that did not cause the
 * problem — a host integrating this package for the first time should be told
 * what to add, not handed a stack trace.
 *
 * `override` is how tests inject an instance without a provider, and how a host
 * with two recorders points a subtree at the second one.
 */
export function useRiboInstance<K extends keyof RiboInstances>(
  key: K,
  override?: RiboInstances[K],
): NonNullable<RiboInstances[K]> {
  const instances = useContext(RiboContext);
  const resolved = override ?? instances[key];
  if (resolved === undefined) {
    throw new Error(
      `ribo: no "${key}" available. Construct one (${HOW_TO_SUPPLY[key]}) and pass it to <RiboProvider value={{ ${key} }}>, or hand it to this hook directly. The host owns instance lifetime — see @azx/ribo-ui-react's RiboProvider docs.`,
    );
  }
  return resolved as NonNullable<RiboInstances[K]>;
}
