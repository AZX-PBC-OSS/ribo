import { useEffect, useState, useSyncExternalStore } from "react";
import type { RecorderState } from "@azx/ribo-core";

import { getRecorder } from "./recorder-handle.js";
import { button, errorBox, monospace, muted, panel } from "./styles.js";
import {
  applyUpdate,
  finishReload,
  getUpdateState,
  startServiceWorker,
  subscribeToUpdates,
} from "./update-store.js";

/**
 * @file The offline/update status line, and the only control that can apply a
 * new version.
 *
 * Deliberately visible on every load rather than only when something is wrong.
 * "Is the shell cached?" and "is the service worker off right now?" are both
 * questions whose wrong answer is silence, and a status line nobody reads costs
 * nothing while an absent one costs an afternoon.
 */

export function UpdatePanel() {
  const update = useSyncExternalStore(subscribeToUpdates, getUpdateState);
  const capturing = useCapturing();

  // Registration is a side effect of the app being on screen, not of this
  // component existing — but this is the component that reports it, so keeping
  // the two together means the report can never describe a worker that was
  // never started. `startServiceWorker` is idempotent, which is what makes it
  // safe under StrictMode's double mount.
  useEffect(() => {
    startServiceWorker();
  }, []);

  return (
    <section style={{ ...panel, background: "#f6f8fa" }}>
      <h2 style={{ fontSize: "1rem", margin: 0 }}>Offline shell</h2>
      <p style={{ ...muted, margin: "0.35rem 0 0" }}>{describe(update.phase)}</p>

      {update.phase === "waiting" && (
        <UpdateAction
          heading="A new version is ready."
          detail="It is installed and waiting. Nothing changes until you say so — this page will not reload on its own."
          label="Update and reload"
          capturing={capturing}
          onApply={applyUpdate}
        />
      )}

      {update.phase === "reload-pending" && (
        <UpdateAction
          heading="A new version took over while you were recording."
          detail="This page is still running the old code, on purpose — reloading would have destroyed the capture. Reload when you are ready."
          label="Reload now"
          capturing={capturing}
          onApply={finishReload}
        />
      )}

      {update.phase === "error" && (
        <p style={errorBox}>
          The service worker did not register: {update.message ?? "unknown error"}. The app still
          works, but it will not start without a network.
        </p>
      )}
    </section>
  );
}

function UpdateAction({
  heading,
  detail,
  label,
  capturing,
  onApply,
}: {
  heading: string;
  detail: string;
  label: string;
  capturing: boolean;
  onApply: () => unknown;
}) {
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <p style={{ fontWeight: 600, margin: 0 }}>{heading}</p>
      <p style={{ ...muted, margin: "0.25rem 0 0.6rem" }}>{detail}</p>
      <button
        type="button"
        style={button}
        disabled={capturing}
        onClick={() => {
          onApply();
        }}
      >
        {label}
      </button>
      {capturing && (
        <p style={errorBox}>
          Held back until capture finishes. Applying an update reloads the page, and a reload
          mid-recording loses the recording for good — there is no draft to come back to. Press{" "}
          <span style={monospace}>■ Stop and queue</span> first; this button re-enables by itself.
        </p>
      )}
    </div>
  );
}

/** Live "is a recording underway", from the shared recorder. */
function useCapturing(): boolean {
  const recorder = getRecorder();
  const [state, setState] = useState<RecorderState>(() => recorder.state);
  useEffect(() => recorder.subscribe(setState), [recorder]);
  return state.phase !== "idle";
}

function describe(phase: ReturnType<typeof getUpdateState>["phase"]): string {
  switch (phase) {
    case "disabled-in-dev":
      // Said out loud, in the page, because the alternative is someone spending
      // an hour on a cache that is not running.
      return "Service worker DISABLED in dev — a precached shell would serve stale bundles over HMR. Offline boot only works in a production build (pnpm build && pnpm --filter playground preview).";
    case "unsupported":
      return "This browser has no service worker support, so the app cannot start without a network.";
    case "registering":
      return "Caching the app shell…";
    case "offline-ready":
      return "Ready to work offline ✓ — the app shell is cached, so it starts with no signal. The Whisper model is not cached here; that is Phase 3.";
    case "waiting":
      return "A new version is waiting.";
    case "reload-pending":
      return "A new version is in control; this page is still on the old one.";
    case "error":
      return "The app shell is not cached.";
  }
}
