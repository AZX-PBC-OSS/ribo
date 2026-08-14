---
"@azx/ribo-core": minor
---

Live-transcription preview: a `preview` field on the outbox document, with the
storage mechanics for accumulating and handing it off.

- `OutboxItem` gains an optional `preview: { segments: string[] }` — an
  append-only array of utterance texts that accumulates while
  `status === "recording"`. No timings, no per-segment engine, no confidence;
  index positions are stable so a UI can render incrementally.
- `Outbox.appendPreviewSegment(id, text)` appends one closed utterance. Refuses
  silently (returns `undefined`) when `status !== "recording"` or `transcript`
  already exists — a late live reply is expected traffic, not an error. The
  refusal checks live inside the `incrementalModify` modifier, not against a
  copy read beforehand, so they cannot be stale on conflict retry.
- `Outbox.writeTranscript(id, transcript, patch)` writes the batch transcript
  and deletes `preview` in one `incrementalModify` revision. `patch` cannot
  delete a key (assigning `undefined` to an optional property does not remove
  the persisted key), and two separate writes publish a half-applied state a
  subscriber can see. The relay's two transcript write sites (normal
  `extracting` and implausible `awaiting-review`) both route through it.
- `preview` is not patchable — added to `OutboxPatch`'s `Omit` list and to the
  type-level guard in `schema.test.ts`.

RxDB schema bumped to version 3 (identity migration — `preview` is optional).
