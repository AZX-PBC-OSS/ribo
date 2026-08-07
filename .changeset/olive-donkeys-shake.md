---
"@azx/ribo-adapter-snuggpro": minor
---

The Snugg Pro field set is now built from the machine-readable spec, not a printed field sheet.

**Breaking, and comprehensively so:** every key and every enum member in `snuggValuesSchema` changed.
The keys are Snugg Pro's wire property names (`hvacSystemEquipmentType`, not `heatingEquipmentType`);
the enum members are the spec's literal strings, punctuation intact (`"6% - Well sealed"`,
`"Furnace / Central AC (shared ducts)"`, `"Not Tested"`, `'Duct Board 1.5"'`); and the shape nests by
write endpoint — `basedata`, `hvac`, `attic`, `wall`, `window`, `dhw`, `health` — because Snugg Pro has
no single audit-data write, only a singleton plus per-instance component resources. Review addresses
the result as dotted leaf paths (`"health.healthGasLeak"`), which the R1.5 review contract already
supported. 51 leaves, up from 34.

Storing the wire values deletes a layer rather than deferring it: ~25 of 27 enumerated leaves used to
be a snake_cased de-punctuation of the spec string, which meant a per-enum lookup table between review
and write, plus richer enums where membership also diverged. There is now nothing between this schema
and the API.

Five things the spec overturned outright:

- **Attic R-value is a real write target** (`attic.atticInsulation`). The old schema held it was not,
  and parked spoken R-values in an `atticInsulationSpokenRValue` holding pen awaiting a climate- and
  material-dependent conversion to a depth band. Both fields exist; nothing converts; the holding pen
  and the conversion problem are gone.
- **Heating and cooling equipment are one field**, on a per-system record that can represent a combined
  unit — hence members like `"Furnace / Central AC (shared ducts)"`. `coolingEquipmentType` is removed.
- **The health matrix is 13 tests, not 11.** `healthUndilutedFlueCo` and `healthRadon` were missing
  outright; undiluted flue CO is a meter reading auditors say out loud, so its absence dropped real
  dictation. `healthRoofCondition` joins on its own 3-state enum.
- **`hvacUpgradeAction` is extracted, not hard-coded.** It is the second of the API's only two required
  capture fields. Doc 15 recommended a write-layer constant on the reasoning that retrofit decisions
  are made at a desk; auditors narrate them ("there's an oil boiler here, we should get rid of it"), and
  a constant would have written a decision nobody made. `requiredOnCreate` is now both HVAC leaves, as
  dotted paths.
- **`combustionVentType` is dropped.** The `caz` resource is GET-only and no vent-type field exists
  anywhere in the spec — it had no write target at all.

Manufacturer fields are closed enums rather than free text, which is why the few-shot example maps
"Burnham" to `"Other"` with the span preserving what was said: the old `z.string()` would have accepted
it and failed at write.

`normalizeFields` now recurses structurally instead of destructuring known keys, so it survived the
reshape untouched. Its enum-to-wire-token responsibility is deleted, not moved.

**Not shipped, and stated rather than implied:** the schema is 51 leaves of a ~163-field capture
surface, and models one instance per component where the API models many. And the extraction-quality
baselines (≈0.5% hard hallucination, 75/75 enums) were measured against the previous vocabulary — they
do not describe this adapter. The acceptance gate now fails fast with that explanation rather than
scoring the new schema against old annotations and reporting every field as a miss; unblocking it means
re-annotating the 14-transcript corpus. The frozen JSON Schema fixture was re-captured for the same
reason, which is the one case its own instructions permit.
