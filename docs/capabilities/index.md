# Capabilities

Ribo's power is in its seams. Three interfaces are the extension points where you swap implementations
without touching the engine:

- **[Transcription](/capabilities/transcription)** — the `Transcriber` contract: on-device WASM Whisper
  or a managed STT service, selected by capability.
- **[Extraction](/capabilities/extraction)** — the `Extractor` seam: a transcript becomes structured
  fields. Strategies live in adapters.
- **[Adapters](/capabilities/adapters)** — the `ToolAdapter`: the only place tool-specific knowledge
  (field names, write-back) lives.

::: info Content coming
Each capability page — centered on its seam with a real code example — lands in the content pass.
:::
