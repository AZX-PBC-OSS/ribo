import { createCaptureCoordinator, type CaptureCoordinator } from "@azx/ribo-ui-react";

/**
 * @file One {@link CaptureCoordinator} per page load — the handle that carries
 * capture health from `useRecorder` across to `useWorkSafety`.
 *
 * It exists because those two hooks cannot see each other. `RiboProvider` passes
 * the host's instance object through unchanged and constructs nothing, so a
 * session created inside one hook is invisible to a sibling. The coordinator is
 * the host-owned object both ends resolve through, which is why it is
 * constructed here beside the recorder and the outbox rather than by the
 * provider.
 *
 * A module singleton for the same two reasons as its siblings: StrictMode's
 * double mount and Vite's HMR both otherwise leave a second coordinator holding
 * a subscription to a session nobody reads.
 *
 * It is genuinely optional in the API. Without it the app records durably just
 * the same — `workSafety` simply never sees capture health, so it cannot say
 * `recording` or `capture-stalled` and falls back to its storage-and-queue
 * answer.
 */

interface HotData {
  captureCoordinator?: CaptureCoordinator;
}

const hotData = import.meta.hot?.data as HotData | undefined;

let handle: CaptureCoordinator | undefined = hotData?.captureCoordinator;

/** The shared capture coordinator, constructing it on first call. */
export function getCaptureCoordinator(): CaptureCoordinator {
  handle ??= createCaptureCoordinator();
  if (hotData) hotData.captureCoordinator = handle;
  return handle;
}
