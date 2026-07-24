# 03 — `@azx/ribo-core` (Headless Engine)

The reusable heart. Framework-free (no React) and no DOM _rendering_ — but very much a browser library: `MediaRecorder`, `IndexedDB`, `fetch`, `Blob`, `AudioContext` and `Worker` are all fair game here. The boundary is enforced by ESLint, not by the `lib` setting ([10 §3](10-build-and-packaging.md)). Owns the pipeline and a **generic** extractor that never names a Snugg Pro field (design decision D2 / "B1").

## Modules & responsibilities

| Module                        | Responsibility                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Recorder`                    | Mic capture via `MediaRecorder` (web standard) + **@ricky0123/vad** for voice-activity; → audio `Blob`s, live level + (on-device) partials.                                                                                                                                                                                                                                                             |
| `Queue`                       | The durable outbox — an **RxDB** collection (Dexie `RxStorage`) with a per-item state machine + foreground relay; audio held as an RxDB attachment; survives reload/offline; idempotency + jittered backoff + serial ordering. Full design + rationale in [09](09-offline-first.md).                                                                                                                    |
| `Transcriber` (interface)     | `OnDeviceTranscriber` (**OSS Whisper** via **`@huggingface/transformers` ^4.2.0**, primary) and `ManagedTranscriber` (proxies a managed **Azure STT** endpoint, fallback — see [02](02-server-stt.md)). Selected at runtime by the capability probe from [01](01-feasibility-spike.md). The on-device impl ships in **its own package**, not in `ribo-core` — see [10 §4.1](10-build-and-packaging.md). |
| `Extractor`                   | One schema-constrained call against Helix's **OpenAI-compatible route** — official `openai` SDK + `zodResponseFormat`, so the response is schema-conformant by construction — then deterministic normalization in TypeScript.                                                                                                                                                                           |
| `Controller`                  | Orchestrates the loop; drives the queue; calls the injected `ReviewPresenter`.                                                                                                                                                                                                                                                                                                                          |
| `ReviewPresenter` (interface) | Rendering seam — the UI layer ([04](04-ribo-ui.md)) implements it; core stays headless.                                                                                                                                                                                                                                                                                                                 |

## Key interfaces

```ts
export interface Recording {
  id: string;
  blob: Blob;
  capturedAt: number;
  ctx?: unknown;
}
export interface Transcript {
  recordingId: string;
  text: string;
  engine: string; // which engine produced it — required; see "Transcriber selection" below
  confidence?: number;
}

export interface TranscribeHints {
  /** Domain jargon to bias decoding toward. See "Transcriber strategy" below —
   *  this is the reason the model choice is Whisper. */
  vocabulary?: readonly string[];
  /** Free-text priming, when a phrase list is the wrong shape. */
  prompt?: string;
}

export interface Transcriber {
  readonly engine: string;
  capability(): Promise<TranscriberCapability>; // ready | needs-download | unavailable
  transcribe(rec: Recording, audio: Blob): Promise<Transcript>;
}

// Ordered roster, first one `ready` wins. `needs-download` is never auto-selected.
export function firstCapable(
  transcribers: readonly Transcriber[],
  options?: FirstCapableOptions,
): CompositeTranscriber;

export interface ToolAdapter<F> {
  name: string;
  schema: z.ZodType<F>; // strict: nullable+required + provenance envelope
  instructions: string; // domain guidance for extraction
  examples?: Array<{ text: string; out: Partial<F> }>; // few-shot
  write(fields: F, ctx: unknown): Promise<void>;
}

export interface ReviewPresenter<T> {
  present(draft: T): Promise<T | null>;
}

// the loop
export async function run<F>(
  rec: Recording,
  a: ToolAdapter<F>,
  ui: ReviewPresenter<F>,
): Promise<void>;
```

## Transcriber strategy (research pass 2026-07-22)

Evidence grades are marked as in [01](01-feasibility-spike.md): **[verified by inspection]**, **[vendor-claimed]**, **[unmeasured]**.

**Why Whisper — and it is not accuracy.** The deciding property is **`prompt_ids`**: transformers.js supports Whisper decoder priming **[verified by inspection]**, so we can prime the decoder with our own jargon — R-value, CFM25, ACH50, AFUE, blower door, backdrafting. Moonshine and Parakeet expose **no biasing hook of any kind**, and Moonshine's fine-tuning is a paid commercial service. For a domain-jargon problem, **a promptable model at 8% WER beats a non-promptable one at 7%**, because the errors we cannot tolerate are concentrated in exactly the tokens the extractor keys on ([01](01-feasibility-spike.md)'s sub-spike, [07](07-testing-and-accuracy.md)).

That is why `Transcriber.transcribe` carries a **hints** argument. It is not speculative generality: it is the one capability the model was chosen for, and an interface without it silently discards the reason for the choice. The `ManagedTranscriber` may ignore hints, or map them onto the vendor's phrase-list feature — the interface does not require every impl to honour them, only to accept them. The adapter's domain vocabulary is the natural source ([05](05-adapter-snuggpro.md)).

**Hints are not in the shipped interface yet.** Phase 1's `transcribe(recording, audio)` has no
`hints` parameter — nothing produces them and nothing consumes them, and a parameter every
implementation ignores is a parameter nobody keeps honest. It is a purely additive optional
third argument when Phase 3 has a decoder to prime; the argument above for why it must exist is
unchanged. Noted here so the omission reads as deferral, not as a decision reversed.

**The actual WER cost of energy-audit jargon and spoken numerals is [unmeasured]** for every candidate ([open questions §12](../open-questions.md)) — priming is the mitigation we designed for, not a measured fix.

**Batch is the contract, deliberately.** `transcribe()` returns a whole `Transcript` for a whole `Recording`. Streaming partials are demonstrated on Chromium+WebGPU but cost roughly N× a batch transcription, because Whisper re-encodes a zero-padded 30 s window on each update — unaffordable on the single-threaded WASM path that iOS is now known to get ([01](01-feasibility-spike.md), Finding 1). Partials therefore ship, if at all, as a **Chromium-only progressive enhancement, off by default**, layered on top of this interface rather than changing it. `Recorder`'s "(on-device) partials" in the table above should be read that way.

**Backend selection is not a device flag.** WebGPU on Chromium; WASM-SIMD, single-thread-safe, everywhere else. On iOS the shipped ORT binary contains **no WebGPU code at all** **[verified by inspection]** while `IS_WEBGPU_AVAILABLE` still reports `true`, so the probe must sniff the **engine** and force the WASM path for every iOS browser — including Chrome and Firefox on iOS, which transformers.js's own `isSafari()` misclassifies. **Never require COOP/COEP** ([10 §4](10-build-and-packaging.md)).

## Extraction

**One schema-constrained call.** The core sends the transcript plus the adapter's `instructions` and `examples`, with the adapter's zod schema as `response_format` — so the response is schema-conformant by construction. Then the core normalizes deterministically in TypeScript (units, enums, ranges) — never in the prompt.

Every extracted field carries `value` / `confidence` / `sourceSpan`, guaranteed present by the strict schema ([05](05-adapter-snuggpro.md)) — which is what lets the review card show the auditor the quote behind each value and flag low-confidence fields.

**Settings:** `temperature: 0` for reproducibility (the accuracy harness depends on it). Because structured outputs are schema-conformant by construction, a parse-and-repair stage isn't part of the design; we keep a single retry only as a backstop.

The core deliberately does **not** impose an extraction _strategy_ (chunking, multi-pass, field grouping). Those are domain- and schema-size-specific; if a future adapter's schema outgrows a single call, that's solved then, without changing this contract.

## Behaviours worth calling out

- **`RecorderState.level` is raw RMS, deliberately.** It is the measurement, not a display value: the SDK reports what the analyser saw and **presentation decides the curve**. Speech RMS is small, so a linear bar drawn straight from it looks broken — which is a rendering problem with a rendering fix, and the fix lives in `ribo-ui`'s meter ([04](04-ribo-ui.md)), not here. Do **not** "fix" it by applying `sqrt` or a dB mapping inside core: `level` is a published, observable value, and rescaling it silently changes the reading for every consumer at once — including any host that already compensated, which would then double-correct.
- **Offline:** on-device transcription needs no network; only extraction (LLM) + write need it, and those queue with retry. The managed STT path is batch on reconnect.
- **Chunking:** audio is split to stay under the fetch-proxy's 10 MB/hop cap on the managed STT path.
- **Transcriber selection:** see below. The earlier wording here — "the probe runs once; result cached; a device that fails the probe **silently** uses the managed STT path" — is superseded on both counts, and both were wrong. Once is not enough (availability is dynamic), and silently is exactly the failure we cannot ship.

## Transcriber selection and fallback (contract, Phase 1 revision)

The `Transcriber` interface reports **capability** separately from **attempting**, and
`firstCapable([...])` composes an ordered roster. Both live in `ribo-core`
(`src/transcriber.ts`, `src/first-capable.ts`) — dependency-free, so the seam ships before the
first real implementation does.

**Three capability states, not two.** `ready` · `needs-download` (with `downloadBytes`, ORT
runtime included per [01](01-feasibility-spike.md)) · `unavailable` (with a machine `reason` and
a human `detail`). "Capable but needs 165 MB" and "cannot run here" are different screens, and a
boolean cannot express the difference.

**Availability is dynamic.** `capability()` is re-probed, never read once at init: on-device
becomes `ready` after a download, the managed path becomes `unavailable` when the uplink drops.
`firstCapable` caches per engine — permanent verdicts (`unsupported-platform`, `too-slow`) for
the life of the page, everything else for 30 s — and exposes `invalidate()` for the events that
actually matter (download finished, `online` fired).

**Capability failure ≠ attempt failure, and the queue keeps owning attempts.** A clip that OOMs
throws whatever it likes and `firstCapable` lets it straight through to
[09](09-offline-first.md)'s `isTransientFailure`/backoff/`maxAttempts`. A device that cannot run
the engine at all throws `TranscriberUnavailableError`, which demotes that engine and falls
through to the next. `queue/backoff.ts` needed **no change**: the error carries no HTTP status
and is not a `TerminalQueueError`, so it already classifies as retryable — correctly, because the
next drain re-probes. Only a roster where _every_ engine is permanently unavailable raises
`TerminalQueueError`.

**`needs-download` is never auto-selected.** That fetch needs network and a human's consent, and
a background queue drain can obtain neither. It is reported through `capabilities()` for a UI to
act on.

**Degradation is visible.** `Transcript.engine` is required and names the engine that actually
ran; it is persisted inside the outbox document, so the engine mix across the whole queue reads
straight off `Outbox.list()`. `firstCapable`'s `onFallback` fires whenever a preferred engine was
passed over.

**Scope, deliberately.** No policy engine, no scoring, no health windows. Fallback is narrower
than it looks — the managed path needs the network, so an offline auditor (the primary scenario,
and the entire reason on-device exists) has no fallback to reach. Fallback rescues the _online_
path, which was already the easy case.

## Packaging

npm package inside a pnpm workspace (mirrors Helix's layout). Framework-free (no React) — depends on browser APIs, zod, and the OSS libs above (RxDB + Dexie `RxStorage`, @ricky0123/vad), which stay behind the module interfaces so they're swappable.

**`@huggingface/transformers` is explicitly _not_ a `ribo-core` dependency.** It pulls `onnxruntime-node` and `sharp` as **hard** dependencies, both with postinstall scripts, which every consumer inherits in their lockfile even in a pure-browser app **[verified by inspection]**. The `OnDeviceTranscriber` therefore lives in a separate package that a host opts into; `ribo-core` depends only on the `Transcriber` interface. See [10 §4.1](10-build-and-packaging.md).

## Size & open items

- **Size:** **L** — the largest single unit (engine + the offline outbox from [09](09-offline-first.md)).
- **Open:** chunking parameters (segment length / overlap); whether the queue also persists transcripts/extractions for crash recovery (proposed yes).
