---
name: @azx/ribo-core
---

Enable `@typescript-eslint/method-signature-style` with `"error", "property"` in
`eslint.config.mjs` and autofix all method signatures to property syntax across
`ribo-core`, `ribo-adapter-snuggpro`, and `ribo-extractor-openai`. The convention
converts 51 sites from method to property syntax (bivariance → strict contravariance).
Internal helper methods in packages outside the core extractor/adapters were left
unchanged per the task's guidance — only exported interfaces and their implementations
were converted. Typecheck and all 1343 unit tests pass.

---

name: @azx/ribo-extractor-openai
---

Same rule and autofix applied within `ribo-extractor-openai` package boundary.
No breaking changes to public API shape; method signatures converted to function
properties structurally equivalently.

---

name: @azx/ribo-adapter-snuggpro
---

Same rule and autofix applied within `ribo-adapter-snuggpro` package boundary.
The `RunStore` interface methods were converted from method to property syntax.
No breaking changes.

---
