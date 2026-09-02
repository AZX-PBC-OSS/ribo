---
"@azx/ribo-core": major
"@azx/ribo-ui-react": major
---

The outbox splits into recordings and sessions, so one review covers the whole capture rather than one review per recording.

`OutboxItem` was two entities wearing one schema. A **session** now owns N **recordings**: `extracted`, `extractedBy`, `reviewOutcome`, `writeResult` and `idempotencyKey` move onto the session, and the recording gains `sessionId`. This is a capture concept, not a domain one — `assessmentId`, `companyId` and `apiBaseUrl` stay in `recording.ctx`, so core still knows nothing about what a session is _about_.

Two state machines instead of one. Recordings narrow to capture and transcription (`recording → queued → transcribing → transcribed`, plus `failed`/`dead`/`discarded`); sessions run `open → extracting → awaiting-review → writing → done` (plus `failed`/`dead`). A session leaves `open` on the host's say-so — the relay does not touch an open session.

Extraction moves to session level. `joinSessionTranscript` joins every transcribed recording's text in capture order, excluding `discarded`, and the recording-id set is stored as the extraction's provenance. The relay's per-item `extract` pass-through is deleted, not stubbed. One `reviewOutcome` on the session means "the most recent outcome is the outcome" is a stored fact rather than a read-time sort over N copies, and the N-item submit fan-out — with its partial-failure window — disappears.

Schema version bumps **5 → 6**. The migration synthesises one session per distinct `ctx.assessmentId`, attaches its recordings, and carries the moved fields up; recordings with no assessment id share one singleton session. Session status is derived from the stashed data: `writeResult` → `done`, `reviewOutcome` → `writing`, `extracted` → `awaiting-review`, otherwise `done`.

Breaking changes:

- One collection (`outbox`) becomes two (`outbox` + `sessions`), with `OutboxDocument` and `SessionDocument`.
- `OutboxItem` loses `extracted`, `extractedBy`, `reviewOutcome`, `writeResult` and `idempotencyKey`, and gains `sessionId`.
- Recording statuses `extracting`, `awaiting-review`, `writing` and `done` are gone; recordings end at `transcribed`.
- `ExtractStep` / `WriteStep` become `SessionExtractStep` / `SessionWriteStep`, taking a session rather than an item.
- `Outbox.submitReview` / `reopenForReview` become `Outbox.submitSessionReview` / `reopenSessionForReview`.
- `summarizeWork(items)` becomes `summarizeWork(recordings, sessions)`.
- `useReview(item, …)` becomes `useReview(session, …)`; `useRecorder` and `recorder.start()` take a `sessionId`.
- New `useSessions` hook, mirroring `useOutboxItems` over the sessions collection.

Two decisions are recorded in the plan but deliberately not implemented here: an all-discarded session does not yet short-circuit to `done`, and adding a late recording does not yet reopen a closed session (`recordingSetChanged` exists for that path and is currently unused).
