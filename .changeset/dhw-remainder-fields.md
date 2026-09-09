---
"@azx/ribo-adapter-snuggpro": minor
---

The `dhw` group gains its full verdicted remainder (doc 20 §5.4, job-collections tranche 9). Base
side: every field verdicted `capture`/`capture?` — the temperature-setting band
(`DhwTemperatureSettings`) and its numeric twin `dhwTemp`, the nameplate model/serial/year block
(`dhwModelYear` as `z.number()`, the year-as-string divergence the hvac model-year fields already
record), the percent-of-load share (DHW shares across systems must total 100), the ENERGY STAR
label, the rated INPUT capacity in BTU/hr (input, unlike hvac's output capacities), the tank/pipe
wrap flags and their R-values, the maintenance star rating as `z.enum(["1", "2", "3"])` (the spec's
enum is `[null, "1", "2", "3"]` — a literal null plus numeric STRINGS, so the null is the leaf's
`.nullable()` and the strings stay strings, the same wire shape as the hvac star ratings),
`dhwSidearmBoiler` as free text (a cross-resource reference to an hvac instance whose `enum: []`
value list is unpublished — the spoken reference is captured verbatim and resolution against the
job's hvac list is a later human-supervised step, the `fromTemplateUuid` pattern),
`dhwSidearmStandbyLoss` as stated-only (its vendor description is a copy-paste error and its units
are unpublished), and the efficiency family: `dhwEnergyFactorType` (`EF`/`UEF`), the
no-decimal-encoded `dhwEnergyFactor`/`dhwUnifiedEnergyFactor` (0.56 on the wire as 56), stated-only
`dhwRecoveryEfficiency`, and `hesDhwEnergyFactor` as a decimal — the one efficiency field the vendor
says to read off the EnergyGuide label in the field. Improved side: only the intent-bearing
`capture?` fields — proposed type, fuel, tank size, capacity, load share, ENERGY STAR class,
temperature setback, and the wrap measures — including `dhwPipeWrapLengthImproved` and
`dhwPipeWrapPercentageImproved`, which are improved-ONLY with no base twins (the pair-census
asymmetry runs both directions: the base-side age, location, temperature setting, wrap R-values,
condition rating and HES factor have no improved twins). The remaining improved fields are desk-side
purchase specs of unbought equipment and stay excluded. `descriptions.generated.ts` was regenerated
(the key-level diff is exactly the new leaves) and the frozen extraction fixture was re-captured for
this deliberate field-set change — its diff is confined to the dhw group's properties and required
list. The dhw group now exceeds the per-call leaf cap and partitions into pieces like the other
large groups.
