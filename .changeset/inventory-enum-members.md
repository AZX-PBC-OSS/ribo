---
"@azx/ribo-core": minor
---

**The leaf inventory shows an enum's or literal's members.** `LeafInventoryEntry` gains `values`
(typed by the new `LeafValue`), and `renderLeafInventory` renders them beside the kind —
`kind (enum: "gas" | "oil")`, `schemaVersion (literal: 2)` — with strings quoted so `"1"` and `1`
stay distinct. The shape proposer used to see only the word `enum`, which is why spike 0009 had to
copy every member into the description by hand. On that spike's basedata schema (300 leaves, 97
enums) the members add 7.3 KB to the inventory.
