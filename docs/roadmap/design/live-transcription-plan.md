# Live Transcription Implementation Plan

> **Executing this:** one task at a time, in order, each ending with its own test cycle and its own
> review. Steps use checkbox (`- [ ]`) syntax so progress is trackable. Every task's final step runs a
> mutation and reports what it saw — a test nobody has watched fail is not a gate.

> **Status of this document.** Decomposition, interfaces, gates and the must-fail tests are complete,
> and they are the whole of what a plan here carries: no implementation code, by standing preference.
> An implementer writes the code from the intent and the tests.

**Goal:** An auditor sees their words appear about a second after they pause, while still in the room,
so a misheard reading is corrected on the spot rather than discovered at review.

**Architecture:** One `getUserMedia` stream feeds both `MediaRecorder` (durable chunks, piece 1,
unchanged) and an `AudioWorklet` emitting 512-sample frames. In the worker, Silero VAD runs per frame
carrying its own recurrent state tensor; 400 ms of trailing silence closes an utterance, which goes to
Moonshine and lands on `item.preview.segments[]`. `Outbox.watch()` already delivers that to the UI, so
no new subscription mechanism exists. At `stop()` the batch path re-transcribes the whole recording and
replaces the preview.

**Tech Stack:** TypeScript 6.0.3 (ESM-only), RxDB 17.4.0, zod 4, Vitest 4 (`unit` = node, `browser` =
real Chromium), React 19, `@huggingface/transformers` 4.2.0.

**Design:** [`live-transcription-design.md`](live-transcription-design.md) — revision 6. Read it
before Task 1. Where this plan and the design disagree, the design wins and the plan is wrong.

## Global Constraints

- **ESM only.** Relative imports carry a `.js` extension though the source is `.ts`.
- **`import type`** for type-only imports — lint-enforced.
- **Comments explain WHY, not what.** Match the surrounding density.
- **`ribo-core` must not depend on any engine package.** The live seam is defined in core; the ondevice
  package implements it. This is the same direction as `Transcriber`.
- **Live must never degrade recording.** Every failure path ends with capture continuing. A preview is
  a nicety; the audio is the product.
- **No back-compat burden.** No users; breaking changes and schema changes are free.
- **Every test must be able to fail.** Break the implementation, confirm _that_ test goes red, report
  which mutations ran. Print whether the mutation applied before trusting a green result — a
  non-matching edit produces output identical to a passing test.
- **Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check` after every task; `./check.sh` before
  the final commit.
- **Do not re-derive the reference constants.** They are adopted from
  `transformers.js-examples/moonshine-web` deliberately: 512-sample frames, enter 0.3 / exit 0.1,
  400 ms min-silence, 80 ms pre-speech pad, 250 ms min-speech, 30 s buffer cap.

## File Structure

**Created:**

| File                                                   | Responsibility                                    |
| ------------------------------------------------------ | ------------------------------------------------- |
| `packages/ribo-core/src/live.ts`                       | `LiveTranscriber` / `LiveSession` seam types      |
| `packages/ribo-core/src/queue/preview.ts`              | append a segment; delete on transcript handoff    |
| `packages/ribo-transcriber-ondevice/src/vad-stream.ts` | Silero frame loop, state carried, utterance close |
| `packages/ribo-transcriber-ondevice/src/live.ts`       | `LiveTranscriber` impl over the worker            |
| `packages/ribo-core/src/worklet.ts`                    | `AudioWorklet` regrouping render quanta into 512  |
| `playground/src/live-handle.ts`                        | host-owned `LiveTranscriber` singleton            |

**Modified:**

| File                                        | Change                                        |
| ------------------------------------------- | --------------------------------------------- |
| `queue/schema.ts`                           | `preview` field, and its `OutboxPatch` `Omit` |
| `queue/outbox.ts`                           | append-segment and the transcript handoff     |
| `queue/relay.ts`                            | do not admit new items while anything records |
| `core/src/recorder.ts`                      | optional `onSamples` tap                      |
| `ondevice/worker.ts`, `protocol.ts`         | the live conversation                         |
| `ondevice/config.ts`                        | Silero id, `liveCapability()`                 |
| `ui-react/src/use-recorder.ts`              | open and close the live session               |
| `playground/src/App.tsx`, `RecordPanel.tsx` | render the preview                            |

---

## Task 1: `preview` on the schema, and the handoff

**Files:** `queue/schema.ts`, `queue/preview.ts` (new), `queue/outbox.ts`, `queue/schema.test.ts`

**Produces:** `preview?: { segments: string[] }` on `OutboxItem`; `Outbox.appendPreviewSegment(id, text)`;
transcript-write deletes `preview` in the same modification.

**No `sessionId` parameter**, deliberately — an earlier draft of this line had one. The outbox stores
no session token and so cannot validate one; discarding replies from a closed session is the session's
own job (Task 3). The outbox's half of that guard is the status/transcript refusal below.

Three requirements, each of which has already been got wrong once in this codebase:

- **`incrementalModify` + `delete`, not `patch`.** `Outbox.patch` is an `incrementalPatch`, and setting
  an optional property to `undefined` does not delete the persisted key.
- **The append modifier rejects when `status !== "recording"` or `transcript` exists.** A live reply
  in flight when the transcript lands must not resurrect the preview.
- **`preview` is not patchable** — add it to `OutboxPatch`'s `Omit` list and to the type-level guard in
  `schema.test.ts`. Removing a field from that `Omit` currently breaks nothing without the guard.

**Must be able to fail:**

- A stale live reply after the transcript is written does not restore `preview`. The naive "never both
  populated" assertion passes without the guard and misses the race entirely.
- Deleting `preview` and writing `transcript` is **one** revision — a subscriber never observes both or
  neither. Assert on the emission count, not the final state.

---

## Task 2: Silero streaming VAD in the worker

**Files:** `ondevice/vad-stream.ts` (new), `ondevice/config.ts`, `ondevice/vad-stream.test.ts`

Load `onnx-community/silero-vad` via `AutoModel.from_pretrained(..., { config: { model_type:
"custom" } })` — it goes through the transformers.js we already pin, not raw ORT. Per 512-sample frame:
run the model, **keep the `stateN` tensor it returns and feed it back**, apply 0.3/0.1 hysteresis,
accumulate while in speech, close after 400 ms of silence, prepend the 80 ms pre-speech FIFO.

`pyannote-segmentation-3.0` stays for the batch path — do not remove it. Its 10-second windows are
fine when nothing is waiting.

**Must be able to fail:**

- **The returned state is carried into the next frame.** Feeding the initial zero state every time
  still broadly detects speech on clean audio, which is exactly why this needs asserting explicitly:
  the bug is silent and shows up as clipped onsets in noise. Assert the tensor fed to call N+1 is the
  one returned by call N.
- **A region opening includes the pre-speech FIFO.** Without it the frame that _detected_ speech is the
  first transcribed and the consonant before it is gone.
- **A silence shorter than 400 ms spanning two feeds does not split an utterance.**

---

## Task 3: The live seam, and the worker conversation

**Files:** `core/src/live.ts` (new), `ondevice/src/live.ts` (new), `ondevice/protocol.ts`,
`ondevice/worker.ts`, `core/src/index.ts`

**Consumes:** Task 3's frame loop. **Produces:**

`LiveSession` — returned by `openSession`:

| member      | signature                       | note                                             |
| ----------- | ------------------------------- | ------------------------------------------------ |
| `feed`      | `(frame: Float32Array) => void` | synchronous; must return before inference        |
| `close`     | `() => void`                    |                                                  |
| `segments$` | `Observable<string>` (readonly) | one emission per closed utterance                |
| `sessionId` | `string` (readonly)             | stamps replies so a closed session's are dropped |

`LiveTranscriber` — the seam an engine implements:

| member           | signature                                        |
| ---------------- | ------------------------------------------------ |
| `liveCapability` | `() => Promise<TranscriberCapability>`           |
| `openSession`    | `(recording: Recording) => Promise<LiveSession>` |

`liveCapability()` is separate from `capability()` because live additionally needs Silero — "ASR
cached, VAD missing" is a real state. Revision 6 notes the justification is now the VAD, not the model,
since both paths share weights.

**Not composed through `firstCapable`** — it takes `Transcriber[]` and widening it would drag a live
concern into every batch roster. The orchestrator takes an optional `LiveTranscriber` directly.

Serialise VAD and ASR through one promise chain: transformers.js does not support simultaneous
inference in a worker.

**Must be able to fail:** `feed()` returns before inference completes (assert synchronously, or a slow
model blocks the audio thread); a closed session's late reply is discarded by `sessionId`.

---

## Task 4: The `AudioWorklet` tap

**Files:** `core/src/worklet.ts` (new), `core/src/recorder.ts`, `recorder.browser.test.ts`

`Recorder` gains optional `onSamples`. One `getUserMedia` stream feeds both `MediaRecorder` and the
worklet; the worklet regroups the browser's 128-sample render quanta into 512-sample frames. Without
the callback, behaviour is identical to today.

**Must be able to fail:** frames arrive at exactly 512 samples regardless of render quantum; the
worklet is torn down on `stop()` **and** on `abort()` (a live worklet on a dead stream is a leak the
existing teardown test will not notice); a worklet failure does not stop capture.

---

## Task 5: React and playground wiring — **turn it on**

**Files:** `ui-react/src/use-recorder.ts`, `playground/src/live-handle.ts` (new), `App.tsx`,
`RecordPanel.tsx`, `playground/src/live.browser.test.ts` (new)

Durable capture shipped exported, tested, and **off**, because every core test supplied its own
factory and no host ever did. Do not repeat it: this task ends with the playground rendering live text
and a browser test driving the playground's **own module singletons**.

- [ ] `RecordPanel` renders `preview.segments` while recording.
- [ ] The relay does not admit new items while anything is `recording`; an in-flight item finishes and
      utterances **buffer** rather than drop for that bounded wait.
- [ ] A browser test over the real handles asserts a segment appears during recording and that
      `preview` is gone once `transcript` lands.

**Must be able to fail:** deleting the live wiring from the playground handle turns the new browser
test red, and nothing else in the repo notices.

---

## Self-review notes

- **Peak memory is a known risk, not a gate.** The Moonshine swap roughly doubled peak RSS
  (3494 → 6644 MB, desktop, 54-second inputs), and live runs inference alongside an open microphone
  and `MediaRecorder`. The design's §Memory records it and names moonshine-tiny as the lever. This
  plan proceeds without measuring it first — a deliberate call, so that a wall shows up as rework
  rather than as a stalled plan.
- **Not in scope:** live extraction (deferred; needs R3 routing), word-level streaming (needs Moonshine
  v2, absent from the pinned runtime), and removing the batch VAD layer (retracted in revision 5 —
  Moonshine's own reference caps input at 30 s).
- **Known-stale before this ships:** `docs/implementation/14` still documents Whisper-hinted figures,
  and `score-partb.mjs` reads a clean-text baseline the corpus v2 reconciliation replaced. Neither
  blocks this plan; both should be fixed before its numbers are quoted anywhere.
