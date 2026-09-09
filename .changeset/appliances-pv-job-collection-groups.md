---
"@azx/ribo-adapter-snuggpro": minor
---

Adds the appliances-and-PV job-collection tranche (doc 20 §5.6): `clothesDryer`, `freezer`, `range`, `refrigerator` and `pv`, each a new per-instance array group carrying every field doc 20 verdicts capture or capture?, with verbatim wire names and enum members — including the freezer/refrigerator brand lists that are genuinely different sets and both carry the vendor's own "Fridgidaire" typo. Instance identity rides the roster's discriminator mechanism for all five (spoken label, make/model, roof plane and orientation), with per-resource granularity rules in the inventory pass. No `oven` group: the oven has no write endpoint anywhere in the spec, and `rangeFuelType` is its fuel's only writable home.
