---
"@azx/ribo-core": patch
---

Introduce `CaptureItem`, generic `Transcriber<S>`, and `UnsupportedItemError`.

Adds a `kind` discriminant to capture records (`"audio"` on `Recording`, `"document"` on the new `DocumentCapture`), a `CaptureItem` union wrapping both, and a `z.preprocess` that stamps `kind: "audio"` onto legacy rows so they parse through the discriminated union unchanged — no RxDB version bump. `Transcriber` becomes generic over its item with `transcribe` declared as a function-typed property (not a method), so an audio-only engine no longer slides unchallenged into a slot that can see documents. `restrictToKind(kind, transcriber)` lifts a narrow engine into a wide slot by refusing other kinds with `UnsupportedItemError` — the third failure class, terminal for the queue but not for the item, extending `TerminalQueueError` with a one-token widening of `name: string`.
