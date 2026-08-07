import { useEffect, useState } from "react";
import { RiboProvider } from "@azx/ribo-ui-react";
import { SNUGGPRO_ADAPTER_NAME as ADAPTER } from "@azx/ribo-adapter-snuggpro";
import type { Outbox } from "@azx/ribo-core";

import { ConnectivityPanel } from "./ConnectivityPanel.js";
import { getConnectivity } from "./connectivity-store.js";
import { EvictionNotice } from "./EvictionNotice.js";
import { messageOf } from "./format.js";
import { getOutbox } from "./outbox-handle.js";
import { QueuePanel } from "./QueuePanel.js";
import { getRecorder } from "./recorder-handle.js";
import { RecordPanel } from "./RecordPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { StoragePanel } from "./StoragePanel.js";
import { errorBox, monospace, muted, page } from "./styles.js";
import { TranscribePanel } from "./TranscribePanel.js";
import { TryItPanel } from "./TryItPanel.js";
import { UpdatePanel } from "./UpdatePanel.js";
import { VerifyPanel } from "./VerifyPanel.js";
import { WorkSafetyPanel } from "./WorkSafetyPanel.js";

/**
 * @file The playground: record real audio, watch it queue, reload, find it
 * still there.
 *
 * Importing all three workspace packages is deliberate — it is what makes the
 * production build a composition check of the whole workspace rather than of
 * `ribo-core` alone. `ribo-ui-react` is now the hook layer's `RiboProvider`;
 * `ribo-adapter-snuggpro` now ships a real `ToolAdapter`, so the footer shows its
 * adapter name. `ribo-core` is the entire rest of this page.
 *
 * `RiboProvider`'s `value` carries the three host-owned singletons — `recorder`
 * and `connectivity` are available immediately (their handles construct lazily
 * but synchronously), `outbox` only once `useOutbox()` below resolves its
 * promise. Every panel below the outbox-ready gate resolves what it needs
 * through the provider now, rather than being handed an `Outbox` prop by hand.
 */

const COMPOSED_NAMES = ["@azx/ribo-ui-react", ADAPTER];

export function App() {
  const outbox = useOutbox();

  return (
    // The instances a host constructs above React: `recorder` and `connectivity`
    // are always ready (their handles construct lazily but synchronously);
    // `outbox` is `undefined` until `useOutbox()` below resolves its promise, so
    // every hook that requires one throws only once a caller tries to use it
    // before the outbox-ready gate — which no panel below does. Rendering the
    // provider here — rather than merely importing it — is what makes this a
    // *runtime* composition check rather than a type-only one; see the `@file`
    // note above.
    <RiboProvider
      value={{
        recorder: getRecorder(),
        outbox: outbox.kind === "ready" ? outbox.outbox : undefined,
        connectivity: getConnectivity(),
      }}
    >
      <main style={page}>
        <h1 style={{ marginBottom: 0 }}>ribo playground</h1>
        <p style={muted}>
          Phase 3 — capture, queue, and transcribe on-device. Prime the Whisper model once, cut the
          network, and recording and transcription still work.
        </p>

        {/* Above everything else, and outside the panels: if the browser dropped
          this user's recordings, that is the first thing they need to know, not
          something to find after scrolling past a storage readout. */}
        {outbox.kind === "ready" && <EvictionNotice outbox={outbox.outbox} />}

        <UpdatePanel />
        <StoragePanel />
        <ConnectivityPanel />
        <VerifyPanel />

        {outbox.kind === "opening" && <p style={muted}>opening the outbox…</p>}
        {outbox.kind === "error" && (
          <p style={errorBox}>The outbox could not be opened: {outbox.message}</p>
        )}
        {outbox.kind === "ready" && (
          <>
            <WorkSafetyPanel />
            <RecordPanel />
            <QueuePanel outbox={outbox.outbox} />
            <TranscribePanel outbox={outbox.outbox} />
            <ReviewPanel />
          </>
        )}

        {/* Independent of the outbox: a dev-only tool to try an extraction against
          any pasted JSON Schema + text, via the same-origin `/api/extract`
          endpoint (server-side inference; no key in the browser). */}
        <TryItPanel />

        <footer style={muted}>
          composed from <code style={monospace}>@azx/ribo-core</code>
          {COMPOSED_NAMES.map((name) => (
            <span key={name}>
              , <code style={monospace}>{name}</code>
            </span>
          ))}{" "}
          — <code style={monospace}>@azx/ribo-ui-react</code> ships{" "}
          <code style={monospace}>RiboProvider</code>;{" "}
          <code style={monospace}>@azx/ribo-adapter-snuggpro</code> now ships a real adapter.
        </footer>
      </main>
    </RiboProvider>
  );
}

type OutboxHandle =
  { kind: "opening" } | { kind: "error"; message: string } | { kind: "ready"; outbox: Outbox };

/**
 * Awaits the shared outbox.
 *
 * The handle itself is a module singleton (`outbox-handle.ts`) precisely so that
 * this effect running twice under StrictMode, or the component remounting under
 * HMR, cannot open a second database over the same IndexedDB name.
 */
function useOutbox(): OutboxHandle {
  const [handle, setHandle] = useState<OutboxHandle>({ kind: "opening" });

  useEffect(() => {
    let cancelled = false;
    void getOutbox()
      .then((outbox) => {
        if (!cancelled) setHandle({ kind: "ready", outbox });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setHandle({ kind: "error", message: messageOf(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return handle;
}
