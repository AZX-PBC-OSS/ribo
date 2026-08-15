---
"@azx/ribo-adapter-snuggpro": minor
---

Alias the six `hvacDuctInsulation` enum members that carry double-quote inch
marks (`Duct Board 1.5"`) to quote-free alternatives (`Duct Board 1.5 inch`).

The platform's structured-output route (`POST <base>/_api/llm/chat`) rejects a
schema whose enum contains a double-quote character with a generic
`400 validation_failed` — verified in isolation against the live route. The
failure reads identically to an over-cap schema and blocked all extraction on
that route, not just per-group. No other enum member anywhere in the extraction
schema carries a double quote.

A `DUCT_INSULATION_VENDOR_LITERALS` lookup table in `normalization.ts` maps each
alias back to the vendor's exact wire string, so `write` can send
`Duct Board 1.5"` — not the alias — when egress lands. The three unquoted
members (`No Insulation`, `Reflective bubble wrap`, `Measured (R Value)`) are
unchanged and absent from the table. A guard test asserts no enum member
anywhere in the extraction schema contains a double quote, so a future field
that reintroduces one fails the build rather than a real extraction in the
field.
