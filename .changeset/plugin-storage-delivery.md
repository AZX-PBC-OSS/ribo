---
"@azx/ribo-core": minor
---

The plugin-scoped storage handle is now **deliverable** — the substrate (the
`pluginStorage` collection, the capture-scoped handle, core's sweep) existed
already, but the only accessor was `Outbox.pluginStorage(captureId, pluginId)`,
so a plugin could reach its own storage only if the application handed it the
whole `Outbox`, which the design rejected.

Two new delivery paths, split where the identity lives:

- **Transcribers get the handle at call time**, through a new
  `TranscribeOptions.storage` — a `CaptureStorageScope` scoped to the capture
  being transcribed, with the plugin dimension supplied by the transcriber
  itself (`forPlugin(engine)`), because the relay cannot know which engine a
  selection combinator will pick. The relay supplies it on every transcribe
  step; a host driving a transcriber by hand supplies nothing, and the member
  is optional so that absence is observable.
- **Extractors get the handle at construction**, via
  `Outbox.pluginStorageScope(pluginId)` — a `PluginStorageScope` baked to one
  plugin across every capture it has entries for, with per-capture addressing
  (`capture(captureId)`) and live enumeration (`captures()`). The relay cannot
  name the plugin behind an opaque extract step (`Extractor` carries no
  identity; `engine` appears on the result, after the call), so the host —
  which knows which plugin it is building — supplies the identity instead.

**What a plugin author can rely on:** durability (entries live in the outbox's
own database; the two halves of a plugin may run in different tabs, minutes
apart), per-plugin and per-capture isolation, and live reads — a capture whose
entries core swept (dropped or discarded) drops out of `captures()` and reads
`undefined`, so a reader never holds a stale view, even the same scope instance
across the sweep.

**What it cannot rely on:** session bounding. `captures()` enumerates every
unswept capture the plugin has entries for, across sessions — an extraction
sees only the joined transcript, so core cannot bound the enumeration to it.
The lifecycle is the sweep, not the session. A plugin that needs session
correlation encodes it in its own keys or values.
