import { useEffect, useState, useSyncExternalStore } from "react";
import type { StoragePersistence } from "@azx/ribo-core";
import { useStoragePersistence } from "@azx/ribo-ui-react";

import { formatBytes } from "./format.js";
import { InstallNudge } from "./InstallNudge.js";
import { button, monospace, muted, panel } from "./styles.js";
import {
  getStorageState,
  hasModelHeadroom,
  MODEL_HEADROOM_BYTES,
  refreshEstimate,
  subscribeToStorage,
  type StorageState,
} from "./storage-store.js";

/**
 * @file Whether the recordings on this device are safe, answered honestly.
 *
 * Every string below is written so that a person reading it learns what the
 * browser *actually said*. `persist()` is a request; the tempting version of
 * this panel says "Storage protected ✓" after calling it and is wrong on iOS
 * essentially always. A field auditor acting on that would leave a day of
 * recordings on a device that will drop them.
 *
 * The panel is always visible, like `UpdatePanel`, for the same reason: the
 * wrong answer to "is my data safe?" is silence.
 *
 * The persistence grant itself now comes from `@azx/ribo-ui-react`'s
 * `useStoragePersistence()` — the module-level store every caller of that hook
 * shares (§ its own doc comment), so a grant made here is visible to
 * `useWorkSafety()`'s verdict without either side re-reading `navigator.storage`
 * on its own. Headroom (the quota/usage estimate this panel needs to warn about
 * Phase 3's model download) stays on `storage-store.ts`, unchanged: that
 * computation — `freeBytes`, `hasModelHeadroom` — has no counterpart in the hook,
 * which only hands back the raw `StorageEstimate`.
 */

export function StoragePanel() {
  const { persistence, request } = useStoragePersistence();
  const storage = useSyncExternalStore(subscribeToStorage, getStorageState);

  // The request is a side effect of the app being on screen; keeping it in the
  // component that reports the outcome means the report can never describe a
  // request that was never made. `request()` itself calls `navigator.storage
  // .persist()` unconditionally, so this only fires once per mount — StrictMode's
  // double mount asks the browser twice, which is harmless (a browser that
  // already granted persistence answers a repeat `persist()` with no fresh
  // prompt).
  useEffect(() => {
    request().catch(() => {
      // `request()` never throws — a rejected `persist()` is caught inside the
      // hook and reported as whatever was already known, not as a fabricated
      // `"denied"` (see @azx/ribo-ui-react's useStoragePersistence). This handler
      // exists only so a hypothetical future throw does not surface as an
      // unhandled rejection on every app boot; there is nothing to do with it.
    });
  }, [request]);

  // Headroom is not gated on the persistence request settling — it is an
  // independent read, and the two used to be chained only because they shared
  // one function (`startStorage`). Firing it directly on mount keeps that read
  // from silently depending on `request()` resolving first.
  useEffect(() => {
    void refreshEstimate();
  }, []);

  return (
    <section style={{ ...panel, background: "#f6f8fa" }}>
      <h2 style={{ fontSize: "1rem", margin: 0 }}>Storage durability</h2>

      <p style={{ margin: "0.35rem 0 0" }}>
        <strong>{headline(persistence)}</strong>
      </p>
      <p style={{ ...muted, margin: "0.25rem 0 0" }}>{detail(persistence)}</p>

      <Headroom storage={storage} />
      <InstallNudge />
      <Limits />
    </section>
  );
}

function Headroom({ storage }: { storage: StorageState }) {
  const [refreshing, setRefreshing] = useState(false);
  const enough = hasModelHeadroom(storage.headroom);

  const recheck = () => {
    setRefreshing(true);
    void refreshEstimate().finally(() => {
      setRefreshing(false);
    });
  };

  return (
    <div style={{ marginTop: "0.75rem" }}>
      {storage.headroom === undefined ? (
        <p style={{ ...muted, margin: 0 }}>
          {storage.estimated
            ? "This browser does not report a storage estimate, so there is no way to know how much room is left before Phase 3's model download starts."
            : "Measuring available storage…"}
        </p>
      ) : (
        <p style={{ ...muted, margin: 0 }}>
          Using <strong>{formatBytes(storage.headroom.usageBytes)}</strong> of{" "}
          <strong>{formatBytes(storage.headroom.quotaBytes)}</strong> —{" "}
          <strong>{formatBytes(storage.headroom.freeBytes)}</strong> free.{" "}
          {enough === true
            ? `Enough for Phase 3's speech model (up to ${formatBytes(MODEL_HEADROOM_BYTES)}).`
            : `NOT enough for Phase 3's speech model, which needs up to ${formatBytes(MODEL_HEADROOM_BYTES)}. Priming it here would fail partway through.`}{" "}
          Quota on iOS is a share of free disk and moves with it, so this is a reading, not a
          promise.
        </p>
      )}
      <button
        type="button"
        style={{ ...button, marginTop: "0.5rem" }}
        onClick={recheck}
        disabled={refreshing}
      >
        {refreshing ? "re-checking…" : "re-check free space"}
      </button>
    </div>
  );
}

/**
 * The limits of the eviction detector, stated where the claim is made.
 *
 * Task 4's requirement is not just to detect eviction but to be straight about
 * the case that cannot be detected. Putting it three files away in a comment
 * would satisfy the letter of that and none of the point.
 */
function Limits() {
  return (
    <p style={{ ...muted, margin: "0.75rem 0 0" }}>
      <strong>What this cannot tell you.</strong> Loss of queued recordings is detected by leaving a
      marker in <code style={monospace}>localStorage</code> and a cookie and checking it against the
      queue at launch. Both are script-writable, and iOS&rsquo;s seven-day sweep takes them along
      with IndexedDB and the cached shell — so a <em>full</em> iOS eviction leaves a device that
      looks exactly like a fresh install, and this page will not report it. What it does catch is
      every partial clear where the marker outlives the queue: quota-pressure eviction, a wiped or
      corrupted database, a &ldquo;clear cached files&rdquo;. Closing that last gap needs a server
      or a synced backend, neither of which exists yet.
    </p>
  );
}

function headline(status: StoragePersistence): string {
  switch (status) {
    case "unknown":
      return "Asking the browser to keep this app's storage…";
    case "granted":
      return "Persistent ✓ — the browser has granted this app's storage.";
    case "denied":
      return "NOT persistent — the browser declined.";
    case "unsupported":
      return "NOT persistent — this browser cannot be asked.";
  }
}

function detail(status: StoragePersistence): string {
  const EVICTABLE =
    "Queued recordings and the offline shell can be removed by the browser at any time. On iPhone and iPad that happens after about seven days without opening the app, and it takes both at once.";
  switch (status) {
    case "unknown":
      return 'This origin has not been asked yet, or the answer has not come back. Not the same as a refusal — see @azx/ribo-ui-react\'s useStoragePersistence, which reserves "denied" for an actual persist() that resolved false.';
    case "granted":
      return "The browser will not evict this app's data to reclaim space, whether that was granted just now or on an earlier visit. Clearing website data by hand still removes it, and so does deleting the app from the Home Screen.";
    case "denied":
      return `navigator.storage.persist() resolved false — the browser was asked and refused. This is the ordinary answer in an iOS Safari tab — WebKit grants persistence to web apps launched from the Home Screen, and rarely otherwise. ${EVICTABLE}`;
    case "unsupported":
      return `navigator.storage.persist is not implemented here, so persistence could not be requested at all. ${EVICTABLE}`;
  }
}
