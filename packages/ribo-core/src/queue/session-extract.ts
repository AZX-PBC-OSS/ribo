import type { Outbox } from "./outbox.js";
import type { SessionItem } from "./session-schema.js";

/**
 * @file Session-level extraction: join every transcribed recording's transcript
 * text in capture order, excluding `discarded`, and provide the cache key that
 * makes "I forgot the crawlspace" cheap.
 *
 * This is the app's `runJobExtraction.ts` rule, promoted: the contractor threw
 * that recording away, and its words should not return through a later
 * extraction. It runs when the session is closed (the auditor is done walking
 * the house), keyed by the recording set, re-running when the set changes.
 */

/**
 * Join the transcript text of every transcribed recording belonging to
 * `sessionId`, in capture order (seq-ascending), excluding `discarded` and
 * `dead`.
 *
 * Returns the joined text and the sorted recording ids that produced it. The
 * ids are the **cache key**: if they haven't changed since the last extraction,
 * the extraction is still valid and need not re-run.
 */
export async function joinSessionTranscript(
  outbox: Outbox,
  sessionId: string,
): Promise<{ text: string; recordingIds: string[] }> {
  const recordings = await outbox.list({ sessionId });
  const usable = recordings
    .filter((r) => r.status === "transcribed" && r.transcript !== undefined)
    .sort((a, b) => a.seq - b.seq);
  return {
    text: usable.map((r) => r.transcript!.text).join(" "),
    recordingIds: usable.map((r) => r.id).sort(),
  };
}

/**
 * Whether the session's recording set has changed since the last extraction.
 *
 * Compares the sorted recording ids against `session.extractedFromRecordingIds`.
 * A session that has never been extracted (`extractedFromRecordingIds` absent)
 * always returns `true` — the first extraction must always run.
 */
export function recordingSetChanged(
  session: SessionItem,
  recordingIds: readonly string[],
): boolean {
  const cached = session.extractedFromRecordingIds;
  if (cached === undefined) return true;
  if (cached.length !== recordingIds.length) return true;
  return recordingIds.some((id, i) => id !== cached[i]);
}
