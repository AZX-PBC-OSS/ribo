---
"@azx/ribo-extractor-ondevice": patch
---

Declare the Prompt API ambient interfaces with property signatures instead of
method signatures, so `method-signature-style` no longer needs a file-level
exemption: `LanguageModelMonitor.addEventListener`,
`LanguageModelSession.measureContextUsage` / `promptStreaming` / `clone` /
`destroy` and `LanguageModel.availability` / `create` are now written
`name: (args) => ret` rather than `name(args): ret`. The runtime shape is
unchanged and the interfaces are structural, so existing implementations and
injected doubles type-check as before; only the emitted declarations differ.
