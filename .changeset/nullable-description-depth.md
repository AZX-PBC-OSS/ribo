---
"@azx/ribo-core": patch
"@azx/ribo-cli": patch
---

`stripOptionalNullable` now carries the description of the outermost optional/nullable wrapper that HAS one, at any depth of the chain — previously it read only the outermost wrapper. `z.fromJSONSchema` renders a property that is absent from its parent's `required` list and carries `"nullable": true` plus a `description` as `ZodOptional(ZodNullable(leaf))` with the text on the middle `ZodNullable`, so that description was silently dropped: `walkLeafInventory` reported the leaf as undescribed, and everything built from the walk — the field-guidance block rendered into extraction prompts, and `ribo schema inspect`'s guidance coverage figure — lost the text with it. The outer-described-wins rule is unchanged: when several layers carry a description, the outermost-described wrapper's text still wins. Schemas whose descriptions were already found (the outermost wrapper, or the inner type itself) behave exactly as before.
