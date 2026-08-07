# 09 — Offline-First Foundation

Backed by a 2025–2026 best-practices review (offline mutation queues + the local-first sync-engine landscape). This is a **foundation** decision: the app is expected to grow into a real offline field tool, so we pick a data layer with headroom rather than a throwaway outbox.

## What "offline" actually means here (per step)

| Step                                         | On-device path                | Managed-STT path |
| -------------------------------------------- | ----------------------------- | ---------------- |
| **Record**                                   | offline ✓                     | offline ✓        |
| **Transcribe**                               | **offline ✓** (WASM Whisper)  | needs network    |
| **Extract** (transcript → fields, LLM proxy) | needs network                 | needs network    |
| **Review / accept**                          | offline ✓ (once fields exist) | offline ✓        |
| **Write** (to Snugg Pro)                     | needs network                 | needs network    |

Offline-first core = **capture + (on-device) transcription**. Extraction and write are network-bound and **queue**. This satisfies the stated requirement — "brief attic/basement gaps, not indefinite offline" (Session 32) — with margin to spare.

## Foundation decision: RxDB (Dexie RxStorage)

**Why RxDB and not a bare outbox or a sync engine:** we confirmed the tool will eventually need **reference data on-device** (property lists, templates, assignments) synced from a server. That rules out both extremes — a throwaway outbox we'd outgrow, and the heavy sync engines (Zero / ElectricSQL / PowerSync / Triplit / InstantDB) that force a mandatory server + Postgres now. RxDB is a real local document DB whose **replication is backend-agnostic (custom HTTP/GraphQL)**, so we can sync against _our own_ API behind Helix's gateway later without re-platforming. (The earlier research verdict "RxDB is overkill" was conditioned on _outbound-only_; the read-sync requirement flips it.)

### Storage adapter + licensing/upgrade seam

Start with the **free, open-source Dexie-based `RxStorage`** — IndexedDB underneath, so it works across the whole device matrix **including iOS Safari**. RxDB is open-core: Dexie storage is free (Apache-2); the faster storages are paid **RxDB Premium**. Because storage sits behind the `RxStorage` interface, upgrading is swappable and touches no app code:

| Adapter                         | When                                              | Note                                                                         |
| ------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Dexie storage** (free)        | now / default                                     | IndexedDB; broadest compatibility incl. iOS                                  |
| **OPFS** (Premium)              | perf on Surface/Chromium                          | iOS OPFS is newer/edge-case-prone — validate before relying on it on iPhones |
| **Premium IndexedDB** (Premium) | faster, same substrate, broad support             | paid                                                                         |
| **SQLite** (Premium)            | only if the tool goes **native** (Capacitor/Expo) | not for a static browser app                                                 |
| **Worker-wrapped** (any)        | keep UI thread smooth as data grows               | storage in a Web Worker                                                      |

### What goes where

- **Structured/queue/reference data** → RxDB collections.
- **Audio** → an **RxDB attachment** on the outbox doc; deletable once transcription is confirmed (shrinks storage and helps the consent story). **As built this is opt-in:** `createRelay({ dropAudioAfterTranscription })` defaults to **`false`**. Deleting unconditionally would contradict Phase 2's own acceptance test — record, reload, the audio is still there — because the fake transcriber "confirms" transcription instantly, so the bytes would be gone before anyone could reload and see them. Turn it on once transcription is real and its output is trusted; until then the retention win is not worth losing the only visible proof that the queue is durable. (Storage-side, `Outbox.dropAudio(id)` is always available and unconditional — the flag governs only whether the relay calls it.)
- **Proving any of this persisted** → not by closing and reopening RxDB, which passes even against in-memory storage. See [07 §"Durability cannot be tested through the thing whose durability you are testing"](07-testing-and-accuracy.md#durability-cannot-be-tested-through-the-thing-whose-durability-you-are-testing).
- **The WASM Whisper model** → **Cache API**, _not_ RxDB. One-time prime on first launch (progress UI); check `navigator.storage.estimate()` before caching.
  - Sizes, now that the model is chosen ([01](01-feasibility-spike.md)): `tiny.en` ~96 MB, `base.en` ~142–165 MB, `small.en` ~300 MB — **plus ~13 MB (Safari build) / ~24 MB (Chromium build) for the ONNX Runtime binary itself** (verified by inspection). The runtime is a real part of the one-time download and is routinely left out of these estimates; the progress UI and the `estimate()` check must both count it.
  - **transformers.js already writes weights to the Cache API** under `transformers-cache` by default — the design here, for free, no work needed. The **runtime binary** is cached only if `wasmPaths` is set explicitly, which we do anyway ([10 §4](10-build-and-packaging.md)).

## The outbox (outbound-pipeline durability)

The voice→fields→external-write pipeline is **our own outbox**, modeled as an RxDB collection the relay drains. RxDB does _not_ do the external-API push — we do.

### State machine (per item)

```
queued → transcribing → extracting → writing → done
                     ↘ (transient error) → failed ─(nextAttemptAt passes)→ retry ↺
                     ↘ (terminal 4xx)    → dead   (surfaced for attention)
                                    failed ─(attempts ≥ maxAttempts)→ dead
```

**`failed` is a resting state, not a terminal one — only `dead` is terminal.** This is the correction that makes backoff expressible at all: a retryable failure has to be _somewhere_ while it waits, and that somewhere is `failed` + a future `nextAttemptAt`. An item is `failed` when the last attempt lost, the error looked transient, and the attempt budget is not spent; the relay picks it back up on the next drain whose clock has passed `nextAttemptAt`, with no timer involved. `maxAttempts` (default **8**) is what promotes `failed` to `dead`, alongside a failure classified terminal outright. `dead` is where an item stops and a human is asked to look.

Concretely, `failed` is in `ACTIVE_OUTBOX_STATUSES` (the relay still asks for it); `done` and `dead` are the finished set.

Fields: `id` (UUID), `seq` (monotonic, ordering), `status`, `idempotencyKey` (UUID at enqueue), `attempts`, `nextAttemptAt`, `lastError`, step outputs, audio attachment. **Persist each step's output back to the doc on completion**, so a crash resumes at the next step rather than re-recording. The relay derives the next step from _which outputs are present_, not from `status`: `status` records what was in flight when the tab died and can be stale, while a persisted transcript cannot lie about transcription having finished.

### A `failed` head blocks the queue; a `dead` head does not

The two resting states differ in a second way, and it is the price of the ordering guarantee below:

- A **`failed`** item at the head **stops the drain.** It is still in the queue, it is still first, and it will be retried — so letting the item behind it proceed would let a later capture overtake an earlier one. The drain returns and waits for the next trigger.
- A **`dead`** item at the head **does not stop the drain.** It has left the queue for good, so blocking behind it would strand every capture made after it, forever.

This asymmetry was a real bug the tests caught — "stop the drain on failure" is the obvious rule and it is wrong for exactly one of the two failure outcomes. Both directions are pinned by tests (`relay.browser.test.ts`: "a parked head-of-queue item holds the queue, preserving capture order" and "a dead item does not block the queue behind it").

### Foreground relay (the iOS reality)

There is **no background execution on iOS Safari** (Background Sync API unsupported through iOS 26). So the queue drains **in-foreground**: on app start, on `online`, on `visibilitychange`, plus an explicit **"Sync now"** button. Process **serially** (concurrency 1), lowest `seq` first, to preserve order. (Workbox Background Sync is Chromium-only progressive enhancement — never the durability guarantee.)

### Idempotency, backoff, ordering

- **Idempotency:** one UUID key per item at enqueue, reused on every retry, sent as `Idempotency-Key` on external writes → an ambiguous success can't double-write.
- **Backoff:** full jitter — `delay = min(cap, base·2^attempts)·random()` — persisted in `nextAttemptAt` so it survives reloads. Retry only transient failures (5xx/429/network); 4xx (except 408/429) → `dead`.
- **Ordering:** monotonic `seq` + serial processing.

## iOS Safari constraints (design requirements, not preferences)

1. **No background drain** → foreground relay + "Sync now" (above).
2. **7-day ITP eviction wipes IndexedDB _and_ Cache together** — the outbox _and_ the WASM model vanish at once. Mitigate: call `navigator.storage.persist()` early; **prompt "Add to Home Screen"** (resets the inactivity counter, favors a persistent grant); on launch **detect a wiped model → re-prime**, and **detect a wiped outbox → surface gracefully**.
3. **Quota is percentage-of-disk and device-dependent** (Safari 17+) — check `storage.estimate()` before priming; warn on tight headroom.
4. **Eviction is all-or-nothing** — never assume partial survival.

## The read-sync future + the API-call story

Everything — now and future — flows through **Helix's gateway** (`/_api/*`); nothing bypasses the single egress. Two call types, kept separate:

|           | Our own synced dataset                     | External tools                                          |
| --------- | ------------------------------------------ | ------------------------------------------------------- |
| Examples  | reference data; optionally capture records | Snugg Pro write, Azure STT, LLM extraction              |
| Mechanism | **RxDB replication** to _our_ backend      | **outbox / direct fetch**                               |
| Route     | `/_api/fetch/<our-backend>/…`              | `/_api/fetch/https://api.snugg.pro/…`, `/_api/llm/chat` |

RxDB replication is just `pull`/`push` fetch handlers we author against the gateway path — RxDB never needs to know Helix exists.

### The mover-swap (why this is "right now")

Design the client so **all writes land in a local RxDB collection**, and a "mover" drains them. Only the mover changes over time — the client shape doesn't:

```
PoC (no backend):
  UI → write local RxDB → client relay → /_api/fetch → Snugg Pro / STT / LLM

Future (backend + read-sync):
  UI → write local RxDB → RxDB replication → /_api/fetch → OUR backend
                                               └─ backend orchestrates STT / extraction /
                                                  Snugg Pro write server-side
  reads: UI reads local RxDB (offline-first); replication keeps it fresh
```

The outbox we build now (RxDB collection + relay + idempotency) is the **exact seam** that later becomes RxDB replication — we swap its transport, we don't throw it away. The external-write concern can migrate **server-side** once the backend exists, which _shrinks_ the client.

### Honest dependency flag

The read-sync backend is where our "no backend" stance ends — **by design, only when read-sync is real**. It needs the **same Azure deploy substrate** the custom-STT-service discussion raised ([02](02-server-stt.md)); that dependency reappears here, later. It trusts the gateway's attested `(app, user)` identity and does not re-auth.

## Build vs adopt

- **Adopt:** RxDB (+ Dexie RxStorage) for the local DB and the future replication protocol; the Cache API for the model; browser `MediaRecorder` + `@ricky0123/vad` for capture.
- **Build (small, owned):** the outbox state machine + foreground relay + idempotency/backoff/ordering, as an RxDB collection. No library gives a _multi-step-resumable_ outbox turnkey without a backend, so this thin orchestration is ours — behind `ribo-core`'s `Outbox` class and `Relay` interface, so the engine stays swappable.

## Open items

- Confirm the client's field devices support the storage path we rely on (they will — IndexedDB is universal; OPFS only matters if we chase Premium perf).
- Decide the "Add to Home Screen" onboarding nudge for iOS durability.
- Defer the read-sync backend + RxDB replication endpoints until reference-data-on-device is actually scheduled (design the seam now, build later).

## Key sources

- iOS Background Sync unsupported: [caniuse](https://caniuse.com/background-sync), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
- ITP 7-day eviction + `persist()`: [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/), [MDN storage quotas & eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- RxDB storage adapters + Premium: [rxdb.info](https://rxdb.info/rx-storage.html), replication: [rxdb.info/replication.html](https://rxdb.info/replication.html)
- Client outbox pattern + idempotency: [AWS Transactional Outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html), [Stripe idempotency](https://stripe.com/blog/idempotency)
