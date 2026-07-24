# 11 — The Audio Pipeline: Recorder → Whisper

The format seam between capture and transcription. An early review flagged it as unspecified —
`Recorder` emits `audio/webm;codecs=opus` on Chromium ([`03`](03-ribo-core.md)'s `Recorder`), Whisper
wants **16 kHz mono Float32 PCM**, and nobody had written down who decodes and resamples. This note
answers that from the shipped source, not from memory.

## Evidence grades

Same discipline as [`01`](01-feasibility-spike.md), with one substitution — `[from docs]` replaces
`[vendor-claimed]`, because the load-bearing non-inspected claims here are web-platform specs, not
vendor marketing:

- **[verified by inspection]** — established by unpacking and reading shipped source
  (`npm pack @huggingface/transformers@4.2.0`, unpacked, read). Trustworthy.
- **[from docs]** — asserted by a normative spec or MDN. Plausible and authoritative, but not
  confirmed against our own run.
- **[unmeasured]** — no number exists, including ours. Must not be planned against.

Verified against tarball `huggingface-transformers-4.2.0.tgz` (shasum `5a5342a1a148…`, 1339 files),
unpacked 2026-07-23.

---

## 1. Does transformers.js decode for us? — **Partly, and not from a `Blob`, and not in a worker**

The ASR pipeline funnels **every** input through one function, `prepareAudios` in
`src/pipelines/_base.js` **[verified by inspection]**. `_call_whisper` reads the sampling rate off
the model's feature-extractor config (16 kHz for Whisper — `preprocessor_config.json`, **[from docs]**)
and calls it:

```js
const sampling_rate = feature_extractor_config.sampling_rate; // 16000 for whisper
const preparedAudios = await prepareAudios(batchedAudio, sampling_rate);
```

`prepareAudios` accepts a **narrow** union — `string | URL | Float32Array | Float64Array` — and nothing
else (`src/pipelines/_base.js`) **[verified by inspection]**:

```js
export async function prepareAudios(audios, sampling_rate) {
  if (!Array.isArray(audios)) audios = [audios];
  return await Promise.all(
    audios.map((x) => {
      if (typeof x === "string" || x instanceof URL) {
        return read_audio(x, sampling_rate); // decode + resample path
      } else if (x instanceof Float64Array) {
        return new Float32Array(x); // just a widen
      }
      return x; // assumed already a 16 kHz Float32Array
    }),
  );
}
```

Three consequences fall straight out of that code, and they decide the whole design:

**(a) A `Blob` is not an accepted input.** `Blob` matches none of the branches, so it hits the final
`return x` and is passed downstream **unchanged**. The Whisper feature extractor then indexes it as a
typed array (`.length`, element access) and fails — far from the call that caused it. **We may not hand
the pipeline the `Recorder`'s `Blob` directly.** The same is true of an `AudioBuffer`: not in the union,
falls through, breaks. **[verified by inspection]**

**(b) The only "decode for us" path is a URL, and it runs on `AudioContext`.** A `string`/`URL` goes to
`read_audio` (aliased from `load_audio`, `src/utils/audio.js`), which is the entire decode+resample
implementation **[verified by inspection]**:

```js
export async function load_audio(url, sampling_rate) {
  if (typeof AudioContext === "undefined") {
    throw Error(
      "Unable to load audio from path/URL since `AudioContext` is not available in your " +
        "environment. Instead, audio data should be passed directly to the pipeline/processor. ...",
    );
  }
  const response = await (await getFile(url)).arrayBuffer();
  const audioCTX = new AudioContext({ sampleRate: sampling_rate }); // 16000
  const decoded = await audioCTX.decodeAudioData(response);
  // ... stereo → mono downmix with SCALING_FACTOR = Math.sqrt(2), else getChannelData(0)
}
```

So yes — hand it a URL and it decodes the container **and** resamples to 16 kHz (via the
`AudioContext({ sampleRate: 16000 })`, whose `decodeAudioData` resamples the decoded buffer to the
context rate — **[from docs]**, MDN), **and** downmixes stereo to mono. That is real, and it means we
do **not** re-implement mel-spectrograms or FFmpeg. But it is gated on `AudioContext` existing.

**(c) `read_audio` cannot run in a Web Worker.** `AudioContext` is `Exposed=Window` — it is **not**
exposed on `WorkerGlobalScope`; the request to expose it is an open, unshipped Web Audio v2 feature
(`WebAudio/web-audio-api-v2#16`, still open) **[from docs]**. Our transcriber runs inference **in a
worker** (packaging rule, [`03`](03-ribo-core.md), Phase 3 plan). Inside that worker
`typeof AudioContext === "undefined"`, so `read_audio` takes its `throw` branch. **Calling
`pipeline('automatic-speech-recognition')(url)` inside the worker fails for URL/Blob-URL inputs**, by
construction, in exactly the environment we run it. **[verified by inspection]** of the guard, cross-checked
with the platform fact in (c).

**Net answer to the question that might have deleted the problem:** it does not evaporate. transformers.js
will decode+resample **only** if we (i) give it a URL rather than a `Blob`, and (ii) call it somewhere
`AudioContext` exists — i.e. the main thread. Since inference must be in a worker, the pipeline there can
only be fed the **`Float32Array` branch**. **We own decode+resample.**

## 2. Where decode/resample runs, and what crosses the worker boundary

Forced by §1(c): **decode+resample happens on the main thread; a 16 kHz mono `Float32Array` crosses to
the worker.**

```
main thread                                   worker
───────────                                   ──────
Blob (audio/webm;codecs=opus)
  │ decodeAudioData @ 16 kHz AudioContext
  │ downmix → Float32Array (16 kHz mono)
  └── postMessage(f32, [f32.buffer]) ───────▶ pipeline(f32)  // Float32Array branch, no AudioContext
                                                └── Transcript
```

- The `Float32Array`'s backing `ArrayBuffer` is a **transferable** — pass it in `postMessage`'s transfer
  list so the samples move, not copy. A 20-minute walkthrough is ~38 MB at 16 kHz mono Float32
  (`20·60·16000·4`); copying it per transcription is avoidable waste, and after transfer the main-thread
  view is neutered (intended — we're done with it). **[from docs]**
- This is the **only** split that works. "Just pass the pipeline a `blob:` URL from inside the worker"
  does not — §1(b)+(c). "Decode inside the worker" does not — no `AudioContext` there.

## 3. The recipe, if we build it (we do)

Re-implement what `read_audio` does, on the main thread. It is ~15 lines and mirrors HF's own reference,
so it is low-risk:

```ts
// main thread — inside OnDeviceTranscriber, before the worker call
async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 }); // decodeAudioData resamples to this rate
  try {
    const buf = await ctx.decodeAudioData(bytes);
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    // FFmpeg-style downmix, matching read_audio exactly:
    const l = buf.getChannelData(0),
      r = buf.getChannelData(1);
    const out = new Float32Array(l.length);
    const k = Math.SQRT2; // 1/sqrt(2) applied as (√2·(l+r))/2
    for (let i = 0; i < out.length; i++) out[i] = (k * (l[i] + r[i])) / 2;
    return out;
  } finally {
    void ctx.close();
  }
}
```

- **Mono downmix: match `read_audio`.** `getChannelData(0)` when already mono; the `(√2·(l+r))/2` sum when
  stereo. Do **not** naively average `(l+r)/2` — that is 3 dB quieter than the ffmpeg convention Whisper's
  training pipeline assumes, and `read_audio` deliberately uses the `√2` scaling. Mic capture via
  `getUserMedia` is mono in practice, so the stereo branch is a correctness backstop, not the common path.
- **Resample: let `decodeAudioData` do it.** `new AudioContext({ sampleRate: 16000 })` then
  `decodeAudioData` yields a buffer already at 16 kHz — MDN: _"The decoded `AudioBuffer` is resampled to
  the `AudioContext`'s sampling rate."_ **[from docs]** No separate `OfflineAudioContext` render is needed.
  Chromium accepts arbitrary `AudioContext` sample rates (3 kHz–768 kHz), so 16 kHz is valid **[from docs]**.
- **`OfflineAudioContext` is the fallback shape, not the primary.** If a target ever refuses a 16 kHz
  realtime context, decode at the native rate and render through
  `new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000)`. Note this does **not** buy
  worker-compatibility: `OfflineAudioContext` is **also** `Window`-only and not in `WorkerGlobalScope`
  (`magenta-js#483` hit exactly this) **[from docs]** — so it changes nothing about §2.

**Gotchas, recorded so they aren't rediscovered:**

- **`decodeAudioData` support for our containers.** On evergreen Chromium (this phase's only target),
  WebM/Opus and MP4/AAC both decode **[from docs]**; the `Recorder` negotiates one of those. Verify with
  our own clip in the Phase 3 browser test — currently **[unmeasured]** by us.
- **Async memory cost.** `decodeAudioData` inflates compressed Opus to full PCM in memory transiently: at
  the _native_ decode rate (often 48 kHz) a 20-minute clip is ~115 MB before the 16 kHz downsample frees
  it. Fine on a Surface, worth chunking long audio if it ever bites. **[unmeasured]** at our lengths.
- **Safari / iOS (out of scope now, noted so it isn't a surprise later).** Safari's `decodeAudioData`
  historically could not demux **WebM** at all, and older Safari clamped `AudioContext` sample rates (no
  arbitrary 16 kHz) — but Safari's `Recorder` path emits **MP4/AAC**, not WebM, and the resample-on-decode
  trick may need the `OfflineAudioContext` fallback there. iOS is deferred (Phase 3 scope, [`01`](01-feasibility-spike.md)
  Finding 1); this bullet is the breadcrumb. **[from docs]**

## 4. What this implies for the transcriber interface

**Keep the public contract as `Blob`.** `Transcriber.transcribe(rec, audio: Blob)`
([`03`](03-ribo-core.md)) stays exactly as written — the queue stores audio as an RxDB `Blob`
attachment ([`09`](09-offline-first.md)), and the interface should speak the queue's language, not the
worker's. `FakeTranscriber` and `ManagedTranscriber` (which POSTs the bytes upstream) both want a `Blob`
too; a `Float32Array` public signature would force every impl to carry PCM it doesn't need.

**The `Float32Array` is an internal detail of `OnDeviceTranscriber`.** The decode of §3 happens _inside_
`transcribe`, on the main thread, and the resulting `Float32Array` is what its worker `postMessage`
carries. So:

- **`ribo-core` `Transcriber` boundary:** `Blob` in, `Transcript` out. Unchanged. **[verified by inspection]**
  of the interface in [`03`](03-ribo-core.md).
- **`@azx/ribo-transcriber-ondevice` main↔worker boundary:** `Float32Array` (16 kHz mono) in via
  transferable, plus the `prompt_ids`/generation kwargs; text out. This is a **new, private** message
  contract this package owns.

**Consequences for the Phase 3 plan** ([`plans/2026-07-23-phase-3-ondevice-transcription.md`](../superpowers/plans/2026-07-23-phase-3-ondevice-transcription.md)):

- **Task 3 gains an explicit decode step** on the main-thread side of `OnDeviceTranscriber`, before the
  worker call — it is not free plumbing the pipeline does for us. The "wrap `@huggingface/transformers`
  and run Whisper in a Web Worker" description is right; what was missing is that the worker is fed
  `Float32Array`, produced by a main-thread `decodeAudioData`, never a `Blob` or URL.
- **Task 2/3 do NOT need to build a resampler or a mel-spectrogram** — `decodeAudioData` resamples and the
  pipeline's own feature extractor does the mel step once it has the `Float32Array`. So the "pipeline"
  between recorder and Whisper is genuinely small: **one main-thread decode function (§3) plus a
  transferable `postMessage`.** That is the honest scope of Task 2/3's audio handling.
- **No change to `Recorder`.** Opus-in-WebM is the right storage codec (~0.2–0.5 MB/min vs. ~1.9 MB/min for
  16 kHz mono WAV, more for 48 kHz) and `decodeAudioData` handles it on Chromium. Recording raw PCM/WAV to
  make it "directly decodable" trades a large, permanent storage cost for a decode step we have to do
  anyway. Leave capture as negotiated Opus; decode downstream.

---

## Sources

- `@huggingface/transformers@4.2.0`, unpacked from `npm pack` 2026-07-23 — `src/pipelines/_base.js`
  (`prepareAudios`), `src/pipelines/automatic-speech-recognition.js` (`_call_whisper`),
  `src/utils/audio.js` (`load_audio`/`read_audio`). **[verified by inspection]**
- MDN, _BaseAudioContext: decodeAudioData()_ —
  <https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData> (resamples to the
  context's sample rate; "complete file data, not fragments"). Fetched 2026-07-23.
- W3C Web Audio API v2, _Worker support for BaseAudioContext_ (issue #16, open) —
  <https://github.com/WebAudio/web-audio-api-v2/issues/16>. Fetched 2026-07-23.
- W3C Web Audio API, _Expose AudioContext in Worker/ServiceWorker_ (issue #2383) —
  <https://github.com/WebAudio/web-audio-api/issues/2383>. Fetched 2026-07-23.
- magenta-js #483, _OfflineAudioContext not defined in web worker_ —
  <https://github.com/magenta/magenta-js/issues/483>. Fetched 2026-07-23.
- Chromium issue 41290979, _decodeAudioData unable to decode dataUrl from MediaRecorder_ (container/decode
  edge cases) — <https://issues.chromium.org/issues/41290979>. Fetched 2026-07-23.
