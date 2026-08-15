---
"@azx/ribo-core": patch
"@azx/ribo-transcriber-ondevice": patch
---

Pin patched versions of eight advisory-flagged transitive dependencies via `pnpm.overrides`.

`fast-uri`, `postcss` and `sharp` reach published packages through `rxdb` and
`@huggingface/transformers`, both of which are already at their latest release — so
overrides are the only lever. The rest are build- and lint-time only.
