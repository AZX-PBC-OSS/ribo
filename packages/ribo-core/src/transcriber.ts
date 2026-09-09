import type { CaptureItem } from "./capture-item.js";
import type { Recording } from "./recording.js";
import type { Transcript } from "./transcript.js";

/**
 * @file The transcription contract: what an engine can do, and what happened when it tried.
 *
 * Two implementations are coming — on-device WASM/WebGPU (`@azx/ribo-transcriber-ondevice`,
 * Phase 3) and a managed HTTP one proxying Azure STT (`docs/implementation/02-server-stt.md`,
 * deferred). This file is the seam they plug into, and `first-capable.ts` is how they compose.
 * Neither is built here.
 */

/**
 * Why an engine cannot run.
 *
 * A closed set on purpose: a UI has to branch on this, and free-text reasons make that
 * impossible. The human-readable part lives in `detail`, which is required precisely so a
 * reason code never has to carry nuance it cannot express.
 */
export const TRANSCRIBER_UNAVAILABLE_REASONS = [
  /** The device or browser cannot run this engine at all — no WebGPU, ORT will not init. */
  "unsupported-platform",
  /** It runs, but not fast enough to be worth routing to (`01`'s real-time-factor gate). */
  "too-slow",
  /** Weights or runtime binaries are not on the device and could not be fetched. */
  "model-unavailable",
  /** Needs the network and there is none. The managed path's normal failure. */
  "offline",
  /** Missing endpoint, key or user consent. Nothing is wrong with the device. */
  "not-configured",
  /** The probe itself failed in a way this vocabulary does not describe. */
  "unknown",
] as const;

export type TranscriberUnavailableReason = (typeof TRANSCRIBER_UNAVAILABLE_REASONS)[number];

/**
 * The reasons that will not change for the life of this page.
 *
 * WebGPU does not appear mid-session, and a device that measured a real-time factor of 4 will
 * not get faster. Everything else — the uplink, a model download, a missing API key — is a
 * situation, not a fact about the hardware, so it is re-probed.
 *
 * This drives two things: how long `firstCapable` caches an `unavailable` verdict, and whether
 * "nothing is capable" is worth retrying at all.
 */
export const PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS = [
  "unsupported-platform",
  "too-slow",
] as const satisfies readonly TranscriberUnavailableReason[];

/**
 * What an engine can do **right now**.
 *
 * Three states rather than a boolean, because `needs-download` and `unavailable` produce
 * completely different screens: "capable, but 165 MB has to come down first — over the network,
 * with your say-so" against "this cannot run here, and here is why". Collapsing them into
 * `available: false` is what makes a download UI impossible to write.
 *
 * Availability is dynamic in **both** directions: on-device becomes `ready` after a download
 * finishes, and the managed path becomes `unavailable` the moment the uplink drops. Nothing may
 * treat this as a value read once at init.
 */
export type TranscriberCapability =
  | {
      /** Can transcribe now, with no further fetching and no further consent. */
      readonly status: "ready";
    }
  | {
      /**
       * Capable of running here, but weights and/or runtime binaries must be fetched first.
       *
       * A selection combinator must **never** pick this on its own: the fetch needs network and
       * a human's agreement, and a queue drain is not the place either can be obtained.
       */
      readonly status: "needs-download";
      /**
       * Total bytes still to fetch, for the consent screen.
       *
       * Include the ONNX Runtime binary, not just the weights — ~13 MB on Safari, ~24 MB on
       * Chromium (`01 §Recommendation`). Quoting model size alone understates a first launch by
       * a sixth and is a mistake `01` calls out by name.
       */
      readonly downloadBytes: number;
      /** What is being downloaded, for the same screen. e.g. `"whisper-base.en"`. */
      readonly detail?: string;
    }
  | {
      /** Cannot run. */
      readonly status: "unavailable";
      readonly reason: TranscriberUnavailableReason;
      /** Human-readable specifics. Required — a reason code with no detail is unactionable. */
      readonly detail: string;
    };

/** Is this a verdict that will not change for the life of the page? */
export function isPermanentlyUnavailable(capability: TranscriberCapability): boolean {
  return (
    capability.status === "unavailable" &&
    (PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS as readonly string[]).includes(capability.reason)
  );
}

/**
 * Turns captured bytes into a {@link Transcript}.
 *
 * The bytes are passed separately from the capture record on purpose: the record
 * is metadata, and the blob is held by the queue (see `recording.ts`). An
 * implementation gets both, and returns a transcript whose `recordingId` ties it
 * back to the record it came from and whose `engine` records that this
 * implementation is what produced it.
 *
 * Generic over the capture kind: `Transcriber<Recording>` is an audio-only
 * engine (the default, so bare `Transcriber` keeps meaning exactly what it did
 * before documents existed), `Transcriber<DocumentCapture>` is a document
 * engine, and `Transcriber<CaptureItem>` is an engine that can accept either.
 *
 * `transcribe` is declared as a **function-typed property, not a method**.
 * Method parameters are exempt from `strictFunctionTypes` and compared
 * bivariantly, so with method syntax an audio-only `Transcriber<Recording>`
 * would slide unchallenged into a `Transcriber<CaptureItem>` slot — which is
 * the bug this contract exists to prevent. A property declaration makes that
 * assignment a type error, which is what sends a host to `restrictToKind`.
 * A class written with an ordinary `async transcribe(…)` method still satisfies
 * the property-typed interface — variance only matters when comparing two
 * _instantiations_ of the interface.
 *
 * Three kinds of failure, and **conflating them is the bug this contract exists
 * to prevent**:
 *
 * - **Attempt failure** — this clip OOMed, this inference threw, this request
 *   503'd. Throw anything (`Error`, a fetch rejection, a `TerminalQueueError`).
 *   The queue owns it: `isTransientFailure`, jittered backoff and `maxAttempts`
 *   already do exactly the right thing, and a selection combinator must let it
 *   straight through. One bad clip must never demote a device to the cloud for
 *   good.
 * - **Capability failure** — the runtime would not init, the weights will not
 *   load, this device cannot do this. Throw {@link TranscriberUnavailableError}.
 *   That is the signal that falling back is correct and that the earlier
 *   `capability()` answer was wrong and should be replaced.
 * - **Item unsuitability** — this engine cannot handle this item, and that says
 *   nothing about the engine. Throw {@link UnsupportedItemError}. A scanned PDF
 *   with no text layer is perfectly transcribable — by OCR — so the correct
 *   response is to try the next engine, not to retry this one. The error is
 *   terminal for the queue (so it does not burn the retry budget) but not for
 *   the item (a composition layer routes to the next engine).
 */
export interface Transcriber<S extends CaptureItem = Recording> {
  /**
   * Stable, opaque id for this engine. Goes into every `Transcript.engine` it produces, so it
   * ends up persisted in the outbox — keep it short and stable across versions.
   */
  readonly engine: string;

  /**
   * What this engine can do right now.
   *
   * **Expected to be called often and expected to be cheap.** Implementations that probe
   * something expensive (a WebGPU adapter request, a model-file stat) should memoize internally;
   * {@link firstCapable} additionally caches the answer so a queue drain of forty recordings
   * does not re-probe forty times. Both layers are deliberate — an implementation used bare
   * still needs to be cheap.
   *
   * Rejecting is allowed and is treated as `unavailable` with reason `"unknown"`; a probe is not
   * permitted to take the caller down.
   */
  capability(): Promise<TranscriberCapability>;

  /**
   * Transcribe one capture item.
   *
   * See the interface doc for the three failure kinds and why conflating them is the bug
   * this contract exists to prevent.
   */
  transcribe: (item: S, bytes: Blob) => Promise<Transcript>;
}

export interface TranscriberUnavailableInit {
  /** The engine that cannot run — `Transcriber.engine`. */
  engine: string;
  reason: TranscriberUnavailableReason;
  detail: string;
  /** Underlying failure, if there was one. */
  cause?: unknown;
}

/**
 * "This engine cannot run here" — a **capability** failure, discovered while attempting.
 *
 * Deliberately **not** a `TerminalQueueError`, and deliberately carrying no HTTP `status`. That
 * makes `isTransientFailure` classify it as transient with no change to `queue/backoff.ts`,
 * which is the correct answer: the item should be retried, because the next attempt re-probes
 * and may route to a different engine entirely. The queue's vocabulary is reused rather than
 * duplicated — there is no second retry classifier here, and there must never be one.
 *
 * Contrast {@link UnsupportedItemError}, which _is_ terminal: "this engine cannot handle this
 * item" will not change on the next attempt, while "this engine cannot run here" might. The two
 * sit on opposite sides of that line on purpose.
 *
 * The exception is a roster on which *every* engine is permanently unavailable; only
 * {@link firstCapable} can know that, and it throws a `TerminalQueueError` instead.
 */
export class TranscriberUnavailableError extends Error {
  override readonly name = "TranscriberUnavailableError";
  readonly engine: string;
  readonly reason: TranscriberUnavailableReason;
  readonly detail: string;

  constructor(init: TranscriberUnavailableInit) {
    super(`${init.engine} cannot transcribe here: ${init.reason} — ${init.detail}`, {
      cause: init.cause,
    });
    this.engine = init.engine;
    this.reason = init.reason;
    this.detail = init.detail;
  }

  /**
   * The capability this failure implies, ready to replace a stale cached answer.
   *
   * A probe that said `ready` and an attempt that says otherwise disagree, and the attempt is
   * the one that actually ran.
   */
  get capability(): TranscriberCapability {
    return { status: "unavailable", reason: this.reason, detail: this.detail };
  }
}
