import type { Connectivity, LiveTranscriber, Outbox, Recorder } from "@azx/ribo-core";
import { createContext } from "react";

import type { CaptureCoordinator } from "./capture-coordinator.js";

/**
 * @file The one context this package defines.
 *
 * **The provider carries instances; it never constructs them.** Lifetime lives
 * above React, with the host, and this is not a style preference — it is the
 * playground's scar tissue. StrictMode's double mount opens a second RxDB
 * database over the same IndexedDB name and a second `Recorder` holding a second
 * microphone stream; Vite HMR replaces a module without reloading the page. The
 * fix is a module singleton with `import.meta.hot.data` carry-over
 * (`playground/src/outbox-handle.ts`), which is a **host** discipline. A provider
 * that called `openOutbox()` itself would pull an async open into the render tree
 * and ship that hazard inside the SDK, where a consumer cannot fix it.
 */

/**
 * A `Recorder` whose host context type (`C`) the provider cannot know.
 *
 * `Recorder<C>` uses `C` only in output position (`stop(): Promise<Capture<C>>`),
 * so a narrower recorder is assignable here covariantly. The cost is that
 * `stop()` resolved through context loses the host's `ctx` type; a host that needs
 * it passes its recorder to the hook explicitly. See the plan's open questions.
 */
export type AnyRecorder = Recorder<Record<string, unknown>>;

/**
 * The engine instances a host makes available to the hooks.
 *
 * Every field optional: a host using only capture must not be forced to open a
 * database. Each hook resolves the one it needs and throws if it is absent.
 */
export interface RiboInstances {
  readonly recorder?: AnyRecorder;
  readonly outbox?: Outbox;
  readonly connectivity?: Connectivity;
  readonly captureCoordinator?: CaptureCoordinator;
  /**
   * Optional live transcription engine. When supplied and ready, recording
   * opens a {@link LiveSession} whose `segments$` carries tail/commit
   * distinctions to the outbox row — tails via `writePreviewTail`
   * (provisional, replaced wholesale), commits via `commitPreview`
   * (permanent, appended). The host owns the instance — the provider never
   * constructs one — and the session lifecycle is driven by
   * `recorder.start()`/`stop()` through the host's capture-session wiring,
   * not by the hooks directly.
   */
  readonly liveTranscriber?: LiveTranscriber;
}

/** Empty rather than `undefined`, so "no provider" and "empty provider" fail identically. */
export const RiboContext = createContext<RiboInstances>({});
