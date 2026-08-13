import type { Observable } from "rxjs";

import type { Recording } from "./recording.js";
import type { TranscriberCapability } from "./transcriber.js";

/**
 * @file The live-transcription seam — utterance-level preview during recording.
 *
 * Where {@link ./transcriber.ts Transcriber} is the batch seam (whole-recording
 * transcription after `stop()`), this is the streaming seam: feed audio frames in
 * while the microphone is open and get utterance text back as each pause closes.
 *
 * The seam is defined here in `ribo-core` and implemented by the on-device engine
 * package — the same direction as `Transcriber`. `ribo-core` orchestrates; the
 * engine implements. No engine package is imported here.
 *
 * ## Not composed through `firstCapable`
 *
 * `firstCapable` takes `Transcriber[]` and returns a composite exposing batch
 * `transcribe` / `capabilities` / `invalidate`. A `LiveTranscriber` is not
 * reachable through it: widening the composite would drag a live concern into
 * every batch roster. Instead the live orchestrator holds an optional
 * `LiveTranscriber` directly. If none is supplied, or `liveCapability()` is not
 * `ready`, there is simply no preview and recording is unaffected — which is the
 * governing failure rule ("live must never degrade recording").
 *
 * ## `liveCapability()` is separate from `capability()`
 *
 * The batch path's `capability()` reports on the ASR model alone. Live
 * additionally needs the streaming VAD (Silero), so "ASR cached but VAD missing"
 * is a real state the batch probe cannot express. The two probes are independent
 * methods on independent interfaces.
 */

/**
 * A live transcription session — the handle returned by
 * {@link LiveTranscriber.openSession}.
 *
 * Feed 512-sample audio frames in at audio-callback rate; closed utterances come
 * out on `segments$`. The session is opened by the capture session and closed by
 * it — if capture ends (stop, abort, failure, tab losing the capture lock), the
 * session closes and its in-flight replies are discarded by `sessionId`.
 */
export interface LiveSession {
  /**
   * Stamp that correlates worker replies to this session. Every `liveSegment`
   * reply carries it; replies from a closed session are dropped by matching
   * against it — not by "the observable has no subscribers", which would pass
   * against no guard at all.
   */
  readonly sessionId: string;

  /**
   * One emission per closed utterance — the transcribed text. Internal to core:
   * the host app reads preview segments through `Outbox.watch()`, not by
   * subscribing here directly. This observable stays open after `close()` so the
   * `sessionId` guard (not Subject completion) is what drops late replies.
   */
  readonly segments$: Observable<string>;

  /**
   * Live-transcription errors that occurred mid-session — one emission per
   * surfaced failure, carrying the worker's error message.
   *
   * **Why a separate observable, not `segments$.error()`.** Erroring the segment
   * `Subject` would terminate it permanently — no segment could ever flow again
   * for that session. But the design's failure table
   * (`docs/roadmap/design/live-transcription-design.md`, §Failure handling) calls
   * for "preview stops, **recording continues**, error surfaced" on a live
   * transcription throw, and a per-utterance failure (one bad `generate` call)
   * says nothing about the next utterance. Killing the whole segment stream for a
   * single failed utterance is the exact trade this change exists to correct. A
   * separate channel lets per-utterance failures be surfaced without ending the
   * preview, and lets session-fatal failures be surfaced without risking an
   * unhandled rejection on `segments$` — which a subscriber like the playground's
   * `live-handle.ts` does not catch, and which RxJS 7 rethrows asynchronously
   * when a subscriber has no error handler. Recording is never affected either
   * way: live is strictly best-effort and the capture pipeline never touches this
   * observable.
   */
  readonly errors$: Observable<string>;

  /**
   * Push one 512-sample frame into the streaming VAD.
   *
   * **Synchronous — must return before the inference it triggers.** Called from
   * an audio callback; if it awaited the model, the audio thread would stall and
   * capture would degrade — which this whole feature exists to avoid. The
   * implementation posts the frame to a worker and returns immediately; inference
   * runs asynchronously and the resulting text arrives on `segments$` when it
   * completes.
   */
  feed(frame: Float32Array): void;

  /**
   * Close the session. Posts a `liveClose` to the worker and marks this session
   * as closed so late replies carrying its `sessionId` are discarded. After
   * `close()`, `feed()` is a no-op and `segments$` emits nothing further.
   */
  close(): void;
}

/**
 * The seam an engine implements for live (utterance-level) transcription.
 *
 * Implemented by `@azx/ribo-transcriber-ondevice`; held directly by the live
 * orchestrator, never composed through `firstCapable`.
 */
export interface LiveTranscriber {
  /**
   * What this engine can do for live transcription right now.
   *
   * Separate from `Transcriber.capability()` because live additionally needs the
   * streaming VAD (Silero): "ASR cached but VAD missing" is a real state the
   * batch probe cannot express. Returns `ready` only when both the ASR model and
   * the streaming VAD are cached and available.
   */
  liveCapability(): Promise<TranscriberCapability>;

  /**
   * Open a live session for a recording. Loads the streaming VAD model if it is
   * not already warm, then returns a handle that accepts frames and emits
   * utterance text. Rejects if the VAD model cannot be loaded — the caller should
   * treat that as "no preview for this recording", not as a recording failure.
   */
  openSession(recording: Recording): Promise<LiveSession>;
}
