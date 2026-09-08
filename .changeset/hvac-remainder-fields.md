---
"@azx/ribo-adapter-snuggpro": minor
---

The `hvac` group gains its full verdicted remainder (doc 20 §5.4, job-collections tranche 11). Base
side: every field verdicted `capture`/`capture?` — the human instance label `hvacSystemName` (the
first natural name field on any array-shaped group), the condensing flag, both percent-of-load
shares (heating shares must total 100 across systems, cooling need not), the cooling-side
manufacturer on its own verbatim closed list (`HvacCoolingSystemManufacturer` — cooling has
`Comfort Maker`/`Coolerado` where heating has `Comfort Master`, typo pair included), the indoor/
outdoor model and serial free-text fields, `hvacCoolingSystemModelYear` as `z.number()` (the
year-as-string divergence `hvacHeatingSystemModelYear` already records), the measured
duct-insulation R-value, the heat-pump inverter flag, both maintenance star ratings as
`z.enum(["1", "2", "3"])` (the spec's enum is `[null, "1", "2", "3"]` — a literal null plus numeric
STRINGS, so the null is the leaf's `.nullable()` and the strings stay strings), the on-site-measured
`hvacSteadyStateEfficiency`, the `capture?` AFUE/HSPF/SEER/EER efficiency numbers (stated values
only — HAZARD 4's lookup rule still forbids estimating them), and the two efficiency rating units as
free text (their `enum: []` value lists are unpublished). Improved side: only the seven
intent-bearing `capture?` fields — for `hvacUpgradeAction: "Install a new non-existing system"` the
improved side is the only place the new system exists, so `hvacHeatingEnergySourceImproved` (free
text; unlike the base twin there is no sanctioned list to borrow), both improved capacities (stated
tonnage, Btu/hr on the wire), both improved load shares, `hvacHeatPumpInverterImproved` and
`energyStarColdClimateHeatPumpImproved` are the dictated recommendation itself, while the remaining
improved fields are desk-side purchase specs of unbought equipment and stay excluded. The two
`energyStarColdClimateHeatPump` fields are `z.number()` with the integer `1`/`0` vocabulary in their
descriptions, the `hasEv` treatment. Extraction rule 10 was rewritten to match: efficiency now has
stated-number-only slots rather than no slot at all. The schema totals 248 leaves across the ten
groups; `descriptions.generated.ts` was regenerated (all new fields are vendor-described except the
rating units, whose empty vendor text leaves our own note) and the frozen extraction fixture was
re-captured for this deliberate field-set change.
