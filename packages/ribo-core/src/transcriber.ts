import type { CapturePayload } from "./capture-item.js";
import type { Recording } from "./recording.js";
import type { Transcript } from "./transcript.js";
import type { CaptureStorageScope } from "./storage/plugin-storage.js";

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
 * Run context for one `transcribe` call.
 *
 * The sibling of `ExtractOptions` on `Extractor.extract` — same parameter position (an optional
 * trailing object), same optionality, same shape, so the two run-context contracts do not drift.
 * An implementation that cannot honour a member must not pretend otherwise: a signal that is
 * accepted and not forwarded looks like cancellation and is not. Each transport states what it
 * does with the signal in its own doc comment.
 */
export interface TranscribeOptions {
  /**
   * Cancels the transcription attempt. The caller (the relay, a hedged race, a host) aborts;
   * what an abort does is per-transport and stated in each implementation's doc comment. An
   * implementation must either forward this to the work it does or say plainly that it cannot.
   */
  readonly signal?: AbortSignal;
  /**
   * The plugin-storage handle for **this capture**, supplied by the caller that has one — the
   * relay, which drains captures through an outbox. A host driving a transcriber by hand has
   * none to give, so the member is optional and an implementation that needs storage must
   * handle its absence rather than assume it.
   *
   * The handle is scoped to the capture being transcribed; the transcriber names its own
   * plugin — conventionally its {@link Transcriber.engine} id — through
   * {@link CaptureStorageScope.forPlugin}, so two engines picked for the same capture land in
   * separate namespaces and cannot read or clobber each other's keys. Entries are durable
   * (they survive a close-and-reopen and are visible from another tab) and core sweeps them
   * when the capture is dropped or discarded, so a plugin never cleans up after itself. An
   * extractor from the same plugin reads them back through `Storage.store(pluginId)`
   * — the construction-time handle, since the relay cannot name the plugin an opaque extract
   * step belongs to.
   *
   * This is the only storage a plugin ever sees. The `Storage` itself is never handed to one.
   */
  readonly storage?: CaptureStorageScope;
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
 * engine, and `Transcriber<CapturePayload>` is an engine that can accept either.
 *
 * `transcribe` is declared as a **function-typed property, not a method**.
 * Method parameters are exempt from `strictFunctionTypes` and compared
 * bivariantly, so with method syntax an audio-only `Transcriber<Recording>`
 * would slide unchallenged into a `Transcriber<CapturePayload>` slot — which is
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
 *   503'd. Throw anything (`Error`, a fetch rejection, a `TerminalError`).
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
export interface Transcriber<S extends CapturePayload = Recording> {
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
   * `firstCapable` additionally caches the answer so a queue drain of forty recordings
   * does not re-probe forty times. Both layers are deliberate — an implementation used bare
   * still needs to be cheap.
   *
   * Rejecting is allowed and is treated as `unavailable` with reason `"unknown"`; a probe is not
   * permitted to take the caller down.
   */
  capability: () => Promise<TranscriberCapability>;

  /**
   * Transcribe one capture item.
   *
   * The trailing `options` parameter is the same bag `extract` takes —
   * {@link TranscribeOptions}, currently an optional `signal`. It is an
   * **options object, not a positional parameter**, exactly so Task-6-style
   * members can join it without a third parameter ever appearing. Passing
   * `options` through is the implementation's job; see the type's doc.
   *
   * See the interface doc for the three failure kinds and why conflating them is the bug
   * this contract exists to prevent.
   */
  transcribe: (item: S, bytes: Blob, options?: TranscribeOptions) => Promise<Transcript>;
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
 * Deliberately **not** a `TerminalError`, and deliberately carrying no HTTP `status`. That
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
 * `firstCapable` can know that, and it throws a `TerminalError` instead.
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
