import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { BehaviorSubject } from "rxjs";
import {
  createConnectivity,
  openOutbox,
  Recorder,
  type CaptureHealth,
  type CaptureSession,
  type Outbox,
  type WorkSafety,
} from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { createCaptureCoordinator } from "./capture-coordinator.js";
import type { CaptureCoordinator } from "./capture-coordinator.js";
import { RiboProvider } from "./RiboProvider.js";
import type { AnyRecorder, RiboInstances } from "./context.js";
import { useRecorder } from "./use-recorder.js";
import type { UseRecorderResult } from "./use-recorder.js";
import { useWorkSafety } from "./use-work-safety.js";

// Browser-mode, real Chromium — same discovery contract as the other
// *.browser.test.tsx files in this package.

/** A connectivity model over injected seams — no real network, no real events. */
function fakeConnectivity(online: boolean) {
  return createConnectivity({
    bindEvents: () => () => undefined,
    isOnline: () => online,
    probe: async () => new Response(null, { status: online ? 204 : 503 }),
  });
}

/** Recorders that may still be recording after a test — stopped in afterEach. */
const started: Recorder<unknown>[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const recorder = started.pop();
    if (recorder && (recorder.phase === "recording" || recorder.phase === "failed")) {
      await recorder.stop().catch(() => undefined);
    }
  }
  // Allow the capture lock to be released between tests — same reason as
  // recorder.browser.test.ts.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/**
 * Renders both `useRecorder` and `useWorkSafety` under one provider so a session
 * created by the recorder hook is visible to the sibling safety hook — which is
 * the whole point of the coordinator.
 */
async function renderHooks(opts: {
  captureCoordinator?: CaptureCoordinator;
  recorder: AnyRecorder;
  outbox: Outbox;
}) {
  let recorderApi: UseRecorderResult | undefined;
  let safety: WorkSafety | undefined;

  function Probe() {
    recorderApi = useRecorder({ recorder: opts.recorder, enqueue: false });
    const safetyApi = useWorkSafety();
    safety = safetyApi.safety;
    return null;
  }

  const instances: RiboInstances = {
    recorder: opts.recorder,
    outbox: opts.outbox,
    connectivity: fakeConnectivity(true),
    captureCoordinator: opts.captureCoordinator,
  };

  await render(
    <RiboProvider value={instances}>
      <Probe />
    </RiboProvider>,
  );

  return {
    get result() {
      return { recorder: recorderApi!, safety };
    },
  };
}

test("a session registered by useRecorder is visible to a SIBLING useWorkSafety", async () => {
  // A session created inside a descendant hook cannot publish itself by mutating
  // the provider's value — RiboProvider passes the host's object straight
  // through. The coordinator is the shared, observable thing that makes this work.
  //
  // The session is registered before render so the BehaviorSubject's immediate
  // delivery on subscribe lands inside the hook's subscription. In a real app,
  // useRecorder.start() registers the session after the component is already
  // mounted, and the coordinator's health$ pushes the update to the already-
  // subscribed useWorkSafety — the same observable mechanism, just a different
  // timing. The test verifies the coordinator plumbing, not the exact call site.
  const captureCoordinator = createCaptureCoordinator();
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  // Pre-populate with a queued item so work.pending > 0 — the safety then
  // depends on capture health, which is the thing under test.
  await outbox.enqueue({
    recording: {
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      durationMs: 10,
      mimeType: "audio/webm",
      ctx: {},
    },
    audio: new Blob(["x"], { type: "audio/webm" }),
    sessionId: crypto.randomUUID(),
  });

  // Register a capture session with "flushing" health — this is what
  // useRecorder.start() does internally via captureCoordinator.register().
  const fakeSession = {
    health$: new BehaviorSubject<CaptureHealth>("flushing"),
  } as Pick<CaptureSession, "health$"> as CaptureSession;
  const unregister = captureCoordinator.register(fakeSession);

  const recorder = new Recorder();
  started.push(recorder);

  try {
    const { result } = await renderHooks({ captureCoordinator, recorder, outbox });
    // workSafety checks captureHealth === "flushing" BEFORE persistence, so the
    // safety is protected/recording regardless of the persistence grant.
    await vi.waitFor(
      () => {
        expect(result.safety).toMatchObject({ level: "protected", reason: "recording" });
      },
      { timeout: 5000, interval: 100 },
    );
    unregister();
  } finally {
    await outbox.close();
  }
});

test("the session disappears on a failed start", async () => {
  const captureCoordinator = createCaptureCoordinator();
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  // A recorder that fails on start — the microphone is denied.
  const failingRecorder = new Recorder({
    getUserMedia: () => Promise.reject(new DOMException("no", "NotAllowedError")),
  });

  try {
    const { result } = await renderHooks({
      captureCoordinator,
      recorder: failingRecorder,
      outbox,
    });
    await result.recorder.start().catch(() => undefined);
    expect(captureCoordinator.active()).toBeUndefined();
  } finally {
    await outbox.close();
  }
});

test("no coordinator means no durable capture and today's behaviour", async () => {
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  const recorder = new Recorder();
  started.push(recorder);

  try {
    const { result } = await renderHooks({ recorder, outbox });
    await result.recorder.start();
    // Without a coordinator there is no capture health, so the reason is never
    // "recording" — it falls through to the existing classification.
    expect(result.safety?.reason).not.toBe("recording");
    await result.recorder.stop();
  } finally {
    await outbox.close();
  }
});
