import type { ChatCapability } from "@azx/ribo-extractor-openai";
import type { ScheduleTimer } from "@azx/ribo-core";

import type { LanguageModel, LanguageModelPrompt, LanguageModelSession } from "./capability.js";
import { probeLanguageModel } from "./capability.js";

/**
 * How long a base session is kept after the last active clone finishes.
 *
 * The next call re-creates the base, paying the warm `create()` cost again, but
 * holding a model in memory forever is worse for a queue drain that may run
 * once and then idle for hours. 30s is long enough to absorb the seven-group
 * burst, short enough not to pin weights needlessly.
 */
export const DEFAULT_SESSION_IDLE_MS = 30_000;

export interface SessionHolderOptions {
  readonly languageModel: LanguageModel;
  /** Standing context: the system prompt and any few-shot turns. */
  readonly initialPrompts?: readonly LanguageModelPrompt[];
  /** How long to keep the base alive after the last clone is destroyed. */
  readonly idleMs?: number;
  /** Injectable timer, so tests can drive the idle window without sleeping. */
  readonly scheduleTimer?: ScheduleTimer;
}

const defaultScheduleTimer: ScheduleTimer = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs);
  return () => clearTimeout(id);
};

/**
 * Thrown when the holder cannot build a base session because the model is not
 * `available`. This is a capability failure, not a transport failure: the caller
 * should surface it as a `ChatCapability` rather than retrying blindly.
 */
export class SessionCapabilityError extends Error {
  override readonly name = "SessionCapabilityError";

  constructor(readonly capability: ChatCapability) {
    super(sessionCapabilityMessage(capability));
  }
}

/**
 * Owns the on-device model session lifecycle.
 *
 * One base session is created **lazily** on the first call and carries the
 * standing prompt (system + few-shot). Every call receives a **clone** of that
 * base, so the seven per-group extractions do not pile groups 1–6 into group 7's
 * context in a 9,216-token window. The base is destroyed after an idle period,
 * freeing the device to unload the model.
 *
 * The lazy create path never runs when availability is not `"available"`. Chrome
 * throws `NotAllowedError` from a background queue drain when availability is
 * `"downloadable"` or `"downloading"`, and surfacing that as a raw error would
 * hide the real reason: the model was never primed.
 */
export class SessionHolder {
  readonly #languageModel: LanguageModel;
  readonly #initialPrompts: readonly LanguageModelPrompt[];
  readonly #idleMs: number;
  readonly #scheduleTimer: ScheduleTimer;

  #basePromise?: Promise<LanguageModelSession>;
  #baseSession?: LanguageModelSession;
  #activeCount = 0;
  #cancelIdle?: () => void;

  constructor(options: SessionHolderOptions) {
    this.#languageModel = options.languageModel;
    this.#initialPrompts = options.initialPrompts ?? [];
    this.#idleMs = options.idleMs ?? DEFAULT_SESSION_IDLE_MS;
    this.#scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
  }

  /**
   * Run a piece of work against a fresh clone of the base session.
   *
   * The clone is destroyed after the work finishes, throws, or aborts. The base
   * is retained and reused for the next call until the idle window elapses.
   */
  async run<T>(work: (session: LanguageModelSession) => Promise<T>): Promise<T> {
    const session = await this.#acquire();
    try {
      return await work(session);
    } finally {
      this.#release(session);
    }
  }

  async #acquire(): Promise<LanguageModelSession> {
    this.#cancelIdleTimer();

    if (this.#baseSession) {
      return this.#cloneFromBase(this.#baseSession);
    }

    if (!this.#basePromise) {
      this.#basePromise = this.#createBase();
    }

    const base = await this.#basePromise;
    return this.#cloneFromBase(base);
  }

  async #createBase(): Promise<LanguageModelSession> {
    try {
      const capability = await probeLanguageModel(this.#languageModel);
      if (capability.status !== "ready") {
        throw new SessionCapabilityError(capability);
      }

      const session = await this.#languageModel.create({
        initialPrompts: this.#initialPrompts,
      });
      this.#baseSession = session;
      return session;
    } catch (error) {
      this.#basePromise = undefined;
      throw error;
    }
  }

  async #cloneFromBase(base: LanguageModelSession): Promise<LanguageModelSession> {
    this.#activeCount++;
    try {
      return await base.clone();
    } catch (error) {
      this.#endRun();
      throw error;
    }
  }

  #release(session: LanguageModelSession): void {
    session.destroy();
    this.#endRun();
  }

  #endRun(): void {
    this.#activeCount = Math.max(0, this.#activeCount - 1);
    if (this.#activeCount === 0 && this.#baseSession) {
      this.#startIdleTimer();
    }
  }

  #startIdleTimer(): void {
    this.#cancelIdleTimer();
    this.#cancelIdle = this.#scheduleTimer(() => this.#destroyBase(), this.#idleMs);
  }

  #cancelIdleTimer(): void {
    this.#cancelIdle?.();
    this.#cancelIdle = undefined;
  }

  #destroyBase(): void {
    this.#baseSession?.destroy();
    this.#baseSession = undefined;
    this.#basePromise = undefined;
    this.#cancelIdle = undefined;
  }
}

function sessionCapabilityMessage(capability: ChatCapability): string {
  if (capability.status === "ready") {
    return "Language model session is ready";
  }
  if (capability.status === "needs-download") {
    return `Language model session needs download: ${capability.detail ?? "primed model required"}`;
  }
  return `Language model session unavailable: ${capability.reason} — ${capability.detail}`;
}
