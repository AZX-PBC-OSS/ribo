---
layout: home

hero:
  name: Ribo
  text: Voice capture for field data collection
  tagline: >-
    Record a dictation, transcribe it on-device, extract structured fields, and let a human review
    them with provenance — offline-first, and pluggable at every seam.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Why Ribo
      link: /guide/
    - theme: alt
      text: API Reference
      link: /reference/

features:
  - title: Capture → transcribe → extract → review
    details: >-
      A headless engine drives the whole loop. Audio is captured, transcribed (on-device Whisper or a
      managed STT service), turned into structured fields, and handed to a human to accept or correct.
  - title: Offline-first by construction
    details: >-
      A durable RxDB outbox holds work until it can sync. The app shell and the on-device model are
      cached so a returning auditor boots and records with no network at all.
  - title: Pluggable at every seam
    details: >-
      Transcription (Transcriber), extraction (Extractor), and write-back (ToolAdapter) are all
      interfaces. A second host tool is a new adapter package and nothing else.
  - title: Provenance you can check
    details: >-
      Every extracted field arrives in an envelope that records where it came from. A span proves the
      model did not invent the quote — surfaced to the reviewer, not hidden behind a confidence score.
---
