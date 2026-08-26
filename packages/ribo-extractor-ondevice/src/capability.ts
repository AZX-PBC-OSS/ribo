import type { ChatCapability } from "@azx/ribo-extractor-openai";

export type LanguageModelAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export interface DownloadProgressEvent {
  readonly loaded: number;
  readonly total: 1;
}

export interface LanguageModelMonitor {
  addEventListener(
    type: "downloadprogress",
    listener: (event: DownloadProgressEvent) => void,
  ): void;
}

export interface LanguageModelCreateOptions {
  monitor(monitor: LanguageModelMonitor): void;
}

export interface LanguageModel {
  availability(): Promise<LanguageModelAvailability>;
  create(options: LanguageModelCreateOptions): Promise<unknown>;
}

export type PrimeProgressListener = (progress: DownloadProgressEvent) => void;

/**
 * Probe whether an injected Chrome Prompt API `LanguageModel` can run without
 * downloading anything.
 *
 * A capability probe is **cheap and gesture-free**: it reads `availability()` and
 * never calls `create()`. Calling `create()` in the background would kick off a
 * multi-gigabyte model download during a queue drain, which is exactly the
 * mistake the no-background-download rule exists to prevent.
 */
export async function probeLanguageModel(
  languageModel: LanguageModel | undefined,
): Promise<ChatCapability> {
  if (!languageModel) {
    return {
      status: "unavailable",
      reason: "unsupported-platform",
      detail: "The LanguageModel API is not available on this platform.",
    };
  }

  try {
    const availability = await languageModel.availability();

    if (availability === "available") {
      return { status: "ready" };
    }

    if (availability === "downloadable" || availability === "downloading") {
      return {
        status: "needs-download",
        detail:
          "The on-device language model is not yet downloaded. Priming is required.",
      };
    }

    return {
      status: "unavailable",
      reason: "model-unavailable",
      detail: `LanguageModel availability returned "${availability}".`,
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: "unknown",
      detail: `capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Ask the browser to download the on-device model, forwarding progress events.
 *
 * This must be called from a **user gesture** (a click handler). Chrome throws
 * `NotAllowedError` when `availability()` is `downloadable` or `downloading` and
 * there is no gesture, which this function surfaces as an actionable
 * `unavailable`/`not-configured` capability failure rather than a raw
 * transport error.
 */
export async function primeLanguageModel(
  languageModel: LanguageModel,
  onProgress?: PrimeProgressListener,
): Promise<ChatCapability> {
  try {
    await languageModel.create({
      monitor: (monitor) => {
        monitor.addEventListener("downloadprogress", (event) => {
          onProgress?.(event);
        });
      },
    });
    return { status: "ready" };
  } catch (error) {
    if (isNotAllowedError(error)) {
      return {
        status: "unavailable",
        reason: "not-configured",
        detail:
          "Requires a user gesture when availability is downloadable or downloading. Call prime() from a click handler.",
      };
    }
    throw error;
  }
}

function isNotAllowedError(error: unknown): error is DOMException {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError"
  );
}
