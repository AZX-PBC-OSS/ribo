import { z } from "zod";

/**
 * @file The marker that makes eviction *visible* — Phase 2.5, Task 4.
 *
 * ## The problem in one line
 *
 * **An empty queue after eviction is byte-for-byte identical to a fresh
 * install.** IndexedDB is gone either way. So unless something outside
 * IndexedDB remembers that there used to be recordings, the first time a
 * browser reclaims someone's captures the app shows them a cheerful empty list
 * and says nothing — which is how a field tool loses its users permanently.
 *
 * ## Where the marker lives, and why there
 *
 * It has to survive the eviction that takes the queue. Per
 * `docs/implementation/09-offline-first.md`, iOS's 7-day sweep is
 * **all-or-nothing** over *script-writable storage*: IndexedDB, the Cache API,
 * `localStorage`, `sessionStorage` and the service-worker registration go
 * together. Nothing a static, backend-less app can write is outside that set.
 *
 * So the marker is written to the two substrates that are *most often* cleared
 * separately from IndexedDB, and read back from whichever still has it:
 *
 * 1. **`localStorage`** — a different store from IndexedDB, and the two are
 *    separable in practice: a corrupted or deleted database, a devtools
 *    "clear IndexedDB", and Chromium's quota eviction of the durable-storage
 *    box all take one and not the other.
 * 2. **A cookie** — a different *jar* entirely, not part of the Storage
 *    Standard's bucket at all. This is the one that survives a "clear cached
 *    files" / "clear site storage" sweep, and it is what the Playwright test in
 *    `playground/e2e/eviction.e2e.test.ts` leans on when it wipes IndexedDB and
 *    Cache Storage the way a browser reclaiming space would.
 *
 * ## What this CANNOT detect — stated plainly rather than papered over
 *
 * **The full iOS ITP sweep.** After ~7 days without opening the app, WebKit
 * removes all script-writable storage *and* caps/clears JavaScript-set cookies.
 * Both markers go with the queue. From inside the origin the result is
 * indistinguishable from a first run, and this module will report `first-run`,
 * not `evicted`. That is the residual case, it is the *expected* iOS case, and
 * the only fixes for it are outside this app's boundary: a server-set
 * `HttpOnly` first-party cookie (there is no server yet) or a synced backend
 * that knows what this device had (Phase "read-sync", per `09`).
 *
 * What the marker does buy, today: every partial clear — quota-pressure
 * eviction on Chromium and Firefox, a wiped or corrupted database, a user
 * clearing cached files, an app-level bug that drops the collection. Those are
 * the cases where the queue disappears and the user is otherwise told nothing.
 *
 * ## Why zod
 *
 * The marker is a persisted record crossing a trust boundary in both
 * directions (AGENTS.md §4), and it is read back from storage an *older or
 * newer* build may have written. A hand-rolled cast would let a malformed or
 * next-version marker be reported to a user as "3 recordings were deleted",
 * which is a worse lie than saying nothing. A failed parse is treated as no
 * marker at all.
 */

const STORAGE_KEY = "ribo.storage-marker";
const COOKIE_NAME = "ribo_storage_marker";

/**
 * A year. Deliberately long, and deliberately not load-bearing: on iOS WebKit
 * caps script-set cookies at seven days regardless of what we ask for, which is
 * exactly the residual case documented above.
 */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const markerSchema = z.strictObject({
  /** Bumped if the shape changes; an unknown version fails the parse and reads as "no marker". */
  v: z.literal(1),
  /** ISO 8601 — when this device first ran the app, as far as the marker knows. */
  firstSeenAt: z.string(),
  /** ISO 8601 — the last time the app observed the queue. */
  lastSeenAt: z.string(),
  /** How many items were in the outbox at `lastSeenAt`. The whole point. */
  items: z.number().int().nonnegative(),
});

export type StorageMarker = z.infer<typeof markerSchema>;

/** Which substrates still hold a marker. Reported so the UI can be specific. */
export interface MarkerReading {
  readonly marker?: StorageMarker;
  readonly fromLocalStorage: boolean;
  readonly fromCookie: boolean;
}

/**
 * Read the marker from both substrates.
 *
 * When both are present and disagree, the **later** `lastSeenAt` wins: a stale
 * copy in one store is a partial write, and the fresher record is the one that
 * describes the queue that was actually lost.
 */
export function readMarker(): MarkerReading {
  const fromLocal = parse(readLocalStorage());
  const fromCookie = parse(readCookie());
  return {
    marker: latest(fromLocal, fromCookie),
    fromLocalStorage: fromLocal !== undefined,
    fromCookie: fromCookie !== undefined,
  };
}

/**
 * Record the current queue size in both substrates.
 *
 * Called on every `items$` emission, not just at boot. That is what keeps a
 * user emptying the queue themselves ("clear queue", or the relay finishing an
 * item) from looking like eviction on the next launch — the marker says zero
 * because zero is true.
 */
export function writeMarker(items: number, previous?: StorageMarker): StorageMarker {
  const now = new Date().toISOString();
  const marker: StorageMarker = {
    v: 1,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    items,
  };
  const encoded = JSON.stringify(marker);
  writeLocalStorage(encoded);
  writeCookie(encoded);
  return marker;
}

/** Whether either substrate is writable at all. */
export function markerSupported(): boolean {
  return canUseLocalStorage() || canUseCookies();
}

function parse(raw: string | undefined): StorageMarker | undefined {
  if (raw === undefined) return undefined;
  try {
    const result = markerSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function latest(a?: StorageMarker, b?: StorageMarker): StorageMarker | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.lastSeenAt >= b.lastSeenAt ? a : b;
}

// --- localStorage -----------------------------------------------------------
//
// Every access is wrapped: Safari in Private Browsing throws on `localStorage`
// rather than returning null, and a thrown marker read at boot would take the
// whole app down over a diagnostic.

function readLocalStorage(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLocalStorage(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // The cookie is the fallback. Losing one substrate narrows coverage; it
    // does not break anything.
  }
}

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage === "object";
  } catch {
    return false;
  }
}

// --- cookie -----------------------------------------------------------------

function readCookie(): string | undefined {
  const prefix = `${COOKIE_NAME}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) return safeDecode(part.slice(prefix.length));
  }
  return undefined;
}

function writeCookie(value: string): void {
  // `SameSite=Lax` rather than `None`: the marker is only ever read by this
  // origin's own top-level page, and `None` would require `Secure`, which does
  // not hold on the plain-HTTP `vite preview` the e2e test drives.
  document.cookie =
    `${COOKIE_NAME}=${encodeURIComponent(value)}; path=/; ` +
    `max-age=${String(COOKIE_MAX_AGE_SECONDS)}; SameSite=Lax`;
}

function canUseCookies(): boolean {
  return navigator.cookieEnabled;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
