/**
 * The type-checked example behind docs/api/use-recorder.html.
 *
 * Calling a hook needs React's renderer plus the browser globals a recorder
 * holds (MediaRecorder, an AudioContext, a microphone), so this file is never
 * executed. It is type-checked by the examples tsconfig (see
 * docs/api/index.md), so the shapes shown on the page are real. Runtime
 * behaviour is covered by
 * packages/ribo-ui-react/src/use-recorder.browser.test.tsx and the e2e suite.
 */

import { useRecorder } from "@azx/ribo-ui-react";

// #region usage
// Hooks run inside a component, never at module scope — this is the component
// body a host would write.
export function RecorderStatus() {
  // With no recorder passed, the hook resolves the provider's — the instance
  // the host constructed and handed to <RiboProvider>. `enqueue` defaults to
  // true, so a `sessionId` is required: every recording is owned by a session.
  const { phase, scaledLevel, error, toggle } = useRecorder({ sessionId: "session-1" });
  console.log(phase, scaledLevel, error, toggle);
  return null;
}
// #endregion usage

// #region stop
// stop() is asymmetric with start() on purpose: start() swallows its failure
// into error state and always resolves; stop() does that AND rethrows,
// because its resolved value carries what the caller needs next. Await it
// inside a try.
export function RecorderStop() {
  const { stop } = useRecorder({ sessionId: "session-1" });
  void (async () => {
    try {
      const { capture, item } = await stop();
      console.log(capture.recording.mimeType, item?.id);
    } catch (cause) {
      console.error(cause);
    }
  })();
  return null;
}
// #endregion stop
