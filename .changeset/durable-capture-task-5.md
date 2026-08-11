---
"@azx/ribo-core": major
"@azx/ribo-ui-react": major
---

Acquire the capture lock, persist chunks during recording, and report capture health.

**Breaking changes:**

- `Recorder.start()` now returns `Promise<string | undefined>` (the outbox item id
  in durable mode, `undefined` otherwise) instead of `Promise<void>`.
- `RecorderOptions` gains `captureSession?` (a durable-capture session factory)
  and `timesliceMs?` (defaults to 5000 ms). `Recorder` gains a `captureSession`
  getter and a `capture-busy` error code.
- `workSafety` gains an optional fourth parameter `captureHealth?: CaptureHealth`.
  The `WorkSafety` type gains `recording` as a `protected` reason and
  `capture-stalled` as an `at-risk` reason. The `at-risk` `persistence` field is
  now optional (absent on `capture-stalled`).
- `RiboInstances` gains an optional `captureCoordinator?` field.
- `@azx/ribo-ui-react` gains `rxjs` as a runtime dependency (for the
  `CaptureCoordinator`'s `BehaviorSubject`).

**What this does:**

`Recorder.start()` now acquires the `CAPTURE_LOCK` Web Lock before opening the
microphone — two tabs recording at once is wrong regardless of durability. When
`captureSession` is configured, `start()` opens a capture session (inserting a
`recording` row), starts `MediaRecorder` with a timeslice, and routes each
`dataavailable` to the session's `ingest`. `stop()` finalises: merges chunks,
decode-verifies, and commits the row to `queued`. A failure after the row is
created unwinds it (abort removes the row) and releases the lock.

`workSafety` keeps `protected` during healthy recording (`captureHealth ===
"flushing"`) with a distinct `recording` reason naming the unflushed tail. It
downgrades to `at-risk` / `capture-stalled` when persistence has actually fallen
behind. The existing precedence is unchanged: `dead` is still checked before
capture health.

`CaptureCoordinator` in `ribo-ui-react` lets `useRecorder` publish the active
capture session and `useWorkSafety` read its health — a session created inside
one hook cannot reach a sibling through `RiboProvider`'s pass-through value, so
the coordinator is the shared, observable thing that makes this work. It is
optional: absent, there is no capture health and `useWorkSafety` behaves as
before.

**Limitation (design §1):** each flushed chunk is safe; emission can stall for
as long as the app is backgrounded (Chrome Android screen-lock, desktop
sleep/wake). The claim is "each flushed chunk is safe", never "a five-second
bound".
