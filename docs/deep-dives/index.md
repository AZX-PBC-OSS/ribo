# Deep Dives

The guide tells you what Ribo does and how to use it. This section is where its claims come from:
the measurements, spikes and reconciliations behind specific numbers cited in the guide. Method, the
actual numbers, and what each result **does and does not** support: a measurement scoped to one
route, one corpus or one snapshot is labeled as such.

- **[Feasibility](/deep-dives/feasibility)** — why on-device WASM transcription is the default: the
  device baseline, the iOS WebGPU trap that ruled out trusting capability flags, and why the library
  and (then-)model were chosen by attrition rather than preference. Records the original Whisper
  decision, since superseded by Moonshine — see the note at the top of that page.
- **[Transcription: Measured](/deep-dives/transcription-measurement)** — our own numbers on our own
  corpus: real-time factor, word error rate, load time and memory for `whisper-base.en` and
  `whisper-tiny.en`, the models measured at the time, plus what happens to extraction when it runs on
  a noisy on-device transcript instead of clean text. The on-device default has since moved to
  Moonshine, not yet measured on this corpus.
- **[Extraction: Measured](/deep-dives/accuracy)** — generated from the committed acceptance-gate run
  records, not hand-written. It states what extraction-accuracy number exists right now (none) and
  why, instead of publishing a stale one.
- **[Real Field Audio](/deep-dives/real-audio)** — the same transcription and extraction pipeline,
  run end to end against two real field recordings instead of synthesized speech: a first check
  against the real thing, not yet a scored benchmark.
- **[The Snugg Pro Data Model](/deep-dives/snuggpro-data-model)** — the structural mismatches between
  what an auditor says and what the measured system of record actually stores: fuel as its own axis,
  a health-and-safety test matrix, and where the printed field sheet undersold what the real API
  accepts.
- **[Schema at Scale: Measured](/deep-dives/schema-scale)** — the hard ceilings a structured-output request runs
  into as a real target schema grows, including one that isn't published anywhere and had to be found
  by bisecting real calls.
- **[Provenance: Measured](/deep-dives/provenance-measurement)** — what unit a citation should
  cover — one field, one row, or nothing — measured in fabrication rate and call cost.
