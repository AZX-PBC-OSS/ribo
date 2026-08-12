import type { Transcript } from "../transcript.js";
import type { OutboxDocument, OutboxPatch } from "./schema.js";

/**
 * Append one closed utterance to the preview, or refuse silently.
 *
 * Refuses when `status !== "recording"` or `transcript` already exists. A late
 * live reply is expected traffic, not an error anyone can act on — the recording
 * may have been committed and transcribed while the reply was in flight — so the
 * refusal is silent rather than thrown.
 *
 * The checks are made against the document the modifier receives, not a copy
 * read beforehand. RxDB re-runs the modifier against the *current* revision on
 * write conflict, so a check made against a stale read can be wrong by the time
 * the write lands: the recording may have been committed between the read and
 * the retry. Moving the checks inside the modifier closes that window.
 *
 * Returns the (possibly unchanged) document and whether the segment was
 * appended, so the caller can return `undefined` on refusal without a second
 * read.
 */
export function appendSegment<T extends OutboxDocument>(
  data: T,
  text: string,
): readonly [T, boolean] {
  if (data.status !== "recording" || data.transcript !== undefined) {
    return [data, false] as const;
  }
  const segments = data.preview?.segments ?? [];
  return [{ ...data, preview: { segments: [...segments, text] } }, true] as const;
}

/**
 * Write the batch transcript and delete the preview in one modification.
 *
 * `Outbox.patch` is an `incrementalPatch`, and assigning `undefined` to an
 * optional property does not delete the persisted key — so a patch cannot
 * remove `preview` at all. This function uses `delete` instead, so the key is
 * gone from the stored document.
 *
 * One modification, not two, because both orderings of two writes publish a
 * state a subscriber can see: transcript-then-delete shows final text beside
 * stale provisional text; delete-then-transcript shows a row with neither,
 * which looks like a failed transcription. A single `incrementalModify` is one
 * committed revision, so no subscriber observes half of it.
 */
export function handoffTranscript<T extends OutboxDocument>(
  data: T,
  transcript: Transcript,
  patch: Omit<OutboxPatch, "transcript">,
): T {
  const merged = { ...data, ...patch, transcript };
  delete merged.preview;
  return merged;
}
