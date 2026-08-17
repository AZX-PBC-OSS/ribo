# 14 — On-device transcription: the measured spike

Phase 3's central bet — _"speak into the device, get a real transcript back, computed locally"_ —
checked with **our own measured numbers**. This is Task 4 of the on-device transcription phase
(Phase 3). Nothing here is cited from a vendor post or a public benchmark; every figure comes from
a run of the harness in
[`spikes/transcription-measurement/`](../../spikes/transcription-measurement/README.md). Where a
number could not be produced in this environment it is called out and a manual recipe is given.

## Evidence grades

- **[measured]** — produced by a run of this repo's harness on this machine, on the date below.
- **[from Task 2/3]** — established earlier in this phase (download size, fp32 decision); repeated
  here as context, not re-measured.
- **[unmeasured]** — no number exists, including ours. Notably: **WebGPU**, and **real field audio**.

Runs performed 2026-07-23, macOS (darwin), Node 24, headless Chromium via Playwright.

---

## TL;DR

- **It works, and it is fast enough.** `whisper-base.en` (fp32, WASM) transcribes the 14-transcript
  Snugg Pro corpus at **RTF 0.16** (≈6× faster than real time) with **8.0 % WER** against our
  authored source text. `whisper-tiny.en` is **RTF 0.075 / 8.6 % WER** on this _clean_ audio. **[measured]**
- **Warm start is effectively instant and offline.** After a one-time load, a fresh worker rebuilds
  the pipeline from the Cache API — **no network** — in **~0.8 s** (base) / **~0.6 s** (tiny). **[measured]**
- **Hints matter on jargon.** On the jargon-dense combustion-safety transcript, hints cut base.en WER
  from **22.4 % → 4.3 %** (−18 pp). Averaged over the tested clips the effect is smaller but positive. **[measured]**
- **The transcription→extraction interaction is benign except for proper nouns.** Running extraction
  on the _noisy_ on-device transcripts instead of clean text left **all four headline hazards
  unchanged** (hallucination, miss, axis-split fuel-drop, health-matrix hallucinated-pass). The only
  degradation: **equipment value accuracy 100 % → ~96 %**, and **every** broken field was a
  mis-transcribed **manufacturer/model name** (Trane→"train", Lennox→"**Linux**", Weil-McLain→"wheel
  McLean", Burnham→"burnum"). **[measured]**
- **These are a floor.** TTS audio has no noise, mic handling, disfluency, or cross-talk. Do not read
  8 % WER as a field forecast; the real-recording gate is still owed (consent, out of scope).

---

## Method

- **Corpus.** The 14 authored Snugg Pro transcripts (`spikes/extraction-snuggpro/transcripts/`). We
  wrote them, so the ground-truth text is exact and WER is directly computable with no consent
  dependency. Realistic content paired with a schema-faithful scorer.
- **Audio.** macOS `say -v Samantha -r 155` → `afconvert` to **16 kHz mono** WAV (`synth.mjs`).
- **Chunking (at harness level).** At ~2.85 words/s every transcript but the shortest exceeds
  Whisper's 30 s window, and the transcriber does **not** chunk yet (`worker.ts` truncates at 30 s).
  So `synth.mjs` splits each transcript into ≤~24 s segments at sentence boundaries (76 segments,
  1253 s of audio total); the harness transcribes each segment through the **real**
  `OnDeviceTranscriber` and concatenates. The transcriber itself is unchanged and still 30 s-bound —
  no clip was truncated.
- **Transcriber.** The real `@azx/ribo-transcriber-ondevice` `OnDeviceTranscriber`, **`device:
"wasm"`, `dtype: "fp32"`**, worker + same-origin ORT `wasmPaths`, exactly as `transcribe.manual.ts`
  wires it. fp32 because q4/q8 do not load on the pinned ORT build (Task 2).
- **WER.** `wer.mjs`: lowercase → straighten quotes → replace every char except `[a-z0-9']` and
  whitespace **with a space** (strips all punctuation/brackets, splits hyphens: `R-38`→`r 38`,
  `[homeowner]`→`homeowner`) → collapse whitespace → word tokens → word-level Levenshtein `(S+D+I)/N`.
  Numerals are **not** normalized, so a spelled-out `"thirty-two hundred"` vs Whisper's `"3200"`
  counts as an error even though nothing was mis-heard — a deliberate, honest inflation (see the
  numeral caveat in `wer.mjs`). `wer.test.mjs` proves the implementation.

### Environment reality

- **WASM, not WebGPU. [measured on wasm; WebGPU unmeasured]** Headless Playwright Chromium has no GPU
  surface, so WebGPU is unreachable here — the same constraint Task 3 hit. All numbers below are the
  WASM execution provider. WebGPU remains untested by us; per the plan's "measure, do not cite" rule
  we report **no** WebGPU figure rather than a borrowed one.
- **`fp32` / ~290 MB. [from Task 2]** The production model is `whisper-base.en` fp32 (~290 MB); the
  largest single weight file **[measured]** streamed at 208 MB.

---

## Part A — quality + performance

### Performance and load (whole-corpus)

| model             | device/dtype | corpus RTF | corpus WER | cold load¹ | warm-from-cache² | memoized reprime³ | peak browser RSS⁴ |
| ----------------- | ------------ | ---------: | ---------: | ---------: | ---------------: | ----------------: | ----------------: |
| `whisper-base.en` | wasm / fp32  |  **0.159** |  **8.0 %** |     85.7 s |       **0.79 s** |            1.4 ms |           ~3.5 GB |
| `whisper-tiny.en` | wasm / fp32  |      0.075 |      8.6 % |     47.3 s |           0.64 s |            1.8 ms |           ~2.5 GB |

1. **Cold load** = first `prime()` in a fresh browser context: streams the weights off the network
   **and** builds the ORT session. Each headless run starts with an empty Cache API, so this always
   includes the full download — it is a genuine first-ever-load number, not just init.
2. **Warm-from-cache** = a brand-new worker priming after the weights are already in the Cache API:
   a cold ORT session but **no network**. This is the returning-user / offline-boot load, and it is
   sub-second. (OS file cache was warm; still, it reads ~290 MB and builds a session in ~0.8 s.)
3. **Memoized reprime** = priming the _same_ worker again; returns the in-memory pipeline (~0).
4. **Peak browser RSS** is summed over the Playwright-Chromium processes only (matched on the
   `ms-playwright` path; the developer's Google Chrome is excluded). `ps` RSS double-counts shared
   pages, so this is a **ceiling for the whole headless browser**, not the model alone. The JS heap
   the page can read is only ~22 MB — it does **not** include the WASM/ORT arena where the model
   lives, which is why process RSS is the honest figure. fp32's large weights make this notably heavy;
   ~~fp16 (~145 MB, deferred in Task 2) is the lever if this becomes a device limit.~~
   **That lever is closed.** Measured 2026-08-17 (`dtype-probe.manual.ts`): fp16 fails session
   creation on **both** WASM and WebGPU, on `moonshine-tiny` and `whisper-tiny.en` alike. The
   working lever is **q8**, which returned output identical to fp32 on the calibration clip while
   loading ~4.5x faster from ~4x fewer bytes — but it needs `onnxruntime-web` ≥ 1.27.0, newer than
   the dev build transformers.js 4.2.0 pins, or a WebGPU device. Peak RSS per dtype is still
   unmeasured, so whether this closes the device limit is not yet established.

RTF is process-time (decode + resample + inference, the full `transcribe()` call) ÷ audio duration.

### WER per transcript (`whisper-base.en`, hinted)

| transcript                |  audio s |       RTF |       WER | S / D / I / ref  |
| ------------------------- | -------: | --------: | --------: | ---------------- |
| 01-attic-r-value-shell    |     74.5 |     0.143 |    12.4 % | 16/10/1 of 217   |
| 02-oil-boiler-basement    |     65.9 |     0.157 |    10.7 % | 16/6/0 of 206    |
| 03-quick-exterior-short   |     32.9 |     0.158 |     3.7 % | 2/2/0 of 108     |
| 04-fuel-stated-separately |     64.0 |     0.161 |     8.9 % | 11/6/0 of 191    |
| 05-full-walkthrough       |    312.4 |     0.172 |     9.1 % | 55/24/8 of 952   |
| 06-homeowner-crosstalk    |     80.1 |     0.165 |     4.2 % | 6/3/2 of 264     |
| 07-combustion-safety      |     98.0 |     0.162 |     4.3 % | 9/3/1 of 299     |
| 08-no-fuel-silent-drop    |     76.7 |     0.144 |    11.0 % | 19/5/3 of 246    |
| 09-chatter-and-scheduling |     70.1 |     0.154 |     1.4 % | 3/0/0 of 217     |
| 10-crawlspace-loose-units |     94.4 |     0.143 |    10.6 % | 20/10/0 of 284   |
| 11-ambiguous-attic        |     65.8 |     0.158 |     9.2 % | 13/5/0 of 196    |
| 12-wrong-field-old-unit   |     73.5 |     0.142 |    11.3 % | 15/9/0 of 212    |
| 13-enum-paraphrase        |    104.1 |     0.151 |     6.9 % | 15/5/1 of 305    |
| 14-rapid-recap            |     40.1 |     0.189 |     1.7 % | 1/0/1 of 120     |
| **corpus**                | **1253** | **0.159** | **8.0 %** | (3817 ref words) |

A large share of the per-transcript errors are numeral-formatting (`"thirty-two hundred"` vs `3200`,
`"twenty seventeen"` vs `2017`) that the extraction layer's number parser tolerates — see Part B.

### Hinted vs unhinted (WER delta)

Hints = the domain vocabulary (`R-value, CFM50, CFM25, ACH50, AFUE, blower door, backdrafting, flue,
BTU, condensing, direct-vented, cellulose, spillage, draft diverter`), wired to Whisper's decoder
prefix (Task 3).

| transcript              | model   | unhinted | hinted | Δ (unhinted − hinted) |
| ----------------------- | ------- | -------: | -----: | --------------------: |
| 07-combustion-safety    | base.en |   22.4 % |  4.3 % |          **−18.1 pp** |
| 01-attic-r-value-shell  | base.en |   13.8 % | 12.4 % |               −1.4 pp |
| 12-wrong-field-old-unit | base.en |   11.8 % | 11.3 % |               −0.5 pp |
| 05-full-walkthrough     | base.en |    9.3 % |  9.1 % |               −0.2 pp |
| 01-attic-r-value-shell  | tiny.en |   17.1 % | 12.0 % |               −5.1 pp |
| 12-wrong-field-old-unit | tiny.en |   14.1 % | 12.7 % |               −1.4 pp |
| 05-full-walkthrough     | tiny.en |    9.3 % |  8.7 % |               −0.6 pp |
| 07-combustion-safety    | tiny.en |    5.3 % |  5.7 % |           **+0.4 pp** |

Hints are **net positive** but not free: they rescued a base.en segment that went badly wrong
unhinted (07: −18 pp), yet on tiny.en/07 they cost 0.4 pp, and in earlier single-clip runs hints
occasionally bled the vocabulary into the text (`"attic"`→`"ACH"`). They help most exactly where the
jargon is dense — which is where we need them — and the transcript-level effect is small because most
words are ordinary English Whisper already hears.

---

## Part B — the transcription → extraction interaction

The thing the clean-text extraction spike could not test: what happens when extraction runs on the
**real, noisy** on-device transcript instead of clean authored text. We fed the `whisper-base.en`
(hinted) transcripts from Part A through the **same** blind extraction pipeline
(`extract-ondevice.mjs`, reusing the spike's `prompt.md` + `schema.ts`) with **both** models, and
scored with the spike's exported scorer — crucially, checking `sourceSpan` verbatimness against the
**noisy** transcript (what the model actually saw). Diffed against the committed clean-text baseline
(`spikes/extraction-snuggpro/results/{codex,opencode}-score.json`, both 14/14).

### codex (gpt-5.6)

| metric                     |     clean |  on-device | verdict               |
| -------------------------- | --------: | ---------: | --------------------- |
| hallucination (hard) rate  | 0.5 % (1) |  0.5 % (1) | **unchanged**         |
| miss rate                  | 0.8 % (1) |  0.8 % (1) | **unchanged**         |
| axis: fuel dropped         |         0 |          0 | **unchanged**         |
| axis: fuel invented (08)   |         0 |          0 | **unchanged**         |
| health: hallucinated pass  |         0 |          0 | **unchanged**         |
| health: clean-dropped→null |         0 |          0 | **unchanged**         |
| enum member accuracy       |     100 % |      100 % | unchanged             |
| band accuracy              |     100 % |      100 % | unchanged             |
| sourceSpan verbatim        |     100 % |      100 % | unchanged             |
| **both-non-null accuracy** | **100 %** | **95.8 %** | **−4.2 pp (5 wrong)** |

### opencode (glm-5.2)

| metric                     |         clean |     on-device | verdict               |
| -------------------------- | ------------: | ------------: | --------------------- |
| hallucination (hard) rate  |     1.0 % (2) |     0.5 % (1) | unchanged (noise)     |
| miss rate                  |           0 % |           0 % | **unchanged**         |
| axis: fuel dropped         |             0 |             0 | **unchanged**         |
| health: hallucinated pass  |             0 |             0 | **unchanged**         |
| health: state accuracy     |        99.2 % |        99.2 % | unchanged             |
| enum / band accuracy       | 100 % / 100 % | 100 % / 100 % | unchanged             |
| sourceSpan verbatim        |         100 % |         100 % | unchanged             |
| **both-non-null accuracy** |     **100 %** |    **96.6 %** | **−3.4 pp (4 wrong)** |

### What broke — and it is exactly one thing

**Every** wrong value on both extractors was a mis-transcribed **manufacturer or model name**:

| transcript | field               | ground truth | on-device heard    | codex | opencode |
| ---------- | ------------------- | ------------ | ------------------ | :---: | :------: |
| 01         | heatingManufacturer | Trane        | "a **train**"      | wrong |    ok    |
| 02         | heatingManufacturer | Burnham      | "**burnum**"       | wrong |  wrong   |
| 02         | heatingModelNumber  | V8           | "SES V8"           | wrong |  wrong   |
| 04         | heatingManufacturer | Weil-McLain  | "**wheel McLean**" | wrong |  wrong   |
| 08         | heatingManufacturer | Lennox       | "**Linux**"        | wrong |  wrong   |

These are **proper nouns Whisper cannot know and hints do not cover** (the hint vocabulary is
building-science jargon, not brand names). Everything the domain-jargon path _does_ cover survived:
`AFUE`, `CFM50/CFM25`, `R-38`, `BTU`, `spillage`, `backdrafting`, the health tests, the equipment/fuel
axis split, the enum and band mappings. And the numeral errors that inflate raw WER (`3200` vs
`"thirty-two hundred"`) are absorbed by the extraction layer's number parser — they did **not**
produce a single wrong number. The failure mode is narrow and predictable: **out-of-vocabulary brand
names**. The obvious mitigation (adding common HVAC manufacturer names to the hint vocabulary) is a
cheap follow-up the harness can re-measure.

### sourceSpan on a noisy transcript — provenance is honest, the words may be mis-heard

The prompt requires each `sourceSpan` to be a verbatim substring of the transcript. On the noisy
transcript the spans are verbatim substrings of the **noisy** text — verbatim rate stayed **100 %**
for both extractors (codex 163→173 spans, opencode 186→174). That means **the provenance guarantee
still holds**: the span is honest to what the model was given. But the underlying words may
be mis-heard — the Lennox span reads `"…a Linux, natural gas…"`. The implication for the product:
a span proves _the model did not invent the quote_, **not** that the audio was heard correctly. Span
verbatimness and transcription correctness are different guarantees; a reviewer UI that shows the span
should not be read as certifying the words.

---

## Part C — this is a floor, not a forecast

**TTS audio is cleaner than any real field recording.** `say` output has no background noise, no HVAC
hum, no mic handling or wind, no disfluent delivery ("uh, so the— the furnace"), no cross-talk with a
homeowner, no room reverberation, no clipping. Every number above is therefore a **floor** on
achievable quality, established under ideal acoustic conditions:

- The 8 % WER is a best case; real audio will be worse, by an amount we have **not** measured.
- The clean Part-B result (only brand names break) may not hold when noise corrupts numbers and jargon
  too — the very tokens that survived here.

These numbers retire the _feasibility_ question (on-device Whisper is fast enough and accurate enough
on clean speech, and integrates through extraction without new hallucination hazards). They do **not**
retire the _field-readiness_ question. That needs the **real-recording gate** — recordings of actual
audits — which remains **gated on recording consent and is out of scope for Phase 3**. Do not plan
against these as field numbers.

---

## Reproduce

Full harness, commands, and file map: [`spikes/transcription-measurement/README.md`](../../spikes/transcription-measurement/README.md).
None of it runs in `./check.sh` (it downloads a real model and runs minutes of inference); the
committed artifacts are the measured summaries `results/metrics-*.json` and
`results/partb-*-score.json`.

```bash
node spikes/transcription-measurement/synth.mjs                      # audio fixtures
node spikes/transcription-measurement/run.mjs Xenova/whisper-base.en \
  01-attic-r-value-shell,05-full-walkthrough,07-combustion-safety,12-wrong-field-old-unit
node spikes/transcription-measurement/run.mjs Xenova/whisper-tiny.en \
  01-attic-r-value-shell,05-full-walkthrough,07-combustion-safety,12-wrong-field-old-unit
node spikes/transcription-measurement/extract-ondevice.mjs codex    whisper-base.en
node spikes/transcription-measurement/score-partb.mjs       codex    whisper-base.en
node spikes/transcription-measurement/extract-ondevice.mjs opencode whisper-base.en
node spikes/transcription-measurement/score-partb.mjs       opencode whisper-base.en
```

### What was run vs left as a documented manual step

- **Run and committed [measured]:** everything above — both models' full Part A (RTF/WER/load/memory/
  hint-delta) and both extractors' full Part B on `whisper-base.en`, all 14 transcripts.
- **Manual step, not automated:** **WebGPU.** Unreachable in headless Playwright Chromium (no GPU
  surface). To measure it, run `measure.manual.ts` with `device: "webgpu"` in a **headed** Chromium on
  a WebGPU-capable machine and compare RTF. Per the plan's history the one existing measured datum has
  WebGPU _slower_ than WASM for Whisper, so this is worth checking before assuming a speedup.
- **Manual step, owed later:** **real field audio.** The whole of Part C — gated on recording consent.
- **Note on the extractor CLIs:** `opencode run` is agentic and occasionally explored its working
  directory instead of emitting JSON on the longest transcript (05); the runner sandboxes it to `/tmp`
  (no repo access → no ground-truth/baseline leak) and a re-run produced clean JSON. `codex exec`
  (`--sandbox read-only`, cwd `/tmp`) was reliable.
