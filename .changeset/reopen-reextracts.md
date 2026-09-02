---
"@azx/ribo-core": minor
---

Reopening a session whose recording set has moved re-extracts, instead of re-presenting a stale draft.

An auditor records three walkthroughs, submits, and the session writes and reaches `done`. Walking back to the van they remember the attic and record a fourth clip. It enqueues against the session and transcribes normally — recording transcription does not depend on session status — so a real transcript with the attic in it now sits on the device.

Neither door opened. `closeSession` refuses any status but `open`. `reopenSessionForReview` accepted `done`, but landed the session in `awaiting-review`, which is deliberately absent from `ACTIVE_SESSION_STATUSES` so the relay never looks at it again. The auditor reviewed the draft computed from the first three recordings, with the attic missing and nothing anywhere saying so.

`reopenSessionForReview` now routes on the recording set: unchanged, it parks at `awaiting-review` as before; moved, it parks at `extracting` so the relay re-extracts and then parks for review. Re-extraction costs a model call over the whole field set, so it only fires when there is genuinely new audio.

The comparison is against every recording that is not `discarded` or `dead`, not against the transcribed ones. `extractedFromRecordingIds` holds the transcribed set, so comparing like with like would find nothing new in exactly the case this exists for — at the moment of reopen the fourth clip has not transcribed yet. Comparing eligible-to-transcribed is safe because the relay drains recordings before sessions. An empty eligible set never counts as movement: re-extracting over no transcript would replace the draft with nothing.

`sessionNextStep` in the relay now reads status before data. It chose the step from `extracted` alone, which was correct only while the sole route into `extracting` was the first close of a never-extracted session. A reopened session that already has an extraction would otherwise have gone to the write step, hit the `reviewOutcome` reopen had just cleared, and died. `failed` stays data-driven, because a session resting mid-cycle no longer has a status that names the step it was in.
