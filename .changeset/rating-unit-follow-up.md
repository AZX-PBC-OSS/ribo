---
"@azx/ribo-core": minor
"@azx/ribo-adapter-snuggpro": patch
---

An auditor's stated hvac efficiency rating unit now survives the create that makes the record
(ADR 0031).

Snugg Pro's `createHvac` returns 200 but discards `hvacHeatingSystemEfficiencyRatingUnit` and
`hvacCoolingSystemEfficiencyRatingUnit`, deriving both from the equipment type, while `updateHvac`
stores them as sent. The Snugg Pro writer now follows a create that states either unit with an
update of the new record carrying just those fields, so review no longer shows a unit as saved
that the vendor dropped. An update of an existing record needs no follow-up.

`@azx/ribo-core` gains `ReceiptedWriteError(receipt, cause)`. A write that is more than one request
throws it when its record landed and a later request failed, and `toInstanceWriteStep` records the
receipt before rethrowing the cause unchanged, so the retry updates that record instead of creating
a second one on the customer's job. A terminal follow-up failure keeps the receipt and surfaces as a
terminal error naming the record and its missing unit.
