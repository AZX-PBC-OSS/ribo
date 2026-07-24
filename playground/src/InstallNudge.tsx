import { useState } from "react";

import { detectInstallState, dismissNudge, isNudgeDismissed } from "./install-state.js";
import { button, muted, noticeBox } from "./styles.js";

/**
 * @file The Add-to-Home-Screen nudge — Phase 2.5, Task 3.
 *
 * A prompt to install is normally engagement bait, and this one is deliberately
 * not that. Per `docs/implementation/09-offline-first.md`, launching from the
 * Home Screen resets iOS's inactivity counter on every launch and is in
 * practice the only way WebKit answers `navigator.storage.persist()` with
 * `true`. It is the mitigation for the data-loss path the panel above it just
 * described, so the copy says *why* rather than asking for the install.
 *
 * Three rules keep it honest:
 *
 * 1. **Only where it applies.** iOS, in a browser tab. Android and desktop have
 *    different eviction rules and gain nothing, so they never see it.
 * 2. **Dismissible, and it stays dismissed.** One "Not now" and the nudge is
 *    gone. No timer that brings it back, no second ask.
 * 3. **No claim it cannot keep.** Installing improves the odds; it is not a
 *    guarantee, and the text says so.
 */

export function InstallNudge() {
  const [installState] = useState(detectInstallState);
  const [dismissed, setDismissed] = useState(isNudgeDismissed);

  if (installState === "not-applicable") return null;

  if (installState === "standalone") {
    return (
      <p style={{ ...muted, margin: "0.75rem 0 0" }}>
        Running from the Home Screen ✓ — every launch resets iOS&rsquo;s seven-day inactivity timer,
        which is what makes eviction unlikely rather than routine.
      </p>
    );
  }

  if (dismissed) return null;

  return (
    <div style={noticeBox}>
      <p style={{ fontWeight: 600, margin: 0 }}>Add this app to your Home Screen.</p>
      <p style={{ margin: "0.4rem 0 0" }}>
        In a Safari tab, iOS clears this app&rsquo;s storage — the queue of unsynced recordings and
        the offline copy of the app, together — after about seven days without opening it. Opening
        it from the Home Screen restarts that clock every time, and it is the one thing that makes
        Safari grant persistent storage.
      </p>
      <p style={{ margin: "0.4rem 0 0" }}>
        Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Nothing is installed
        or sent anywhere; it adds an icon. It lowers the risk — it does not remove it.
      </p>
      <button
        type="button"
        style={{ ...button, marginTop: "0.6rem" }}
        onClick={() => {
          dismissNudge();
          setDismissed(true);
        }}
      >
        Not now
      </button>
    </div>
  );
}
