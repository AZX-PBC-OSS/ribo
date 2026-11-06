/**
 * @module @azx/ribo-systemone-managed
 *
 * @file The public surface of `@azx/ribo-systemone-managed`.
 *
 * One client for the System One API — hosted TypeSafe ("Jev"), a self-hosted
 * `kev` server and a fine-tune all speak the same contract, which is why the
 * package is named for the deployment mode and not for a vendor. The wire
 * handling is the official `@typesafe-ai/sdk`; this package classifies its
 * errors for Ribo's arbitration ladders and owns batching.
 *
 * **The package has no capacity to authenticate.** It takes an endpoint and an
 * injected `fetch`, and the host's transport attaches whatever credential the
 * call needs. The hosted endpoint sends no CORS headers for any origin, so a
 * browser host points this at its own proxy.
 */
export { SystemOneError } from "./errors.js";
export { systemOneClient } from "./client.js";
export type {
  SystemOneAnswer,
  SystemOneAnswers,
  SystemOneAskOptions,
  SystemOneClient,
  SystemOneClientOptions,
  SystemOneQuestion,
  SystemOneQuestions,
} from "./client.js";

// The question builders and the wire's question/answer shapes — callers build
// questions with these rather than by hand, and answers discriminate on `type`
// the way the wire does.
export { choice, noul } from "@typesafe-ai/sdk";
export type { ChoiceQuestion, ChoiceResponse, NoulQuestion, NoulResponse } from "@typesafe-ai/sdk";
