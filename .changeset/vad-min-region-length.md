---
"@azx/ribo-transcriber-ondevice": patch
---

Fix the streaming VAD committing a region on every phrase pause, keeping regions short.

A pause — silence past `VAD_COMMIT_SILENCE_MS` (800 ms) — committed immediately once the region
held 250 ms of speech, with no minimum region length. Real dictation is short phrases separated
by pauses longer than 800 ms, so every phrase committed, regions stayed 2–5 seconds long, and the
model was handed short fragments with no context — the failure revision 7 was written to
eliminate.

A pause may now only commit once the region has reached `VAD_MIN_REGION_SECONDS` (15 s, a
placeholder pending measurement on real speech). Below that, a qualifying pause triggers a
refresh (the tail is re-transcribed and replaced) and the region keeps growing across pauses. The
region cap still forces a commit regardless, and `drain` still returns whatever remains at close.
The minimum is injectable through the constructor alongside the other thresholds.
