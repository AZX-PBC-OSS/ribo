# Phase 2 — Recorder + Queue Implementation Plan

The plan for real audio capture (`MediaRecorder`) and the durable RxDB-backed outbox. Phase 2 is complete.

**Goal:** record real audio in a real browser and have it survive a reload. Ends with a playground you can talk into, watch the recording queue, refresh the page, and find it still there.

**Architecture:** two independent subsystems in `@azx/ribo-core` — `Recorder` (MediaRecorder capture) and `Queue` (RxDB-backed durable outbox) — plus the Vitest **browser project** that Phase 0 deliberately deferred until something needed it. This is the first phase that calls browser APIs rather than merely typing them.

**Tech Stack:** `MediaRecorder`, RxDB on the free Dexie `RxStorage`, Vitest browser mode (Playwright/Chromium).

## Global Constraints

Everything in [`AGENTS.md`](../../../AGENTS.md) applies, plus:

- **TDD, and the tier matters.** jsdom has no `MediaRecorder`, a shimmed IndexedDB, and does not faithfully simulate workers. Anything touching those APIs is tested in **browser mode**, not jsdom. Mocking your way around this produces tests that pass while production breaks — see [`10 §7`](../../implementation/10-build-and-packaging.md).
- **`ribo-core` stays headless** — browser APIs yes, `document`/`window` no (ESLint-enforced). A recorder needs `navigator.mediaDevices`; it does not need the DOM.
- **Dependencies get declared properly** — catalog-pinned exact, added to the right manifest. Phase 1 shipped zod on disk with no manifest entry and nearly broke a clean checkout.
- **New dependencies mean worktree isolation.** Tasks that add packages run in their own worktree so concurrent agents do not race the lockfile.
- Build on the Phase 1 vocabulary (`Recording`, `Transcript`, `Extracted`). Do not invent parallel types.

## Target platform (decided)

Evergreen Chromium on Windows (Surface), current-2; Safari iOS/iPadOS current-1; Chrome Android current-2. WebGPU, WASM SIMD, OPFS, IndexedDB, MediaRecorder and Web Workers may all be assumed present. **Capability is settled; performance is not.**

---

### Task 1: Browser test project

**Files:** modify `vitest.config.ts`; add dev deps

The Phase 0 config has a single `unit` project and a comment saying the browser project arrives when the first test needs real browser APIs. That is now.

- Add a `browser` project (Vitest browser mode, **Playwright provider**, Chromium, headless) discovering `packages/*/src/**/*.browser.test.ts`.
- **Mind the resolution trap.** `vitest.config.ts` documents that the `unit` project needs project-level `ssr.resolve.conditions` for `@azx/source`, because Node tests go through Vite's SSR pipeline. A browser project runs through the **client** pipeline and needs plain `resolve.conditions` instead. Get this right and **prove it** with a test importing a workspace package by bare specifier — the same guard `workspace-resolution.test.ts` provides for the unit project.
- Verify `./check.sh` runs both projects.

### Task 2: `Recorder`

**Files:** `packages/ribo-core/src/recorder.ts` + `recorder.browser.test.ts`

- **Mime-type negotiation first.** `MediaRecorder` emits different containers per browser — `audio/webm;codecs=opus` on Chromium, `audio/mp4` on Safari. Implement a capability probe using `MediaRecorder.isTypeSupported` that picks the best supported type from an ordered preference list, and record the chosen type onto the `Recording` (the field already exists and is documented as including the codecs parameter). **Downstream decoding depends entirely on this being accurate** — Phase 3 has to decode whatever this produces.
- `Recorder` API: `start()`, `stop()` returning `{ recording, audio }` (metadata per Phase 1's `recordingSchema` + the `Blob`), plus a way to observe elapsed time and input level for the capture UI.
- Handle the failure modes explicitly and test them: permission denied, no input device, `stop()` before `start()`, `start()` twice.
- Browser-mode tests. Chromium supports `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`; configure the Playwright launch so `getUserMedia` resolves without a human clicking a permission prompt, and say so in a comment.

### Task 3: `Queue` — storage layer

**Files:** `packages/ribo-core/src/queue/*.ts` + browser tests. **Run in a worktree** (adds RxDB).

- Add RxDB + the Dexie `RxStorage` (catalog-pinned exact, `dependencies` — it is in the public surface).
- Define the outbox collection per [`09 §"The outbox"`](../../implementation/09-offline-first.md): `id`, monotonic `seq`, `status`, `idempotencyKey`, `attempts`, `nextAttemptAt`, `lastError`, step outputs, and the **audio as an RxDB attachment** (not a base64 field).
- Tests must prove **durability across a page reload**, not merely that a write returns. That is the whole point of the subsystem and the one thing an in-memory fake would silently fake.

### Task 4: `Queue` — state machine and relay

**Files:** `packages/ribo-core/src/queue/*.ts` + tests

- Implement the per-item transitions from [`09`](../../implementation/09-offline-first.md): `queued → transcribing → extracting → writing → done`, with `failed`/`dead` terminals. **Persist each step's output back to the item on completion**, so a crash resumes at the next step rather than re-recording.
- Idempotency key generated once at enqueue and reused on every retry.
- Backoff with **full jitter**, `nextAttemptAt` persisted so it survives reload. Retry only transient failures; 4xx-equivalent → `dead`.
- **Serial processing**, lowest `seq` first.
- The relay drains in-foreground (`online`, `visibilitychange`, app start, and an explicit "sync now"). **There is no background drain on iOS** — Background Sync is unsupported there, so do not design for it.
- Use `FakeTranscriber` from Phase 1 to drive the machine without a model.

### Task 5: Playground — the visible payoff

**Files:** `playground/src/*`

- A record button, a live level/elapsed indicator, and a list of queued items with status.
- **The acceptance test is manual and specific:** record something, see it listed, **reload the page**, and see it still listed with its audio intact. Document that recipe in the playground UI itself or a README, so the next person can verify it in fifteen seconds.
- Keep the playground importing all three packages so the production build stays a composition check.

---

## Definition of done

- `./check.sh` green, running both unit and browser projects.
- Record → queue → **reload** → still queued, with audio recoverable.
- The mime-type probe reports what the browser actually produced, and a test pins it.
- RxDB and any other new dependency are catalog-pinned and declared in the right manifest.

## Deliberately NOT in Phase 2

Real transcription (Phase 3), audio decode/resample to 16 kHz PCM (Phase 3 — it is transcription-input prep, not capture), extraction, React components, the service worker and model caching, and read-sync/replication. If a task starts reaching for those, it is out of scope.
