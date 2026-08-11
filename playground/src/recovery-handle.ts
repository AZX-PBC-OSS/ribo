import { decodeAudioDuration, recoverInterrupted } from "@azx/ribo-core";

import { getOutbox } from "./outbox-handle.js";

/**
 * @file Startup recovery, run exactly once per page load.
 *
 * A recording interrupted by a crash, a reload or a tab close leaves its row at
 * `recording` with its chunks on disk. Nothing else in the app looks at such a
 * row — the relay refuses to select one, deliberately, because audio may still
 * be arriving — so without this call the chunks would sit there until the
 * storage quota noticed them.
 *
 * **Recovery writes a NEW row and never mutates the interrupted one.** The
 * original is marked `dead` with a `lastError` naming its successor, so the
 * orphan left behind in the queue is expected output rather than a failure: it
 * is the audit trail saying where the audio went.
 *
 * Running it at load, before the user can click record, is what keeps it useful.
 * `recoverInterrupted` refuses while the capture lock is held — a live recording
 * owns its own row — so a recovery that loses that race resolves `[]` and simply
 * tries again next load. Nothing is corrupted by losing it; the audio just waits
 * one more page load.
 *
 * A promise-valued singleton for the same reason the outbox is: StrictMode
 * mounts every effect twice, and two concurrent recoveries would race for the
 * same lock, so the second would silently no-op and report "nothing recovered"
 * for rows the first was busy recovering.
 */

interface HotData {
  recovery?: Promise<readonly string[]>;
}

const hotData = import.meta.hot?.data as HotData | undefined;

let handle: Promise<readonly string[]> | undefined = hotData?.recovery;

/**
 * The ids of the rows recovery created, recovering on first call.
 *
 * Resolves `[]` when there was nothing to recover, which is the common case, and
 * also when a live recording held the lock.
 */
export function getRecovery(): Promise<readonly string[]> {
  handle ??= getOutbox().then(
    async (outbox) => await recoverInterrupted({ outbox, decode: decodeAudioDuration }),
  );
  if (hotData) hotData.recovery = handle;
  return handle;
}
