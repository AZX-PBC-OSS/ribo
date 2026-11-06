# The Snugg Pro Data Model

Snugg Pro is the field-service system of record one of Ribo's adapters writes into, and it's the
measured example throughout this section — [Schema at Scale: Measured](/deep-dives/schema-scale) and
[Provenance: Measured](/deep-dives/provenance-measurement) both walk its real API. This page is
about a different question: not how big the schema is, but what actually goes wrong mapping spoken
auditor language onto it. The gap between what an auditor says and what Snugg Pro stores is
structural, not cosmetic. An extraction schema has to model it explicitly, or the LLM will bridge
the mismatches silently and wrong.

## The paper form undersold the real capture model

The adapter's field set was first grounded against Snugg Pro's own printed field sheet — the paper
form auditors fill in before keying into the app. Reading the sheet gave a reasonable first model,
but it was wrong in a specific, informative way: **the field sheet is a paper intake form; the API is
the model, and the model accepts strictly more than the paper does.**

Two corrections made after checking the sheet's account against Snugg Pro's own public,
machine-readable API spec:

- **Equipment efficiency is a real, writable field, not a derived lookup.** The field sheet has no
  AFUE/HSPF/SEER box, which reads naturally as "efficiency is looked up from make and model, not
  typed." The API disagrees: heating efficiency (AFUE or HSPF), cooling efficiency (SEER or EER), and
  a separate steady-state combustion-analyzer efficiency reading are all writable numbers, each
  paired with its own unit field so the model never has to infer AFUE vs. HSPF from the number
  alone. An extractor built strictly off the field sheet would have been instructed to discard every
  efficiency figure an auditor actually states.
- **Attic R-value has a direct write target of its own.** The field sheet only exposes an insulation
  _depth band in inches_ (`0`, `1-3`, `4-6`, … `16+`), which reads as "auditors say R-value, Snugg
  stores inches, and the two must be converted." The API instead accepts **both**: a depth-band field
  and a separate numeric R-value field. An auditor's stated R-value is written as stated, not
  flattened into an inches band.

Both corrections came from reading Snugg Pro's own OpenAPI spec directly rather than trusting the
paper form's account of itself, and both are reflected in the adapter's current schema
(`hvacHeatingSystemEfficiency`, `hvacCoolingSystemEfficiency`, `hvacSteadyStateEfficiency`, and
`atticInsulation` alongside `atticInsulationDepth`).

## Fuel is a separate axis from equipment type

Snugg Pro's HVAC record has one field for what kind of equipment it is (`hvacSystemEquipmentType`:
`Boiler`, `Furnace / Central AC (shared ducts)`, `Central Heat Pump (shared ducts)`, …) and a wholly
separate field for what it burns (`hvacHeatingEnergySource`: `Electricity`, `Natural Gas`, `Propane`,
`Fuel Oil`, `Pellets`, `Wood`, `Solar`). An auditor says "the oil boiler," and the schema has to
decompose that single utterance into `{ equipmentType: "Boiler", fuel: "Fuel Oil" }` — never one
fused token. A schema with a single `HeatingSystemType`-style enum can only pick one axis and
silently drop the other; this is the highest-value normalization rule in the adapter, and
it's a rule the LLM has to be told, not one it will infer from the field names.

One further wrinkle, found only by reading the spec rather than the field sheet: heating and
cooling equipment type are **the same field** on one HVAC-system record, because a single record can
represent a combined heating-and-cooling unit. A schema with independent `heatingEquipmentType` and
`coolingEquipmentType` slots invents a distinction the API doesn't draw.

## The health-and-safety matrix is 13 tests, not 11

Snugg Pro's health-and-safety block is a fixed matrix of named tests, each on a four-state enum
(`Passed`, `Failed`, `Warning`, `Not Tested`) — not free text, so a single `safetyIssue` string can't
hold it. Reading the field sheet's printed list gives 11 tests. Reading the API directly turns up
**13**: the sheet's list is missing an undiluted-flue-CO test and a radon test. The API also
carries three more health-related fields on non-four-state enums the sheet doesn't
surface — a roof-condition and a drainage-system-condition field on a `Good` / `Potential
Issues` / `NA` scale, and a yes/no "were safety questions disclosed" flag. All 13 four-state tests are
in the adapter's current schema; a "clean" utterance ("CO was clean," "no spillage") has to set
`Passed`, and must never be dropped as though nothing was said.

## The current wire-field count

Walking every write operation in Snugg Pro's spec gives **837 distinct writable wire fields** — 293
of them on the single `basedata` endpoint that captures most of a house-audit walkthrough, and **544
more spread across roughly two dozen other write endpoints** (HVAC systems, attic, walls, windows,
ducts, water heater, appliances, and more). Why that whole surface can't be handed to a model as one
schema is [Schema at Scale: Measured](/deep-dives/schema-scale)'s argument. The point here is
simpler: the writable surface is large, and the adapter's job is to choose a defensible, bounded
slice of it. See [`SnuggValues`](/reference/@azx/ribo-adapter-snuggpro#snuggvalues) for
the slice the adapter currently commits to.

## Other normalization hazards worth naming

- **Enum labels no auditor says verbatim.** Snugg Pro's stored enum strings are things like
  `"Furnace / Central AC (shared ducts)"` or `"Duct Board 1.5\""` — nobody says that out loud. An
  auditor says "shared-duct heat pump" or "duct board" and the model has to land on the exact stored
  string; this is pure normalization work the schema's enum list doesn't do by itself.
- **A three-state field where speech implies a boolean.** Wall insulation is `Poorly` / `Yes` / `No`.
  "The walls have some insulation, but it's thin" is `Poorly`, not `Yes` — a distinction an auditor
  states loosely and a boolean field would erase entirely.
- **Banded ages and settings.** Water-heater age and temperature settings are buckets, not numbers
  (`0-5`, `6-10`, … years; `Low (120-130°F)`, …). "About twelve years old" lands in `11-15`; an
  auditor stating a boundary value ("exactly fifteen years") is a predictable off-by-one-bucket risk.
- **Loose, ambiguous units.** "CFM fifty of eleven hundred," "eleven ACH," "duct blaster read
  one-fifty" — CFM50, ACH50 and CFM25 are three distinct fields, and auditors rarely state which
  pressure reference they mean.

## What this doesn't settle

This page is about the shape of the data model and where spoken language and stored schema diverge —
not about how many of Snugg Pro's fields the adapter should eventually cover, and not about
extraction accuracy against this schema, which is [Extraction: Measured](/deep-dives/accuracy)'s
subject; it currently publishes no number. Snugg Pro's spec drifts, too: it has changed before and
will again, and a figure repeated here is only as current as its last reconciliation against the
real spec.
