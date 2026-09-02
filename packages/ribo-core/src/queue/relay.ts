import type { ExtractionUsage } from "../extractor.js";
import type { Transcriber } from "../transcriber.js";
import { transcriptSchema } from "../transcript.js";
import {
  fullJitterDelay,
  isTransientFailure,
  TerminalQueueError,
  type BackoffOptions,
} from "./backoff.js";
import { holdLock, relayItemLock, relaySessionLock } from "./capture-lock.js";
import type { Outbox } from "./outbox.js";
import { isActiveStatus } from "./schema.js";
import type { OutboxItem, OutboxPatch } from "./schema.js";
import type { SessionItem, SessionPatch } from "./session-schema.js";
import { joinSessionTranscript } from "./session-extract.js";
import type { ConnectivityState, ConnectivityStatus, Unsubscribe } from "../connectivity.js";

/** Structured fields produced by extraction. */
export type ExtractedFieldMap = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Session-level step interfaces
// ---------------------------------------------------------------------------

export interface SessionExtractInput {
  session: SessionItem;
  /** The joined transcript text of all transcribed recordings, in capture order. */
  transcript: string;
  /** The recording ids that produced `transcript`, sorted — the cache key. */
  recordingIds: readonly string[];
}

/**
 * What one extraction step produced: the fields, and optionally which engine
 * produced them.
 */
export interface ExtractStepResult {
  readonly fields: ExtractedFieldMap;
  readonly engine?: string;
  /**
   * What the run cost and which strategy produced it, persisted onto the session.
   *
   * `engine` above is kept as its own member rather than read off here: it is
   * existing public API and it already has a home on the session document
   * (`extractedBy`). This carries the rest — the strategy that won a ladder, the
   * call count, and the token totals including prefix-cache hits — which the step
   * seam used to drop on the floor.
   */
  readonly usage?: ExtractionUsage;
}

/** Joined transcripts → structured fields. Network-bound, so it is a queued step. */
export type SessionExtractStep = (input: SessionExtractInput) => Promise<ExtractStepResult>;

export interface SessionWriteInput {
  session: SessionItem;
  /**
   * The values review settled on — unwrapped from provenance envelopes by
   * `resolveReview`. Never empty: a review that rejected every field never
   * reaches the write step.
   */
  reviewed: ExtractedFieldMap;
  /**
   * Send this as `Idempotency-Key`. Stable across every retry of this session.
   */
  idempotencyKey: string;
  /**
   * The write context, from the session's `ctx` — set at open, opaque to core.
   * The session owns the destination; the relay does not read recordings for it.
   */
  ctx: unknown;
}

/** Fields → the host tool. Anything returned is persisted as `writeResult`. */
export type SessionWriteStep = (input: SessionWriteInput) => Promise<ExtractedFieldMap | void>;

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/**
 * The connectivity slice the relay watches: just the subscription. A full
 * `Connectivity` model satisfies it structurally.
 */
export interface ConnectivitySource {
  subscribe(listener: (state: ConnectivityState) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Relay options
// ---------------------------------------------------------------------------

export interface RelayOptions extends BackoffOptions {
  outbox: Outbox;
  transcriber: Transcriber;
  /** Session-level extraction: joined transcripts → structured fields. */
  sessionExtract: SessionExtractStep;
  /** Session-level write: reviewed fields → host tool. */
  sessionWrite: SessionWriteStep;
  locks?: LockManager;
  now?: () => number;
  maxAttempts?: number;
  stepTimeoutMs?: number;
  isTransient?: (error: unknown) => boolean;
  dropAudioAfterTranscription?: boolean;
  onError?: (error: unknown, item: OutboxItem | SessionItem) => void;
}

// ---------------------------------------------------------------------------
// Relay interface
// ---------------------------------------------------------------------------

export interface Relay {
  syncNow(): Promise<void>;
  start(connectivity?: ConnectivitySource): Promise<void>;
  stop(): void;
  settled(): Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const DEFAULT_STEP_TIMEOUT_MS = 900_000;

async function withTimeout<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `relay: the ${step} step did not settle within ${ms} ms — failing the attempt so ` +
                  `the queue keeps draining rather than stalling behind it`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Whether the relay would act on this session status. */
function isSessionActive(status: string): boolean {
  return status === "extracting" || status === "writing" || status === "failed";
}

/** Which session step still has to run, derived from persisted outputs. */
/**
 * Which step an active session is due for.
 *
 * **Status first, data second.** This used to read `extracted` alone, which was
 * correct only while the sole route into `extracting` was the first close of a
 * never-extracted session. `reopenSessionForReview` can now park a session that
 * already HAS an extraction back in `extracting`, because its recording set
 * moved — and under the data-only rule that session went to the write step
 * instead, hit the missing `reviewOutcome` reopen had just cleared, and died.
 * A re-extraction request has to be expressible.
 *
 * `failed` stays data-driven and must: it is resting mid-cycle and its status no
 * longer names the step it was in. A session that failed during extraction has
 * no `extracted`; one that failed during the write does.
 */
function sessionNextStep(session: SessionItem): "extract" | "write" {
  if (session.status === "extracting") return "extract";
  if (session.status === "writing") return "write";
  if (session.extracted === undefined) return "extract";
  return "write";
}

const SESSION_STEP_STATUS = {
  extract: "extracting",
  write: "writing",
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRelay(options: RelayOptions): Relay {
  return new QueueRelay(options);
}

/**
 * The foreground relay: drains recordings (transcribe) and sessions (extract,
 * write), one at a time, lowest `seq` / `openedAt` first.
 *
 * **Two drain phases.** The relay first tries to transcribe the next pending
 * recording; if there is none, it tries to process the next pending session
 * (extract or write). Recordings are drained first because session-level
 * extraction joins transcripts — a recording still being transcribed would be
 * missed by the extraction if the session were processed first.
 *
 * **No background drain and no timer.** iOS Safari has no Background Sync, so
 * retry eligibility is persisted (`nextAttemptAt`) rather than scheduled.
 */
class QueueRelay implements Relay {
  readonly #options: RelayOptions;
  readonly #now: () => number;
  readonly #isTransient: (error: unknown) => boolean;
  readonly #maxAttempts: number;
  #unsubscribe: Unsubscribe | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#isTransient = options.isTransient ?? isTransientFailure;
    this.#maxAttempts = options.maxAttempts ?? 8;
  }

  syncNow(): Promise<void> {
    const next = this.#chain.then(() => this.#drain());
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async start(connectivity?: ConnectivitySource): Promise<void> {
    if (connectivity) this.#watch(connectivity);
    await this.syncNow();
  }

  #watch(connectivity: ConnectivitySource): void {
    let previous: ConnectivityStatus | undefined;
    this.#unsubscribe = connectivity.subscribe((state) => {
      const prior = previous;
      previous = state.status;
      if (prior === undefined) return;
      if (state.status === "online" && prior !== "online") {
        void this.syncNow().catch(() => undefined);
      }
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async settled(): Promise<void> {
    let previous: Promise<void> | undefined;
    while (previous !== this.#chain) {
      previous = this.#chain;
      await previous;
    }
  }

  async #drain(): Promise<void> {
    for (;;) {
      // 1. Live needs the worker: do not admit new items while anything is recording.
      const [recording] = await this.#options.outbox.list({ status: ["recording"], limit: 1 });
      if (recording) return;

      // 2. Drain recordings: transcribe the next pending one.
      const item = await this.#options.outbox.nextPending();
      if (item) {
        if (Date.parse(item.nextAttemptAt) > this.#now()) return;
        const held = await holdLock(
          relayItemLock(item.id),
          async () => {
            const fresh = await this.#options.outbox.get(item.id);
            if (!fresh) return false;
            if (!isActiveStatus(fresh.status)) return false;
            if (Date.parse(fresh.nextAttemptAt) > this.#now()) return false;
            return await this.#processRecordingStep(fresh);
          },
          this.#options.locks ?? navigator.locks,
        );
        if (held === undefined) return;
        if (!(await held.ready)) return;
        continue;
      }

      // 3. Drain sessions: extract or write the next pending one.
      const session = await this.#options.outbox.nextPendingSession();
      if (session) {
        if (Date.parse(session.nextAttemptAt) > this.#now()) return;
        const held = await holdLock(
          relaySessionLock(session.id),
          async () => {
            const fresh = await this.#options.outbox.getSession(session.id);
            if (!fresh) return false;
            if (!isSessionActive(fresh.status)) return false;
            if (Date.parse(fresh.nextAttemptAt) > this.#now()) return false;
            return await this.#processSessionStep(fresh);
          },
          this.#options.locks ?? navigator.locks,
        );
        if (held === undefined) return;
        if (!(await held.ready)) return;
        continue;
      }

      return;
    }
  }

  // -----------------------------------------------------------------------
  // Recording: transcribe only
  // -----------------------------------------------------------------------

  async #processRecordingStep(item: OutboxItem): Promise<boolean> {
    try {
      await this.#patch(item.id, { status: "transcribing" });
      await this.#transcribe(item);
      return true;
    } catch (error) {
      this.#options.onError?.(error, item);
      const parked = await this.#recordFailure(item, error);
      return !parked;
    }
  }

  async #transcribe(item: OutboxItem): Promise<void> {
    const audio = await this.#options.outbox.getAudio(item.id);
    if (!audio) {
      throw new TerminalQueueError(`audio attachment is missing for item ${item.id}`);
    }
    const transcript = transcriptSchema.parse(
      await withTimeout(
        this.#options.transcriber.transcribe(item.recording, audio),
        this.#options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
        "transcribe",
      ),
    );
    // Transitions to `transcribed` — extraction and write are session-level now.
    // Routed through `writeTranscript` so `preview` is deleted in the same revision.
    await this.#options.outbox.writeTranscript(item.id, transcript, {
      status: "transcribed",
      attempts: 0,
    });
    if (this.#options.dropAudioAfterTranscription) {
      await this.#options.outbox.dropAudio(item.id);
    }
  }

  /** Records a transcription failure. Returns true if parked for retry, false if dead. */
  async #recordFailure(item: OutboxItem, error: unknown): Promise<boolean> {
    const attempts = item.attempts + 1;
    const lastError = messageOf(error);
    const exhausted = attempts >= this.#maxAttempts;

    if (!this.#isTransient(error) || exhausted) {
      await this.#patch(item.id, { status: "dead", attempts, lastError });
      return false;
    }

    const delay = fullJitterDelay(item.attempts, this.#options);
    await this.#patch(item.id, {
      status: "failed",
      attempts,
      lastError,
      nextAttemptAt: new Date(this.#now() + delay).toISOString(),
    });
    return true;
  }

  // -----------------------------------------------------------------------
  // Session: extract and write
  // -----------------------------------------------------------------------

  async #processSessionStep(session: SessionItem): Promise<boolean> {
    const step = sessionNextStep(session);
    try {
      await this.#patchSession(session.id, { status: SESSION_STEP_STATUS[step] });
      await this.#runSessionStep(step, session);
      return true;
    } catch (error) {
      this.#options.onError?.(error, session);
      const parked = await this.#recordSessionFailure(session, error);
      return !parked;
    }
  }

  async #runSessionStep(step: "extract" | "write", session: SessionItem): Promise<void> {
    if (step === "extract") return await this.#sessionExtract(session);
    return await this.#sessionWrite(session);
  }

  async #sessionExtract(session: SessionItem): Promise<void> {
    const { text, recordingIds } = await joinSessionTranscript(this.#options.outbox, session.id);

    const result = await withTimeout(
      this.#options.sessionExtract({ session, transcript: text, recordingIds }),
      this.#options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      "session-extract",
    );

    await this.#patchSession(session.id, {
      extracted: result.fields,
      ...(result.engine !== undefined ? { extractedBy: result.engine } : {}),
      // Spread as a plain record: the session document schema is loose here on
      // purpose, and an absent `usage` must leave the field absent rather than
      // writing `undefined` into a strictObject parse.
      ...(result.usage !== undefined ? { extractionUsage: { ...result.usage } } : {}),
      extractedFromRecordingIds: recordingIds,
      status: "awaiting-review",
      attempts: 0,
    });
  }

  async #sessionWrite(session: SessionItem): Promise<void> {
    const outcome = session.reviewOutcome;
    if (outcome === undefined || outcome.status === "discarded") {
      throw new TerminalQueueError(
        `session ${session.id} reached the write step with no review outcome. ` +
          "Nothing is written that a human has not reviewed; move sessions forward with Outbox.submitSessionReview.",
      );
    }

    if (Object.keys(outcome.fields).length === 0) {
      const cause =
        outcome.status === "edited"
          ? "the review rejected every field"
          : "the extraction produced no fields to review";
      throw new TerminalQueueError(
        `session ${session.id} reached the write step with nothing to write — ${cause}. ` +
          "To try again, re-park with Outbox.reopenSessionForReview(id); to abandon, Outbox.patchSession(id, { status: 'done' }).",
      );
    }

    const writeResult = await withTimeout(
      this.#options.sessionWrite({
        session,
        reviewed: outcome.fields,
        idempotencyKey: session.idempotencyKey,
        ctx: session.ctx,
      }),
      this.#options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      "session-write",
    );

    await this.#patchSession(session.id, {
      status: "done",
      attempts: 0,
      // A session that failed once and then succeeded should not carry the
      // error it recovered from — an amend would present a stale failure as
      // current. Nothing else clears this field.
      lastError: undefined,
      ...(writeResult ? { writeResult } : {}),
    });
  }

  /** Records a session-level failure. Returns true if parked for retry, false if dead. */
  async #recordSessionFailure(session: SessionItem, error: unknown): Promise<boolean> {
    const attempts = session.attempts + 1;
    const lastError = messageOf(error);
    const exhausted = attempts >= this.#maxAttempts;

    if (!this.#isTransient(error) || exhausted) {
      await this.#patchSession(session.id, { status: "dead", attempts, lastError });
      return false;
    }

    const delay = fullJitterDelay(session.attempts, this.#options);
    await this.#patchSession(session.id, {
      status: "failed",
      attempts,
      lastError,
      nextAttemptAt: new Date(this.#now() + delay).toISOString(),
    });
    return true;
  }

  // -----------------------------------------------------------------------
  // Patches
  // -----------------------------------------------------------------------

  async #patch(id: string, patch: OutboxPatch): Promise<void> {
    await this.#options.outbox.patch(id, patch);
  }

  async #patchSession(id: string, patch: SessionPatch): Promise<void> {
    await this.#options.outbox.patchSession(id, patch);
  }
}
