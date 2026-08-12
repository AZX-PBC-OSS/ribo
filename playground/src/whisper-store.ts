import { OnDeviceTranscriber, type PrimeProgress } from "@azx/ribo-transcriber-ondevice";

import { messageOf } from "./format.js";

/**
 * @file On-device Whisper availability and priming — Phase 3, Task 5.
 *
 * The store that owns the one shared {@link OnDeviceTranscriber} (the model
 * download control and the queue drain must use the SAME instance and its one
 * warm worker) and reports, honestly, whether the model can transcribe right
 * now: cached and `ready`, `needs-download` with its real size, or unavailable.
 *
 * ## Priming is explicit and user-initiated (plan Task 2 / Phase 2.5 "Decided")
 *
 * Nothing here fetches the model on a timer or a queue drain. {@link primeModel}
 * runs only when the user presses the button — a ~300 MB fetch over what may be
 * cellular data is a decision the product makes deliberately, never a surprise.
 *
 * ## Store shape
 *
 * Same pattern as `storage-store.ts` / `update-store.ts`: a module singleton, a
 * listener set, and a `getWhisperState` returning a stable object identity so
 * `useSyncExternalStore` does not loop. One style for every app-level concern.
 */

/**
 * Domain jargon that biases the Whisper decoder toward energy-audit vocabulary
 * (the decisive reason Whisper was chosen — it is the only candidate exposing a
 * biasing hook; see the package's `config.ts`).
 *
 * TODO: source this from `@azx/ribo-adapter-snuggpro`'s vocabulary once it
 * exposes one — the adapter is where tool-specific knowledge belongs (AGENTS.md
 * §4, doc 03). It is a real 51-leaf adapter today, but nothing on it exposes a
 * biasing vocabulary yet, so the list is inline here, mirroring
 * `transcribe.manual.ts`.
 */
export const DOMAIN_VOCABULARY = [
  "R-value",
  "CFM25",
  "CFM50",
  "ACH50",
  "AFUE",
  "blower door",
  "backdrafting",
  "flue",
];

/** Same-origin ORT runtime base served by `serveOrtRuntime` in `vite.config.ts`. */
const WASM_PATHS = "/ort/";

/**
 * Real one-time download size for `whisper-base.en` **fp32**: ~290 MB of weights
 * plus the ~24 MB Chromium ORT binary.
 *
 * The package registry now quotes the measured ~314 MB fp32 total for base.en
 * (Task 4), so this override no longer papers over a stale value — it just keeps
 * the store's `downloadBytes` a single local constant across every phase. fp32 is
 * the one dtype proven to prime (q4/q8 do not load on the pinned ORT build), and
 * the consent screen quotes this real cost. Passed as `downloadBytes` so the
 * capability report the UI reads quotes it.
 */
export const WHISPER_MODEL_BYTES = 314 * 1024 * 1024;

export type WhisperPhase =
  /** Probing the Cache API for an existing download. */
  | "checking"
  /** No Cache API / the engine cannot run here. */
  | "unsupported"
  /** Capable, but the model must be downloaded first. */
  | "needs-download"
  /** Download + cache in progress. */
  | "downloading"
  /** Model cached — transcription works, offline included. */
  | "ready"
  /** A probe or download threw. */
  | "error";

export interface WhisperProgress {
  /** Bytes fetched so far, summed across the files seen. */
  readonly loaded: number;
  /** Total bytes, summed across the files that advertised a length. */
  readonly total: number;
  /** 0–1 aggregate. Best-effort: it counts only files whose length is known yet. */
  readonly fraction: number;
}

export interface WhisperState {
  readonly phase: WhisperPhase;
  /** Bytes to download, for the consent screen. */
  readonly downloadBytes: number;
  /** Model id, for display. */
  readonly detail?: string;
  /** Present while `downloading`. */
  readonly progress?: WhisperProgress;
  /** Present on `error` / `unsupported`. */
  readonly message?: string;
}

let state: WhisperState = { phase: "checking", downloadBytes: WHISPER_MODEL_BYTES };

const listeners = new Set<() => void>();

function setState(next: WhisperState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Subscribe to state changes. Returns its own unsubscribe handle. */
export function subscribeToWhisper(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current state, stable by identity until something changes. */
export function getWhisperState(): WhisperState {
  return state;
}

let transcriber: OnDeviceTranscriber | undefined;

/**
 * The shared on-device transcriber, constructed on first use.
 *
 * One instance for the whole app: the model-download control and the queue drain
 * relay must both hold THIS transcriber so they share one warm worker and one
 * cached model. `device` is left unset so transformers.js auto-selects WebGPU
 * where the pinned build has it (the phase's Chromium+WebGPU target) and falls
 * back to WASM otherwise; `dtype: "fp32"` is the one that loads (Task 2).
 */
export function getTranscriber(): OnDeviceTranscriber {
  transcriber ??= new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    dtype: "fp32",
    downloadBytes: WHISPER_MODEL_BYTES,
    // No `hints`. The default model is Moonshine now, and it cannot be primed — passing hints
    // THROWS at construction rather than silently doing nothing, because a prefix replaces the
    // transcript instead of biasing it. `DOMAIN_VOCABULARY` below is kept: it is still the right
    // list, it is what a whisper-* configuration would pass, and deleting it would lose the one
    // record of which terms this domain actually needs biasing toward — so it is exported rather
    // than left as dead weight lint would (correctly) reject.
    createWorker: () =>
      new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" }),
  });
  return transcriber;
}

let started = false;

/**
 * Probe capability once on first mount. Idempotent, so StrictMode's double mount
 * asks the browser once. Reads the Cache API only — no download.
 */
export function startWhisper(): void {
  if (started) return;
  started = true;
  void refreshCapability();
}

/** Re-read whether the model is cached, and republish the phase it implies. */
export async function refreshCapability(): Promise<void> {
  // Never clobber an in-flight download with a probe result.
  if (state.phase === "downloading") return;
  setState({ ...state, phase: "checking" });
  try {
    const capability = await getTranscriber().capability();
    if (capability.status === "ready") {
      setState({ phase: "ready", downloadBytes: WHISPER_MODEL_BYTES });
    } else if (capability.status === "needs-download") {
      setState({
        phase: "needs-download",
        downloadBytes: capability.downloadBytes,
        detail: capability.detail,
      });
    } else {
      setState({
        phase: "unsupported",
        downloadBytes: WHISPER_MODEL_BYTES,
        message: capability.detail,
      });
    }
  } catch (cause: unknown) {
    setState({ phase: "error", downloadBytes: WHISPER_MODEL_BYTES, message: messageOf(cause) });
  }
}

let priming = false;

/**
 * Download and cache the model, streaming aggregated progress into the store.
 *
 * Explicit and user-initiated: called only from the "Make available offline"
 * button. Idempotent while a download is in flight. A warm cache re-reads rather
 * than re-downloads, so a second call resolves quickly to `ready`.
 */
export function primeModel(): void {
  if (priming) return;
  priming = true;
  const perFile = new Map<string, { loaded: number; total: number }>();
  setState({
    phase: "downloading",
    downloadBytes: state.downloadBytes,
    detail: state.detail,
    progress: { loaded: 0, total: 0, fraction: 0 },
  });
  void getTranscriber()
    .prime((event) => {
      accumulate(perFile, event);
    })
    .then(() => {
      setState({ phase: "ready", downloadBytes: state.downloadBytes, detail: state.detail });
    })
    .catch((cause: unknown) => {
      setState({ phase: "error", downloadBytes: state.downloadBytes, message: messageOf(cause) });
    })
    .finally(() => {
      priming = false;
    });
}

/**
 * Fold one per-file progress datum into an overall bar.
 *
 * transformers.js reports bytes per file (config, tokenizer, each `.onnx`
 * shard), so an overall percentage is a sum across files. The aggregate `total`
 * only reflects files seen so far, so the fraction moves as new files appear —
 * honest for a multi-file download, and never runs ahead of 100%.
 */
function accumulate(
  perFile: Map<string, { loaded: number; total: number }>,
  event: PrimeProgress,
): void {
  if (event.stage === "progress") {
    perFile.set(event.file, { loaded: event.loaded, total: event.total });
  } else if (event.stage === "done") {
    const seen = perFile.get(event.file);
    if (seen && seen.total > 0) perFile.set(event.file, { loaded: seen.total, total: seen.total });
    else return;
  } else {
    return; // "initiate" / "download" carry no bytes
  }

  let loaded = 0;
  let total = 0;
  for (const file of perFile.values()) {
    loaded += file.loaded;
    total += file.total;
  }
  const fraction = total > 0 ? Math.min(loaded / total, 1) : 0;
  setState({ ...state, progress: { loaded, total, fraction } });
}
