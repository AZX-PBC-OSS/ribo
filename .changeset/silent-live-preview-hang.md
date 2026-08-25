---
"@azx/ribo-transcriber-ondevice": patch
---

Fix a silent, permanent hang in on-device transcription and live preview when the model is already
fully cached but a network path to `huggingface.co` is present and stalling (rather than cleanly
unreachable).

`env.allowRemoteModels` is a mutable transformers.js singleton shared by every pipeline build in the
worker. It stayed at the library default (`true`) for every build, including a warm cache-hit build
during ordinary `transcribe()`/live-session inference — so transformers.js's `_get_file_metadata`
could still reach for the network to look up a cached file's size for progress reporting, with no
timeout on that call. On a network that black-holes the request instead of failing it outright, that
one metadata fetch hung forever, and with it the whole transcription — even though every byte it
needed was already on disk.

`getPipeline`/`getVad` now take an explicit `allowDownload` flag, defaulting to `false`. Only `prime`
(the one caller a human explicitly triggers, and the only place a real download should ever happen)
passes `true`. A warm build that turns out not to be fully cached after all now fails immediately and
loudly instead of hanging silently and permanently.
