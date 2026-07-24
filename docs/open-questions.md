1. Do we want voice to text as a part of helix as a part of v0?

No, we can move to a different model once helix is available, use openai compatible endpoints for now.

2. Are there any objections/proposals on SDK architecture?

Let's see how it goes (let's think about risks)

Spotty internet makes a good candidate for moving this to the backend

---

## Packaging and compatibility (raised 2026-07-23 by documentation review)

These came out of a four-way review of the Phase 0 scaffolding. They are recorded here so nobody
invents an answer silently. Each open one notes what would settle it; **settled ones keep their
number and carry a `Decided <date>` line**, so links to a question number stay valid and the
answer is found where the question was.

### 3. What is the supported React floor?

`ribo-ui` declares `peerDependencies.react` as `^18.3 || ^19`. That is often described as a "wide
range", which is misleading: it **excludes React 18.0–18.2**, still a large installed population,
and everything before 18. Two possible answers, and we need to pick one deliberately:

- It is an intentional compatibility floor (18.3 is where the React 19 codemods/deprecation
  warnings land, which makes it a reasonable line) — then it must be **stated in the README/SDK
  docs and tested**, ideally by a pack-and-consume job pinned to the floor version.
- It is accidental — then widen it (`^18 || ^19`) and test the widened floor.

**Settled by:** the host team's React version (the Helix field app) plus any third-party host we
expect to support. Ask before Phase 5 (`ribo-ui`'s first real build), because it constrains which
hooks/APIs the UI may use.

### 4. What is the browser support matrix? — **Decided 2026-07-23**

**Baseline (the supported target platform floor):**

| Platform                  | Browser                          | Versions supported |
| ------------------------- | -------------------------------- | ------------------ |
| Windows — Surface tablets | Evergreen Chromium (Chrome/Edge) | current − 2        |
| iOS / iPadOS              | Safari                           | current − 1 major  |
| Android                   | Chrome                           | current − 2        |

**Therefore assumed available**, without feature-detection ceremony or polyfill: WebGPU, WASM
SIMD, OPFS, IndexedDB, MediaRecorder, Web Workers, `crypto.randomUUID`, top-level await.

This resolves the two risks the question was raised over. `tsdown` (`ribo-core`) and Vite library
mode (`ribo-ui`) must now both be pinned to this floor explicitly — one shared browserslist or an
explicit `target` in each build config — so the two published packages cannot drift apart
([`10 §2`](implementation/10-build-and-packaging.md)).

**This settles capability, not performance.** "WebGPU is available" is not "Whisper runs faster
than real-time on a phone GPU." Nothing above tells us the on-device transcription path is viable
on any given device class; it only tells us the APIs are there to try. The feasibility spike
([`01`](implementation/01-feasibility-spike.md)) therefore narrows rather than disappears, and the
managed-STT fallback stays in the design on **performance** grounds. `crossOriginIsolated` /
`SharedArrayBuffer` also remain a **host-header** question, not a browser-version one
([`10 §4`](implementation/10-build-and-packaging.md)), so the single-threaded fallback stays.

_(Previously: there was no matrix, and the only signal was `target: "ES2023"` in the shared
tsconfig — a TypeScript downlevel setting, not a policy. The concern that field devices would be
old locked-down Android tablets did not survive contact with the actual deployment picture.)_

### 5. Should `skipLibCheck` stay `true`?

`packages/tsconfig/base.json` sets `"skipLibCheck": true`. It is the pragmatic default, and today
it costs nothing — the packages have almost no dependencies. That changes shortly: RxDB, the
WASM/STT libraries and our own generated `.d.ts` files are exactly the kind of ambient-type
sources whose breakage `skipLibCheck` hides, and the failure surfaces in the **consumer's** build,
not ours.

Proposal to evaluate (not yet accepted): keep `skipLibCheck: true` for the fast per-package
`tsc --noEmit`, but add **at least one packed-consumer check that compiles with
`skipLibCheck: false`** — the pack-and-consume matrix from
[`10 §8`](implementation/10-build-and-packaging.md) is the natural home. **Settled by:** whoever
wires that matrix up, once there is a real `dist/` to pack.

### 6. What is the supported consumer TypeScript / `moduleResolution` floor?

Our `exports` maps put `types` inside each condition block and there is **no top-level `types`
fallback**. Consumers on `moduleResolution: "node"` (classic/Node10 resolution) do not read
`exports` at all, so they will find **no declarations** — a silent "implicitly any" experience, not
a clear error. We also ship no `typesVersions` (deliberately —
[`10 §3`](implementation/10-build-and-packaging.md)).

So the floor is effectively "TypeScript 5.0+ with `moduleResolution: bundler | node16 | nodenext`".
That is defensible for an ESM-only SDK, but it is currently **unwritten**. Decide whether to state
it as a requirement (and let `attw --pack` enforce it) or to add a compatibility fallback.
**Settled by:** the host app's tsconfig, plus a decision on whether third-party hosts get support
for legacy resolution.

### 7. Should test declarations be allowed anywhere near `dist`?

Each package's `tsconfig.json` is `"include": ["src"]`, and `*.test.ts` files are **colocated in
`src`**. A dts build driven from that config will happily emit `index.test.d.ts` alongside
`index.d.ts` — published, in `files: ["dist"]`, invisible until someone notices test types in
their editor.

Two things to decide: whether tests move to a location excluded from the build config (or get an
`exclude` entry), and — regardless — that the CI tarball gate should validate an **allowlist** of
expected files rather than merely asserting "no raw `.ts` reached the tarball" (the current TODO in
`.github/workflows/ci.yml`), since `.d.ts` files pass that check by construction.
**Settled by:** whoever implements the tsdown/Vite library builds in Phase 1/5.

### 8. When do we get real field recordings? — **Deferred 2026-07-23**

Not answered, and deliberately **not** waited on. The client's in-home recording-consent
policy path (design spec §10) is outside our control, so for the PoC the accuracy corpus
stays **synthetic** (`spikes/extraction-snuggpro/`, plus the proposed TTS-synthesized audio path in
[`01`](implementation/01-feasibility-spike.md)).

This deliberately overrides the team's own stated hard line, _"no production code against assumptions"_,
in exchange for PoC velocity. The trade is recorded rather than dropped: see
[`07`](implementation/07-testing-and-accuracy.md) and
[`08`](implementation/08-risks-and-sequencing.md). Real-recording validation moves from a gate
before **build** to a gate before **field use** — it is not removed, and it must not be silently
skipped.

**Settled by:** the client returning a consent path. Owner: the client.

## Consumer API (raised 2026-07-23 by the playground)

The playground became the first real consumer of `@azx/ribo-core` and surfaced questions design review
had not. Same convention as above: numbered, kept in place, `Decided <date>` when settled.

### 9. Should `getAudio`'s return type distinguish "gone" from "not yet"?

`Outbox.getAudio()` returns `Blob | undefined`, and that `undefined` collapses three genuinely
different situations:

- the item **never had** audio;
- the audio **was there and is gone** — deleted after transcription (`dropAudioAfterTranscription`),
  or evicted by the browser (iOS storage pressure, [09](implementation/09-offline-first.md));
- the audio is **not written yet** — the caller asked during the window before the attachment lands.

A `hasAudio` projection on the item is being added now, so presence is at least **observable** from
the stream a UI already subscribes to — which is what the playground actually needed. The open part
is narrower: whether the **return type** should also become a discriminant (say
`{ status: "present"; blob } | { status: "dropped" } | { status: "never" }`) rather than leaving
callers to correlate two calls.

This is **not a defect** — `Blob | undefined` is a correct answer to "give me the bytes", and every
current caller (the relay, the tests) only wants the bytes. It becomes a real question the moment a
UI has to _explain_ an absence. **Settled by:** what the review UI needs to tell an auditor when the
audio behind a transcript is gone — "deleted after transcription, as configured" and "we lost it"
are different sentences, and only one of them is reassuring. Decide in Phase 5, when those needs are
known, rather than designing the discriminant against a guess.

## On-device transcription (raised 2026-07-22 by the transcription research pass)

The research pass behind [`01`](implementation/01-feasibility-spike.md) settled the library and model
choice, and in doing so exposed four things nobody has a number for. Same convention as above:
numbered, kept in place, `Decided <date>` when settled. Each is tagged with what kind of unknown it
is — **[unmeasured]** means no published figure exists **anywhere**, not merely that we haven't
looked it up.

### 10. What does `device: 'webgpu'` actually do on iOS 26? — **highest-value unknown**

`@huggingface/transformers` v4 serves Safari an ONNX Runtime build containing **zero WebGPU code**
(verified by unpacking the published tarball — [`01`](implementation/01-feasibility-spike.md),
Finding 1). Meanwhile `IS_WEBGPU_AVAILABLE` reports **`true`**, because it checks the _browser_,
not the _runtime we shipped it_. So a caller can request a device the runtime cannot possibly
honour, and **we do not know what happens**: throw, silently fall back to WASM, or hang.

Those are three very different products. A clean throw is a two-line fix. A silent fallback means we
must not trust the flag anywhere. A hang on a field device in someone's attic is a support incident.

**This is roughly a 30-minute experiment** — load the library on an iOS device, request `webgpu`,
observe — and it **decides whether iOS is on-device-batch-only or managed-STT-primary**, which is
the single largest branch left in the transcription design. **Run it first**, ahead of any
benchmarking. **Settled by:** whoever starts the feasibility spike, on day one.

### 11. What is the single-thread vs multi-thread WASM penalty for Whisper? — **[unmeasured]**

ORT degrades silently to one thread without cross-origin isolation, and iOS is now known to be
WASM-only, so this factor sets the iOS verdict and prices the COOP/COEP platform ask
([`06`](implementation/06-field-app-helix.md), [`10 §4`](implementation/10-build-and-packaging.md)).

**No published figure exists for Whisper in a browser.** Assume **2–4×** as a planning placeholder
and mark every downstream number that uses it as provisional. **Settled by:** the spike, measuring
both thread configurations on the same device.

### 12. How much WER does energy-audit jargon and spoken numerals cost? — **[unmeasured]**

"CFM twenty-five", "R-nineteen, sorry, R-thirteen", AFUE, ACH50, backdrafting, kneewall, soffit.
**Unmeasured for every candidate model**, and it is the failure mode that matters most — a
mis-transcribed numeral that survives into a confidently-wrong extracted field
([`01`](implementation/01-feasibility-spike.md) sub-spike,
[`07`](implementation/07-testing-and-accuracy.md)).

Whisper's `prompt_ids` priming is the designed **mitigation**, and it is the reason Whisper was
chosen over more accurate non-promptable models ([`03`](implementation/03-ribo-core.md)) — but a
mitigation is not a measurement. **Settled by:** our own eval set. Nothing public will answer this,
so this one cannot be researched away; it has to be built.

### 13. Does `whisper-base.en` need a self-exported `q4f16` variant?

The `onnx-community` Whisper **English** exports were **last modified 2024-10-08** and lack the
WebGPU-friendly dtype that Moonshine's export has. If the Chromium WebGPU path turns out to matter
(itself not established — see the fabricated-benchmark caution in
[`01`](implementation/01-feasibility-spike.md), Finding 2), we may have to export `q4f16` ourselves,
which adds a model-provenance and re-export burden we currently don't carry.

Note the ordering: **this only becomes a question if WebGPU proves faster than WASM**, and the one
measured browser data point available says it isn't. Do not pre-emptively take on the export.
**Settled by:** the spike's Chromium backend comparison.
