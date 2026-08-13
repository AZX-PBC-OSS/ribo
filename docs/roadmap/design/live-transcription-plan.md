# Live transcription — implementation plan (revision 7)

**Authority:** `live-transcription-design.md`, revision 7. Read §The frame loop, §Data model,
§Failure handling and §Worker contention before starting any task.

**Supersedes** the previous five-task plan, which is complete and merged on `feat/live-transcription`.
That work built live transcription around VAD-detected utterances. Revision 7 replaces that model
after field testing showed the VAD discards audio it does not classify as speech — on the worst
measured emission, 28 % of the buffer was speech and the model received four words where the batch
pass produced thirteen. This plan implements the replacement.

## Goal

The live path transcribes **raw, contiguous, unfiltered audio**. The VAD decides only _when_ to
transcribe and where a commit boundary falls. Nothing the microphone captures is discarded before
transcription.

## Global constraints

Every task inherits these.

- ESM-only; `.js` extensions on relative TypeScript imports; `import type` for type-only imports
  (lint-enforced).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` must pass. Run `./check.sh` before the final
  commit of each task.
- `./check.sh`'s test stage has one **known pre-existing failure**: `live.browser.test.ts` fails when
  the `unit` and `browser` projects run together, from a test-isolation problem with the playground's
  shared singletons. It is not yours. Do not fix it; do not let it block a commit.
- Comments explain **why**, not what. Match the surrounding density. A comment that describes
  behaviour the code no longer has is a defect — three separate bugs survived review in this feature
  behind comments that had gone stale.
- No new dependencies.
- **Live must never affect recording.** A live failure degrades the preview and nothing else.
- Commit in small pieces as you go. A run that leaves everything uncommitted produced nothing, and an
  earlier task in this feature died with an empty worktree after hitting the model's output cap.
- Each task adds a changeset.
- The branch carries a commit marked `TEMP: @@LIVE@@ instrumentation — DROP BEFORE MERGE`. Leave it
  alone. Do not build on its console logging and do not remove it.

## Task 1 — The region buffer replaces utterance segmentation

**Files:** `packages/ribo-transcriber-ondevice/src/vad-stream.ts` and its tests.

**Intent.** `StreamingVad` currently retains only frames it classifies as speech and emits closed
utterances. Replace that with a component that appends **every** frame to a contiguous region buffer
and uses Silero's probability solely for timing. It reports two things to its caller: that a **pause**
has occurred, meaning the region should be re-transcribed, and that a **commit boundary** has been
reached — a pause long enough to be a natural break, or the region cap — meaning the current text
becomes permanent and the buffer advances past the committed audio.

The hysteresis thresholds and the recurrent-state handling carry over unchanged; the streaming state
is not the thing being replaced.

**Delete:** the minimum-utterance hold, `flush()`'s role as a rescue for discarded audio, and the
min-speech filter as an emission gate. The 250 ms filter survives only to suppress transcribing a
region containing no speech at all, and it must never remove audio from a region.

**Interfaces.** Decide the shape and state it in the task report, because Task 2 consumes it. It needs
to expose, per fed frame, whether a refresh is due and whether a commit boundary was reached, plus
access to the region's samples and a way to advance past committed audio. Keep the frame-feeding call
synchronous-friendly in the same way it is today — it is driven from an audio callback.

**Must-fail tests.**

- **No audio is ever dropped.** Feed a probability pattern that dips below the exit threshold
  repeatedly mid-region — the stuttering-delivery case — and assert the region's samples contain
  every frame fed, including the low-probability ones. Reinstating speech-only retention must turn
  this red. This is the test the whole revision exists for.
- **A pause triggers a refresh without advancing the buffer.** After a refresh point, the region still
  contains the audio from before it.
- **A commit boundary advances the buffer** past exactly the committed audio, and the next region
  begins where the previous one ended, with no gap and no overlap.
- **The region cap forces a commit** when no qualifying pause arrives.

Existing tests pin their own thresholds through constructor options rather than the production
constants; follow that pattern and read the comment explaining why.

## Task 2 — The worker transcribes regions and distinguishes tail from commit

**Files:** `packages/ribo-transcriber-ondevice/src/worker.ts`, `protocol.ts`, and their tests.
**Depends on Task 1.**

**Intent.** On a refresh, transcribe the whole region buffer and post the text as a **provisional
tail**. On a commit boundary, post the text as **committed** and advance the buffer. The worker
protocol currently has a single `liveSegment` message that means "append this"; it must distinguish
the two, because the host renders and stores them differently.

The existing error boundaries stay as they are: a VAD failure is session-fatal, a transcription
failure skips that refresh, surfaces, and leaves the session alive. Do not re-litigate that split.

**Load shedding.** If a refresh is requested while one is in flight, **skip it** — do not queue.
Dropping a refresh costs an intermediate rendering of provisional text; the buffer is untouched and
the next refresh sees everything. Never let backpressure touch the region buffer.

**Must-fail tests.**

- A refresh posts a tail message, not a committed one; a commit posts a committed one.
- A refresh requested during an in-flight refresh is skipped, and the following refresh still
  transcribes the full region including the audio that arrived during the skip.
- A transcription failure on one refresh leaves the session alive and a later refresh still produces
  text.

## Task 3 — `preview` becomes committed plus tail

**Files:** `packages/ribo-core/src/queue/schema.ts`, `preview.ts`, `outbox.ts`, and their tests.
**Independent of Tasks 1 and 2 — may run in parallel.**

**Intent.** Replace `preview: { segments: string[] }` with `preview: { committed: string[], tail?:
string }`. `committed` is append-only and never revised. `tail` is replaced wholesale on every write
and is never appended to. On commit, the tail's final value moves onto `committed` and the tail is
cleared.

There are no users and no migration to write; the field does not outlive a recording, since it is
deleted in the same modification that writes `transcript`.

**Preserve** the existing guarantees around the field: writes are refused once the row leaves
`recording` or once `transcript` exists, and the handoff deletes `preview` and writes `transcript` in
a single modification so no subscriber observes half of it. Read the existing tests for both before
changing anything — they encode races that were expensive to find.

**Must-fail tests.**

- A tail write replaces the previous tail rather than appending.
- A commit appends to `committed` and clears the tail, in one modification.
- Writes are still refused after the row leaves `recording`, and after `transcript` lands.
- The handoff still deletes `preview` atomically with the `transcript` write.

## Task 4 — The seam carries the distinction to hosts

**Files:** `packages/ribo-core/src/live.ts` (the `LiveSession` type),
`packages/ribo-transcriber-ondevice/src/live.ts`, and their tests. **Depends on Task 2.**

**Intent.** `segments$` currently emits strings that mean "append this". Hosts now need to tell a
provisional tail from a commit. Choose the shape — two observables, or one carrying a discriminated
value — and justify the choice in a comment against how `use-recorder` and the playground consume it.

`errors$` stays as it is. The `#closed` behaviour stays as it is: segments arriving after `close()`
must still reach the subscriber.

**Must-fail tests.** A tail and a commit are distinguishable by the subscriber; a late arrival after
`close()` still reaches it.

## Task 5 — Rendering, and proving it is switched on

**Files:** `packages/ribo-ui-react/src/use-recorder.ts`, `playground/src/live-handle.ts`,
`playground/src/RecordPanel.tsx`, and their tests. **Depends on Tasks 3 and 4.**

**Intent.** Route tails and commits to the right outbox writes, and render committed text and the
provisional tail **visually distinctly**. Settled text and text that is still rewriting itself must
not look identical — the design calls this out, and a reader who cannot tell them apart experiences
churn as the system changing its mind.

**Must-fail test.** A browser test over the **playground's own module singletons**, not a hand-built
provider, asserting that a tail appears during recording, that a commit moves it into committed text,
and that `preview` is gone once `transcript` lands. Deleting the live wiring from the playground
handle must turn this red. `playground/src/durable-capture.browser.test.ts` is the precedent — read it
first and follow its shape.

This task exists because durable capture shipped exported, tested and switched off, and the same hole
hid four live bugs behind a green suite.

## Non-goals for every task

- No live **extraction** — text only.
- Do not make the preview authoritative; the batch pass still replaces it.
- Do not change the batch path, the recorder, the worklet, or the capture lock.
- Do not adopt `@moonshine-ai/moonshine-wasm`, and do not revisit LocalAgreement — see
  `live-localagreement-spike.md`.
- Do not tune the region cap or refresh cadence beyond what the design states. Both are listed as open
  questions and want measurement on real speech, not a guess in an implementation task.
