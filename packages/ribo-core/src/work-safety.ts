import type { ConnectivityStatus } from "./connectivity.js";
import { ACTIVE_OUTBOX_STATUSES } from "./queue/schema.js";
import { ACTIVE_SESSION_STATUSES } from "./queue/session-schema.js";
import type { CaptureHealth } from "./queue/capture-session.js";
import type { OutboxItem } from "./queue/schema.js";
import type { SessionItem } from "./queue/session-schema.js";

/**
 * @file `workSafety` — the one honest answer to "is my work safe?".
 *
 * This app exists to capture field work that must not be lost, so its most
 * important sentence is the one that tells an auditor whether the recordings on
 * their device are actually safe. That answer is derived, not stored: it is a
 * pure classification of state that already exists — the outbox, the storage
 * persistence grant, connectivity — into a single verdict. It lives in core, next
 * to {@link resolveReview}, for the same reason: the playground (verbose) and a
 * future `ribo-ui-react` (one sentence) must classify *identically*, and the only way
 * to guarantee that is to write the rule once.
 *
 * ## Safety is a gradient with a hard edge
 *
 * Work is only **truly safe once it has left the device** — synced or written
 * back. Everything before that is safe from some things and not others:
 *
 * | Situation                       | Safe from            | Still at risk from        |
 * | ------------------------------- | -------------------- | ------------------------- |
 * | captured + persisted            | reload, crash        | eviction, lost device     |
 * | storage persistence NOT granted | —                    | routine eviction too      |
 * | transcribed but not synced      | audio drop           | lost device               |
 * | synced / written                | everything           | —                         |
 *
 * The hard edge is the bottom row. {@link WorkSafety} therefore reserves its
 * `safe` level for the case where **no unsynced work remains on the device** —
 * a persistence grant, however good, only ever earns `protected`. Encoding the
 * edge this way is what makes "never overstate safety" a property of the type
 * rather than a discipline: there is no path from on-device work to `safe`.
 *
 * ## The non-negotiable rule
 *
 * Saying "safe" while work sits on a device whose storage persistence was *not
 * granted* is the same lie as a UI claiming durability the browser never gave.
 * So the grant is a **required** input, and anything short of an outright
 * `granted` — `denied`, `unsupported`, or a still-in-flight `unknown` — drops
 * on-device work to `at-risk`. `unknown` is deliberately conservative: we do not
 * claim protection we have not yet confirmed. `work-safety.test.ts` pins this.
 *
 * ## Three situations a naive count would flatten
 *
 * A bare "N items pending" cannot tell these apart, and telling them apart is
 * the whole job — the {@link WorkSafety.level} and {@link WorkSafety} reason do:
 *
 *   - pending work waiting for connectivity → `protected` / `awaiting-sync`. The
 *     normal, expected field condition; the carried {@link ConnectivityStatus}
 *     lets a UI reassure ("saved, will upload when you're back online") or report
 *     progress ("uploading…").
 *   - pending work **and** storage not persistent → `at-risk` / `not-persisted`.
 *     Genuinely at risk of routine eviction; the carried grant says which sentence.
 *   - a permanently-failed (`dead`) item → `action-required` / `failed-permanently`.
 *     No amount of waiting fixes it; a human must look.
 *
 * ## Precedence
 *
 * When more than one is true, the most severe, most actionable answer wins:
 * `action-required` > `at-risk` > `protected` > `safe`. A `dead` item outranks an
 * eviction risk because it is the one state that will never resolve on its own —
 * and reporting it does not overstate safety, so the load-bearing rule still holds.
 *
 * ## On `audioReady`
 *
 * `OutboxItem.audioReady` is intentionally *not* an input to the level. On this
 * selector's axis — persistence and sync — it changes nothing: eviction and a
 * lost device take the audio attachment and the persisted transcript *together*,
 * and only leaving the device makes either safe. Whether the audio has been
 * dropped after transcription is a real fact, but it is orthogonal to "is my work
 * safe?"; folding it into the verdict would add a distinction that does not change
 * the honest answer — the mirror image of the naive count's spurious flattening.
 * {@link summarizeWork} classifies on `status` alone for exactly this reason.
 *
 * Pure, synchronous, no I/O, no DOM, no React (AGENTS.md §4, ESLint-enforced).
 */

/**
 * A summary of the outbox reduced to the three facts safety depends on. The
 * input {@link workSafety} classifies, so the classifier never has to hold the
 * full {@link OutboxItem} shape and a caller can summarize once per render.
 */
export interface WorkOnDevice {
  /** Unsynced work still on the device: active recordings, open/extracting/writing sessions. */
  readonly pending: number;
  /** Items that failed permanently and will not move without a human. */
  readonly dead: number;
  /** Sessions that have left the device (write succeeded) — the only truly-safe state. */
  readonly synced: number;
  /**
   * Of `pending`, how many are sessions parked waiting for a human to review them.
   *
   * A **subset of `pending`**, not a fourth bucket: an un-reviewed session is
   * unsynced work on a device. Exposed separately only so a UI can say "N sessions
   * need review" without re-querying.
   */
  readonly awaitingReview: number;
  /** Sessions that are open — the auditor is still walking the house. */
  readonly openSessions: number;
}

/**
 * The storage persistence grant, as it bears on safety.
 *
 * Mirrors the distinctions the playground's storage store draws
 * (`PersistenceStatus`), collapsed to what changes the verdict: its
 * `granted`/`already-persistent` both map to `"granted"` (persistent); its
 * `denied`/`error` both map to `"denied"` (asked, refused); `unsupported` stays
 * itself (cannot be asked); and `checking` maps to `"unknown"` (in flight). Only
 * `"granted"` is a grant; the other three are all "not persistent", and differ
 * only in the sentence a UI shows.
 */
export type StoragePersistence = "granted" | "denied" | "unsupported" | "unknown";

/**
 * The verdict: a **level** (the gradient a one-sentence UI sets its tone from)
 * and a **reason** (the specific cause it phrases the sentence around), as a
 * discriminated union so each situation carries exactly the facts its sentence
 * needs and no more.
 */
export type WorkSafety =
  /** No unsynced work on the device. `all-synced` had work and it all left; `nothing-captured` never did. */
  | { readonly level: "safe"; readonly reason: "nothing-captured" | "all-synced" }
  /** On-device work, storage persistent: survives reload/crash/eviction, not a lost device. */
  | {
      readonly level: "protected";
      readonly reason: "awaiting-sync" | "recording";
      readonly pending: number;
      /** Why it is waiting — `offline`/`probing` (waiting to reconnect) vs `online` (syncing now). */
      readonly connectivity: ConnectivityStatus;
    }
  /** On-device work with no persistence grant: routine eviction can take it. */
  | {
      readonly level: "at-risk";
      readonly reason: "not-persisted" | "capture-stalled";
      readonly pending: number;
      /** The non-grant in force, so a UI can say *why* — refused, unsupported, or still checking. */
      readonly persistence?: Exclude<StoragePersistence, "granted">;
    }
  /** A permanently-failed item; needs a human. */
  | {
      readonly level: "action-required";
      readonly reason: "failed-permanently";
      readonly dead: number;
    };

/**
 * Reduce recordings and sessions to a {@link WorkOnDevice} summary.
 *
 * Sessions drive the `synced` (done), `awaitingReview`, and `openSessions`
 * counts. Recordings in flight (queued/transcribing/failed/recording) are
 * pending work that hasn't reached a session yet. `transcribed` recordings are
 * counted through their session. `dead` recordings and sessions are both
 * counted as `dead`. `discarded` recordings are counted nowhere.
 */
export const summarizeWork = (
  recordings: readonly Pick<OutboxItem, "status">[],
  sessions: readonly Pick<SessionItem, "status">[] = [],
): WorkOnDevice => {
  let pending = 0;
  let dead = 0;
  let synced = 0;
  let awaitingReview = 0;
  let openSessions = 0;

  for (const { status } of sessions) {
    if (status === "done") synced += 1;
    else if (status === "dead") dead += 1;
    else if (status === "awaiting-review") {
      pending += 1;
      awaitingReview += 1;
    } else if (status === "open") {
      openSessions += 1;
      pending += 1;
    } else if ((ACTIVE_SESSION_STATUSES as readonly string[]).includes(status)) pending += 1;
  }

  for (const { status } of recordings) {
    if (status === "dead") dead += 1;
    else if (
      status === "recording" ||
      (ACTIVE_OUTBOX_STATUSES as readonly string[]).includes(status)
    )
      pending += 1;
    // transcribed and discarded are counted through their session or not at all
  }

  return { pending, dead, synced, awaitingReview, openSessions };
};

/**
 * Classify the safety of the work on this device.
 *
 * Pure and total. See the file header for the model, the precedence
 * (`action-required` > `at-risk` > `protected` > `safe`) and why only `synced`
 * is truly `safe`.
 */
export const workSafety = (
  work: WorkOnDevice,
  persistence: StoragePersistence,
  connectivity: ConnectivityStatus,
  captureHealth?: CaptureHealth,
): WorkSafety => {
  // A permanently-failed item is the most severe, most actionable answer: it
  // will never resolve on its own, so a human is told before anything else.
  if (work.dead > 0) {
    return { level: "action-required", reason: "failed-permanently", dead: work.dead };
  }

  // A stalled capture is at-risk regardless of persistence: persistence has
  // actually fallen behind — a failed chunk write or no dataavailable past a
  // threshold — and the recording in memory is not reaching disk.
  if (captureHealth === "stalled") {
    return { level: "at-risk", reason: "capture-stalled", pending: work.pending };
  }

  // No unsynced work left on the device — the only truly-safe state. Persistence
  // is moot here: there is nothing on the device for eviction to take.
  if (work.pending === 0) {
    return { level: "safe", reason: work.synced > 0 ? "all-synced" : "nothing-captured" };
  }

  // Healthy recording is protected — the unflushed tail is the expected state of
  // a live recording, not a warning.
  if (captureHealth === "flushing") {
    return { level: "protected", reason: "recording", pending: work.pending, connectivity };
  }

  // On-device work is only ever `protected`, never `safe` — and only when the
  // grant is an outright `granted`. Anything less means routine eviction can take
  // it, and claiming protection we do not have would be the exact lie this exists
  // to prevent.
  if (persistence !== "granted") {
    return { level: "at-risk", reason: "not-persisted", pending: work.pending, persistence };
  }

  // Persisted, on the device, waiting to sync: safe from reload/crash/eviction,
  // still exposed to a lost or broken device until it leaves.
  return { level: "protected", reason: "awaiting-sync", pending: work.pending, connectivity };
};
