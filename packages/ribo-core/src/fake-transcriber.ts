import type { Recording } from "./recording.js";
import type { Transcript } from "./transcript.js";
import {
  TranscriberUnavailableError,
  type Transcriber,
  type TranscriberCapability,
  type TranscriberUnavailableReason,
} from "./transcriber.js";

/** Text a {@link FakeTranscriber} returns when nothing else is configured. */
export const DEFAULT_FAKE_TRANSCRIPT_TEXT = "fake transcript";

/** `Transcriber.engine` a {@link FakeTranscriber} reports unless told otherwise. */
export const DEFAULT_FAKE_TRANSCRIBER_ENGINE = "fake";

/** A canned response: bare text, or text plus a confidence to echo back. */
export type FakeTranscriberResponse = string | { text: string; confidence?: number };

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
  /** Canned responses keyed by `recording.id`. */
  responses?: Readonly<Record<string, FakeTranscriberResponse>>;
  /** Starting capability. Defaults to `{ status: "ready" }`. */
  capability?: TranscriberCapability;
}

/** One `transcribe` invocation, in call order. */
export interface FakeTranscribeCall {
  readonly recording: Recording;
  readonly audio: Blob;
}

/**
 * A {@link Transcriber} that returns canned text instead of running a model.
 *
 * This is a shipped deliverable, not test scaffolding: Phases 4–6 need to drive the capture →
 * transcribe → extract → review → write pipeline end to end without loading weights, the queue's
 * retry paths need a transcriber that fails on demand, and Phase 3's download UI needs to render
 * every capability state before there is anything to download.
 *
 * It can simulate all three capability states and **both** kinds of failure, which is the
 * distinction the whole contract turns on:
 *
 * - attempt failure — {@link failWith} / {@link failNextWith} with any error;
 * - capability failure — {@link failWithUnavailable}, or the same setters with a
 *   `TranscriberUnavailableError` for a one-shot.
 */
export class FakeTranscriber implements Transcriber {
  readonly engine: string;

  readonly #calls: FakeTranscribeCall[] = [];
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
  get calls(): readonly FakeTranscribeCall[] {
    return this.#calls;
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
   * Drop recorded calls, the probe count and any queued failure, and restore the capability the
   * fake was constructed with. Canned responses survive.
   */
  reset(): void {
    this.#calls.length = 0;
    this.#capabilityCalls = 0;
    this.#capability = this.#initialCapability;
    this.#persistentFailure = undefined;
    this.#nextFailure = undefined;
  }

  capability(): Promise<TranscriberCapability> {
    this.#capabilityCalls += 1;
    return Promise.resolve(this.#capability);
  }

  async transcribe(recording: Recording, audio: Blob): Promise<Transcript> {
    this.#calls.push({ recording, audio });

    const failure = this.#takeFailure();
    if (failure) throw failure;

    return this.#respondTo(recording.id);
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
