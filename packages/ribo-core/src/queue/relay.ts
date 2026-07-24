import type { Transcriber } from "../transcriber.js";
import type { Transcript } from "../transcript.js";
import { transcriptSchema } from "../transcript.js";
import {
  fullJitterDelay,
  isTransientFailure,
  TerminalQueueError,
  type BackoffOptions,
} from "./backoff.js";
import type { Outbox } from "./outbox.js";
import type { OutboxItem, OutboxPatch } from "./schema.js";
import type { ConnectivityState, ConnectivityStatus, Unsubscribe } from "../connectivity.js";

/** Structured fields produced by extraction. Kept loose until Phase 4 owns it. */
export type ExtractedFieldMap = Record<string, unknown>;

export interface ExtractStepInput {
  item: OutboxItem;
  transcript: Transcript;
}

/** Transcript → structured fields. Network-bound, so it is a queued step. */
export type ExtractStep = (input: ExtractStepInput) => Promise<ExtractedFieldMap>;

export interface WriteStepInput {
  item: OutboxItem;
  extracted: ExtractedFieldMap;
  /**
   * Send this as `Idempotency-Key`. It is stable across every retry of this item,
   * which is the only thing standing between an ambiguous success and a
   * double-write.
   */
  idempotencyKey: string;
}

/** Fields → the host tool. Anything returned is persisted as `writeResult`. */
export type WriteStep = (input: WriteStepInput) => Promise<ExtractedFieldMap | void>;

/**
 * The connectivity slice the relay watches: just the subscription. A full
 * `Connectivity` model (`connectivity.ts`) satisfies it structurally.
 *
 * The relay drains on the **rising edge into `online`** — the *stably-online*
 * edge the connectivity model only asserts after its probe holds healthy across
 * the stability window — and never on the raw browser `online` event. `09` and
 * the connectivity model explain why: `navigator.onLine` lies (a captive portal
 * reports `true`), and a marginal signal flaps, so draining on every raw
 * `online` gives drain → fail → back off → drain on repeat. Watching the
 * hysteresis edge instead is what makes the relay quiet across a flapping
 * boundary. `ribo-core` stays headless (AGENTS.md §4): the relay never touches
 * `window`; it is handed a model built over injected fakes.
 */
export interface ConnectivitySource {
  subscribe(listener: (state: ConnectivityState) => void): Unsubscribe;
}

export interface RelayOptions extends BackoffOptions {
  outbox: Outbox;
  transcriber: Transcriber;
  extract: ExtractStep;
  write: WriteStep;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Failures after which an item is declared `dead`. Defaults to 8. */
  maxAttempts?: number;
  /** Override the transient/terminal decision. Defaults to {@link isTransientFailure}. */
  isTransient?: (error: unknown) => boolean;
  /**
   * Delete the audio attachment as soon as transcription succeeds
   * (`09 §"What goes where"`: it shrinks storage and shortens how long a
   * recording of someone's home sits on the device).
   *
   * Defaults to `false` because Phase 2's whole visible payoff is reloading the
   * playground and finding the audio still there. Turn it on once transcription
   * is real and its output is trusted.
   */
  dropAudioAfterTranscription?: boolean;
  /** Notified about every failure, for logging. Never throws into the relay. */
  onError?: (error: unknown, item: OutboxItem) => void;
}

export interface Relay {
  /**
   * Drain now — the explicit "Sync now" button. Resolves when the drain ends.
   *
   * This is the **manual path, and it bypasses hysteresis on purpose**: it
   * drains immediately without consulting connectivity, so a human pressing the
   * button means "try now regardless" even while the model reports `offline`.
   * (If there really is no route, the steps fail fast and park under backoff —
   * pressing the button can never make things worse.)
   */
  syncNow(): Promise<void>;
  /**
   * Drain once (the app-start trigger) and, if a `connectivity` model is given,
   * drain again on each **stably-online edge** it asserts — never on the raw
   * browser `online` event. The app owns the connectivity model's own
   * start/stop lifecycle; the relay only subscribes to it.
   */
  start(connectivity?: ConnectivitySource): Promise<void>;
  /** Detach the connectivity subscription `start` attached. Does not cancel a running drain. */
  stop(): void;
  /** Resolves once any in-flight or queued drain has finished. */
  settled(): Promise<void>;
}

/** Which step still has to run, derived from what has already been persisted. */
type Step = "transcribe" | "extract" | "write";

/**
 * The step the item needs next, read off its persisted outputs rather than off
 * its status.
 *
 * This is what makes a crash resumable. `status` records what was *in flight*
 * when the tab died and is therefore untrustworthy — an item stuck at
 * `transcribing` may have finished transcribing microseconds before the crash.
 * The outputs cannot lie: a persisted transcript means transcription is done.
 */
function nextStep(item: OutboxItem): Step {
  if (!item.transcript) return "transcribe";
  if (!item.extracted) return "extract";
  return "write";
}

const STEP_STATUS = {
  transcribe: "transcribing",
  extract: "extracting",
  write: "writing",
} as const;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createRelay(options: RelayOptions): Relay {
  return new QueueRelay(options);
}

/**
 * The foreground relay: drains the outbox one item at a time, lowest `seq` first.
 *
 * **There is no background drain and there is no timer.** iOS Safari has no
 * Background Sync (`09 §"Foreground relay"`), so pretending otherwise would give
 * us a schedule that works on the Surface and silently does nothing on an iPad.
 * Retry eligibility is therefore *persisted*, not scheduled: `nextAttemptAt` sits
 * in IndexedDB and is compared against the clock the next time something in the
 * foreground asks for a drain.
 */
class QueueRelay implements Relay {
  readonly #options: RelayOptions;
  readonly #now: () => number;
  readonly #isTransient: (error: unknown) => boolean;
  readonly #maxAttempts: number;
  #unsubscribe: Unsubscribe | undefined;

  /**
   * Serializes drains. Concurrency 1 is a requirement, not an optimisation: two
   * overlapping drains would both claim the head item and write the external tool
   * twice — the idempotency key would save the remote side, but the local state
   * machine would still be racing itself.
   */
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
    // App start is itself a drain trigger: a tab that was closed mid-queue has
    // work waiting and nothing else will notice. Like `syncNow`, this drain is
    // unconditional — it does not wait for the connectivity model to settle,
    // because the very first thing a reopened tab should do is try.
    await this.syncNow();
  }

  /**
   * Subscribe to the connectivity model and drain on the rising edge into
   * `online`.
   *
   * The model emits immediately on subscribe; that first emission only
   * establishes the baseline and never drains (app start already drained
   * unconditionally, so treating it as an edge would double up). After that, a
   * transition *into* `online` from any other state is the stably-online edge —
   * and the only automatic drain trigger. `probing` and `offline` never drain,
   * and a repeated `online` (already online) does not either.
   */
  #watch(connectivity: ConnectivitySource): void {
    let previous: ConnectivityStatus | undefined;
    this.#unsubscribe = connectivity.subscribe((state) => {
      const prior = previous;
      previous = state.status;
      if (prior === undefined) return; // baseline emission, not an edge
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
    // Awaiting `#chain` once can miss work: a drain that is still running may
    // itself extend the chain, and a trigger that fires while we wait appends to
    // it too. Loop until the chain stops changing.
    let previous: Promise<void> | undefined;
    while (previous !== this.#chain) {
      previous = this.#chain;
      await previous;
    }
  }

  /**
   * Process items until the queue is empty, the head is not yet due, or an item
   * fails.
   *
   * Stopping on failure is deliberate. The head item is the head for a reason —
   * `09` asks for capture order to be preserved — so once it is parked behind a
   * backoff window there is nothing behind it that may legitimately overtake it.
   * Retrying it immediately in the same drain would defeat the backoff entirely.
   */
  async #drain(): Promise<void> {
    for (;;) {
      const item = await this.#options.outbox.nextPending();
      if (!item) return;
      if (Date.parse(item.nextAttemptAt) > this.#now()) return;
      const progressed = await this.#processStep(item);
      if (!progressed) return;
    }
  }

  /** Run exactly one step. Returns false if the drain should stop here. */
  async #processStep(item: OutboxItem): Promise<boolean> {
    const step = nextStep(item);
    try {
      await this.#patch(item.id, { status: STEP_STATUS[step] });
      await this.#runStep(step, item);
      return true;
    } catch (error) {
      this.#options.onError?.(error, item);
      const parked = await this.#recordFailure(item, error);
      // A parked (`failed`) item is still the head of the queue and must not be
      // overtaken, so the drain stops. A `dead` one has left the queue for good
      // and blocking behind it would strand every later capture forever.
      return !parked;
    }
  }

  async #runStep(step: Step, item: OutboxItem): Promise<void> {
    if (step === "transcribe") return await this.#transcribe(item);
    if (step === "extract") return await this.#extract(item);
    return await this.#write(item);
  }

  async #transcribe(item: OutboxItem): Promise<void> {
    const audio = await this.#options.outbox.getAudio(item.id);
    if (!audio) {
      // Nothing will bring the bytes back — most likely iOS evicted the origin's
      // storage (`09 §iOS`, eviction is all-or-nothing). Retrying forever would
      // just hide it, so this surfaces as `dead` for attention.
      throw new TerminalQueueError(`audio attachment is missing for item ${item.id}`);
    }
    const transcript = transcriptSchema.parse(
      await this.#options.transcriber.transcribe(item.recording, audio),
    );
    // Persisted BEFORE the status moves on, so a crash between the two lands on
    // "transcript present, status stale" — which `nextStep` reads correctly —
    // rather than "status advanced, transcript lost".
    await this.#patch(item.id, { transcript, status: "extracting", attempts: 0 });
    if (this.#options.dropAudioAfterTranscription) {
      await this.#options.outbox.dropAudio(item.id);
    }
  }

  async #extract(item: OutboxItem): Promise<void> {
    const extracted = await this.#options.extract({ item, transcript: item.transcript! });
    await this.#patch(item.id, { extracted, status: "writing", attempts: 0 });
  }

  async #write(item: OutboxItem): Promise<void> {
    const writeResult = await this.#options.write({
      item,
      extracted: item.extracted!,
      idempotencyKey: item.idempotencyKey,
    });
    await this.#patch(item.id, {
      status: "done",
      attempts: 0,
      ...(writeResult ? { writeResult } : {}),
    });
  }

  /** Records the failure. Returns true if the item was parked for retry, false if it died. */
  async #recordFailure(item: OutboxItem, error: unknown): Promise<boolean> {
    const attempts = item.attempts + 1;
    const lastError = messageOf(error);
    const exhausted = attempts >= this.#maxAttempts;

    if (!this.#isTransient(error) || exhausted) {
      await this.#patch(item.id, { status: "dead", attempts, lastError });
      return false;
    }

    // 09's formula takes the attempt count *before* this failure, so the first
    // retry draws from [0, base].
    const delay = fullJitterDelay(item.attempts, this.#options);
    await this.#patch(item.id, {
      status: "failed",
      attempts,
      lastError,
      nextAttemptAt: new Date(this.#now() + delay).toISOString(),
    });
    return true;
  }

  async #patch(id: string, patch: OutboxPatch): Promise<void> {
    await this.#options.outbox.patch(id, patch);
  }
}
