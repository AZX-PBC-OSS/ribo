---
"@azx/ribo-transcriber-ondevice": minor
---

Measure the real-time factor during `prime()` and persist the verdict.

After `prime()` has constructed the pipeline and before it resolves, one
calibration inference runs over the committed 5 s clip. Elapsed wall-clock
divided by the clip's known duration produces the real-time factor, which is
written through Task 1's `writeRtfVerdict` store — keyed by model id, so a
model swap re-measures. The pipeline is warm at that point, so the measurement
covers decode + inference rather than model load; measuring the load instead
would produce a number that says more about the disk than the device.

A calibration failure must not fail `prime()`. If the timed run throws, it is
swallowed and no verdict is stored — Task 1 treats "no verdict" as "unknown,
therefore ready", so the device degrades to today's behaviour instead of a
broken prime.

New module `calibration.ts` exports `measureRtf`, called from `prime()` via a
private `#calibrate()` step. The `now` option on `OnDeviceTranscriberOptions`
(defaults to `performance.now`) is the injectable clock that lets tests assert
the arithmetic exactly — a clip of known duration timed against a controlled
clock yields the arithmetically correct RTF, which a test asserting only "some
number appeared" would not catch if the units were inverted.

No change to `Transcriber`, `TranscriberCapability`, `firstCapable`, or the
outbox schema. No new runtime dependencies.
