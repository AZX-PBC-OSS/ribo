# Photo capture and on-device image transcription — Design

**Date:** 2026-09-09
**Status:** Design — pre-measurement. No code is written; this is a recommendation for what to
measure and how, with a scoping judgement and an engine architecture that follows from it.
**Depends on:** `CaptureItem` (the discriminated union landed with document transcription),
`Transcriber<S>` (the generic seam), `firstCapable` / `fallbackTranscriber` / `restrictToKind`
(the composition combinators). All exist and are tested.
**Related:** [document-transcription-plan.md](document-transcription-plan.md) — D1 (the
`CaptureItem` union), D7a (why `Transcriber` is generic and how a narrow engine is lifted),
D8 (lazy-loading a heavy dependency, injected worker URLs, provisional thresholds with knobs).
This doc follows its house style.

---

## The one thing to take away

A field auditor photographs things — an HVAC nameplate, a meter reading, a panel label — and
today must dictate the information on them. A 14-character alphanumeric serial is exactly what
speech transcription gets wrong, and a nameplate is short, high-contrast text that a vision model
ought to read well. The proposal is to **capture a photo, transcribe it to text with an on-device
vision model, and let it flow through the existing `extract → review → write` pipeline unchanged**.
The pipeline already speaks text from `transcribed` onward — `joinSessionTranscript()` returns
`{ text, recordingIds }` and never touches `recording.kind` — so a photo is a third capture kind
that needs only the `capture → transcribe` half, exactly as a document was.

**This doc does not recommend building it yet.** It recommends measuring four specific things
first (§5), because every number that would justify the design — download size, latency, accuracy
on real nameplates, and whether image input is even available on the target hardware — is
currently unknown. The scoping judgement (§3) and the engine architecture (§4) are the design;
the measurement plan is what the design rests on.

---

## 1. Context: what the codebase already gives

The document-transcription tranche built the machinery this design reuses. Verifying each claim
against the tree rather than trusting the plan:

| Piece                          | Where                                         | What it provides                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CaptureItem` union            | `ribo-core/src/capture-item.ts`               | A `z.discriminatedUnion` on `kind` with branches for `audio` (`AudioCapture`, `durationMs`) and `document` (`DocumentCapture`, `pageCount`). A photo branch would be a third member. The `z.preprocess` wrapper stamps `kind: "audio"` onto legacy rows, so a new branch needs no migration concern — there are no legacy photo rows.       |
| `Transcriber<S>`               | `ribo-core/src/transcriber.ts:149`            | Generic over `CaptureItem`, with `transcribe` declared as a **function-typed property** (D7a) so a narrow engine does not slide into a wide slot. `Transcriber<PhotoCapture>` is a photo-only engine; `Transcriber<CaptureItem>` is one that can accept any kind. A vision model producing text _is_ a transcriber; this needs no new seam. |
| `TranscriberCapability`        | `ribo-core/src/transcriber.ts:65`             | The three-state capability (`ready` / `needs-download` / `unavailable`) with `downloadBytes` and a consent story. `firstCapable` caches and re-probes it. A photo transcriber reports the same three states.                                                                                                                                |
| `UnsupportedItemError`         | `ribo-core/src/unsupported-item.ts`           | The third failure class — "this engine cannot handle this item." A photo engine handed an audio recording throws this, and `restrictToKind` is the combinator that makes that automatic.                                                                                                                                                    |
| `restrictToKind`               | `ribo-core/src/restrict-to-kind.ts`           | Lifts a `Transcriber<PhotoCapture>` into a `Transcriber<CaptureItem>` slot by refusing other kinds. The compiler sends a host here when wiring a photo-only roster into a mixed queue.                                                                                                                                                      |
| `firstCapable`                 | `ribo-core/src/first-capable.ts`              | Sequential selection on `capability()`: first `ready` wins, `needs-download` is never auto-selected, `unavailable` is skipped. A photo roster composes here.                                                                                                                                                                                |
| `fallbackTranscriber`          | `ribo-core/src/fallback-transcriber.ts`       | Per-item fallback: calls candidates in order **without consulting `capability()`** and lets an arbiter decide. This is how a Prompt API engine that cannot read a particular image falls through to a transformers.js one.                                                                                                                  |
| Session mixing                 | `ribo-core/src/queue/session-extract.test.ts` | Proves a session already mixes a document and a dictation and both reach extraction in capture order. A photo alongside a dictation is the same case — `joinSessionTranscript` reads only `status`, `seq` and `transcript.text`.                                                                                                            |
| On-device extractor capability | `ribo-extractor-ondevice/src/capability.ts`   | Wraps Chrome's Prompt API (`LanguageModel.availability()` / `.create({ monitor })`). Its `LanguageModelCreateOptions` has `expectedOutputs` but **no** `expectedInputs`, and `LanguageModelPrompt.content` is a plain `string`. Multimodal input is a widening of these types — see §4.1.                                                   |
| On-device transcriber pattern  | `ribo-transcriber-ondevice`                   | The proven shape for a downloaded on-device model: ONNX Runtime WASM/WebGPU, a real-time-factor gate at `prime()` time, an injected `createWorker` factory (AGENTS.md §5.2). A transformers.js vision model follows the same structure.                                                                                                     |

**The pipeline needs no new seam.** `Transcriber<S>`, `Transcript`, `CaptureItem`, the
composition combinators and the session layer are all reusable. The work is a third capture
branch and a new transcriber package — structurally identical to what the document tranche did.

---

## 2. The shape of the capture record

Audio carries `durationMs` — the length of the recording, used for RTF prediction and
elapsed-time display. A document carries `pageCount` — the number of pages, known at enqueue
time and required for a queue listing. Both are branch-specific fields that a capture UI reads
and that are `.int().nonnegative()` or `.int().positive()` respectively, because they distinguish
a legitimate edge case (a zero-length recording) from a parse error (a zero-page document).

**A photo carries nothing beyond the shared fields.** The four shared fields
(`captureFields.ts`: `id`, `capturedAt`, `mimeType`, `ctx`) already describe a photo completely:
`mimeType` is `image/jpeg` or `image/png`, `capturedAt` is when the shutter fired, `id` is the
queue key for the bytes, and `ctx` carries the host's job association. There is no quantity a
capture UI needs to display that the shared fields do not supply — a photo has no "duration" and
no "pages," and inventing an analogue (an `imageCount`?) would be a field that is always `1` and
whose zero is neither a legitimate capture nor a meaningful parse error, but merely an absence
that the `kind` discriminant already expresses.

**The argument against an optional `dimensions` field.** Image width and height are readable from
the blob by the transcriber, and nothing downstream needs them before transcription — the
extractor receives text, not pixels. Adding `{ width, height }` to the capture record would be
metadata that crosses the persistence boundary (the outbox) for the convenience of a capture UI
that can equally read it from the blob on display. The document tranche's `pageCount` earns its
place because counting pages requires a PDF parser — a host would load a second copy of pdf.js
without it (D8). Reading image dimensions needs no parser at all.

**The argument against a `photoCount` field for multi-shot captures.** An auditor might photograph
the front and back of a nameplate, and a multi-shot capture is a real workflow. But the same was
true of audio (an auditor might record two clips) and documents (an auditor might submit two
PDFs), and in both cases the answer was one capture per enqueue: the session is the unit that
binds them, and `joinSessionTranscript` already joins multiple captures in capture order
(`session-extract.test.ts`). A photo of the back of a nameplate is a second `PhotoCapture`
enqueued into the same session, not a field on the first. This keeps the branch simple and the
ordering guarantee unchanged.

So: `kind: "photo"`, `z.literal("photo")` as the discriminator, and the four shared fields — no
branch-specific field. The `z.strictObject` that wraps each branch means a photo record carrying
a stray `durationMs` or `pageCount` fails to parse, which is the same protection D1 gives against
modelling a document as a zero-length recording.

---

## 3. Why nameplates and not documents — the scoping judgement

This is the doc's most important judgement, and it is a judgement rather than a measurement:
**scope the first photo transcriber to short, high-contrast text on nameplates, meter faces and
panel labels — not to dense printed documents.**

The argument has three legs.

**Leg 1: nameplates are where dictation is worst.** The information on an HVAC nameplate — model
number, serial number, BTU rating, SEER — is a string of alphanumerics that speech transcription
mishears systematically. "B T U" is three letters; "fourteen thousand" is words that map to a
number; a serial like `SZ171AC1A` is unpronounceable and undictatable. This is the gap the photo
path exists to close, and it is the gap where the payoff per unit of engineering effort is
highest.

**Leg 2: nameplates are the easiest vision task.** A nameplate is a dozen lines of
high-contrast, sans-serif text on a flat metal plate, photographed at arm's length. The text is
large relative to the image, the contrast is near-binary, and the layout is predictable. This is
the easy end of OCR, and it is where a small on-device model — or a browser-provided multimodal
model — is most likely to be accurate enough to be useful. A dense printed invoice at 8-point is
the hard end, and it is where a small model is most likely to fail.

**Leg 3: the document path already exists, and dense OCR is explicitly deferred.**
`@azx/ribo-transcriber-pdfjs` transcribes text-layer PDFs. A scanned PDF (no text layer) is the
gap, and the document-transcription plan explicitly defers an OCR transcriber: _"Any OCR
transcriber. Task 4 makes it composable; building it is a separate tranche"_ (§Out of scope). A
photo of a printed invoice is OCR on dense small text — the hardest case, and one where the PDF
path already serves the workflow (the auditor submits the PDF, not a photo of it). A photo of a
nameplate is a different workflow: the nameplate is a physical object, there is no PDF, and the
information is what dictation cannot capture.

**What this scoping does not claim.** It does not claim a photo transcriber _cannot_ read a
document — only that nameplates are where to start, where the value is highest, and where the
risk is lowest. If the measurement (§5) shows the model is accurate on nameplates, expanding to
meter faces and panel labels is the same engine on different input, not new engineering. If it
shows the model is accurate on dense documents, the OCR transcriber the document plan deferred
becomes a photo transcriber that happens to read documents too — but that is a conclusion to draw
from measurement, not a premise to design from.

---

## 4. Two candidate engine paths

A vision model that produces text is a `Transcriber<PhotoCapture>`. Two engines are candidates,
and they **compose rather than compete** — `firstCapable` and `fallbackTranscriber` exist
precisely for this, and the document tranche built the per-item fallback ladder that a photo
roster would use identically.

### 4.1 Chrome's Prompt API with multimodal input

The repo already depends on the Prompt API for on-device extraction
(`ribo-extractor-ondevice/src/capability.ts`). The API's explainer declares multimodal support:
image input is requested via `expectedInputs: [{ type: "image" }]` at `create()` time, and the
prompt's `content` becomes an array of typed parts rather than a plain string
([explainer: "Multimodal inputs"](https://github.com/webmachinelearning/prompt-api#multimodal-inputs)).
Chrome's developer documentation confirms this is shipping, with a [Canvas Image Prompt
demo](https://chrome.dev/web-ai-demos/canvas-image-prompt/) for image input, and lists the
accepted image types (`Blob`, `ImageData`, `ImageBitmap`, `HTMLImageElement`, etc.)
([Chrome docs: "Multimodal capabilities"](https://developer.chrome.com/docs/ai/prompt-api#multimodal_capabilities)).

**The delta from what the repo models today is a widening of types, not a new seam.**
`LanguageModelCreateOptions` (capability.ts:24) gains an `expectedInputs` field; the
`LanguageModelPrompt.content` type widens from `string` to `string | readonly ContentPart[]`
where `ContentPart` is `{ type: "text"; value: string } | { type: "image"; value: ImageBitmapSource }`.
The capability probe (`probeLanguageModel`) would call `availability({ expectedInputs: [{ type:
"image" }] })` to check whether the device's model can accept images — the docs caution to _"always
pass the same options to the `availability()` function that you use in `prompt()`"_ — and the
priming path (`primeLanguageModel`) would pass `expectedInputs` to `create()`. This is the same
`availability()` → `create()` → `prompt()` flow the extractor already uses, with one more field
on each call.

**What makes it attractive.** If the model is already downloaded for on-device extraction (which
it is, on any device that has armed itself for offline extraction), there may be no additional
download — the same Gemini Nano weights serve both text and multimodal sessions. Chrome manages
the model, so there are no weights for Ribo to ship, version, or serve from a static host. And the
`responseConstraint` mechanism the extractor already uses for structured output is available on
the photo path too, so the transcriber could ask for a constrained JSON shape directly.

**What makes it provisional.** The Prompt API is Chrome-only (Edge too, with caveats — the
explainer states plainly: _"We do not intend to provide guarantees of language model quality,
stability, or interoperability between browsers"_). The Chrome docs are explicit that **Chrome for
Android, iOS, and ChromeOS on non-Chromebook Plus devices are not yet supported** by the
foundation-model APIs ([hardware requirements](https://developer.chrome.com/docs/ai/prompt-api#hardware)).
A field auditor on a tablet — the target form factor — may be on a platform the API does not
reach. Whether image input specifically works on the desktop hardware the API does support is a
question for measurement (§5.1), not an assumption from the docs: the explainer says the design
_"initially includes the potential to support images,"_ which is a promise of capability, not a
confirmation of shipping behaviour on every device.

### 4.2 transformers.js + a small vision model over WebGPU

The repo already uses `@huggingface/transformers` for on-device Whisper transcription
(`ribo-transcriber-ondevice`). transformers.js supports image-to-text as a pipeline task
([supported tasks: "Image-to-Text"](https://github.com/huggingface/transformers.js#multimodal)),
runs models via ONNX Runtime with WebGPU acceleration (`device: 'webgpu'`), and supports
quantization (`q4`, `q8`, `fp16`) to shrink the download
([WebGPU guide](https://huggingface.co/docs/transformers.js/guides/webgpu)). A photo transcriber
built on this stack is **structurally identical to `ribo-transcriber-ondevice`**: lazy-load the
pipeline, inject `createWorker` for the ONNX Runtime WASM binaries (AGENTS.md §5.2), measure a
throughput gate at `prime()` time, and report `capability()` from a stored verdict.

**What makes it attractive.** It is cross-platform in principle: transformers.js runs on any
browser with WASM, and WebGPU accelerates it where available. Per caniuse.com (accessed
2026-09-09), WebGPU has [~87% global support](https://caniuse.com/webgpu), with Safari on iOS
showing ✅ from version 26.0 and Safari desktop showing ◐ partial support from 26.0. This is a
recent and rapid change — the transformers.js docs still warn that global support was ~70% "as of
October 2024" — and the partial-support marker on desktop Safari means **"available" is not the
same as "validated for an on-device vision model."** But the trajectory is clear: the platform
constraint that kept `ribo-transcriber-ondevice` Chromium-only is eroding, and a transformers.js
photo engine is the path that benefits. The repo controls the model (it ships the weights, pins
the version, and can swap a better one in), which is the property the Prompt API explicitly does
not provide.

**What makes it provisional.** A vision model is a larger first-launch download than a speech
model — this is a general property of vision encoders, not a measured figure for any specific
model, and §5.2 is where the actual bytes get measured. The model is weaker on dense small text
than a frontier model, which is the scoping argument's leg 2: nameplates are where a small model
has the best chance. And the WASM single-threaded path — the fallback when WebGPU is absent — is
the one the repo has already deferred for iOS (`docs/roadmap/index.md`: _"iOS/Safari support,
engine sniffing, and the WASM single-threaded path are deferred"_). A transformers.js photo engine
inherits that deferral: it works where WebGPU works, and the WASM path is a separate measurement.

### 4.3 How the two compose

The two engines are not alternatives a host chooses between — they are rungs on a ladder, and the
composition machinery already exists.

**`firstCapable` for engine-level selection.** A roster
`firstCapable([promptApiPhoto, transformersJsPhoto])` selects the first engine reporting `ready`.
On a desktop Chrome where Gemini Nano is armed for extraction, the Prompt API engine is `ready`
with no additional download and wins. On a tablet without the Prompt API, the transformers.js
engine is `ready` (if WebGPU is available and the model is downloaded) and wins. The
`needs-download` state is never auto-selected, so a first-launch on either engine parks the item
until a human primes the device — the same consent story the Whisper transcriber uses.

**`fallbackTranscriber` for per-item fallback.** The Prompt API engine might report `ready` but
fail to read a particular nameplate — a blurry photo, a model that cannot parse the image, a
`NotSupportedError` on an unexpected image format. That is an `UnsupportedItemError` (the engine
is fine, the item is the problem for this engine), and `fallbackTranscriber` with
`unsupportedFallsThrough` routes to the transformers.js engine without re-probing `capability()`.
This is the D6/D7 pattern from the document tranche, used unchanged.

**`restrictToKind` to lift the roster into a mixed queue.** A photo-only roster is
`Transcriber<PhotoCapture>`[], and the relay's `Transcriber<CaptureItem>` slot rejects it at
compile time (D7a). `restrictToKind("photo", firstCapable([…]))` is the one-line fix, and it
throws `UnsupportedItemError` for any audio or document item that reaches it — which is the
correct behaviour, because a photo engine cannot transcribe audio any more than an audio engine
can transcribe a photo.

The intended composition for a host that has all three media:

```
firstCapable([
  restrictToKind("audio", firstCapable([ondevice, managed])),
  restrictToKind("document", pdfjs),
  restrictToKind("photo", firstCapable([promptApiPhoto, transformersJsPhoto])),
])
```

This is illustrative, not prescriptive — a host composes its own roster, and the combinators are
the tools, not a wiring diagram. The point is that no new combinator is needed.

---

## 5. What must be measured before building

This is the section that matters most. **None of the numbers below exist yet.** Every one is a
question, and each has a specific method for answering it. The repo has a precedent for probing
browser-only APIs: the on-device extraction work served a page that drove the real Prompt API in
real Chrome and posted results to a local collector (`docs/spikes/0005-ondevice-acceptance/`), because
Playwright's Chromium implements the Prompt API as a stub that returns canned text
(`ondevice-extraction-design.md` §10.6). That constraint applies identically here: every
measurement below needs real Chrome on real hardware, not Playwright.

### 5.1 Is image input available on the Prompt API, on target hardware?

**The question.** The explainer declares image input; the Chrome docs list accepted image types;
there is a Canvas Image Prompt demo. But _"the design initially includes the potential to support
images"_ is not _"this device's model accepts image input and returns useful text."_ The Chrome
docs also say the foundation-model APIs are desktop-only (Windows, macOS, Linux, ChromeOS
Chromebook Plus), requiring ≥22 GB storage and >4 GB VRAM. A field auditor's tablet is not on
that list.

**How to answer it.** Serve a page that calls
`LanguageModel.availability({ expectedInputs: [{ type: "image" }] })`, and if available, calls
`LanguageModel.create({ expectedInputs: [{ type: "image" }] })` from a click handler, prompts
with a nameplate photo as a `Blob`, and captures the response. POST the result — availability
string, create latency, prompt response or error — to a local collector, exactly as
`docs/spikes/0005-ondevice-acceptance/` does. Run this on:

- A desktop Chrome on macOS/Windows where the model is already armed (the easy case — if this
  fails, the Prompt API path is not viable at all).
- A mid-range tablet (the target form factor — if the API is not available here, the Prompt API
  engine is desktop-only and the transformers.js engine is the field path).

**What would kill the Prompt API path.** `availability()` returns `unavailable` for
`expectedInputs: [{ type: "image" }]` on hardware where the text-only model is `available` —
meaning image input is declared but not shipped. Or `create()` throws `NotSupportedError` despite
`availability()` reporting `available` — meaning the availability check is not honest about
multimodal capability. Both have precedent in the extraction work's discovery that
`QuotaExceededError` fires in undocumented ways (§10.3 of `ondevice-extraction-design.md`).

### 5.2 What is the first-launch download size?

**The question.** The Prompt API model is Chrome-managed; if the device has already armed itself
for on-device extraction, the multimodal session may reuse the same weights with no additional
download. Or it may not — the docs do not say, and the `downloadprogress` monitor reports
`loaded` 0..1 with `total` always 1 (§10.1 of `ondevice-extraction-design.md`), so byte counts are
not available from the API. For transformers.js, the vision model weights are a separate download
whose size depends on the model and quantization level, none of which has been measured.

**How to answer it.**

- **Prompt API:** On a device where the model is not yet downloaded, call `create()` with
  `expectedInputs: [{ type: "image" }]` from a click handler and time the wall clock. Then
  compare with a device where the model _is_ downloaded (armed for extraction) — if the second
  `create()` is fast and fires no `downloadprogress`, the weights are shared. Check
  `chrome://on-device-internals` for the model size, as the Chrome docs suggest.
- **transformers.js:** Load a candidate vision model (e.g. a small image-to-text or
  document-question-answering model) with `device: 'webgpu'` and `dtype: 'q4'`, and measure the
  actual bytes fetched across the network. Include the ONNX Runtime WASM binaries, not just the
  weights — AGENTS.md §5.2's rule and the on-device transcriber's precedent both say the runtime
  counts toward the first-launch cost.

**What this determines.** Whether the download is small enough to ask a field auditor to perform
over wifi before going offline, and whether the consent screen can quote an honest number. The
Whisper transcriber's `downloadBytes` is a measured figure that drives a real consent UI; a photo
engine's must be too.

### 5.3 What is the per-image latency on a mid-range tablet?

**The question.** A nameplate photo is a single image, not a minute of audio, so the latency
budget is different — the auditor is waiting for one image, not a dictation. But "different" is
not "fast," and a vision model over WebGPU on a mid-range tablet may take seconds or tens of
seconds. The on-device transcriber's RTF gate exists because a slow device is worse than no
device; the same logic applies to a vision model.

**How to answer it.** Time `transcribe()` from the moment the blob is handed to the engine to the
moment the `Transcript` returns, on a mid-range tablet (the repo's target is a Surface Go 3, per
`ondevice-extraction-design.md` §6.3). Run it on a set of real nameplate photos at different
resolutions, because image size may dominate inference time. Compare the Prompt API engine (if
available on that hardware) against the transformers.js engine.

**What this determines.** Whether a throughput gate is needed (the on-device transcriber's
`too-slow` capability, measured at `prime()` time) or whether the latency is small enough that a
gate is over-engineering. The answer is not assumed; it is measured.

### 5.4 What is the accuracy on a real nameplate?

**The question.** The entire design rests on the premise that a vision model can read a
nameplate more accurately than dictation can. That premise is plausible — a model reading
characters from an image does not mishear "S Z one seven one A C one A" the way speech
transcription does — but it is not measured. A model that hallucinates plausible-looking serials,
or that reads "B" as "8" and "O" as "0" consistently, is worse than dictation because it produces
confident wrong answers that a reviewer may not catch.

**How to answer it.** Photograph a set of real HVAC nameplates (10–20, covering different
manufacturers, lighting conditions, and angles). Transcribe each with both engines. Compare the
transcribed text to the ground truth — the actual characters on the nameplate, transcribed by a
human. Score character-level accuracy on the high-value fields: model number, serial number,
BTU, SEER. The repo has precedent for this: `score.mjs` grades extraction against annotated ground
truth, and the on-device extraction work ran a 14-transcript corpus through it
(`ondevice-extraction-design.md` §4). A nameplate corpus is smaller and simpler — the "transcript"
is the image-to-text output, and the "ground truth" is the nameplate's text — but the principle
is the same.

**What this determines.** Whether the design is worth building at all. If the model cannot read a
serial number accurately enough for a human reviewer to catch the errors, the photo path is a
worse experience than dictation, not a better one. The review card is the safety net — a
beta-quality transcriber produces a worse first draft, not a wrong write — but the first draft
needs to be close enough that review is correction, not transcription from scratch.

---

## 6. Open questions

These are the questions this design cannot resolve from the repo and cannot answer without the
measurements in §5. They are stated as questions, not deferred decisions.

1. **Does the Prompt API's `availability()` honestly report image-input capability?** The
   extraction work found that `availability()` returns `available` for text input even when the
   model is a Playwright stub, and that `QuotaExceededError` fires in undocumented ways. Does
   `availability({ expectedInputs: [{ type: "image" }] })` return `available` only when the
   device's model genuinely accepts images, or does it over-report the way the text path can?

2. **Are the Gemini Nano weights shared between text and multimodal sessions?** If a device has
   armed itself for on-device extraction (downloading the model for text), does creating a
   session with `expectedInputs: [{ type: "image" }]` trigger a second download, or reuse the
   same weights? The docs do not say, and the `downloadprogress` event's `total: 1` reporting
   makes it impossible to read the byte count from the API.

3. **Which transformers.js vision model is the right one?** transformers.js supports
   `image-to-text` and `document-question-answering` pipelines, with models ranging from small
   captioners to document understanding transformers (e.g. Donut). A nameplate is not a document
   and not a scene to caption — it is structured text to extract. The right model is the one that
   reads alphanumerics accurately, not the one that describes the image, and selecting it is a
   measurement exercise (§5.4), not a design decision.

4. **Is WebGPU on iOS Safari real for a vision model?** caniuse.com shows ✅ for iOS Safari from
   26.0, but ◐ partial for desktop Safari, and the repo has explicitly deferred iOS for its
   existing on-device transcription. A transformers.js photo engine on iOS needs WebGPU to be not
   just present but performant enough for inference. This is a measurement on an actual device,
   not a conclusion from a support table — the repo has been burned by trusting docs over the tree
   before (`ondevice-extraction-design.md` §10.6: _"When this spec and the tree disagree, the tree
   is right"_).

5. **What prompt does the model need?** The Prompt API engine needs a system prompt that tells
   the model to transcribe the nameplate's text verbatim, not describe it. The transformers.js
   `image-to-text` pipeline may take a prompt or may be a captioner that cannot be steered. The
   prompt is part of the transcriber, not part of the extraction layer — the transcriber's output
   is text, and the extractor receives it as it receives any transcript — but the prompt's quality
   determines the transcript's quality, and that is a measurement question (§5.4), not a design
   one.

6. **Should a photo carry image dimensions after all?** §2 argues no, on the grounds that nothing
   downstream needs them and the capture UI can read them from the blob. If the measurement (§5.3)
   shows that image size dominates latency, a capture UI may want to downscale before enqueue —
   and at that point, recording the original dimensions in the capture record becomes useful for
   display. This is a question that measurement answers, not one this doc can close.

7. **Does the photo path need a `fallbackTranscriber` ladder, or is `firstCapable` enough?** §4.3
   shows both. The ladder matters only if the Prompt API engine reports `ready` but fails on
   individual images — the per-item unsuitability case. Whether that happens in practice is a
   measurement question (§5.1, §5.4): if the Prompt API engine either reads the image or throws
   `NotSupportedError` (a capability failure, not an item unsuitability), `firstCapable` alone
   suffices and the ladder is over-engineering. If it reads some images and fails on others
   without a clear capability signal, the ladder is load-bearing.

---

## Sources

- `packages/ribo-core/src/{capture-item,transcriber,first-capable,fallback-transcriber,restrict-to-kind,unsupported-item,transcript,capture-fields,recording}.ts`
  — the contracts and combinators this design reuses.
- `packages/ribo-core/src/queue/session-extract.test.ts` — the test that proves mixed-kind sessions
  work.
- `packages/ribo-extractor-ondevice/src/capability.ts` — the Prompt API wrapper whose types
  multimodal input widens.
- `docs/roadmap/design/document-transcription-plan.md` — D1, D7a, D8: the precedents for a new
  capture branch, a generic transcriber, and a lazy-loaded heavy dependency.
- `docs/roadmap/design/ondevice-extraction-design.md` — the Prompt API measurement methodology,
  the Playwright-stub discovery, and the precedent for probing browser-only APIs with a served
  page and a local collector.
- Prompt API explainer, <https://github.com/webmachinelearning/prompt-api> — fetched 2026-09-09.
  "Multimodal inputs" section, `expectedInputs`, content parts.
- Chrome developer docs, <https://developer.chrome.com/docs/ai/prompt-api> — fetched 2026-09-09.
  "Multimodal capabilities," hardware requirements, image input types. Last updated 2026-08-26.
- Chrome built-in AI API status, <https://developer.chrome.com/docs/ai/built-in-apis> — fetched
  2026-09-09. Prompt API shipping status (Chrome 148 stable for web, 138 for extensions).
- transformers.js, <https://github.com/huggingface/transformers.js> — fetched 2026-09-09.
  Supported tasks including `image-to-text` and `document-question-answering`, WebGPU support,
  quantization options.
- transformers.js WebGPU guide,
  <https://huggingface.co/docs/transformers.js/guides/webgpu> — fetched 2026-09-09. `device:
'webgpu'` usage, experimental-status warning.
- caniuse.com WebGPU, <https://caniuse.com/webgpu> — fetched 2026-09-09. Global support ~87%,
  Safari on iOS ✅ from 26.0, Safari desktop ◐ partial from 26.0.
