import type { CapturePayload } from "../capture/capture-item.js";
import type { Recording } from "../capture/recording.js";
import type { Transcript } from "../capture/transcript.js";
import {
  TranscriberUnavailableError,
  type Transcriber,
  type TranscriberCapability,
  type TranscriberUnavailableReason,
  type TranscribeOptions,
} from "./transcriber.js";
import { UnsupportedItemError, type UnsupportedItemReason } from "./unsupported-item.js";

/**
 * Text a {@link FakeTranscriber} returns when nothing else is configured.
 *
 * @category Transcription
 */
export const DEFAULT_FAKE_TRANSCRIPT_TEXT = "fake transcript";

/**
 * `Transcriber.engine` a {@link FakeTranscriber} reports unless told otherwise.
 *
 * @category Transcription
 */
export const DEFAULT_FAKE_TRANSCRIBER_ENGINE = "fake";

/**
 * A canned response: bare text, or text plus a confidence to echo back.
 *
 * @category Transcription
 */
export type FakeTranscriberResponse = string | { text: string; confidence?: number };

/** @category Transcription */
export interface FakeTranscriberOptions {
  /**
   * The engine id this fake reports and stamps onto its transcripts.
   *
   * Set it when standing in for a real engine — two fakes constructed as
   * `{ engine: "ondevice-whisper" }` and `{ engine: "managed-azure" }` are enough to drive every
   * selection and fallback path without a model.
   */
  engine?: string;
  /** Text returned for any recording with no specific canned response. */
  text?: string;
  /** Confidence attached to the default response. Omitted when unset. */
  confidence?: number;
  /** Canned responses keyed by `item.id`. */
  responses?: Readonly<Record<string, FakeTranscriberResponse>>;
  /** Starting capability. Defaults to `{ status: "ready" }`. */
  capability?: TranscriberCapability;
}

/**
 * One `transcribe` invocation, in call order.
 *
 * @category Transcription
 */
export interface FakeTranscribeCall<S extends CapturePayload = Recording> {
  readonly item: S;
  readonly bytes: Blob;
}

/**
 * A {@link Transcriber} that returns canned text instead of running a model.
 *
 * This is a shipped deliverable, not test scaffolding: Phases 4–6 need to drive the capture →
 * transcribe → extract → review → write pipeline end to end without loading weights, the queue's
 * retry paths need a transcriber that fails on demand, and Phase 3's download UI needs to render
 * every capability state before there is anything to download.
 *
 * It can simulate all three capability states and **all three** kinds of
 * failure, which is the distinction the whole contract turns on:
 *
 * - attempt failure — {@link failWith} / {@link failNextWith} with any error;
 * - capability failure — {@link failWithUnavailable}, or the same setters with a
 *   `TranscriberUnavailableError` for a one-shot;
 * - item unsuitability — {@link failWithUnsupported} / {@link failNextWithUnsupported},
 *   the third failure kind: terminal for the queue but not for the item.
 * @category Transcription
 */
export class FakeTranscriber<S extends CapturePayload = Recording> implements Transcriber<S> {
  readonly engine: string;

  readonly #calls: FakeTranscribeCall<S>[] = [];
  readonly #callOptions: (TranscribeOptions | undefined)[] = [];
  readonly #responses = new Map<string, FakeTranscriberResponse>();
  readonly #defaultText: string;
  readonly #defaultConfidence: number | undefined;
  readonly #initialCapability: TranscriberCapability;
  #capability: TranscriberCapability;
  #capabilityCalls = 0;
  #persistentFailure: Error | undefined;
  #nextFailure: Error | undefined;

  constructor(options: FakeTranscriberOptions = {}) {
    this.engine = options.engine ?? DEFAULT_FAKE_TRANSCRIBER_ENGINE;
    this.#defaultText = options.text ?? DEFAULT_FAKE_TRANSCRIPT_TEXT;
    this.#defaultConfidence = options.confidence;
    this.#initialCapability = options.capability ?? { status: "ready" };
    this.#capability = this.#initialCapability;
    for (const [recordingId, response] of Object.entries(options.responses ?? {})) {
      this.#responses.set(recordingId, response);
    }
  }

  /** Every call so far, including calls that were made to fail. */
  get calls(): readonly FakeTranscribeCall<S>[] {
    return this.#calls;
  }

  /**
   * The options of every `transcribe()` call, positionally matching {@link calls}.
   *
   * Recorded rather than ignored so a combinator test can assert the caller's options — the
   * `AbortSignal` by identity — actually reached the candidate. A combinator that accepts
   * `options` and forwards none typechecks, and did in the extractor's case: the parameter
   * is optional, so a dropped forward is invisible without this.
   */
  get callOptions(): readonly (TranscribeOptions | undefined)[] {
    return this.#callOptions;
  }

  /**
   * How many times `capability()` has been probed.
   *
   * The only way to prove a caching layer is actually caching — an assertion on the answer
   * cannot tell one probe from forty.
   */
  get capabilityCalls(): number {
    return this.#capabilityCalls;
  }

  /** Canned response for one recording id. Overrides the default text. */
  setResponse(recordingId: string, response: FakeTranscriberResponse): this {
    this.#responses.set(recordingId, response);
    return this;
  }

  /**
   * Change what `capability()` reports, from now on.
   *
   * Both directions matter: a model download finishing (`needs-download` → `ready`) and an
   * uplink dropping (`ready` → `unavailable`) are the two events the design exists to tolerate.
   */
  setCapability(capability: TranscriberCapability): this {
    this.#capability = capability;
    return this;
  }

  /** Reject every subsequent call with `error`, until {@link reset}. */
  failWith(error: Error): this {
    this.#persistentFailure = error;
    return this;
  }

  /** Reject only the next call with `error` — a transient failure, for retries. */
  failNextWith(error: Error): this {
    this.#nextFailure = error;
    return this;
  }

  /**
   * Reject every subsequent call with a **capability** failure.
   *
   * Note this deliberately leaves `capability()` alone, so it models the nastier case: a probe
   * that answered optimistically and a runtime that only fails once it is really asked to run.
   * Pass the resulting capability to {@link setCapability} too if you want both to agree.
   */
  failWithUnavailable(reason: TranscriberUnavailableReason, detail: string): this {
    return this.failWith(new TranscriberUnavailableError({ engine: this.engine, reason, detail }));
  }

  /**
   * Reject every subsequent call with an **item unsuitability** failure.
   *
   * Like {@link failWithUnavailable}, this deliberately leaves `capability()`
   * alone: the engine stays `ready`, because the problem is the item, not the
   * engine. One unreadable item must never demote an engine for every future
   * item.
   */
  failWithUnsupported(reason: UnsupportedItemReason, detail: string): this {
    return this.failWith(new UnsupportedItemError({ engine: this.engine, reason, detail }));
  }

  /** Reject only the next call with an **item unsuitability** failure. */
  failNextWithUnsupported(reason: UnsupportedItemReason, detail: string): this {
    return this.failNextWith(new UnsupportedItemError({ engine: this.engine, reason, detail }));
  }

  /**
   * Drop recorded calls, options, the probe count and any queued failure, and restore the
   * capability the fake was constructed with. Canned responses survive.
   */
  reset(): void {
    this.#calls.length = 0;
    this.#callOptions.length = 0;
    this.#capabilityCalls = 0;
    this.#capability = this.#initialCapability;
    this.#persistentFailure = undefined;
    this.#nextFailure = undefined;
  }

  capability(): Promise<TranscriberCapability> {
    this.#capabilityCalls += 1;
    return Promise.resolve(this.#capability);
  }

  async transcribe(item: S, bytes: Blob, options?: TranscribeOptions): Promise<Transcript> {
    this.#calls.push({ item, bytes });
    this.#callOptions.push(options);

    const failure = this.#takeFailure();
    if (failure) throw failure;

    return this.#respondTo(item.id);
  }

  #takeFailure(): Error | undefined {
    const next = this.#nextFailure;
    if (next) {
      this.#nextFailure = undefined;
      return next;
    }
    return this.#persistentFailure;
  }

  #respondTo(recordingId: string): Transcript {
    const canned = this.#responses.get(recordingId);
    if (canned === undefined) {
      return this.#transcript(recordingId, this.#defaultText, this.#defaultConfidence);
    }
    if (typeof canned === "string") {
      return this.#transcript(recordingId, canned, undefined);
    }
    return this.#transcript(recordingId, canned.text, canned.confidence);
  }

  #transcript(recordingId: string, text: string, confidence: number | undefined): Transcript {
    const base = { recordingId, text, engine: this.engine };
    return confidence === undefined ? base : { ...base, confidence };
  }
}
