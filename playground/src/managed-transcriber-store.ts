import { ManagedTranscriber, MANAGED_AZURE_SPEECH_ENGINE } from "@azx/ribo-transcriber-managed";

/**
 * @file The shared managed transcriber — constructed once, here.
 *
 * The playground owns the transport, and this is where the endpoint is supplied
 * (Task 3 scaffold; Task 7 wires it into the queue composition). The package has
 * no capacity to authenticate: the endpoint and the bare global `fetch` are all
 * it gets here, and whatever credential the call needs is the transport's
 * responsibility — supplied by Task 7 as a `fetchImpl` that attaches the Azure
 * key from the environment. No key lives in this file.
 *
 * Same singleton pattern as `whisper-store.ts` / `extractor-store.ts`: one
 * instance for the whole app, constructed lazily on first use.
 */

const endpoint = import.meta.env.VITE_AZURE_SPEECH_ENDPOINT;

let transcriber: ManagedTranscriber | undefined;

/**
 * The shared managed transcriber, constructed on first use.
 *
 * With no `VITE_AZURE_SPEECH_ENDPOINT` the transcriber reports `not-configured` —
 * the demo runs with the on-device engine alone. Set the endpoint and it becomes
 * `ready` (subject to connectivity), ready for Task 7's queue composition.
 */
export function getManagedTranscriber(): ManagedTranscriber {
  transcriber ??= new ManagedTranscriber({
    endpoint,
    isOnline: () => navigator.onLine,
  });
  return transcriber;
}

/** The engine id, for display in the footer alongside the other package names. */
export { MANAGED_AZURE_SPEECH_ENGINE };
