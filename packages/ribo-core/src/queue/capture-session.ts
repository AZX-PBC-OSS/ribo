import type { Observable } from "rxjs";
import { BehaviorSubject } from "rxjs";

import type { Outbox } from "./outbox.js";
import type { OutboxItem } from "./schema.js";
import type { Recording } from "../recording.js";
import { chunkName, sliceOversized } from "./chunk-names.js";

/**
 * Capture health — the signal `workSafety` reads to distinguish a healthy
 * recording from one whose persistence has fallen behind.
 *
 * - `"flushing"` — chunks are being written; the unflushed tail is the expected
 *   state of a live recording, not a warning.
 * - `"stalled"` — a chunk write failed, or no `dataavailable` has fired past a
 *   threshold. The recording is still in memory, but nothing new has reached disk.
 */
export type CaptureHealth = "flushing" | "stalled";

/** Placeholder — the real threshold needs a real backgrounded device to choose. */
const STALL_AFTER_MS = 30_000;

/** Max bytes per chunk attachment before byte-slicing kicks in. */
const MAX_CHUNK_BYTES = 10_000_000;

export interface CaptureSessionOptions {
  outbox: Outbox;
  recording: Recording;
  sourceId: string;
  mimeType: string;
  /** The session this recording belongs to. */
  sessionId: string;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable decode function: returns `durationMs` from the merged blob, or
   * throws if it cannot decode. Defaults to `decodeAudioData` on the main thread.
   * Injected so tests can fake it.
   */
  decode?: (blob: Blob) => Promise<number>;
}

export interface CaptureSession {
  /** Synchronous ingestion — appends to an ordered buffer and returns. */
  ingest(blob: Blob): void;
  /** User-initiated `Recorder.resume()` — resets the emission baseline. */
  resumed(): void;
  /** Close ingestion, drain, merge, decode-verify, commit. Resolves when done. */
  finalize(): Promise<{ audio: Blob; durationMs: number; item: OutboxItem }>;
  /** Abort: stop accepting data and remove the row. Fire-and-forget. */
  abort(): void;
  readonly itemId: string;
  readonly sourceId: string;
  readonly health$: Observable<CaptureHealth>;
}

/**
 * Open a capture session — inserts the `recording` row and returns a session
 * that ingests `dataavailable` events and finalises at `stop()`.
 */
export async function openCaptureSession(options: CaptureSessionOptions): Promise<CaptureSession> {
  const outbox = options.outbox;
  const sourceId = options.sourceId;
  const now = options.now ?? (() => Date.now());
  const decode = options.decode ?? decodeAudioDuration;

  const item = await outbox.beginRecording({
    recording: options.recording,
    sourceId,
    sessionId: options.sessionId,
  });

  // BehaviorSubject so a late subscriber immediately sees the current health —
  // `firstValueFrom(health$)` resolves with the present state rather than
  // hanging for the next change. A plain Subject would miss the initial
  // emission and any stall latched before the subscription.
  const health$ = new BehaviorSubject<CaptureHealth>("flushing");

  return new CaptureSessionImpl(item.id, sourceId, options.mimeType, outbox, now, decode, health$);
}

class CaptureSessionImpl implements CaptureSession {
  readonly #itemId: string;
  readonly #sourceId: string;
  readonly #mimeType: string;
  readonly #outbox: Outbox;
  readonly #now: () => number;
  readonly #decode: (blob: Blob) => Promise<number>;
  readonly #health$: BehaviorSubject<CaptureHealth>;

  /** Ordered buffer of ingested blobs, drained by the persistence loop. */
  readonly #buffer: Blob[] = [];
  /** Monotonic chunk counter. */
  #chunkIndex = 0;
  /** Whether ingestion is closed (finalize or abort has been called). */
  #closed = false;
  /** Whether the drain loop is running. */
  #draining = false;
  /** Resolves when the drain loop has caught up to the buffer. */
  #drained: Promise<void> = Promise.resolve();
  /** Last `dataavailable` timestamp, for stall detection. */
  #lastEmission: number;
  /** Whether `resumed()` has reset the baseline since the last emission. */
  #baselineReset = false;
  /** Re-checks for a stall while no `dataavailable` is arriving. Cleared on close. */
  readonly #watchdog: ReturnType<typeof setInterval>;

  /** Whether the health has latched to `stalled`. */
  #stalled = false;

  constructor(
    itemId: string,
    sourceId: string,
    mimeType: string,
    outbox: Outbox,
    now: () => number,
    decode: (blob: Blob) => Promise<number>,
    health$: BehaviorSubject<CaptureHealth>,
  ) {
    this.#itemId = itemId;
    this.#sourceId = sourceId;
    this.#mimeType = mimeType;
    this.#outbox = outbox;
    this.#now = now;
    this.#decode = decode;
    this.#health$ = health$;
    this.#lastEmission = now();
    // Re-check the gap on a timer, because the check in `ingest` only runs when a blob
    // ARRIVES — so a stall in progress was invisible: emission stopping is exactly the
    // condition that prevents the code which notices emission stopping from running.
    // A visible tab whose recorder had quietly died reported `flushing` indefinitely.
    //
    // Honest limit: a frozen or heavily throttled tab suppresses this timer too, so a
    // pocketed phone is still detected late — on resume, via `ingest`'s own check. That
    // is acceptable in a way the visible case is not, because a frozen tab has no
    // observer: nothing is reading `workSafety` while the screen is off.
    this.#watchdog = setInterval(() => {
      if (this.#closed) return;
      if (this.#now() - this.#lastEmission > STALL_AFTER_MS) this.#latchStalled();
    }, STALL_AFTER_MS);
  }

  get itemId(): string {
    return this.#itemId;
  }

  get sourceId(): string {
    return this.#sourceId;
  }

  get health$(): Observable<CaptureHealth> {
    return this.#health$;
  }

  /**
   * Ingestion is SYNCHRONOUS: it appends to an ordered buffer and returns.
   * Persistence drains that buffer separately. One queue would deadlock — a chunk
   * operation that detects a write failure must finalize, and the final
   * `dataavailable` may already be queued behind it.
   */
  ingest(blob: Blob): void {
    if (this.#closed) return;
    const gap = this.#now() - this.#lastEmission;
    // BEFORE updating the timestamp: a late event must detect the interval it
    // missed, or a stall that only becomes observable on resume is never seen.
    if (!this.#baselineReset && gap > STALL_AFTER_MS) {
      this.#latchStalled();
    }
    this.#baselineReset = false;
    this.#lastEmission = this.#now();
    this.#buffer.push(blob);
    void this.#drain();
  }

  /** A user-initiated `Recorder.resume()`. Resets the emission baseline —
   * deliberately NOT called on page restore, which is the whole distinction:
   * one is the user choosing to stop capturing, the other is capture being
   * taken away. */
  resumed(): void {
    this.#baselineReset = true;
    this.#lastEmission = this.#now();
  }

  async finalize(): Promise<{ audio: Blob; durationMs: number; item: OutboxItem }> {
    this.#closed = true;
    clearInterval(this.#watchdog);
    // Await the drain of everything ingested before finalize was called.
    await this.#drained;
    const audio = await this.#outbox.mergeChunks(this.#itemId);
    const durationMs = await this.#decode(audio);
    const item = await this.#outbox.commitRecording(this.#itemId, audio, durationMs);
    this.#health$.complete();
    return { audio, durationMs, item };
  }

  abort(): void {
    this.#closed = true;
    clearInterval(this.#watchdog);
    this.#health$.complete();
    // Fire-and-forget: if the removal fails, startup recovery collects the row.
    void this.#outbox.remove(this.#itemId).catch(() => undefined);
  }

  #latchStalled(): void {
    if (this.#stalled) return;
    this.#stalled = true;
    this.#health$.next("stalled");
  }

  /** Drain the buffer: write each blob as chunk attachment(s). */
  #drain(): Promise<void> {
    // Chain onto the previous drain so they run serially.
    this.#drained = this.#drained.then(() => this.#drainOnce());
    return this.#drained;
  }

  async #drainOnce(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#buffer.length > 0) {
        const blob = this.#buffer.shift()!;
        const slices = sliceOversized(blob, this.#mimeType, MAX_CHUNK_BYTES);
        // ONE chunk index per `dataavailable`, with the slice index distinguishing the
        // pieces it was cut into. Incrementing the chunk index per slice instead made a
        // sliced event look like several separate events — the slice field stayed `00`
        // forever and the naming scheme the design specifies was never produced. Ordering
        // survived either way, which is why nothing caught it.
        const chunkIndex = this.#chunkIndex;
        this.#chunkIndex += 1;
        for (const [sliceIndex, slice] of slices.entries()) {
          let name: string;
          try {
            name = chunkName(this.#sourceId, chunkIndex, sliceIndex);
          } catch (cause) {
            // An index overflow threw from OUTSIDE the write's catch, so it neither
            // latched health nor stopped capture: `ingest` discards this drain with
            // `void`, so it surfaced only at finalize, by which point teardown had run.
            // Treat it as what it is — capture can no longer name its output safely.
            this.#latchStalled();
            this.#closed = true;
            void cause;
            return;
          }
          try {
            await this.#outbox.appendChunk(this.#itemId, name, slice);
          } catch {
            // A failed chunk write latches stalled. The session continues —
            // finalize will still try to merge what did land.
            this.#latchStalled();
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}

/**
 * Decode-verify: prove the merged blob is decodable, and return its duration in
 * milliseconds. Uses `decodeAudioData` on the main thread (`AudioContext` is
 * Window-only). The transcriber decodes through the same route, so a blob that
 * decodes here will decode there.
 *
 * This proves **decodability, not completeness** — it cannot establish that every
 * emitted chunk was persisted, or that a permissive decoder did not accept a
 * truncated tail.
 */
export async function decodeAudioDuration(blob: Blob): Promise<number> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const buffer = await audioContext.decodeAudioData(arrayBuffer);
    return Math.round(buffer.duration * 1000);
  } finally {
    void audioContext.close().catch(() => undefined);
  }
}
