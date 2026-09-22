/**
 * @file The public surface of `@azx/ribo-systemone-managed`.
 *
 * One client for the System One HTTP API — hosted TypeSafe ("Jev"), a
 * self-hosted `kev` server and a fine-tune all speak the same contract, which
 * is why the package is named for the deployment mode and not for a vendor.
 *
 * **The package has no capacity to authenticate.** It takes an endpoint and an
 * injected `fetch`, and the host's transport attaches whatever credential the
 * call needs. The hosted endpoint sends no CORS headers for any origin, so a
 * browser host points this at its own proxy.
 */
export { SystemOneError } from "./errors.js";
export { systemOneClient } from "./client.js";
export type {
  NoulQuestion,
  SystemOneAskOptions,
  SystemOneClient,
  SystemOneClientOptions,
} from "./client.js";
