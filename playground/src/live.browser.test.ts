import { expect, test } from "vitest";
import type {
  LiveSegment,
  LiveSegmentKind,
  LiveSession,
  LiveTranscriber,
  TranscriberCapability,
} from "@azx/ribo-core";
import { FakeTranscriber, createRelay } from "@azx/ribo-core";

import { getOutbox } from "./outbox-handle.js";
import { getRecorder } from "./recorder-handle.js";
import { closeLiveSession, setLiveTranscriber } from "./live-handle.js";

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

/** Extract `next` and `complete` from either subscribe form — function or observer object. */
type SegmentObserver =
  ((value: LiveSegment) => void) | { next?: (value: LiveSegment) => void; complete?: () => void };
type ErrorObserver = ((value: string) => void) | { next?: (value: string) => void };

function nextFn(observer: SegmentObserver): (value: LiveSegment) => void | undefined {
  return typeof observer === "function" ? observer : (observer.next ?? (() => undefined));
}
function completeFn(observer: SegmentObserver): (() => void) | undefined {
  return typeof observer === "function" ? undefined : observer.complete;
}
function errorNextFn(observer: ErrorObserver): (value: string) => void | undefined {
  return typeof observer === "function" ? observer : (observer.next ?? (() => undefined));
}

/**
 * A fake live session that emits one segment after a short delay.
 *
 * `close()` sets a guard flag (matching `OnDeviceLiveSession`'s pattern) rather
 * than completing an observable — the guard, not completion, is what drops
 * late replies after close. `close()` also calls `complete` handlers, simulating
 * the worker's `liveClosed` signal so the host's `complete` callback can tear
 * down the subscription.
 *
 * The `segments$` is a minimal subscribable: `openLiveSession` calls
 * `.subscribe({ next, complete })` and `.unsubscribe()` on the return value,
 * nothing more. Cast through `unknown` because `Observable` is a class with many
 * operators we do not need, and `rxjs` is not a direct dependency of the playground.
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
  const handlers: Array<(value: LiveSegment) => void> = [];
  const completeHandlers: Array<() => void> = [];
  const errorHandlers: Array<(value: string) => void> = [];
  let closed = false;
  let armed = false;
  const armEmission = (): void => {
    if (armed) return;
    armed = true;
    setTimeout(() => {
      if (!closed) {
        for (const handler of handlers) handler({ kind: "commit", text });
      }
    }, SEGMENT_DELAY_MS);
  };
  return {
    sessionId: crypto.randomUUID(),
    segments$: {
      subscribe: (observer: SegmentObserver) => {
        const next = nextFn(observer);
        const complete = completeFn(observer);
        handlers.push(next);
        if (complete) completeHandlers.push(complete);
        armEmission();
        return {
          unsubscribe: () => {
            const i = handlers.indexOf(next);
            if (i >= 0) handlers.splice(i, 1);
            if (complete) {
              const j = completeHandlers.indexOf(complete);
              if (j >= 0) completeHandlers.splice(j, 1);
            }
          },
        };
      },
    } as unknown as LiveSession["segments$"],
    errors$: {
      subscribe: (observer: ErrorObserver) => {
        const next = errorNextFn(observer);
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
      for (const handler of completeHandlers) handler();
    },
  };
}

/**
 * A fake live session that emits a sequence of segments on a schedule.
 *
 * Extends {@link createFakeSession} to test tail/commit routing: each emission
 * carries its own `kind` and `delay` (from the first `subscribe()` call — see
 * {@link createFakeSession} for why emission starts on subscribe, not at
 * creation). The delays are staggered so a polling test can catch intermediate
 * states (a tail before the commit clears it).
 */
function createMultiSegmentSession(
  emissions: ReadonlyArray<{ kind: LiveSegmentKind; text: string; delay: number }>,
): LiveSession {
  const handlers: Array<(value: LiveSegment) => void> = [];
  const completeHandlers: Array<() => void> = [];
  const errorHandlers: Array<(value: string) => void> = [];
  let closed = false;
  let armed = false;
  const armEmission = (): void => {
    if (armed) return;
    armed = true;
    for (const { kind, text, delay } of emissions) {
      setTimeout(() => {
        if (!closed) {
          for (const handler of handlers) handler({ kind, text });
        }
      }, delay);
    }
  };
  return {
    sessionId: crypto.randomUUID(),
    segments$: {
      subscribe: (observer: SegmentObserver) => {
        const next = nextFn(observer);
        const complete = completeFn(observer);
        handlers.push(next);
        if (complete) completeHandlers.push(complete);
        armEmission();
        return {
          unsubscribe: () => {
            const i = handlers.indexOf(next);
            if (i >= 0) handlers.splice(i, 1);
            if (complete) {
              const j = completeHandlers.indexOf(complete);
              if (j >= 0) completeHandlers.splice(j, 1);
            }
          },
        };
      },
    } as unknown as LiveSession["segments$"],
    errors$: {
      subscribe: (observer: ErrorObserver) => {
        const next = errorNextFn(observer);
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
      for (const handler of completeHandlers) handler();
    },
  };
}

/**
 * A fake live session that emits a flush segment **after** `close()` — the
 * exact scenario the bug fix targets.
 *
 * Unlike {@link createFakeSession}, the emission happens in `close()` (after a
 * delay), not on subscribe. This mirrors the real worker's `liveClose` handler:
 * when `close()` is called, the worker drains the final region, transcribes it,
 * and posts it back as a commit — arriving after `close()` returned. The `complete`
 * handlers fire after the flush, simulating the worker's `liveClosed` signal.
 *
 * The `completed` flag is exposed so a test can assert the Subject was completed
 * (i.e. the `complete` callback fired and the host tore down its subscription).
 */
function createFlushSession(
  flushText: string,
): LiveSession & { completed: boolean; unsubscribed: boolean } {
  const handlers: Array<(value: LiveSegment) => void> = [];
  const completeHandlers: Array<() => void> = [];
  const errorHandlers: Array<(value: string) => void> = [];
  let closed = false;
  let completed = false;
  let unsubscribed = false;
  let armed = false;
  const armEmission = (): void => {
    if (armed) return;
    armed = true;
  };
  const session = {
    sessionId: crypto.randomUUID(),
    segments$: {
      subscribe: (observer: SegmentObserver) => {
        const next = nextFn(observer);
        const complete = completeFn(observer);
        handlers.push(next);
        if (complete) completeHandlers.push(complete);
        armEmission();
        return {
          unsubscribe: () => {
            unsubscribed = true;
            const i = handlers.indexOf(next);
            if (i >= 0) handlers.splice(i, 1);
            if (complete) {
              const j = completeHandlers.indexOf(complete);
              if (j >= 0) completeHandlers.splice(j, 1);
            }
          },
        };
      },
    },
    errors$: {
      subscribe: (observer: ErrorObserver) => {
        const next = errorNextFn(observer);
        errorHandlers.push(next);
        return {
          unsubscribe: () => {
            const i = errorHandlers.indexOf(next);
            if (i >= 0) errorHandlers.splice(i, 1);
          },
        };
      },
    },
    feed: () => undefined,
    close: () => {
      if (closed) return;
      closed = true;
      setTimeout(() => {
        for (const handler of handlers) handler({ kind: "commit", text: flushText });
        completed = true;
        for (const handler of completeHandlers) handler();
      }, SEGMENT_DELAY_MS);
    },
    get completed(): boolean {
      return completed;
    },
    get unsubscribed(): boolean {
      return unsubscribed;
    },
  };
  return session as unknown as LiveSession & { completed: boolean; unsubscribed: boolean };
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
    sessionExtract: () => Promise.resolve({ fields: {} }),
    sessionWrite: () => Promise.resolve(),
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

test("a tail appears in preview.tail, a second tail replaces it, a commit moves to committed and clears the tail", async () => {
  // Three emissions on a schedule: two tails then a commit. The 500 ms gap
  // between the second tail and the commit gives the polling loop time to
  // catch the tail before the commit clears it.
  const fakeSession = createMultiSegmentSession([
    { kind: "tail", text: "the attic", delay: SEGMENT_DELAY_MS },
    { kind: "tail", text: "the attic is R-19", delay: SEGMENT_DELAY_MS * 2 },
    { kind: "commit", text: "the attic is R-19", delay: SEGMENT_DELAY_MS * 5 },
  ]);
  const fakeLiveTranscriber: LiveTranscriber = {
    liveCapability: async (): Promise<TranscriberCapability> => ({ status: "ready" }),
    openSession: async () => fakeSession,
  };
  setLiveTranscriber(fakeLiveTranscriber);

  const outbox = await getOutbox();
  await outbox.clear();
  const recorder = getRecorder();

  await recorder.start();

  // Wait for the second tail to replace the first. The tail is "the attic is
  // R-19" (the second text), not "the attic" (the first) — writePreviewTail
  // replaces wholesale, never appends. If tails were routed to commitPreview
  // instead, preview.tail would never exist and this wait would time out.
  const withTail = await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item?.preview?.tail === "the attic is R-19" ? item : undefined;
  }, "the second tail to replace the first");
  expect(withTail.preview!.tail).toBe("the attic is R-19");
  // Tails went to preview.tail, not to committed — the first tail was
  // replaced, not appended. If the routing sent tails to commitPreview,
  // committed would contain "the attic" here.
  expect(withTail.preview!.committed).toEqual([]);

  // Wait for the commit to move text into committed and clear the tail.
  // commitPreview appends to committed and clears tail in one modification,
  // so no subscriber sees the text in both places or in neither.
  const withCommit = await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item?.preview?.committed?.length ? item : undefined;
  }, "the commit to move text into committed");
  expect(withCommit.preview!.committed).toContain("the attic is R-19");
  expect(withCommit.preview!.tail).toBeUndefined();

  await recorder.stop();

  // Run the relay to produce a transcript. The transcript handoff deletes
  // preview in the same committed revision that writes transcript.
  const relay = createRelay({
    outbox,
    transcriber: new FakeTranscriber(),
    sessionExtract: () => Promise.resolve({ fields: {} }),
    sessionWrite: () => Promise.resolve(),
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

// ── Flush-after-close tests ───────────────────────────────────────────────────
//
// The bug: `closeLiveSession()` used to unsubscribe from `segments$` BEFORE
// calling `close()`. The worker's `liveClose` handler drains the final region,
// transcribes it, and posts it as a commit AFTER `close()` returns — but by
// then the subscriber was already gone, so the last ~10 seconds of preview was
// silently lost on every recording. The fix: close first, stay subscribed, and
// tear down when the worker posts `liveClosed` (which completes the `Subject`).

test("a segment posted after close() still reaches the outbox — the flushed final region is not dropped", async () => {
  // A fake session that emits a flush segment AFTER close() — the exact
  // scenario the bug fix targets. The flush arrives after `closeLiveSession`
  // → `session.close()`.
  const fakeSession = createFlushSession("the final words");
  const fakeLiveTranscriber: LiveTranscriber = {
    liveCapability: async (): Promise<TranscriberCapability> => ({ status: "ready" }),
    openSession: async () => fakeSession,
  };
  setLiveTranscriber(fakeLiveTranscriber);

  const outbox = await getOutbox();
  await outbox.clear();
  const recorder = getRecorder();

  await recorder.start();

  // Wait for the session to be open and subscribed — the recorder's
  // fire-and-forget `openLiveForCapture` chain runs async. The flush session
  // emits nothing during recording, so wait for the recording row plus a
  // small delay for the subscribe to complete.
  await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item ? item : undefined;
  }, "a recording row");
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Call closeLiveSession directly — the row is still "recording", so
  // commitPreview will accept the flush segment. In the real app,
  // closeLiveSession is called by the sample tap teardown inside
  // recorder.stop()'s finally block; calling it directly here isolates the
  // fix from finalize()'s decode step (which fails on a short test recording).
  closeLiveSession();

  // The flush segment must land in `preview.committed`. Against the old code
  // (unsubscribe-before-close) this wait times out — the segment was posted
  // but nobody was subscribed to receive it.
  const withFlush = await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item?.preview?.committed?.includes("the final words") ? item : undefined;
  }, "the flushed final region to reach the outbox");
  expect(withFlush.preview!.committed).toContain("the final words");

  // The session completed and the subscription was torn down — the
  // `liveClosed` signal fired, the host's `complete` callback unsubscribed.
  expect(fakeSession.completed).toBe(true);
  expect(fakeSession.unsubscribed).toBe(true);

  // Clean up the recorder. finalize() may fail to decode a very short
  // recording — that's fine, the test has already verified the flush.
  try {
    await recorder.stop();
  } catch {
    /* short recording, decode fails — the flush already landed */
  }

  await outbox.clear();
  setLiveTranscriber(undefined);
});

test("the subscription is eventually torn down — no leak across successive record/stop cycles", async () => {
  // Two record/stop cycles with flush sessions. After each cycle, the
  // `complete` callback must fire (the worker posted `liveClosed`), which
  // tears down the subscription. If the subscription leaked, the second
  // cycle's `complete` would not fire (the first cycle's subscription is
  // still holding a reference) — or more precisely, the host's `complete`
  // callback would not clear `segmentSubscription` because it would not
  // match `sub` from the first cycle.

  const outbox = await getOutbox();
  await outbox.clear();
  const recorder = getRecorder();

  // First cycle.
  const session1 = createFlushSession("first flush");
  setLiveTranscriber({
    liveCapability: async (): Promise<TranscriberCapability> => ({ status: "ready" }),
    openSession: async () => session1,
  });

  await recorder.start();
  await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item ? item : undefined;
  }, "a recording row (cycle 1)");
  await new Promise((resolve) => setTimeout(resolve, 50));

  closeLiveSession();

  // Wait for the flush segment AND the completion signal.
  await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item?.preview?.committed?.includes("first flush") ? item : undefined;
  }, "the first flush to reach the outbox");
  await until(async () => session1.completed, "the first session to complete");
  expect(session1.completed).toBe(true);
  expect(session1.unsubscribed).toBe(true);

  try {
    await recorder.stop();
  } catch {
    /* short recording, decode fails */
  }
  await outbox.clear();

  // Second cycle — a fresh session. If the first cycle's subscription leaked,
  // the host's `segmentSubscription` would still point at the old subscription,
  // and the new `openLiveSession` would replace it — but the old `complete`
  // callback already fired and cleared `segmentSubscription` (because it
  // matched `sub`). So the second cycle's subscription is clean.
  const session2 = createFlushSession("second flush");
  setLiveTranscriber({
    liveCapability: async (): Promise<TranscriberCapability> => ({ status: "ready" }),
    openSession: async () => session2,
  });

  await recorder.start();
  await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item ? item : undefined;
  }, "a recording row (cycle 2)");
  await new Promise((resolve) => setTimeout(resolve, 50));

  closeLiveSession();

  await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item?.preview?.committed?.includes("second flush") ? item : undefined;
  }, "the second flush to reach the outbox");
  await until(async () => session2.completed, "the second session to complete");
  expect(session2.completed).toBe(true);
  expect(session2.unsubscribed).toBe(true);

  try {
    await recorder.stop();
  } catch {
    /* short recording, decode fails */
  }

  await outbox.clear();
  setLiveTranscriber(undefined);
});

test("closeLiveSession is idempotent and safe with no session open", async () => {
  // Calling closeLiveSession with no session open must not throw.
  // This is the "safe to call when no session is open" requirement.
  closeLiveSession();
  closeLiveSession();

  // Also safe after a real cycle — calling close again is a no-op.
  const fakeSession = createFlushSession("idempotent flush");
  const fakeLiveTranscriber: LiveTranscriber = {
    liveCapability: async (): Promise<TranscriberCapability> => ({ status: "ready" }),
    openSession: async () => fakeSession,
  };
  setLiveTranscriber(fakeLiveTranscriber);

  const outbox = await getOutbox();
  await outbox.clear();
  const recorder = getRecorder();

  await recorder.start();
  await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item ? item : undefined;
  }, "a recording row");
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Close the live session — the flush should still arrive.
  closeLiveSession();

  // Calling closeLiveSession again must be a no-op — currentSession is
  // already undefined, so the second call returns early without tearing
  // down the subscription (which is waiting for the flush).
  closeLiveSession();

  const withFlush = await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item?.preview?.committed?.includes("idempotent flush") ? item : undefined;
  }, "the flush to reach the outbox after an extra closeLiveSession call");
  expect(withFlush.preview!.committed).toContain("idempotent flush");

  // And one more close for good measure.
  closeLiveSession();

  try {
    await recorder.stop();
  } catch {
    /* short recording, decode fails */
  }

  await outbox.clear();
  setLiveTranscriber(undefined);
});
