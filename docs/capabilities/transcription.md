# Transcription

The `Transcriber` seam turns captured audio into a `Transcript`. Implementations report what they can do
right now through a capability model, and `firstCapable` selects the first ready engine in preference
order. Today: on-device Whisper (`@azx/ribo-transcriber-ondevice`) and the `FakeTranscriber` double in
core. Managed STT is a further implementation of the same interface.

::: info Content coming
The narrative and a worked example land in the content pass. See
[`Transcriber`](/reference/ribo-core/src/interfaces/Transcriber) and
[`OnDeviceTranscriber`](/reference/ribo-transcriber-ondevice/src/classes/OnDeviceTranscriber).
:::
