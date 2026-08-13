import { expect, test } from "vitest";
import type { LiveSession, LiveTranscriber, TranscriberCapability } from "@azx/ribo-core";
import { FakeTranscriber, createRelay } from "@azx/ribo-core";

import { getOutbox } from "./outbox-handle.js";
import { getRecorder } from "./recorder-handle.js";
import { setLiveTranscriber } from "./live-handle.js";

/**
 * @file Does this app actually produce live preview segments during recording?
 *
 * Every live-transcription test in `ribo-core` and `ribo-transcriber-ondevice`
 * builds its own session and feeds it frames, which means all of them pass
 * whether or not any host ever wires the `LiveTranscriber` into the recorder.
 * This file deliberately imports the app's own module singletons rather than
 * constructing anything. `getRecorder()` is the unit under test — not the
 * `Recorder` class, which is already covered, but *this app's configuration of
 * it*. Delete the live wiring from `recorder-handle.ts` (the `onSamples`
 * callback, the `createSampleTap` injection, or the `openLiveForCapture` call
 * in the `captureSession` factory) and the assertions below fail; nothing else
 * in the repo would notice.
 *
 * It uses the real default outbox (`ribo-outbox`) for the same reason: naming a
 * test-only database here would test a wiring the app does not have.
 *
 * The `LiveTranscriber` is faked — the real `OnDeviceLiveTranscriber` needs
 * ~250 MB of model weights that no test should download. The fake's session
 * emits one segment so the preview wiring can be verified end to end: capture
 * session factory → `openLiveForCapture` → `segments$` subscription →
 * `outbox.commitPreview`.
 */

/** Delay from subscription to segment emission — mirrors real inference latency. */
const SEGMENT_DELAY_MS = 200;

/** Polls `read` until it returns a value, or fails the test on timeout. */
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A fake live session that emits one segment after a short delay.
 *
 * `close()` sets a guard flag (matching `OnDeviceLiveSession`'s pattern) rather
 * than completing an observable — the guard, not completion, is what drops
 * late replies after close.
 *
 * The `segments$` is a minimal subscribable: `openLiveSession` calls
 * `.subscribe(next)` and `.unsubscribe()` on the return value, nothing more.
 * Cast through `unknown` because `Observable` is a class with many operators
 * we do not need, and `rxjs` is not a direct dependency of the playground.
 *
 * **The emission countdown starts on subscribe, not at creation.** A real
 * `LiveSession` produces segments in response to audio frames arriving through
 * `feed()` — which only happens after the host has opened the session and
 * subscribed to `segments$`. Starting the `setTimeout` at `createFakeSession`
 * time instead creates a race: `recorder.start()` (which triggers the
 * fire-and-forget `openLiveForCapture` chain that eventually subscribes) can
 * take longer than `SEGMENT_DELAY_MS` under concurrent load (e.g. when the
 * `unit` Vitest project runs alongside the `browser` project). The timer fires
 * before anyone subscribes, the segment is lost, and the test times out.
 * Deferring the countdown to the first `.subscribe()` call mirrors the real
 * session's lifecycle and eliminates the race regardless of how slow the setup
 * path is.
 */
function createFakeSession(text: string): LiveSession {
  const handlers: Array<(value: string) => void> = [];
  const errorHandlers: Array<(value: string) => void> = [];
  let closed = false;
  let armed = false;
  const armEmission = (): void => {
    if (armed) return;
    armed = true;
    setTimeout(() => {
      if (!closed) {
        for (const handler of handlers) handler(text);
      }
    }, SEGMENT_DELAY_MS);
  };
  return {
    sessionId: crypto.randomUUID(),
    segments$: {
      subscribe: (next: (value: string) => void) => {
        handlers.push(next);
        armEmission();
        return {
          unsubscribe: () => {
            const i = handlers.indexOf(next);
            if (i >= 0) handlers.splice(i, 1);
          },
        };
      },
    } as unknown as LiveSession["segments$"],
    errors$: {
      subscribe: (next: (value: string) => void) => {
        errorHandlers.push(next);
        return {
          unsubscribe: () => {
            const i = errorHandlers.indexOf(next);
            if (i >= 0) errorHandlers.splice(i, 1);
          },
        };
      },
    } as unknown as LiveSession["errors$"],
    feed: () => undefined,
    close: () => {
      closed = true;
    },
  };
}

test("a preview segment appears during recording and is gone once the transcript lands", async () => {
  // Inject a fake live transcriber so the preview wiring can be verified
  // without downloading the Moonshine + Silero models.
  const fakeSession = createFakeSession("the attic is R-19");
  const fakeLiveTranscriber: LiveTranscriber = {
    liveCapability: async (): Promise<TranscriberCapability> => ({ status: "ready" }),
    openSession: async () => fakeSession,
  };
  setLiveTranscriber(fakeLiveTranscriber);

  const outbox = await getOutbox();
  await outbox.clear();
  const recorder = getRecorder();

  await recorder.start();

  // Wait for the preview segment to appear on the recording row. This is the
  // whole claim: `openLiveForCapture` (fire-and-forget from the capture session
  // factory) opened a session, subscribed to `segments$`, and the fake emitted
  // a segment that landed on `outbox.commitPreview`. Delete the
  // `openLiveForCapture` call or the `onSamples` wiring and this wait times out.
  const withPreview = await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    if (item?.preview?.committed?.length) return item;
    return undefined;
  }, "a preview segment");
  expect(withPreview.preview!.committed).toContain("the attic is R-19");

  await recorder.stop();

  // Run the relay to produce a transcript. The transcript handoff deletes
  // `preview` in the same committed revision that writes `transcript`, so no
  // subscriber ever sees both. A FakeTranscriber is sufficient — the test
  // verifies the handoff, not the batch transcript's quality.
  const relay = createRelay({
    outbox,
    transcriber: new FakeTranscriber(),
    extract: () => Promise.resolve({}),
    write: () => Promise.resolve(),
  });
  await relay.syncNow();

  const settled = await until(async () => {
    const [item] = await outbox.list({});
    return item?.transcript ? item : undefined;
  }, "the transcript to land");
  expect(settled.transcript).toBeDefined();
  expect(settled.preview).toBeUndefined();

  await outbox.clear();
  setLiveTranscriber(undefined);
});
