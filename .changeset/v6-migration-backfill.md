---
"@azx/ribo-core": patch
---

Fix the v5 → v6 outbox migration, which could strand or silently drop an auditor's captured work.

The shipped v6 migration stashed session-level fields in a module-level `Map` and drained it after `addCollections`. Three defects followed.

**A recording still awaiting transcription was stranded.** With no extraction to find, the status derivation fell through to `done` — which is terminal (`FINISHED_SESSION_STATUSES`, no reopen path). The relay transcribed the audio and then had nowhere to take it, while `summarizeWork` counted the session as `synced`, reporting work that had never left the device as safe.

**Only the first recording of a session contributed anything.** The merge branch pushed an id and dropped `extracted`, `reviewOutcome` and `writeResult`, so which recording's data survived depended on RxDB's iteration order. `extractedFromRecordingIds` then claimed the whole recording set, so `recordingSetChanged` would report the cache as valid and suppress the re-extraction that would have repaired it.

**An interrupted migration orphaned rows.** Since RxDB 15 migrations resume from a checkpoint, and a checkpoint survives a page reload where module state does not. A tab closed mid-migration resumed with only the documents it had not reached, so rows migrated before the interruption referenced sessions that were never created.

Replaced with expand/contract. The v6 strategy is now a pure per-document transform: it moves the six session-level fields sideways into a `legacy` carrier, adds `sessionId` and remaps the status, deleting nothing. `backfillSessions` then runs once both collections are open, groups the migrated recordings by `sessionId`, creates one session per group, and clears the carriers. Every step is safe to run twice, which is the only property a resumed migration preserves.

Grouping is what fixes the data loss: the backfill finds the extraction on whichever recording holds it, derives status from every recording in the group — so "still queued" opens the session and "all discarded" finishes it — and records provenance naming only the recording that actually produced the extraction.

No API change. `backfillSessions` and `migratedSessionId` are exported from `database.ts` for direct testing.
