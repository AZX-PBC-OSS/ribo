---
"@azx/ribo-transcriber-ondevice": patch
---

Add `liveClosed` signal: the worker posts a `liveClosed` message after the
drain from `liveClose` completes (in every exit path — empty drain, successful
commit, transcription error, VAD-drain error). `OnDeviceLiveSession` completes
its `Subject` and removes the message listener on this signal, giving the host
a reliable "done" signal so it can tear down its subscription without dropping
the flushed final region or leaking.

This fixes the silent-loss bug where the host unsubscribed from `segments$`
before calling `close()`, so the worker's flush segment — transcribed after
close — arrived at a subscriber that was already gone. The last ~10 seconds of
preview was lost on every recording.
