import type { Transcript } from "../transcript.js";
import type { OutboxDocument, OutboxPatch } from "./schema.js";

/**
 * Replace the current region's provisional tail, or refuse silently.
 *
 * Refuses when `status !== "recording"` or `transcript` already exists. A late
 * live reply is expected traffic, not an error anyone can act on — the recording
 * may have been committed and transcribed while the reply was in flight — so the
 * refusal is silent rather than thrown.
 *
 * The tail is **replaced wholesale**, never appended to: a region is re-transcribed
 * as it grows, so each refresh produces the region's full text and the previous
 * provisional rendering must be discarded rather than accumulated.
 *
 * The checks are made against the document the modifier receives, not a copy
 * read beforehand. RxDB re-runs the modifier against the *current* revision on
 * write conflict, so a check made against a stale read can be wrong by the time
 * the write lands: the recording may have been committed between the read and
 * the retry. Moving the checks inside the modifier closes that window.
 *
 * Returns the (possibly unchanged) document and whether the tail was written,
 * so the caller can return `undefined` on refusal without a second read.
 */
export function writeTail<T extends OutboxDocument>(data: T, text: string): readonly [T, boolean] {
  if (data.status !== "recording" || data.transcript !== undefined) {
    return [data, false] as const;
  }
  const committed = data.preview?.committed ?? [];
  return [{ ...data, preview: { committed, tail: text } }, true] as const;
}

/**
 * Commit the current region: append its text to `committed` and clear the tail,
 * in one modification, or refuse silently.
 *
 * Refuses on the same conditions as {@link writeTail} — `status !== "recording"`
 * or `transcript` already exists — and for the same reason.
 *
 * One modification, not two, because both orderings of two writes publish a
 * state a subscriber can see: append-then-clear shows the text in both
 * `committed` and `tail` at once; clear-then-append shows it in neither. A
 * single modifier return is one committed revision, so no subscriber observes
 * the text in both places or in neither.
 *
 * The committed text is the value the caller passes in — the region's final
 * transcription — not a read of the current tail. A refresh that would have
 * written the tail may have been shed as backpressure (Task 2's load shedding),
 * so the commit must carry its own text rather than depend on a tail being
 * present. In the normal flow the two match: the last refresh wrote the tail,
 * and the commit finalises the same region.
 */
export function commitRegion<T extends OutboxDocument>(
  data: T,
  text: string,
): readonly [T, boolean] {
  if (data.status !== "recording" || data.transcript !== undefined) {
    return [data, false] as const;
  }
  const committed = data.preview?.committed ?? [];
  // No `tail` key on the returned preview — omitting it clears it. The whole
  // preview object is rebuilt here, so there is no stale tail to `delete`.
  return [{ ...data, preview: { committed: [...committed, text] } }, true] as const;
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
