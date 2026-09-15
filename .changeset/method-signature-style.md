---
"@azx/ribo-core": major
"@azx/ribo-extractor-openai": major
"@azx/ribo-adapter-snuggpro": patch
---

Declare contract members as function-typed properties rather than methods, enforced by
`@typescript-eslint/method-signature-style`.

Method syntax is bivariant even under `strictFunctionTypes`, so a too-narrow implementation
satisfies a wider slot silently. Property syntax is contravariant in its parameters and rejects
it. Nothing in this repo was relying on the looseness — the conversion changed no behaviour and no
existing implementation failed — but `Transcriber`, `Extractor`, `ChatClient` and `PluginStorage`
are implemented outside this repo, so the guarantee is worth making mechanical rather than
remembered.

Marked major for the two packages whose contracts consumers implement: an implementation that
typechecked against the method form because of bivariance may now be rejected, which is the point.
