import type { ExtractionUsage, ExtractOptions } from "../extractor.js";
import type { AnnotatedTranscript } from "../annotated-transcript.js";
import type { CapturePayload } from "../capture-item.js";
import type { Transcriber } from "../transcriber.js";
import { transcriptSchema } from "../transcript.js";
import {
  fullJitterDelay,
  isTransientFailure,
  TerminalError,
  type BackoffOptions,
} from "./backoff.js";
import { holdLock, relayItemLock, relaySessionLock } from "./capture-lock.js";
import type { Storage } from "./storage.js";
import { isActiveStatus } from "./capture-schema.js";
import type { Capture, CapturePatch } from "./capture-schema.js";
import type { SessionItem, SessionPatch } from "./session-schema.js";
import { listSessionTranscriptParts } from "./session-extract.js";
import { createDefaultTranscriptCombiner } from "../transcript-combiner.js";
import type { TranscriptCombiner } from "../transcript-combiner.js";
import type { ConnectivityState, ConnectivityStatus, Unsubscribe } from "../connectivity.js";

/** Structured fields produced by extraction. */
export type ExtractedFieldMap = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Session-level step interfaces
// ---------------------------------------------------------------------------

export interface SessionExtractInput {
  session: SessionItem;
  /** The joined transcript of all transcribed recordings, in capture order. */
  transcript: AnnotatedTranscript;
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
  /**
   * Per-group verbatim spans where the roster recorded an explicit "none of
   * these," surfaced from `scopedInstanceExtractor`. Persisted as its own
   * session field (`statedEmptyGroups`), consulted by `buildReviewRequest` to
   * produce the `"statedEmpty"` group state. Absent for any extractor that does
   * not use a roster.
   */
  readonly statedEmptyGroups?: Readonly<Record<string, string>>;
}

/**
 * Joined transcripts → structured fields. Network-bound, so it is a queued step.
 *
 * The optional second parameter carries the same {@link ExtractOptions} bag
 * `Extractor.extract` takes — deliberately the same type in the same position,
 * because {@link toSessionExtractStep} collapses one contract onto the other and
 * the forward has to be a pure hand-through, not a re-pack. The relay passes a
 * signal it aborts when the step's timeout fires, so a timed-out extraction
 * cancels its in-flight request instead of leaving it running behind the
 * rejection.
 */
export type SessionExtractStep = (
  input: SessionExtractInput,
  options?: ExtractOptions,
) => Promise<ExtractStepResult>;

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

/**
 * What a session write step resolves with.
 *
 * `fields` is unchanged from today's bare return value (persisted as
 * `writeResult`); `receipts` is new and persisted onto `session.receipts`,
 * additively.
 */
export interface SessionWriteResult {
  readonly fields?: ExtractedFieldMap;
  readonly receipts?: {
    readonly singleton?: string;
    readonly instances?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
}

/**
 * Fields → the host tool. `result.fields` is persisted as `writeResult`;
 * `result.receipts` is persisted onto `session.receipts` (merged, additive).
 */
export type SessionWriteStep = (input: SessionWriteInput) => Promise<SessionWriteResult | void>;

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/**
 * The connectivity slice the relay watches: just the subscription. A full
 * `Connectivity` model satisfies it structurally.
 */
export interface ConnectivitySource {
  subscribe: (listener: (state: ConnectivityState) => void) => Unsubscribe;
}

// ---------------------------------------------------------------------------
// Relay options
// ---------------------------------------------------------------------------

/**
 * What {@link RelayOptions.onError} is handed: a tagged union the relay
 * constructs at each call site, where a recording and a session are already
 * distinguishable. Nothing is persisted — the discriminant lives at the
 * callback boundary only (design §0.6). A `switch (subject.kind)` reaches a
 * correctly-typed document with no cast.
 */
export type RelaySubject =
  | { readonly kind: "recording"; readonly item: Capture }
  | { readonly kind: "session"; readonly session: SessionItem };

export interface RelayOptions extends BackoffOptions {
  outbox: Storage;
  /**
   * The transcriber draining the queue. Widened to `Transcriber<CapturePayload>`
   * because `Capture.recording` is now the union — an audio-only
   * `Transcriber<Recording>` no longer typechecks into this slot (the
   * property-typed `transcribe` makes that assignment a type error, which is
   * the point). Wrap with `restrictToKind("audio", …)` to lift a narrow
   * engine.
   */
  transcriber: Transcriber<CapturePayload>;
  /** Session-level extraction: joined transcripts → structured fields. */
  sessionExtract: SessionExtractStep;
  /** Session-level write: reviewed fields → host tool. */
  sessionWrite: SessionWriteStep;
  /**
   * Combines per-capture transcripts into one. The relay supplies the array
   * (already sorted by `seq`); the combiner decides how the texts join.
   * Defaults to {@link createDefaultTranscriptCombiner} (no markers). Inject
   * a custom combiner to replace the combination policy without forking the
   * I/O — the combiner is pure, so it is testable with a plain array and no
   * database.
   */
  combineTranscripts?: TranscriptCombiner;
  locks?: LockManager;
  now?: () => number;
  maxAttempts?: number;
  stepTimeoutMs?: number;
  isTransient?: (error: unknown) => boolean;
  dropAudioAfterTranscription?: boolean;
  onError?: (error: unknown, subject: RelaySubject) => void;
}

// ---------------------------------------------------------------------------
// Relay interface
// ---------------------------------------------------------------------------

export interface Relay {
  syncNow: () => Promise<void>;
  start: (connectivity?: ConnectivitySource) => Promise<void>;
  stop: () => void;
  settled: () => Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const DEFAULT_STEP_TIMEOUT_MS = 900_000;

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  step: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Fire the hook before the rejection so anything it aborts is already
          // unwinding when the caller sees the timeout — the abort is
          // synchronous, so observers of the signal never see a window where
          // the step "timed out" but nothing was cancelled.
          onTimeout?.();
          reject(
            new Error(
              `relay: the ${step} step did not settle within ${ms} ms — failing the attempt so ` +
                `the queue keeps draining rather than stalling behind it`,
            ),
          );
        }, ms);
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
 * Merge new write receipts into the session's existing ones, additively per
 * group. Returns `previous` unchanged when `next` is undefined (nothing new
 * to merge), and `undefined` only when there is nothing at all to persist.
 */
function mergeReceipts(
  previous: SessionItem["receipts"],
  next: SessionWriteResult["receipts"],
): SessionItem["receipts"] | undefined {
  if (next === undefined) return previous;
  const instances: Record<string, Record<string, string>> = { ...previous?.instances };
  for (const [group, byKey] of Object.entries(next.instances ?? {})) {
    instances[group] = { ...instances[group], ...byKey };
  }
  const singleton = next.singleton ?? previous?.singleton;
  if (singleton === undefined && Object.keys(instances).length === 0) return undefined;
  return {
    ...(singleton !== undefined ? { singleton } : {}),
    ...(Object.keys(instances).length > 0 ? { instances } : {}),
  };
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
      const [recording] = await this.#options.outbox.captures.list({
        status: ["recording"],
        limit: 1,
      });
      if (recording) return;

      // 2. Drain recordings: transcribe the next pending one.
      const item = await this.#options.outbox.captures.nextPending();
      if (item) {
        if (Date.parse(item.nextAttemptAt) > this.#now()) return;
        const held = await holdLock(
          relayItemLock(item.id),
          async () => {
            const fresh = await this.#options.outbox.captures.get(item.id);
            if (!fresh) return false;
            if (!isActiveStatus(fresh.status)) return false;
            if (Date.parse(fresh.nextAttemptAt) > this.#now()) return false;
            return await this.#processRecordingStep(fresh);
          },
          this.#options.locks ?? navigator.locks,
        );
        if (held === undefined) return;
        const advanced = await held.ready;
        // Wait for the lock itself, not just the work. `holdLock` resolves
        // `ready` when the step finishes but keeps the lock until the request's
        // own callback settles, so returning here would leave `syncNow` holding
        // a lock it has finished with — and the caller's next `syncNow` would
        // find it busy and silently do nothing. A drain loop that calls
        // `syncNow` twice in a row is the normal shape, so that is a real stall
        // rather than a theoretical one.
        await held.released;
        if (!advanced) return;
        continue;
      }

      // 3. Drain sessions: extract or write the next pending one.
      const session = await this.#options.outbox.sessions.nextPending();
      if (session) {
        if (Date.parse(session.nextAttemptAt) > this.#now()) return;
        const held = await holdLock(
          relaySessionLock(session.id),
          async () => {
            const fresh = await this.#options.outbox.sessions.get(session.id);
            if (!fresh) return false;
            if (!isSessionActive(fresh.status)) return false;
            if (Date.parse(fresh.nextAttemptAt) > this.#now()) return false;
            return await this.#processSessionStep(fresh);
          },
          this.#options.locks ?? navigator.locks,
        );
        if (held === undefined) return;
        const advanced = await held.ready;
        // Wait for the lock itself, not just the work. `holdLock` resolves
        // `ready` when the step finishes but keeps the lock until the request's
        // own callback settles, so returning here would leave `syncNow` holding
        // a lock it has finished with — and the caller's next `syncNow` would
        // find it busy and silently do nothing. A drain loop that calls
        // `syncNow` twice in a row is the normal shape, so that is a real stall
        // rather than a theoretical one.
        await held.released;
        if (!advanced) return;
        continue;
      }

      return;
    }
  }

  // -----------------------------------------------------------------------
  // Recording: transcribe only
  // -----------------------------------------------------------------------

  async #processRecordingStep(item: Capture): Promise<boolean> {
    try {
      await this.#patch(item.id, { status: "transcribing" });
      await this.#transcribe(item);
      return true;
    } catch (error) {
      this.#options.onError?.(error, { kind: "recording", item });
      const parked = await this.#recordFailure(item, error);
      return !parked;
    }
  }

  async #transcribe(item: Capture): Promise<void> {
    const audio = await this.#options.outbox.captures.getAudio(item.id);
    if (!audio) {
      throw new TerminalError(`audio attachment is missing for item ${item.id}`);
    }
    // The step's signal and the step timeout are one mechanism, not two: when
    // the deadline fires the controller aborts, so the transcriber's in-flight
    // work (a fetch request, a worker's chunk loop, a pdf.js loading task) is
    // cancelled rather than left to run to completion behind the rejection.
    // Same wiring as `#sessionExtract` below.
    const stepAbort = new AbortController();
    const transcript = transcriptSchema.parse(
      await withTimeout(
        this.#options.transcriber.transcribe(item.recording, audio, {
          signal: stepAbort.signal,
          // The transcriber's half of the plugin-storage delivery: a handle
          // scoped to THIS capture, with the plugin naming itself through
          // `forPlugin` — the relay cannot know which engine a selection
          // combinator will pick, so it scopes what it knows and the engine
          // supplies the identity it knows. An extractor from the same plugin
          // reads these entries back through `Storage.pluginStorageScope`,
          // minted at that extractor's construction.
          storage: this.#options.outbox.captureStore(item.id),
        }),
        this.#options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
        "transcribe",
        () => stepAbort.abort("relay: the transcribe step timed out"),
      ),
    );
    // Transitions to `transcribed` — extraction and write are session-level now.
    // Routed through `writeTranscript` so `preview` is deleted in the same revision.
    await this.#options.outbox.captures.writeTranscript(item.id, transcript, {
      status: "transcribed",
      attempts: 0,
    });
    if (this.#options.dropAudioAfterTranscription) {
      await this.#options.outbox.captures.dropAudio(item.id);
    }
  }

  /** Records a transcription failure. Returns true if parked for retry, false if dead. */
  async #recordFailure(item: Capture, error: unknown): Promise<boolean> {
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
      this.#options.onError?.(error, { kind: "session", session });
      const parked = await this.#recordSessionFailure(session, error);
      return !parked;
    }
  }

  async #runSessionStep(step: "extract" | "write", session: SessionItem): Promise<void> {
    if (step === "extract") return await this.#sessionExtract(session);
    return await this.#sessionWrite(session);
  }

  async #sessionExtract(session: SessionItem): Promise<void> {
    const { parts, recordingIds } = await listSessionTranscriptParts(
      this.#options.outbox,
      session.id,
    );
    const combine = this.#options.combineTranscripts ?? createDefaultTranscriptCombiner();
    const { text } = combine(parts);

    // The step's signal and the step timeout are one mechanism, not two: when
    // the deadline fires the controller aborts, so the extractor's in-flight
    // request is cancelled rather than left to run to completion behind the
    // rejection. This is the wiring Task 9's changeset named as a motivation
    // and deferred.
    const stepAbort = new AbortController();
    const result = await withTimeout(
      this.#options.sessionExtract(
        { session, transcript: { text, annotations: {} }, recordingIds },
        { signal: stepAbort.signal },
      ),
      this.#options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      "session-extract",
      () => stepAbort.abort("relay: the session-extract step timed out"),
    );

    await this.#patchSession(session.id, {
      extracted: result.fields,
      ...(result.engine !== undefined ? { extractedBy: result.engine } : {}),
      // Spread as a plain record: the session document schema is loose here on
      // purpose, and an absent `usage` must leave the field absent rather than
      // writing `undefined` into a strictObject parse.
      ...(result.usage !== undefined ? { extractionUsage: { ...result.usage } } : {}),
      // Unconditional, not conditional-spread like `extractedBy`/`extractionUsage`
      // above: `statedEmptyGroups` is content about this specific transcript,
      // exactly like `extracted` itself (which is always overwritten). A
      // re-extraction whose new roster no longer states a group is empty must not
      // leave a stale quote from the previous extraction on the session — same
      // reasoning as `lastError: undefined` below.
      statedEmptyGroups: result.statedEmptyGroups,
      extractedFromRecordingIds: recordingIds,
      status: "awaiting-review",
      attempts: 0,
    });
  }

  async #sessionWrite(session: SessionItem): Promise<void> {
    const outcome = session.reviewOutcome;
    if (outcome === undefined || outcome.status === "discarded") {
      throw new TerminalError(
        `session ${session.id} reached the write step with no review outcome. ` +
          "Nothing is written that a human has not reviewed; move sessions forward with Storage.submitSessionReview.",
      );
    }

    if (Object.keys(outcome.fields).length === 0) {
      const cause =
        outcome.status === "edited"
          ? "the review rejected every field"
          : "the extraction produced no fields to review";
      throw new TerminalError(
        `session ${session.id} reached the write step with nothing to write — ${cause}. ` +
          "To try again, re-park with Storage.sessions.reopenForReview(id); to abandon, Storage.sessions.patch(id, { status: 'done' }).",
      );
    }

    const result = await withTimeout(
      this.#options.sessionWrite({
        session,
        reviewed: outcome.fields,
        idempotencyKey: session.idempotencyKey,
        ctx: session.ctx,
      }),
      this.#options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      "session-write",
    );

    const receipts = mergeReceipts(session.receipts, result?.receipts);

    await this.#patchSession(session.id, {
      status: "done",
      attempts: 0,
      // A session that failed once and then succeeded should not carry the
      // error it recovered from — an amend would present a stale failure as
      // current. Nothing else clears this field.
      lastError: undefined,
      ...(result?.fields ? { writeResult: result.fields } : {}),
      ...(receipts ? { receipts } : {}),
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

  async #patch(id: string, patch: CapturePatch): Promise<void> {
    await this.#options.outbox.captures.patch(id, patch);
  }

  async #patchSession(id: string, patch: SessionPatch): Promise<void> {
    await this.#options.outbox.sessions.patch(id, patch);
  }
}
