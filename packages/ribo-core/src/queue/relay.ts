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
  /**
   * The values review settled on — flat, already unwrapped from their provenance
   * envelopes by `resolveReview`, which is the shape `ToolAdapter.write(fields, ctx)`
   * wants.
   *
   * **This replaced an `extracted` field carrying the model's raw envelope map,
   * and the rename is the point.** Two similarly-named fields here would make
   * "wrote the un-reviewed values" a one-word typo with a silent symptom and a
   * customer's audit as the blast radius. The raw envelopes are still available as
   * `item.extracted` for provenance and diagnostics.
   *
   * Never empty. A review that rejected every field never reaches a write step —
   * see the guard in `#write` — so an implementation does not have to decide what
   * writing nothing would mean.
   */
  reviewed: ExtractedFieldMap;
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
 *
 * An item parked at `awaiting-review` has `extracted`, so this returns `"write"`
 * for it as well. That is not a hole, and making this status-aware is not the
 * fix: `awaiting-review` is absent from `ACTIVE_OUTBOX_STATUSES`, so the relay is
 * never handed a parked item in the first place — that omission is the review
 * gate, and `#write`'s refusal to write without a `reviewOutcome` is the defence
 * in depth behind it. Two half-gates would leave neither obviously in charge.
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
    // Parks for a human rather than advancing to `writing`. `awaiting-review` is
    // not in ACTIVE_OUTBOX_STATUSES, so `nextPending()` stops selecting this item
    // and the drain moves on to the next capture. `Outbox.submitReview` is the
    // only thing that moves it forward.
    await this.#patch(item.id, { extracted, status: "awaiting-review", attempts: 0 });
  }

  async #write(item: OutboxItem): Promise<void> {
    const outcome = item.reviewOutcome;
    if (outcome === undefined || outcome.status === "discarded") {
      // Unreachable through the state machine: `awaiting-review` is not active, so
      // only `submitReview` moves an item to `writing`, and a discard moves it to
      // `discarded` instead. Reaching here means the invariant broke, and writing
      // un-reviewed data to a customer's tool is not an acceptable way to find out.
      throw new TerminalQueueError(
        `outbox item ${item.id} reached the write step with no review outcome. Nothing is written that a human has not reviewed; move items forward with Outbox.submitReview.`,
      );
    }

    if (Object.keys(outcome.fields).length === 0) {
      // Reachable, unlike the guard above: `resolveReview` classifies "the human
      // rejected every field" as `edited` with no fields — deliberately, because
      // rejecting everything is a statement about the *extraction* where discarding
      // is a statement about the recording — and `submitReview` unparks that
      // outcome to `writing` like any other edit rather than collapsing it into a
      // discard and destroying audio nobody asked to throw away. So the refusal
      // belongs here, at the one place that decides what may reach the host tool.
      //
      // Refused rather than left to `ToolAdapter.schema.parse`: the relay is never
      // handed an adapter — `RelayOptions` has no field for one, and `write` is a
      // bare host-supplied function — so "a real schema would reject an empty field
      // set" is a guarantee nothing on this path enforces. A human who means "there
      // is nothing to record here" edits the field to `null`, which keeps the key
      // (`review.ts` draws exactly that distinction); rejecting every field means
      // write nothing, and there is no such thing as writing nothing to a
      // customer's audit.
      //
      // The cause is branched because both branches are reachable and they are
      // different events: an `accepted` outcome with no fields is `resolveReview`
      // answering a request that had no fields at all — an extraction that found
      // nothing — and blaming a reviewer for rejecting fields they were never shown
      // would send an operator looking in the wrong place.
      const cause =
        outcome.status === "edited"
          ? "the review rejected every field"
          : "the extraction produced no fields to review";
      // The remedy names what the API can actually do. `submitReview` is not a
      // route back: it accepts only `awaiting-review`, and this item is about to be
      // `dead`, so re-parking is `Outbox.reopenForReview` — the one method that
      // accepts `dead` as a source status precisely for this case — and nothing else.
      throw new TerminalQueueError(
        `outbox item ${item.id} reached the write step with nothing to write — ${cause}. An empty field set is never written. To try again, re-park the item with Outbox.reopenForReview(id) and review it afresh; to abandon it, Outbox.remove(id).`,
      );
    }

    const writeResult = await this.#options.write({
      item,
      reviewed: outcome.fields,
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
