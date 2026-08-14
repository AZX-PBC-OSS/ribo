---
"@azx/ribo-core": minor
---

Live-transcription preview becomes `committed` plus `tail`, replacing the
append-only `segments` array.

Under the revision-7 frame loop a region is re-transcribed as it grows, so its
text must be allowed to change until it commits. An append-only array could not
express that.

- `OutboxItem.preview` is now `{ committed: string[], tail?: string }`.
  `committed` is append-only and never revised — index keys stay stable for
  incremental rendering, joined with a space exactly as `segments` was. `tail`
  is the current region's provisional text, **replaced wholesale on every write
  and never appended to**. On commit, the tail's final value moves onto
  `committed` and the tail is cleared in one modification.
- `Outbox.appendPreviewSegment` is replaced by two methods:
  - `writePreviewTail(id, text)` — replaces the tail.
  - `commitPreview(id, text)` — appends to `committed` and clears the tail in
    one `incrementalModify` revision, so no subscriber observes the text in
    both places or in neither.
- Both refuse silently (return `undefined`) when `status !== "recording"` or
  `transcript` already exists — the stale-reply guard, with its checks inside
  the modifier so they cannot be stale on conflict retry.
- The handoff is unchanged: `writeTranscript` still deletes `preview` and writes
  `transcript` in one modification. `preview` remains unpatchable.

No migration: there are no users, and no persisted `preview` survives a
recording (deleted in the same modification that writes `transcript`).
