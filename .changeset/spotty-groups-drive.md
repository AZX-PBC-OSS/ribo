---
"@azx/ribo-extractor-ondevice": major
"@azx/ribo-core": major
---

Export missing symbols from package barrels so consumers can reuse them instead of reimplementing trust-boundary logic:

- `@azx/ribo-extractor-ondevice` now exports `SessionCapabilityError`.
- `@azx/ribo-extractor-openai` now exports `assertStopFinishReason`, `completeOrClassify`, `parseWithSchema`, `parseJsonContent`, and `buildMessages`.
