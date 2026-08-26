/**
 * @file The connectivity model: a **three-state** view of whether this device
 * can actually reach the network, not merely whether the link layer claims it
 * can.
 *
 * This app's defining condition is a flimsy, spotty offline/online boundary —
 * auditors in basements and attics (`09`). Two facts make a boolean useless:
 *
 * 1. **`navigator.onLine` lies.** It is link-layer state. A captive portal, a
 *    wifi AP with no backhaul, a tower with no route — all report `true`. The
 *    nastiest state is *online-but-useless*, where a request hangs instead of
 *    failing.
 * 2. **Flapping thrashes a naive relay.** Draining on every raw `online` event
 *    gives drain → fail → back off → drain, on repeat.
 *
 * So this model replaces the boolean with three states and adds hysteresis:
 *
 * - **`offline`** — proven unreachable (or `navigator.onLine === false`).
 * - **`probing`** — the link says online but we have not confirmed reachability,
 *   or we confirmed it once and are holding it across the stability window. This
 *   is the hysteresis *made observable*; a downstream "is my work safe?" selector
 *   renders it as "checking…".
 * - **`online`** — a probe succeeded and stayed healthy across the stability
 *   window. The queue relay drains on the edge into *this* state, never on the
 *   raw browser event.
 *
 * ### The load-bearing rules (all settled by research; `09`)
 *
 * - `navigator.onLine === false` is **trusted immediately** (offline-negative is
 *   reliable). `true` is **never trusted without a probe** (online-positive is
 *   not).
 * - The **probe is injected** — `(signal) => Promise<Response>` — with a **hard
 *   abort timeout**, so an online-but-hanging endpoint resolves to `offline`
 *   fast rather than occupying the queue. Abort, DNS failure, a thrown error and
 *   a non-ok response all land as `offline`.
 * - **Hysteresis:** `online` is asserted only after the probe stays healthy for
 *   a stability window; going `offline` is **instant** (you never want to delay
 *   recognising a loss).
 * - **Everything ambient is injected** — the event source, the `navigator.onLine`
 *   reader, the probe, the timer scheduler. `ribo-core` is headless (AGENTS.md
 *   §4, ESLint-enforced): nothing here reaches for `window`, `document` or
 *   `navigator`, which is also what makes it testable with fakes.
 *
 * The subscription mirrors {@link Recorder.subscribe} — an immediate first
 * emission, then one on every change, returning an unsubscribe handle. The
 * injectable event source borrows the *shape* of TanStack Query's
 * `setEventListener(onChange => cleanup)` seam, not the dependency.
 */

/** The three states. `probing` is deliberately not collapsible to a boolean. */
export type ConnectivityStatus = "offline" | "probing" | "online";

/** What a subscriber is pushed. An object, not a bare string, so it can grow. */
export interface ConnectivityState {
  readonly status: ConnectivityStatus;
}

/**
 * The reachability probe.
 *
 * Resolve with an **ok** {@link Response} to report healthy; a non-ok response,
 * a thrown error (DNS failure, `TypeError: Failed to fetch`) or an abort all
 * count as unreachable. Keep it cheap: a `HEAD`/`204` against the gateway health
 * path is the intended shape — a few bytes, no body to read. It is handed an
 * {@link AbortSignal} that fires when the hard timeout elapses; a well-behaved
 * probe passes it to `fetch` so the socket is torn down rather than left hanging.
 */
export type ConnectivityProbe = (signal: AbortSignal) => Promise<Response>;

/**
 * Injectable source of raw online/offline transitions, TanStack-`setEventListener`
 * shaped: it is handed one `onChange` callback to invoke on **every** raw
 * transition, and returns a cleanup that detaches it.
 *
 * The field app wires this to `window` (`online`/`offline`) — and may fold in
 * `document`'s `visibilitychange`, so returning to a backgrounded tab re-checks
 * — each firing the same `onChange`. `onChange` reads {@link isOnline} itself;
 * the callback carries no payload.
 */
export type ConnectivityEventBinder = (onChange: () => void) => () => void;

/**
 * Schedules `fn` to run after `delayMs`, returning a **canceller**.
 *
 * A canceller rather than an opaque handle so the model never has to name a
 * timer id type that differs between node and the browser. Defaults to
 * `setTimeout`/`clearTimeout`; a test injects a hand-driven clock so it can
 * advance the stability window without a real wait and without faking timers
 * around IndexedDB.
 */
export type ScheduleTimer = (fn: () => void, delayMs: number) => () => void;

/** Detaches a {@link Connectivity.subscribe} listener. Safe to call twice. */
export type Unsubscribe = () => void;

export interface ConnectivityOptions {
  /** Source of raw online/offline transitions. See {@link ConnectivityEventBinder}. */
  bindEvents: ConnectivityEventBinder;
  /** Reads link-layer online state. The field app passes `() => navigator.onLine`. */
  isOnline: () => boolean;
  /** The reachability probe. See {@link ConnectivityProbe}. */
  probe: ConnectivityProbe;
  /**
   * Hard deadline for a single probe, in ms. When it elapses the probe is
   * aborted and the model resolves to `offline`. Defaults to
   * {@link DEFAULT_PROBE_TIMEOUT_MS}.
   */
  probeTimeoutMs?: number;
  /**
   * How long a probe must stay healthy before `online` is asserted, in ms.
   * Defaults to {@link DEFAULT_STABILITY_WINDOW_MS}.
   */
  stabilityWindowMs?: number;
  /** Timer seam. Defaults to `setTimeout`/`clearTimeout`. See {@link ScheduleTimer}. */
  schedule?: ScheduleTimer;
}

/**
 * Hard abort deadline for one probe.
 *
 * 5s is long enough that a genuinely slow-but-alive basement uplink still
 * answers, and short enough that an *online-but-useless* endpoint is written off
 * before it can wedge the serial queue. The whole reason the probe is abortable
 * is this number: without it a hung socket would keep the model in `probing`
 * indefinitely.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long the probe must stay healthy before `online` is asserted.
 *
 * This is the hysteresis. It is a deliberate trade: too short and a
 * two-second-long "we're back!" blip drains the queue straight into another
 * failure (drain → fail → back off), which is exactly the thrash we are here to
 * prevent; too long and a real recovery is needlessly delayed while an auditor
 * waits. 3s sits at the knee — long enough to outlast the sub-second flapping of
 * a marginal signal reconnecting, short enough that a genuine return to coverage
 * feels immediate. It pairs with instant offline detection: we are patient about
 * declaring success and never patient about declaring failure.
 */
export const DEFAULT_STABILITY_WINDOW_MS = 3_000;

/** A live connectivity model. Create with {@link createConnectivity}. */
export interface Connectivity {
  /** The current state. Cheap; the model holds it. */
  readonly state: ConnectivityState;
  /**
   * Observe {@link ConnectivityState}. Called **immediately** with the current
   * state, then once on every change. Returns the unsubscribe handle.
   */
  subscribe(listener: (state: ConnectivityState) => void): Unsubscribe;
  /**
   * Bind the event source and evaluate once. Idempotent — a second call while
   * already started is a no-op.
   */
  start(): void;
  /** Unbind the event source, cancel any in-flight probe and pending window. */
  stop(): void;
}

export function createConnectivity(options: ConnectivityOptions): Connectivity {
  return new ConnectivityModel(options);
}

/**
 * The state machine.
 *
 * Reachability is re-evaluated on start and on every raw transition. The whole
 * machine is a reaction to those events plus probe results and two timers — no
 * polling, because probes must stay cheap and the events already tell us when
 * something changed.
 */
class ConnectivityModel implements Connectivity {
  readonly #bindEvents: ConnectivityEventBinder;
  readonly #isOnline: () => boolean;
  readonly #probe: ConnectivityProbe;
  readonly #probeTimeoutMs: number;
  readonly #stabilityWindowMs: number;
  readonly #schedule: ScheduleTimer;

  readonly #listeners = new Set<(state: ConnectivityState) => void>();

  // Unproven until a probe says otherwise, so the honest default is `offline` —
  // consistent with the rule that `true` is never trusted without a probe.
  #status: ConnectivityStatus = "offline";

  #unbind: Unsubscribe | undefined;
  #cancelProbeTimeout: Unsubscribe | undefined;
  #cancelStabilityWindow: Unsubscribe | undefined;
  #probeController: AbortController | undefined;
  /**
   * Monotonic probe generation. Bumped whenever an in-flight probe is
   * superseded (a new event, an offline drop, teardown), so a late-resolving or
   * late-timing-out probe from a previous cycle is ignored instead of clobbering
   * the current state.
   */
  #probeSeq = 0;

  constructor(options: ConnectivityOptions) {
    this.#bindEvents = options.bindEvents;
    this.#isOnline = options.isOnline;
    this.#probe = options.probe;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#stabilityWindowMs = options.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
    this.#schedule = options.schedule ?? ((fn, ms) => scheduleWithTimeout(fn, ms));
  }

  get state(): ConnectivityState {
    return { status: this.#status };
  }

  subscribe(listener: (state: ConnectivityState) => void): Unsubscribe {
    this.#listeners.add(listener);
    listener(this.state);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(): void {
    if (this.#unbind) return;
    this.#unbind = this.#bindEvents(() => this.#evaluate());
    this.#evaluate();
  }

  stop(): void {
    this.#unbind?.();
    this.#unbind = undefined;
    this.#abandonProbe();
    this.#clearStabilityWindow();
    // The probe is gone, so the status must stop claiming one is running:
    // #evaluate() reads `probing` as "already probing" and would refuse to
    // start a new cycle after a restart. `offline` is also the honest answer —
    // a stopped model is not measuring — and returns #status to its initial
    // value, making stop/start symmetric.
    this.#setStatus("offline");
  }

  /**
   * The one entry point for "something changed" — start and every raw event.
   *
   * `false` is trusted instantly. `true` is never trusted: it only ensures a
   * probe cycle is (or already is) running. A redundant `true` while already
   * `online` or already `probing` is intentionally a no-op, so repeated `online`
   * events neither re-probe needlessly nor reset a window that only a genuine
   * loss should reset.
   */
  #evaluate(): void {
    if (!this.#isOnline()) {
      this.#goOffline();
      return;
    }
    if (this.#status === "online" || this.#status === "probing") return;
    this.#beginProbe();
  }

  #beginProbe(): void {
    this.#clearStabilityWindow();
    this.#setStatus("probing");
    this.#runProbe();
  }

  #runProbe(): void {
    const seq = ++this.#probeSeq;
    const controller = new AbortController();
    this.#probeController = controller;

    // The hard deadline. A probe that ignores its signal and hangs forever must
    // still fail fast, so the timeout resolves the cycle on its own rather than
    // waiting for the probe to reject.
    this.#cancelProbeTimeout = this.#schedule(() => {
      controller.abort();
      this.#settleProbe(seq, false);
    }, this.#probeTimeoutMs);

    this.#probe(controller.signal).then(
      (response) => this.#settleProbe(seq, response.ok),
      () => this.#settleProbe(seq, false),
    );
  }

  #settleProbe(seq: number, healthy: boolean): void {
    if (seq !== this.#probeSeq) return; // a superseded cycle — ignore.
    this.#cancelProbeTimeout?.();
    this.#cancelProbeTimeout = undefined;
    this.#probeController = undefined;

    if (!healthy) {
      this.#goOffline();
      return;
    }
    // Healthy — but a single healthy probe is not `online`. Hold `probing` and
    // arm the stability window; only its expiry, uninterrupted by a loss,
    // asserts `online`.
    this.#cancelStabilityWindow = this.#schedule(() => {
      if (seq !== this.#probeSeq) return;
      this.#setStatus("online");
    }, this.#stabilityWindowMs);
  }

  #goOffline(): void {
    this.#abandonProbe();
    this.#clearStabilityWindow();
    this.#setStatus("offline");
  }

  /** Invalidate and abort any in-flight probe and its deadline. */
  #abandonProbe(): void {
    this.#probeSeq += 1;
    this.#cancelProbeTimeout?.();
    this.#cancelProbeTimeout = undefined;
    this.#probeController?.abort();
    this.#probeController = undefined;
  }

  #clearStabilityWindow(): void {
    this.#cancelStabilityWindow?.();
    this.#cancelStabilityWindow = undefined;
  }

  #setStatus(next: ConnectivityStatus): void {
    if (next === this.#status) return;
    this.#status = next;
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }
}

/** The default {@link ScheduleTimer}: `setTimeout` with a `clearTimeout` canceller. */
function scheduleWithTimeout(fn: () => void, delayMs: number): () => void {
  const handle = setTimeout(fn, delayMs);
  return () => clearTimeout(handle);
}
