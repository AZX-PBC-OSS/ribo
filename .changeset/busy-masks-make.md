---
"@azx/ribo-transcriber-ondevice": minor
---

Add the RTF verdict store: a persisted, per-model-id measured real-time factor
that `capability()` consults to produce `too-slow`.

A new `rtf-verdict.ts` module stores one measured RTF per model id in a dedicated
`CacheStorage` bucket (`ribo-rtf-verdict`), keyed by model id, so the verdict
survives a reload and a model swap re-measures rather than inheriting. Storage is
injected as a `CacheStorage`, following the existing `#cacheStorage` pattern —
tests supply a double, no real persistence needed.

`capability()` now checks the stored RTF **before** the cache check: a device
known to be too slow reports `unavailable`/`too-slow` even with the weights
cached, because cached weights are exactly the situation the old code mistook for
readiness. When no verdict is stored, today's behaviour is unchanged — a device
that primed but never calibrated still reports `ready`.

`too-slow` is in `PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS`, so `firstCapable`
stops re-probing a too-slow device on every drain, and the managed engine is
selected instead — the behaviour that makes the fallback reachable for the
devices that most need it.

A `measuredRtf()` accessor on `OnDeviceTranscriber` exposes the stored value (or
`undefined` before calibration) for the hedge combinator's delay policy. An
`rtfThreshold` option (default 3, provisional) controls the gate boundary.

No inference is added in this task — the RTF value is written directly by tests.
Calibration during `prime()` is Task 2.
