# example-durable-queue — the durable in-memory queue, host-observable half

One idea: **the offline-first ordering promise, observed the way a host lives
it.** The drain itself is already taught by `docs/api/examples/relay.run.ts` —
this example deliberately does not restate it, and it does not re-teach the
relay's retry/backoff either. Its two additions:

- **Watch, don't poll.** `storage.sessions.watch({ ref })` is subscribed before
  anything runs, and the example is not allowed to finish until the stream has
  reported the session reaching `awaiting-review`.
- **Persisted before transcribed, proved in call.** The transcriber handed to
  the relay is a `FakeTranscriber` subclass whose `transcribe` override reads
  storage itself at invocation time. The relay hands the override the capture
  **payload**, not the stored row, and the row's id is minted by the queue at
  enqueue time — it is not on the payload, so `captures.get(item.id)` would
  look up the wrong key. The override therefore reaches the row through the
  public session-scoped `captures.list({ sessionId })`, matching on the payload
  id, and asserts the row is already there, carrying the injected clock's
  `enqueuedAt`. A test-body read-back after enqueue could never catch a relay
  that transcribed before persisting; this can.

The example stops at `awaiting-review` — no review is submitted, because the
review gate is another example's subject. It also does not demonstrate
durability across close-and-reopen: that property belongs to the storage port
itself (obligation 2, held by the conformance kit and the memory backend's own
tests), not to this queue arc.

Runs credential-free against in-memory storage, an injected clock and a
granting lock manager. Its code is pulled into `docs/guide/sessions.md` (the
watch region) and `docs/guide/offline-and-storage.md` (the enqueue plus
in-transcriber assertion region) by VitePress snippet includes, and the runner
(`examples/run-examples.test.ts`) executes its export in the `unit` project on
every `./check.sh` run.
