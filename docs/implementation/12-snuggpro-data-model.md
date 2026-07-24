# 12 — Snugg Pro Data Model & Write API (grounding the adapter schema)

> **⚠️ Superseded in part by [15 — Snugg Pro API, verified (architectural conclusions)](15-snuggpro-api-verified.md).**
> Snugg Pro's machine-readable OpenAPI spec (a proprietary vendor artifact, **not** committed to this
> repo — see the private integration notes) resolves **every `[unknown]` below** — the API key names,
> the serialized enum tokens, and the write endpoints. **Where 12 and 15 disagree, 15 wins.** In
> particular 15 **overturns** three conclusions on this page: efficiency
> **is** writable (§3 rows 5/7/22 and the "no AFUE slot" reasoning), attic R-value **does** have a
> direct write target (`atticInsulation`, §3 row 12's framing), and the health matrix has **13**
> tests, not 11 (§4 row 24). This document is left unedited as the dated research record of what was
> knowable from the printed field sheet alone, and of how the field sheet and the API differ.

**Status:** Research findings, for review. Replaces the earlier invented field schema and the
placeholder `write()` in
[05](05-adapter-snuggpro.md) with the closest defensible approximation of the **real** Snugg Pro
capture model.

The point of this document is the **evidence tag on every claim**. Building an extractor against an
invented schema is cheap to do and expensive to discover was wrong. So each field, enum, unit and
endpoint below is marked, and the marks are load-bearing:

- **[verified — Snugg Pro]** — printed on Snugg Pro's own field sheet or stated in their own KB /
  API docs. Trustworthy as _what the tool captures_.
- **[domain-derived]** — not confirmed in a Snugg Pro source; taken from the energy-audit field
  generally (HPXML data dictionary, BPI-2400, DOE Home Energy Score). Realistic, but a stand-in.
- **[unknown]** — nobody here has it. Chiefly: the exact **API JSON key names and serialized enum
  tokens**, which live behind an authenticated Swagger UI we could not read.

**Primary source for the capture model:** the Snugg Pro **Energy Audit Field Sheet, Version 5.0**
(document dated `04/2017`), published by Snugg Pro at
`https://snuggpro.com/images/uploads/SnuggPro-Field-Sheet.pdf` — the paper form auditors fill in
before keying into the app. Its labels, checkbox groups and dropdown options are Snugg Pro's own
controlled vocabulary. Retrieved and text-extracted 2026-07-23. (A "Condensed — Version 5.5" exists
at the same path stem.)

---

## The one thing to take away

**"Just pass the schema" is materially wrong, and the field sheet proves it four ways.** The gap
between what an auditor _says_ and what Snugg Pro _stores_ is not a formatting nicety a JSON Schema
absorbs — it is a set of structural mismatches the schema cannot express and the LLM cannot be
trusted to bridge on its own:

1. **Fuel is a separate axis, not part of the system name.** Snugg Pro has a `System Equipment Type`
   field (`Boiler`, `Furnace / Central AC`, …) **and a distinct `Heating Energy Source` field**
   (`Electricity / Natural Gas / Propane / Fuel Oil / Pellets / Wood / Solar`). The earlier spike
   worry — collapsing "oil boiler" and "gas boiler" to "boiler" loses fuel — is **confirmed against
   the primary source**: the correct model is _two_ fields, `equipmentType = Boiler` + `fuel = Fuel
Oil`. Our current `HeatingSystemType` enum (`gas_furnace`, `oil_furnace`, …) fuses the two axes
   and is wrong in both directions. **[verified — Snugg Pro]**
2. **Attic insulation is captured as a _depth band in inches_ + a material, not an R-value.** The
   sheet's `Attic Insulation depth (in)` options are `0 / 1-3 / 4-6 / 7-9 / 10-12 / 13-15 / 16+`.
   Auditors _say_ "R-38"; Snugg Pro _stores_ a depth bucket. Our `atticInsulationRValue: number` has
   no home to write to. **[verified — Snugg Pro]**
3. **The field sheet captures no AFUE / HSPF / SEER input.** Per system it records `Manufacturer`,
   `Model #`, `Model Year`, `Output Capacity (BTU/h)` and `Total Load %` — efficiency is _derived_
   (equipment lookup / program default), not typed. Our `heatingSystemAfue: number` assumes a field
   that may not exist as a direct write target. **[verified — Snugg Pro]** (that AFUE is absent from
   the sheet); **[unknown]** (whether the API accepts a written efficiency).
4. **Health & safety is a fixed 4-state test matrix, not free text.** ~11 named tests, each
   `Passed / Failed / Warning / Not Tested`. Our single free-text `safetyIssue` collapses a
   structured matrix. **[verified — Snugg Pro]**

The real work is the **normalization layer** — spoken form → Snugg enum / band / axis-split — and it
is exactly what a schema-only approach skips. This is the stress test the pilot needs.

---

## 1. Write API — shape, auth, and a correction to [05]

| Item                | Finding                                                                                                                                                                                                             | Tag                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Base URL            | `https://api.snuggpro.com`                                                                                                                                                                                          | **[verified — Snugg Pro]**                                        |
| Full API docs       | `https://app.snuggpro.com/apidocs/` — Swagger UI behind app login; the SPA served no schema to an unauthenticated fetch                                                                                             | **[verified]** it exists / **[unknown]** contents                 |
| Auth scheme         | An **HMAC-SHA256 signed scheme** (AWS-style; per-request signature over a timestamped request). Exact header names, signing-string construction, and key-provisioning steps are in the private integration notes    | **[verified — Snugg Pro]**                                        |
| Trade-ally endpoint | A `direct-installs` endpoint lets trade allies "programmatically access the data"                                                                                                                                   | **[verified — Snugg Pro]** mentioned / **[unknown]** path & verbs |
| Export formats      | Assessment data exports to **CSV** and **HPXML**                                                                                                                                                                    | **[verified — Snugg Pro]**                                        |
| Webhooks            | Supported (separate KB article)                                                                                                                                                                                     | **[verified — Snugg Pro]**                                        |
| Assessment CRUD     | An assessment **create / update / PATCH** endpoint — the thing `write()` targets — is **not confirmed**. The `PATCH /assessments/{jobId}` in [05] remains a placeholder; no source shows that path or its JSON body | **[unknown]**                                                     |
| Public vs gated     | Docs are gated behind app auth; keys are self-serve for company/program admins. Treat as **partner/customer-gated, not open**                                                                                       | **[verified]** gated / **[domain-derived]** "partner" framing     |

**Correction for [05] and [06] — the auth recipe as written will not work.** [05]'s build-time
action assumes Snugg Pro takes a simple `X-Api-Key` "injected server-side by egress," and notes the
fetch-proxy _drops_ `authorization`. But Snugg Pro's real auth is a **signed HMAC-SHA256 scheme**
that uses an `Authorization` header (on the proxy's drop-list) **plus a non-safelisted timestamp
header**, with a **per-request signature computed from a private key** — not a static key. So the
egress layer must **sign each request server-side** (hold the private key, compute the timestamp +
`Authorization` per call), not inject a constant header. This is a concrete change to the [06] Helix
egress design, and it should be confirmed against a real key before the adapter's `write()` is built.
The exact signing-string construction lives in the private integration notes.
**[verified — Snugg Pro]** (the scheme) / **[unknown]** (exact per-endpoint signing string).

---

## 2. The fuel dimension (spike question #3, answered)

**Snugg Pro models fuel as its own field.** On the field sheet, each `HVAC System N` block has:

- `System Equipment Type` — **[verified — Snugg Pro]** enum:
  `Boiler` · `Furnace / Central AC (shared ducts)` · `Central Heat Pump (shared ducts)` ·
  `Electric Resistance` · `Direct Heater` · `Stove or Insert` · `Central AC with standalone ducts` ·
  `Room AC` · `Evaporative Cooler - Direct` · `Evaporative Cooler - Ducted` · `Solar Thermal`
- `Heating Energy Source` — **[verified — Snugg Pro]** enum:
  `Electricity` · `Natural Gas` · `Propane` · `Fuel Oil` · `Pellets` · `Wood` · `Solar`

HPXML independently models it the same way — `FuelType` is a separate element
(`natural gas / propane / fuel oil / coal / wood / wood pellets` …) from `HeatingSystemType`
(`Furnace / Boiler / WallFurnace / Stove / …`). **[domain-derived]** — corroborating, not primary.

**Schema consequence:** replace the fused `HeatingSystemType` enum with **two** fields,
`heatingEquipmentType` + `heatingFuel`, and let the extractor fill each independently. "Oil boiler"
must land as `{ equipmentType: "boiler", fuel: "fuel_oil" }`.

---

## 3. Concrete buildable field spec (the bounded pilot set)

Names in **Our field** are the proposed zod keys (each wrapped in the `{value, confidence,
sourceSpan}` provenance envelope, nullable+required, per [05]). **Snugg source** is the field-sheet
label. **Enum / values** are verbatim from the field sheet where tagged verified.

| #   | Our field                | Snugg source (field sheet)             | Type   | Unit          | Enum / values                                                                                                                                                                                                                                 | Tag                                                          |
| --- | ------------------------ | -------------------------------------- | ------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `heatingEquipmentType`   | HVAC System N › System Equipment Type  | enum   | —             | `Boiler` · `Furnace / Central AC (shared ducts)` · `Central Heat Pump (shared ducts)` · `Electric Resistance` · `Direct Heater` · `Stove or Insert`                                                                                           | **[verified — Snugg Pro]**                                   |
| 2   | `heatingFuel`            | HVAC System N › Heating Energy Source  | enum   | —             | `Electricity` · `Natural Gas` · `Propane` · `Fuel Oil` · `Pellets` · `Wood` · `Solar`                                                                                                                                                         | **[verified — Snugg Pro]**                                   |
| 3   | `heatingOutputCapacity`  | HVAC System N › Output Capacity        | number | BTU/h         | free numeric                                                                                                                                                                                                                                  | **[verified — Snugg Pro]**                                   |
| 4   | `heatingModelYear`       | HVAC System N › Model Year             | number | year          | free numeric                                                                                                                                                                                                                                  | **[verified — Snugg Pro]**                                   |
| 5   | `heatingAfue`            | _(not on field sheet — derived)_       | number | % (AFUE)      | 0–100; **absent from the paper form** — efficiency is looked up / defaulted, so this may not be a writable field                                                                                                                              | **[domain-derived]** + **[unknown]** writability             |
| 6   | `coolingEquipmentType`   | HVAC System N › System Equipment Type  | enum   | —             | `Central AC with standalone ducts` · `Room AC` · `Central Heat Pump (shared ducts)` · `Evaporative Cooler - Direct` · `Evaporative Cooler - Ducted`                                                                                           | **[verified — Snugg Pro]**                                   |
| 7   | `coolingSeer`            | _(not on field sheet — derived)_       | number | SEER / SEER2  | free numeric; same derivation caveat as AFUE                                                                                                                                                                                                  | **[domain-derived]** + **[unknown]**                         |
| 8   | `ductLocation`           | System N Duct Work › Duct Location     | enum   | —             | `Attic (unconditioned)` · `Basement (unconditioned)` · `Crawlspace (unconditioned)`                                                                                                                                                           | **[verified — Snugg Pro]**                                   |
| 9   | `ductSealing`            | System N Duct Work › Duct Sealing      | enum   | (labelled %)  | `30% - Very leaky` · `15% - Somewhat leaky` · `6% - Well sealed` · `3% - Very tight`                                                                                                                                                          | **[verified — Snugg Pro]**                                   |
| 10  | `ductInsulation`         | System N Duct Work › Duct Insulation   | enum   | —             | `None` · `Duct board 1.5"` · `Fiberglass 1.25"` · `Fiberglass 2"` · `Fiberglass 2.5"`                                                                                                                                                         | **[verified — Snugg Pro]**                                   |
| 11  | `ductLeakageCfm25`       | System N Duct Work › Duct Leakage      | number | CFM @ 25 Pa   | free numeric                                                                                                                                                                                                                                  | **[verified — Snugg Pro]**                                   |
| 12  | `atticInsulationDepthIn` | Attic / Vault › Attic Insulation depth | enum   | inches (band) | `0` · `1-3` · `4-6` · `7-9` · `10-12` · `13-15` · `16+`                                                                                                                                                                                       | **[verified — Snugg Pro]**                                   |
| 13  | `atticInsulationType`    | Attic / Vault › Attic Insulation type  | enum   | —             | `Cellulose` · `Spray foam` · (`Fiberglass` present on form but not cleanly extracted → confirm)                                                                                                                                               | **[verified — Snugg Pro]** (partial)                         |
| 14  | `wallInsulated`          | Exterior Walls › Wall N Insulated?     | enum   | —             | `Poorly` · `Yes` · `No` — a **3-state**, not a boolean                                                                                                                                                                                        | **[verified — Snugg Pro]**                                   |
| 15  | `wallConstruction`       | Exterior Walls › Wall N Construction   | enum   | —             | `Concrete Block` · `Full Brick` · `2x6 Frame` · `Log` · `Straw Bale`                                                                                                                                                                          | **[verified — Snugg Pro]**                                   |
| 16  | `blowerDoorResult`       | Air Leakage › Blower Door Test         | number | CFM50 (app)   | value + mode `Tested` / `Estimate`; sheet leaves the unit blank, Snugg app models CFM50                                                                                                                                                       | **[verified — Snugg Pro]** field / **[domain-derived]** unit |
| 17  | `windowGlazing`          | Windows › Type                         | enum   | —             | `Single pane` · `Double pane` (form has no triple-pane box)                                                                                                                                                                                   | **[verified — Snugg Pro]**                                   |
| 18  | `windowFrame`            | Windows › Frame                        | enum   | —             | `Metal` · `Vinyl` · `Wood or metal clad`                                                                                                                                                                                                      | **[verified — Snugg Pro]**                                   |
| 19  | `dhwFuel`                | Hot Water (DHW) › Fuel Type            | enum   | —             | `Electricity` · `Natural Gas` · `Fuel Oil` · `Propane` · `Solar`                                                                                                                                                                              | **[verified — Snugg Pro]**                                   |
| 20  | `dhwSystemType`          | Hot Water (DHW) › System Type          | enum   | —             | options not legible in extraction; HPXML analogues: `storage water heater` · `instantaneous water heater` · `heat pump water heater` · `space-heating boiler w/ tank`                                                                         | **[unknown]** (Snugg) / **[domain-derived]** (values)        |
| 21  | `dhwAgeBand`             | Hot Water (DHW) › Age                  | enum   | years (band)  | `0-5` · `6-10` · `11-15` · `16-20` · `21-25` · `26-30` · `31-35` · `36+`                                                                                                                                                                      | **[verified — Snugg Pro]**                                   |
| 22  | `dhwEnergyFactor`        | _(not on field sheet)_                 | number | EF / UEF      | e.g. 0.58; **absent from the paper form** (KB mentions EF/UEF entry in-app) — likely derived/in-app                                                                                                                                           | **[domain-derived]** + **[unknown]**                         |
| 23  | `combustionVentType`     | CAZ › Vent System Type                 | enum   | —             | `Induced Draft` · `Power Vented (at unit)` · `Power Vented (at exterior)` · `Direct Vented`                                                                                                                                                   | **[verified — Snugg Pro]**                                   |
| 24  | `coSpillageTest`         | Health & Safety Tests › (per test)     | enum   | —             | per named test: `Passed` · `Failed` · `Warning` · `Not Tested`. Tests: Ambient CO, Venting, Natural Condition Spillage, Worst Case Depressurization, Worst Case Spillage, Draft Pressure, Gas Leak, Mold & Moist., Asbestos, Lead, Electrical | **[verified — Snugg Pro]**                                   |

> Trim to ~15 for the pilot; the table is intentionally over-provided so the cut is a scoping
> decision, not a research gap. Rows 5, 7, 22 (efficiency values) and 20 (DHW type tokens) are the
> ones that still need a real API key against `apidocs/` to nail down.

---

## 4. Fields most likely to trip the LLM (the normalization hazards)

These are why the extractor needs `instructions` + few-shot `examples`, not just a schema:

- **Fuel axis-split.** "Oil-fired boiler," "gas pack," "the propane furnace" must decompose into
  `equipmentType` + `fuel`. A model handed one `HeatingSystemType` enum will pick `oil_furnace` and
  silently drop that a boiler ≠ a furnace. **The single highest-value normalization rule.**
- **R-value → depth band.** Auditors speak R-values ("R-38 in the attic"); Snugg stores inches
  (`10-12`). The mapping is climate/material-dependent and _lossy in both directions_ — do **not**
  let the LLM invent the conversion; capture what was said (R-value _or_ inches) and convert in a
  reviewed deterministic table, or store the spoken R-value in a note and flag for the auditor.
- **Efficiency that isn't a capture field.** "Ninety-two percent furnace" is a real utterance with
  **no direct Snugg write target** (AFUE is derived). Extracting it into `heatingAfue` produces a
  value the API may reject or ignore. Capture it, but treat it as advisory until writability is
  confirmed.
- **Banded ages and temperatures.** DHW `Age` and `Settings` are buckets (`0-5`, `Low (120-130°F)`).
  "About twelve years old" → `11-15`; "set around 125" → `Low`. Off-by-one-bucket at boundaries
  ("exactly 15 years") is a predictable error.
- **3-state where speech implies boolean.** `Wall Insulated?` is `Poorly / Yes / No`. "The walls
  have some insulation but it's thin" is `Poorly`, not `Yes` — a distinction an auditor states
  loosely and a boolean schema erases.
- **Enum labels no auditor says verbatim.** `Furnace / Central AC (shared ducts)`,
  `Central Heat Pump (shared ducts)`, `Wood or metal clad`, `Induced Draft`. The spoken form
  ("shared duct heat pump," "clad windows," "it's a power-vented water heater") never matches the
  stored string; this is pure normalization, and the enum is invisible to the speaker.
- **Loose units.** "CFM fifty of eleven hundred" vs "eleven ACH" vs "duct blaster read one-fifty" —
  CFM50, ACH50 and CFM25 are three different fields and the auditor rarely says which Pa reference.
- **Test results as denials.** "CO was clean," "no spillage," "backdraft test came back fine" map to
  `Passed`, not to a null or a safety _issue_. The made-up single `safetyIssue` string can't hold an
  11-test matrix, and a "clean" utterance must set `Passed`, not be dropped.

---

## Size & next action

- **Size:** **S** to turn rows 1–4, 8–19, 21, 23–24 into a real zod schema + adapter
  `instructions`/`examples` now — those are verified. The blocked part is the **write path** (row-5/7/22
  writability and the assessment-update endpoint), which needs a real API key against
  `https://app.snuggpro.com/apidocs/`.
- **Open item carried to [05]/[06]:** the HMAC signing (an `Authorization` header + a timestamp
  header, per the private integration notes) must move server-side in the Helix egress; the "inject a
  static `X-Api-Key`" recipe does not match Snugg Pro's actual scheme.

---

## Sources

- **Snugg Pro Energy Audit Field Sheet, Version 5.0** (form dated `04/2017`) — primary capture-model
  source: `https://snuggpro.com/images/uploads/SnuggPro-Field-Sheet.pdf` (retrieved 2026-07-23).
  Condensed v5.5 at `https://snuggpro.com/images/uploads/SnuggPro-Field-Sheet-Condensed.pdf`.
- **Snugg Pro KB — API Access** (base URL, HMAC auth, key provisioning, direct-installs, HPXML/CSV
  export): `https://support.snuggpro.com/en/articles/8285282-api-access` and
  `https://snuggpro.com/help/article/using-the-snugg-pro-api` (retrieved 2026-07-23).
- **Snugg Pro API docs (Swagger)** — `https://app.snuggpro.com/apidocs/` (login-gated; contents not
  retrievable unauthenticated, 2026-07-23).
- **HPXML Data Dictionary (NREL)** — fuel-as-separate-dimension, water-heater types, AFUE/SEER/HSPF
  units: `https://hpxml.nrel.gov/datadictionary/` and OpenStudio-HPXML workflow inputs
  `https://openstudio-hpxml.readthedocs.io/en/v1.8.1/workflow_inputs.html` (retrieved 2026-07-23).
  [domain-derived] backstop only.
