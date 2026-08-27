import type { ChatCapability } from "@azx/ribo-extractor-openai";

export type LanguageModelAvailability =
  "unavailable" | "downloadable" | "downloading" | "available";

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

/** One role-tagged turn of the session's standing context. */
export interface LanguageModelPrompt {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LanguageModelCreateOptions {
  /**
   * **Optional**, because most `create()` calls are not downloads. Only `prime()` — the one
   * call a human triggers — has any progress to report; the lazy session build during a queue
   * drain passes nothing. A fake that assumes this is always present fails the far more common
   * path.
   */
  monitor?: (monitor: LanguageModelMonitor) => void;
  /** Standing context: the system prompt and any few-shot turns. */
  initialPrompts?: readonly LanguageModelPrompt[];
  /** Declared output languages. The model advertises a limited set. */
  expectedOutputs?: readonly { readonly type: "text"; readonly languages: readonly string[] }[];
  signal?: AbortSignal;
}

/** Per-prompt options. `responseConstraint` is what makes the output a schema-shaped JSON. */
export interface LanguageModelPromptOptions {
  responseConstraint?: Record<string, unknown>;
  omitResponseConstraintInput?: boolean;
  signal?: AbortSignal;
}

/**
 * One session. Sessions are the unit of context: a base session carries the standing prompt,
 * and each call runs on a {@link LanguageModelSession.clone} of it so one group's answer never
 * sits in another group's context.
 */
export interface LanguageModelSession {
  /** Total tokens this session can hold, input and output together. Measured at 9,216. */
  readonly contextWindow: number;
  /** Tokens currently consumed by the standing context. */
  readonly contextUsage: number;
  /**
   * Price an input before sending it.
   *
   * Note this **ignores `responseConstraint`**: measured across schemas from 1.5 KB to 26 KB it
   * returned an identical figure, and a 26 KB schema still completed inside a 9,216-token
   * window. The constraint is enforced at the sampler and does not consume context, so pricing
   * the prompt alone is the correct measurement rather than a limitation.
   */
  measureContextUsage(input: string, options?: LanguageModelPromptOptions): Promise<number>;
  promptStreaming(input: string, options?: LanguageModelPromptOptions): AsyncIterable<string>;
  /** A fresh context sharing this session's standing prompt. */
  clone(): Promise<LanguageModelSession>;
  destroy(): void;
}

export interface LanguageModel {
  availability(): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
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
        detail: "The on-device language model is not yet downloaded. Priming is required.",
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
    const session = await languageModel.create({
      monitor: (monitor) => {
        monitor.addEventListener("downloadprogress", (event) => {
          onProgress?.(event);
        });
      },
    });
    // `create()` is the download trigger AND a session factory, and priming wants only the
    // former. The session holder builds its own base session later with the standing prompt
    // this one lacks, so keeping this would pin a model in memory that nothing will ever use.
    session.destroy();
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
