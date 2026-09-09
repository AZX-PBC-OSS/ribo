import type { Outbox } from "./outbox.js";
import type { OutboxItem } from "./schema.js";
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
 *
 * When {@link JoinSessionTranscriptOptions.markCaptures} is true, each capture's
 * text is preceded by a per-capture marker so a model can attribute a value to
 * the capture it came from — mirroring the page-marker convention from
 * `@azx/ribo-transcriber-pdfjs`.
 */

/**
 * Options for {@link joinSessionTranscript}.
 */
export interface JoinSessionTranscriptOptions {
  /**
   * When true, prefix each capture's transcript text with a per-capture marker
   * (`\n===== CAPTURE seq:N kind:K id:I =====\n`) so a model can attribute a
   * value to the capture it came from. Mirrors the page-marker convention
   * (`\n===== PAGE n =====\n`) from `@azx/ribo-transcriber-pdfjs`.
   *
   * The marker carries three things a downstream consumer needs to resolve a
   * citation back to a row:
   *
   * - **`seq`** — the capture-order index, stable and human-readable. Gives a
   *   reviewer "this was the third capture."
   * - **`kind`** — `audio` or `document`, one word. Tells a reviewer what kind
   *   of source they are looking at without a row lookup.
   * - **`id`** — the outbox item id, the primary key `outbox.get(id)` resolves.
   *   This is what `recordingIds` already returns, so a consumer that has the
   *   structured array can cross-reference directly. A UUID is not natural
   *   language, so it is unambiguous against real transcript content.
   *
   * All three are assigned at enqueue time and never change across a retry.
   *
   * Defaults to `false`: the joined text is unchanged for existing callers, so
   * what every extractor sees does not shift unless the caller explicitly opts
   * in. The risk of unconditional emission is real — an extractor might produce
   * different output when it sees markers, and that is a behaviour change for
   * every caller — and the risk of opt-in is merely that a host must know to
   * turn it on, which is acceptable for a design-forward change.
   */
  markCaptures?: boolean;
}

/**
 * The per-capture marker prefix. The full marker for a capture is
 * `` `\n===== CAPTURE seq:${seq} kind:${kind} id:${id} =====\n` ``.
 *
 * Mirrors the page-marker convention from `@azx/ribo-transcriber-pdfjs`:
 * a `===== … =====` line on its own, surrounded by newlines, so it is
 * greppable, unambiguous against real transcript content, and cheap in tokens.
 */
const CAPTURE_MARKER_PREFIX = "\n===== CAPTURE ";

/**
 * Build the per-capture marker for one outbox item.
 *
 * The marker sits **before** the capture's text, never inside it — so
 * `isSpanGrounded` still finds a verbatim quote from within the transcript as a
 * substring of the joined text. The `\n` at each end of the marker separates it
 * from surrounding text without needing a join space.
 */
function captureMarker(item: OutboxItem): string {
  return `${CAPTURE_MARKER_PREFIX}seq:${item.seq} kind:${item.recording.kind} id:${item.id} =====\n`;
}

/**
 * Join the transcript text of every transcribed recording belonging to
 * `sessionId`, in capture order (seq-ascending), excluding `discarded` and
 * `dead`.
 *
 * Returns the joined text and the sorted recording ids that produced it. The
 * ids are the **cache key**: if they haven't changed since the last extraction,
 * the extraction is still valid and need not re-run.
 *
 * When `options.markCaptures` is true, each capture's text is preceded by a
 * per-capture marker — see {@link JoinSessionTranscriptOptions.markCaptures}.
 */
export async function joinSessionTranscript(
  outbox: Outbox,
  sessionId: string,
  options?: JoinSessionTranscriptOptions,
): Promise<{ text: string; recordingIds: string[] }> {
  const recordings = await outbox.list({ sessionId });
  const usable = recordings
    .filter((r) => r.status === "transcribed" && r.transcript !== undefined)
    .sort((a, b) => a.seq - b.seq);
  const { markCaptures = false } = options ?? {};
  return {
    text: markCaptures
      ? usable.map((r) => captureMarker(r) + r.transcript!.text).join("")
      : usable.map((r) => r.transcript!.text).join(" "),
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
