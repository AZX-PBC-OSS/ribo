import type { Outbox } from "./outbox.js";
import type { SessionItem } from "./session-schema.js";
import type { AnnotatedTranscript } from "../annotated-transcript.js";
import type { TranscriptCombiner } from "../transcript-combiner.js";
import { createDefaultTranscriptCombiner } from "../transcript-combiner.js";

/**
 * @file Session-level extraction: list a session's transcribed captures in
 * capture order (excluding `discarded` and `dead`), build an
 * {@link AnnotatedTranscript} for each, and hand the array to a
 * {@link TranscriptCombiner} for the policy.
 *
 * The I/O (listing, filtering, sorting, building parts) lives here; the
 * combination policy lives in the combiner, which is pure. That split is the
 * point: the combiner is testable with a plain array and no database, and a
 * host can replace it without forking the I/O.
 *
 * This is the app's `runJobExtraction.ts` rule, promoted: the auditor threw
 * that capture away, and its words should not return through a later
 * extraction. It runs when the session is closed (the auditor is done walking
 * the house), keyed by the capture set, re-running when the set changes.
 */

/**
 * List a session's transcribed captures in capture order (seq-ascending),
 * excluding `discarded` and `dead`, and build an {@link AnnotatedTranscript}
 * for each.
 *
 * Each part's `annotations` bag carries `seq`, `kind`, and `id` from the
 * outbox item, so a combiner that builds per-capture markers has what it needs
 * without reaching back into the database. The bag is open by design.
 *
 * Returns the parts and the sorted capture ids that produced them. The ids are
 * the **cache key**: if they haven't changed since the last extraction, the
 * extraction is still valid and need not re-run.
 */
export async function listSessionTranscriptParts(
  outbox: Outbox,
  sessionId: string,
): Promise<{ parts: AnnotatedTranscript[]; recordingIds: string[] }> {
  const recordings = await outbox.list({ sessionId });
  const usable = recordings
    .filter((r) => r.status === "transcribed" && r.transcript !== undefined)
    .sort((a, b) => a.seq - b.seq);
  return {
    parts: usable.map((r) => ({
      text: r.transcript!.text,
      annotations: { seq: r.seq, kind: r.recording.kind, id: r.id },
    })),
    recordingIds: usable.map((r) => r.id).sort(),
  };
}

/**
 * Join the transcript text of every transcribed capture belonging to
 * `sessionId`, in capture order (seq-ascending), excluding `discarded` and
 * `dead`.
 *
 * A convenience that calls {@link listSessionTranscriptParts} for the I/O and
 * `combiner` for the policy. The combiner defaults to
 * {@link createDefaultTranscriptCombiner} (no markers), so existing callers
 * see the same text they always have. Pass a custom combiner to replace the
 * combination policy without forking the I/O.
 *
 * Returns the joined text and the sorted capture ids that produced it. The
 * ids are the **cache key**: if they haven't changed since the last extraction,
 * the extraction is still valid and need not re-run.
 */
export async function joinSessionTranscript(
  outbox: Outbox,
  sessionId: string,
  combiner?: TranscriptCombiner,
): Promise<{ text: string; recordingIds: string[] }> {
  const { parts, recordingIds } = await listSessionTranscriptParts(outbox, sessionId);
  const combine = combiner ?? createDefaultTranscriptCombiner();
  const { text } = combine(parts);
  return { text, recordingIds };
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
