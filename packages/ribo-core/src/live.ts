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
 * Whether a {@link LiveSegment} is provisional text for the current growing
 * region or permanent text for a committed region. Mirrors the worker protocol's
 * own `LiveSegmentKind` (`@azx/ribo-transcriber-ondevice`'s `protocol.ts`), kept
 * in this package so hosts do not depend on the engine's private protocol.
 *
 * - `"tail"` — provisional text for the current growing region. Replaces the
 *   previous tail wholesale; never appended to. The host renders it as still
 *   being revised and stores it via `Outbox.writePreviewTail`.
 * - `"commit"` — permanent text for a committed region. Appended to the
 *   committed list; never revised. The host renders it as settled and stores it
 *   via `Outbox.commitPreview`.
 */
export type LiveSegmentKind = "tail" | "commit";

/**
 * One emission on {@link LiveSession.segments$} — transcribed text for a region,
 * tagged so the receiver knows whether to render it as provisional or permanent.
 *
 * ## Why one observable of a discriminated value, not two
 *
 * The alternative is two observables — `tails$` and `commits$` — and it is
 * worse on every axis that matters for the actual consumers:
 *
 * 1. **A host that ignores the distinction still gets all the text, in order.**
 *    `playground/src/live-handle.ts` subscribes today, routing tails to
 *    `writePreviewTail` and commits to `commitPreview`. But a host that
 *    does not care about the distinction — a test, a logger, a future consumer
 *    — subscribes to one stream, reads `.text`, and ignores `.kind`. With two
 *    observables the same host must subscribe to both, and RxJS gives no
 *    ordering guarantee across two separate `Subject`s: the host either loses
 *    half the text (subscribes to one) or gets it out of order (subscribes to
 *    both). The silently-wrong outcome is the one this shape exists to prevent.
 *
 * 2. **The flush-after-close property stays on one stream.** The worker's
 *    `liveClose` handler transcribes the final drained region *after* `close()`
 *    and posts it back — that segment must reach the subscriber (see
 *    {@link LiveSession.close}). Splitting into two `Subject`s duplicates the
 *    "do not gate on `#closed`" logic for no benefit, and a late commit after
 *    close would need to reach `commits$` while a late tail reaches `tails$` —
 *    the same mechanism, twice.
 *
 * 3. **Task 5's routing is one `switch (segment.kind)` in one subscriber.** Two
 *    observables make the routing implicit in which subscription you are in, but
 *    not safer: a host that wires both to the same write still needs to
 *    distinguish, now across two callbacks instead of one exhaustiveness-checked
 *    switch.
 *
 * `errors$` stays a separate observable for a *different* reason — erroring the
 * segment `Subject` would terminate it permanently — and that reasoning is about
 * a different kind of channel, not about the tail/commit distinction.
 */
export type LiveSegment =
  | { readonly kind: "tail"; readonly text: string }
  | { readonly kind: "commit"; readonly text: string };

/**
 * A live transcription session — the handle returned by
 * {@link LiveTranscriber.openSession}.
 *
 * Feed 512-sample audio frames in at audio-callback rate; transcribed region
 * text comes out on `segments$` — tagged `tail` (provisional, still being
 * revised) or `commit` (permanent, settled). The session is opened by the
 * capture session and closed by it — if capture ends (stop, abort, failure, tab
 * losing the capture lock), the session closes and further `feed()` calls are
 * no-ops.
 */
export interface LiveSession {
  /**
   * Stamp that correlates worker replies to this session. Every `liveSegment`
   * reply carries it; the message listener uses it to skip replies from other
   * sessions sharing the same worker channel — not to drop late replies from
   * this session after `close()` (see {@link segments$} and {@link close}).
   */
  readonly sessionId: string;

  /**
   * One emission per transcribed region — a {@link LiveSegment} carrying the
   * text and whether it is a provisional tail or a permanent commit. Internal
   * to core: the host app reads preview text through `Outbox.watch()`, not by
   * subscribing here directly.
   *
   * **Stays open after `close()`** so the worker's final drain — transcribing
   * the last region after `close()` was called — still reaches the subscriber.
   * The listener is deliberately not removed and the `Subject` deliberately not
   * completed on close, because dropping that segment would lose the auditor's
   * last sentence. The `#closed` flag only prevents further `feed()` calls; it
   * does not gate segment delivery.
   *
   * **Completes when the worker is done.** After the drain from `close()`
   * finishes — whether it produced a flush segment or not — the implementation
   * completes this `Observable`. A host that subscribes with a `complete`
   * callback can tear down its subscription at that point, knowing no more
   * segments will arrive. This is the signal that prevents the host from having
   * to choose between unsubscribing too early (dropping the flush) and never
   * unsubscribing (leaking a subscription per recording).
   */
  readonly segments$: Observable<LiveSegment>;

  /**
   * Live-transcription errors that occurred mid-session — one emission per
   * surfaced failure, carrying the worker's error message.
   *
   * **Why a separate observable, not `segments$.error()`.** Erroring the segment
   * `Subject` would terminate it permanently — no segment could ever flow again
   * for that session. But the design's failure table
   * (`docs/roadmap/design/live-transcription-design.md`, §Failure handling) calls
   * for "preview stops, **recording continues**, error surfaced" on a live
   * transcription throw, and a per-region failure (one bad `generate` call)
   * says nothing about the next region. Killing the whole segment stream for a
   * single failed region is the exact trade this change exists to correct. A
   * separate channel lets per-region failures be surfaced without ending the
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
   * as closed so further `feed()` calls are no-ops. The worker transcribes the
   * final drained region *after* `close()` and posts it back as a
   * `liveSegment` — that segment **must** reach the subscriber, so the message
   * listener is not removed and the `Subject` is not completed here. The
   * `Subject` is completed when the worker posts `liveClosed` (after the drain
   * finishes), at which point the host's `complete` callback fires and it can
   * tear down. See {@link segments$} for why the stream stays open after close.
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
