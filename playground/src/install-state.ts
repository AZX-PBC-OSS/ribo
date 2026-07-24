/**
 * @file "Should this device be nudged to add the app to its Home Screen?"
 *
 * The nudge exists for exactly one reason, and it is a storage reason rather
 * than an engagement one: per `docs/implementation/09-offline-first.md`, iOS
 * clears script-writable storage after ~7 days without *interaction*, and a web
 * app launched from the Home Screen resets that counter on every launch. It is
 * also, in practice, the only way Safari answers `navigator.storage.persist()`
 * with `true`. So the prompt is a mitigation for a real data-loss path, which
 * is why it is shown **only where it applies** — an Android or desktop user
 * gains nothing from it and must never see it.
 *
 * Kept out of `storage-store.ts` because it is a device question, not a
 * browser-permission one, and the two have no shared state.
 */

export type InstallState =
  /** Running as an installed/standalone app. The eviction counter resets on launch. */
  | "standalone"
  /** iOS Safari, in a browser tab. The one case the nudge is for. */
  | "ios-browser"
  /** Everywhere else. No nudge — this device's eviction rules are not iOS's. */
  | "not-applicable";

const DISMISSED_KEY = "ribo.a2hs-dismissed";

export function detectInstallState(): InstallState {
  if (isStandalone()) return "standalone";
  return isIos() ? "ios-browser" : "not-applicable";
}

/**
 * Whether the page is running outside a browser tab.
 *
 * Two checks because iOS answers to the older one: `navigator.standalone` is
 * WebKit's non-standard flag for Home Screen apps and predates
 * `display-mode: standalone` support there, so relying on the standard media
 * query alone would nudge an already-installed iPhone to install itself.
 */
function isStandalone(): boolean {
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  return legacy === true || window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * Whether this is an iOS/iPadOS device.
 *
 * `navigator.platform` is deprecated and, worse, wrong here: iPadOS 13+ reports
 * itself as `MacIntel` with a desktop Safari user agent by default. The
 * `maxTouchPoints` clause is what separates a real Mac (0 or 1) from an iPad
 * pretending to be one — a Mac never has more than one touch point, and it is
 * the only signal that survives Apple's desktop-class masquerade.
 */
function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/**
 * Whether the nudge was already waved off.
 *
 * Honest and non-nagging means: shown once, dismissible, and it stays
 * dismissed. Note the flag lives in `localStorage`, which the very eviction it
 * warns about would also clear — so after a wipe the nudge returns. That is the
 * right behaviour rather than a bug: the wipe is proof the advice was needed.
 */
export function isNudgeDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // Safari in Private Browsing throws on `localStorage` access rather than
    // returning null. Not being able to remember a dismissal is not a reason to
    // hide the nudge.
    return false;
  }
}

export function dismissNudge(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Nothing to do — the nudge simply reappears next launch.
  }
}
