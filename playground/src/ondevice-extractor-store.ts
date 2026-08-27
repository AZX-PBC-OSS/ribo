import {
  OnDeviceChat,
  type DownloadProgressEvent,
  type LanguageModel,
} from "@azx/ribo-extractor-ondevice";

import { messageOf } from "./format.js";

/**
 * @file On-device extraction availability and priming — Task 14.
 *
 * The store that owns the shared {@link OnDeviceChat} instance used by the
 * playground's composite extractor. One instance for the whole app: the arming
 * control and the extraction path must never disagree about state.
 *
 * ## Priming is explicit and user-initiated (spec §3.3)
 *
 * Chrome's Prompt API throws `NotAllowedError` from `create()` when the model is
 * `downloadable` and there is no user gesture — measured, not documented. So
 * {@link primeOnDeviceExtractor} runs only when the user presses the button.
 * Nothing here fetches the model on a timer, a mount, or a connectivity change.
 *
 * ## The download is Chrome-managed and of unknown size
 *
 * The Prompt API reports progress as a 0..1 fraction with `total` always 1. There
 * is no byte count. The consent copy says the size is unknown and the wait is
 * minutes (measured ~5.4 minutes cold) rather than quoting an invented megabyte
 * figure or leaving a bare percentage with no time estimate.
 *
 * ## Store shape
 *
 * Same pattern as `whisper-store.ts`: a module singleton, a listener set, and a
 * `getOnDeviceExtractorState` returning a stable object identity so
 * `useSyncExternalStore` does not loop.
 */

export type OnDeviceExtractorPhase =
  /** Probing whether the Prompt API is present and downloaded. */
  | "checking"
  /** The API is absent or reports unavailable. */
  | "unsupported"
  /** Capable, but the model must be downloaded first. */
  | "needs-download"
  /** Download in progress. */
  | "downloading"
  /** Model downloaded — extraction can run offline. */
  | "ready"
  /** A probe or download threw. */
  | "error";

export interface OnDeviceExtractorProgress {
  /** 0..1 fraction. The Prompt API does not expose bytes. */
  readonly fraction: number;
}

export interface OnDeviceExtractorState {
  readonly phase: OnDeviceExtractorPhase;
  /** Model detail, when the platform reports one. */
  readonly detail?: string;
  /** Present while `downloading`. */
  readonly progress?: OnDeviceExtractorProgress;
  /** Present on `error` / `unsupported`. */
  readonly message?: string;
}

let state: OnDeviceExtractorState = { phase: "checking" };

const listeners = new Set<() => void>();

function setState(next: OnDeviceExtractorState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Subscribe to state changes. Returns its own unsubscribe handle. */
export function subscribeToOnDeviceExtractor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current state, stable by identity until something changes. */
export function getOnDeviceExtractorState(): OnDeviceExtractorState {
  return state;
}

let languageModelOverride: LanguageModel | undefined;

/**
 * Test seam: replace the language model the singleton reads from
 * `globalThis.LanguageModel`. Resetting the store also resets this override.
 */
export function setOnDeviceExtractorLanguageModel(languageModel: LanguageModel): void {
  languageModelOverride = languageModel;
}

let extractor: OnDeviceChat | undefined;

/**
 * The shared on-device chat client, constructed on first use.
 *
 * Reads `globalThis.LanguageModel` if no test override is set, and falls back to
 * an unavailable stub so the store can report `unsupported` rather than throwing
 * at construction time.
 */
export function getOnDeviceExtractor(): OnDeviceChat {
  extractor ??= new OnDeviceChat({
    languageModel: languageModelOverride ?? getGlobalLanguageModel() ?? unavailableLanguageModel(),
  });
  return extractor;
}

/**
 * Reset the store to a clean state. Exported for tests: the module singleton holds
 * state across test cases, so each test must start from a known initial state.
 */
export function resetOnDeviceExtractorStoreForTests(languageModel?: LanguageModel): void {
  languageModelOverride = languageModel;
  extractor = undefined;
  started = false;
  priming = false;
  state = { phase: "checking" };
  listeners.clear();
}

/** Read the Chrome Prompt API global, or `undefined` if absent. */
function getGlobalLanguageModel(): LanguageModel | undefined {
  return (globalThis as unknown as { LanguageModel?: LanguageModel }).LanguageModel;
}

/** A stub that reports `unavailable` so the store renders an honest message. */
function unavailableLanguageModel(): LanguageModel {
  return {
    availability: async () => "unavailable",
    create: async () => {
      throw new Error("On-device language model is not available on this platform");
    },
  };
}

let started = false;

/**
 * Probe capability once on first mount. Idempotent, so StrictMode's double mount
 * asks the browser once. Reads `availability()` only — no `create()` call.
 */
export function startOnDeviceExtractor(): void {
  if (started) return;
  started = true;
  void refreshOnDeviceExtractorCapability();
}

/** Re-read whether the model is downloaded, and republish the phase it implies. */
export async function refreshOnDeviceExtractorCapability(): Promise<void> {
  // Never clobber an in-flight download with a probe result.
  if (state.phase === "downloading") return;
  setState({ ...state, phase: "checking" });
  try {
    const capability = await getOnDeviceExtractor().capability();
    if (capability.status === "ready") {
      setState({ phase: "ready" });
    } else if (capability.status === "needs-download") {
      setState({
        phase: "needs-download",
        detail: capability.detail,
      });
    } else {
      setState({
        phase: "unsupported",
        message: capability.detail,
      });
    }
  } catch (cause: unknown) {
    setState({ phase: "error", message: messageOf(cause) });
  }
}

let priming = false;

/**
 * Download the on-device model, forwarding progress into the store.
 *
 * Explicit and user-initiated: called only from the "Arm this device for offline
 * extraction" button. Idempotent while a download is in flight. A warm cache
 * re-reads rather than re-downloads, so a second call resolves quickly to
 * `ready`.
 */
export function primeOnDeviceExtractor(): void {
  if (priming) return;
  priming = true;
  setState({
    phase: "downloading",
    detail: state.detail,
    progress: { fraction: 0 },
  });
  void getOnDeviceExtractor()
    .prime((event: DownloadProgressEvent) => {
      setState({ ...state, progress: { fraction: event.loaded / event.total } });
    })
    .then((capability) => {
      if (capability.status === "ready") {
        setState({ phase: "ready" });
      } else {
        setState({ phase: "unsupported", message: capability.detail });
      }
    })
    .catch((cause: unknown) => {
      setState({ phase: "error", message: messageOf(cause) });
    })
    .finally(() => {
      priming = false;
    });
}
