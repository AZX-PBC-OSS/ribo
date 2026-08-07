# 17 — Snugg Pro field reconciliation (against the real spec)

**Status:** Research findings, no code changed. Field-by-field reconciliation of our 34-leaf
`snuggValuesSchema` (`packages/ribo-adapter-snuggpro/src/schema.ts`) against Snugg Pro's real
machine-readable spec — not the printed field sheet doc 12 was built from.

**Source:** `https://app.snuggpro.com/apidocs/swagger.json` — Swagger 2.0, **public and
unauthenticated**. `curl` returns HTTP 200 with no auth headers and no `security`/
`securityDefinitions` anywhere in the document. This matters: doc 12 and doc 15 both recorded this
spec as **login-gated**, because the earlier attempt fetched `https://app.snuggpro.com/apidocs/` —
the Swagger UI's HTML page — rather than the JSON spec URL itself. The UI is behind app auth; the
spec it renders is not. See the amended redaction note on
[15 — Snugg Pro API, verified](15-snuggpro-api-verified.md) for the policy consequence of that
correction. Every quote below is copy-pasted from the parsed JSON, not paraphrased.

---

## What this changes about our behaviour

**~25 of our 27 enumerated leaves are snake_case (`well_sealed`, `not_tested`) where the API expects
exact human-readable strings** (`"6% - Well sealed"`, `"Not Tested"`) — Title Case, spaces, slashes,
parentheses, quote marks, percent signs. Because the transform is consistent (our token is always a
snake_cased, de-punctuated version of the spec's exact string), **this is one normalization/lookup
problem, not 25 separate per-field fixes** — a per-enum `Record<OurToken, SpecString>` map covers
almost all of it. The exception: **five fields where enum _membership_ also diverges**
(`heatingEquipmentType`/`coolingEquipmentType`'s fusion, `ductInsulation`, `windowGlazing`,
`dhwFuel`, plus the two missing health tests) — a pure string map can't fix a missing member, so
those need either a richer enum or an explicit `other`/fallback policy, decided per field.

Three further findings that change behaviour, not just vocabulary:

- **`combustionVentType` has no write target at all.** The combustion-appliance-zone resource
  (`caz`) is **GET-only** in the spec — no create/update verb exists for it, and no vent-type field
  or value list appears anywhere else in the document either.
- **Custom fields are real**, carry their own `key`/`valueType`/`min`/`max`/`options` metadata, and
  are attached to every writable component's response — not a hypothetical extension point.
- **`POST /jobs/{jobId}/basedata`'s parameters are all independently optional** — there is no
  wrapper request-body schema. Our patch write model (send only accepted/changed leaves, omit
  rejected ones) maps directly onto the transport: build a request containing only the keys you
  want to change, omit the rest. **No read-modify-write is required** for `basedata`.

---

## 1. Inventory

- `swagger: "2.0"`, `info.title: "Snugg Pro API"`, `info.version: "1.0.0"`, `basePath:
"https://api.snuggpro.com/"`.
- **91 paths, 61 definitions.** Document-level `consumes`/`produces` is `application/json`, but
  every write operation's parameters are declared `"in": "formData"` — a form-encoded submission,
  not a JSON body validated against a `definitions` schema.
- **Zero `patch` operations anywhere in the document** — confirmed by scanning every path's
  operation keys. Verbs used: `get`, `post`, `put`, `delete`.
- Write verbs for the job/audit-data surface:
  - `PUT /jobs/{jobId}` (`updateJob`) — job-level metadata (`serviceTime`, `accountId`,
    `companyId`, `note`, `householdIncomeTier`). **Not** the audit-data endpoint.
  - `GET`/`POST /jobs/{jobId}/basedata` (`updateBasedata`) — the house-level audit-data write
    endpoint, **294 formData parameters**, one per house-level field.
  - Per-system-type child resources, each with its own create (`POST` to the job-scoped
    collection) and update/delete (`POST`/`DELETE` to the item's own uuid path): `attic`,
    `clothesDryer`, `concern`, `dhw`, `door`, `freezer`, `hvac`, `pv`, `range`, `recommendation`,
    `refrigerator`, `vault`, `wall`, `window`. E.g. `POST /jobs/{jobId}/hvac` creates; `POST
/jobs/hvac/{uuid}` / `DELETE /jobs/hvac/{uuid}` update/remove an existing instance. **No
    `PUT`/`PATCH` variant exists for any of these** — update is a `POST` to the item's own uuid.
  - `POST /jobs/{jobId}/health` — the health & safety matrix.
  - `caz` (combustion appliance zone) is **GET-only** — `GET /jobs/{jobId}/caz`, no write verb at
    all.

---

## 2. Field-by-field table (our 34 leaves vs. the spec)

Legend: **match** = same concept, comparable value space. **match (format)** = same concept, token
format differs. **partial** = concept exists but enum membership differs materially. **not found**
= no corresponding property anywhere in the document.

| #     | Our field                                                                                                                                                                     | Our type/enum                                                                                                                      | Spec property (endpoint)                                                                                                                                                                                                                                                                              | Spec type/enum (verbatim)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verdict                                                                                                                                                                                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `heatingEquipmentType`                                                                                                                                                        | enum: `boiler, furnace_central_ac, central_heat_pump, electric_resistance, direct_heater, stove_or_insert, other`                  | `hvacSystemEquipmentType` (`POST /jobs/{jobId}/hvac`, **required**)                                                                                                                                                                                                                                   | `["Boiler", "Steam Boiler", "Furnace with standalone ducts", "Electric Resistance", "Direct Heater", "Stove or Insert", "Solar Thermal", "Central AC with standalone ducts", "Room AC", "Evaporative Cooler - Direct", "Evaporative Cooler - Ducted", "Ductless Heat Pump", "Central Heat Pump (shared ducts)", "Deep Loop Ground Source Heat Pump (shared ducts)", "Open Loop Ground Source Heat Pump (shared ducts)", "Shallow Loop Ground Source Heat Pump (shared ducts)", "Furnace / Central AC (shared ducts)"]` | **mismatch (structural)** — one field shared by heating and cooling equipment (see row 7), `required: true`, and 17 members vs. our 7 (adds Steam Boiler, Solar Thermal, Ductless Heat Pump, 3 ground-source variants, and splits standalone-duct furnace from shared-duct furnace) |
| 2     | `heatingFuel`                                                                                                                                                                 | enum: `electricity, natural_gas, propane, fuel_oil, pellets, wood, solar, other`                                                   | `hvacHeatingEnergySource` (`hvac`)                                                                                                                                                                                                                                                                    | `enum: []` — empty; description: "This is the primary fuel source. It is used to set prices and energy content."                                                                                                                                                                                                                                                                                                                                                                                                       | exists, but **not a static enum** in the spec (see §3)                                                                                                                                                                                                                              |
| 3     | `heatingManufacturer`                                                                                                                                                         | `z.string()`                                                                                                                       | `hvacHeatingSystemManufacturer` (`hvac`)                                                                                                                                                                                                                                                              | `["Unknown", "AirEase", "Amana", "American Standard", "Bosch", "Bryant", "Carrier", "Coleman", "Comfort Master", "Daikin", "Day & Night", "Fujitsu", "General Electric", "Goodman", "Janitrol", "Lennox", "LG", "Luxaire", "Mitsubishi", "Navien", "New Yorker", "Payne", "Panasonic", "Peerless", "Rheem", "RUUD", "Samsung", "Sears Kenmore", "Tappan", "Trane", "Triangle Tube", "Utica", "York", "Other"]`                                                                                                         | **mismatch (type)** — spec constrains this to a closed enum; ours is free text                                                                                                                                                                                                      |
| 4     | `heatingModelNumber`                                                                                                                                                          | `z.string()`                                                                                                                       | `hvacHeatingSystemModel` (`hvac`)                                                                                                                                                                                                                                                                     | `type: "string"`, free text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | match                                                                                                                                                                                                                                                                               |
| 5     | `heatingModelYear`                                                                                                                                                            | `z.number()`                                                                                                                       | `hvacHeatingSystemModelYear` (`hvac`)                                                                                                                                                                                                                                                                 | `type: "string"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **mismatch (type)** — spec is a string, ours numeric (stringify at write time)                                                                                                                                                                                                      |
| 6     | `heatingOutputCapacityBtuh`                                                                                                                                                   | `z.number()`                                                                                                                       | `hvacHeatingCapacity` (`hvac`)                                                                                                                                                                                                                                                                        | `type: "integer"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | match                                                                                                                                                                                                                                                                               |
| 7     | `coolingEquipmentType`                                                                                                                                                        | enum: `central_ac_standalone_ducts, room_ac, central_heat_pump, evaporative_cooler_direct, evaporative_cooler_ducted, none, other` | **same field as row 1**, `hvacSystemEquipmentType`                                                                                                                                                                                                                                                    | (see row 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **mismatch (structural)** — no separate cooling field; heating and cooling equipment type are the _same_ field on the _same_ per-system record                                                                                                                                      |
| 8     | `ductLocation`                                                                                                                                                                | enum: `attic_unconditioned, basement_unconditioned, crawlspace_unconditioned, other`                                               | `hvacDuctLocation` (`hvac`)                                                                                                                                                                                                                                                                           | `enum: []` — empty; description: "Select the location of the duct work for this system."                                                                                                                                                                                                                                                                                                                                                                                                                               | exists, but **not a static enum**                                                                                                                                                                                                                                                   |
| 9     | `ductSealing`                                                                                                                                                                 | enum: `very_leaky, somewhat_leaky, well_sealed, very_tight, other`                                                                 | `hvacDuctLeakage` (`hvac`)                                                                                                                                                                                                                                                                            | `["30% - Very leaky", "15% - Somewhat leaky", "6% - Well sealed", "3% - Very tight", "Measured (CFM25)"]`                                                                                                                                                                                                                                                                                                                                                                                                              | match (format) — spec adds a `"Measured (CFM25)"` member we don't have                                                                                                                                                                                                              |
| 10    | `ductInsulation`                                                                                                                                                              | enum: `none, duct_board_1_5in, fiberglass_1_25in, fiberglass_2in, fiberglass_2_5in, other`                                         | `hvacDuctInsulation` (`hvac`)                                                                                                                                                                                                                                                                         | `["No Insulation", "Duct Board 1\"", "Duct Board 1.5\"", "Duct Board 2\"", "Fiberglass 1.25\"", "Fiberglass 2\"", "Fiberglass 2.5\"", "Reflective bubble wrap", "Measured (R Value)"]`                                                                                                                                                                                                                                                                                                                                 | **partial** — spec has 9 members (adds `Duct Board 1"`, `Duct Board 2"`, `Reflective bubble wrap`, `Measured (R Value)`) vs. our 6                                                                                                                                                  |
| 11    | `ductLeakageCfm25`                                                                                                                                                            | `z.number()`                                                                                                                       | `hvacDuctLeakageValue` (`hvac`)                                                                                                                                                                                                                                                                       | `type: "number"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | match                                                                                                                                                                                                                                                                               |
| 12    | `atticInsulationDepthIn`                                                                                                                                                      | enum: `0, 1-3, 4-6, 7-9, 10-12, 13-15, 16+`                                                                                        | `atticInsulationDepth` (`POST /jobs/{jobId}/attic`)                                                                                                                                                                                                                                                   | `["0", "1-3", "4-6", "7-9", "10-12", "13-15", "16+", "Don't Know"]`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **match, verbatim** (spec adds `"Don't Know"`) — one of two fields where our token already equals the spec string                                                                                                                                                                   |
| 13    | `atticInsulationType`                                                                                                                                                         | enum: `cellulose, spray_foam, fiberglass, none, other`                                                                             | `atticInsulationType` (`attic`)                                                                                                                                                                                                                                                                       | `["Fiberglass or Rockwool (batts or blown)", "Cellulose", "Spray Foam", "Don't Know"]`                                                                                                                                                                                                                                                                                                                                                                                                                                 | match (format) — spec merges fiberglass/rockwool into one member, no explicit "None"                                                                                                                                                                                                |
| 14    | `atticInsulationSpokenRValue`                                                                                                                                                 | `z.number()`, documented in our schema as "NOT a Snugg write target"                                                               | `atticInsulation` (`attic`)                                                                                                                                                                                                                                                                           | `type: "number"`; description: "Enter the total R-value of insulation installed (BASE) or to be installed (IMPROVED) in this Attic..."                                                                                                                                                                                                                                                                                                                                                                                 | **overturned** — this field IS a real, direct write target, confirming doc 15's correction over doc 12                                                                                                                                                                              |
| 15    | `wallInsulated`                                                                                                                                                               | enum (documented 3-state): `yes, poorly, no, other`                                                                                | `wallsInsulated` (`POST /jobs/{jobId}/wall`)                                                                                                                                                                                                                                                          | `["Well", "Poorly", "Yes", "No"]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **mismatch** — spec is actually 4-state (`Well` distinct from generic `Yes`); we're missing the `Well` member and our "3-state, not boolean" framing is one state short                                                                                                             |
| 16    | `wallConstruction`                                                                                                                                                            | enum: `concrete_block, full_brick, frame_2x6, log, straw_bale, other`                                                              | `wallExteriorWallConstruction` (`wall`)                                                                                                                                                                                                                                                               | `enum: []` — empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | exists, but **not a static enum**                                                                                                                                                                                                                                                   |
| 17    | `blowerDoorCfm50`                                                                                                                                                             | `z.number()`                                                                                                                       | `blowerDoorReading` (`basedata`)                                                                                                                                                                                                                                                                      | `type: "number"`; description confirms "...pressure difference between the building and ambient of 50 Pascals..."                                                                                                                                                                                                                                                                                                                                                                                                      | match (unit confirmed CFM@50Pa)                                                                                                                                                                                                                                                     |
| 18    | `windowGlazing`                                                                                                                                                               | enum: `single_pane, double_pane, other`                                                                                            | `windowType` (`POST /jobs/{jobId}/window`)                                                                                                                                                                                                                                                            | `["Single pane", "Single pane + storm", "Double pane", "Double pane + low e", "Triple pane + low e", "Don't Know"]`                                                                                                                                                                                                                                                                                                                                                                                                    | **partial/mismatch** — spec has a triple-pane option, contradicting doc 12's "form has no triple-pane box"; also missing storm/low-e variants                                                                                                                                       |
| 19    | `windowFrame`                                                                                                                                                                 | enum: `metal, vinyl, wood_or_metal_clad, other`                                                                                    | `windowFrame` (`window`)                                                                                                                                                                                                                                                                              | `["Metal", "Vinyl", "Wood or metal clad", "Don't Know"]`                                                                                                                                                                                                                                                                                                                                                                                                                                                               | match (format)                                                                                                                                                                                                                                                                      |
| 20    | `dhwFuel`                                                                                                                                                                     | enum: `electricity, natural_gas, fuel_oil, propane, solar, other`                                                                  | `dhwFuel2` (`POST /jobs/{jobId}/dhw`)                                                                                                                                                                                                                                                                 | `["Electricity", "Natural Gas", "Fuel Oil", "Propane", "Pellets", "Wood", "Solar", "None"]`                                                                                                                                                                                                                                                                                                                                                                                                                            | **partial** — we're missing `Pellets`/`Wood`, which our own `heatingFuel` enum _does_ include (an internal inconsistency worth fixing alongside)                                                                                                                                    |
| 21    | `dhwSystemType`                                                                                                                                                               | enum: `storage, instantaneous, heat_pump_water_heater, space_heating_boiler_with_tank, other`                                      | `dhwType2` (`dhw`)                                                                                                                                                                                                                                                                                    | `["Tank Water Heater", "Tankless Water Heater", "Heat Pump", "Sidearm Tank"]`                                                                                                                                                                                                                                                                                                                                                                                                                                          | match (format), loosely — our `space_heating_boiler_with_tank` ("indirect" framing) vs. the spec's plain `"Sidearm Tank"`                                                                                                                                                           |
| 22    | `dhwAgeBand`                                                                                                                                                                  | enum: `0-5, 6-10, ..., 36+`                                                                                                        | `dhwAge` (`dhw`)                                                                                                                                                                                                                                                                                      | `["0-5", "6-10", "11-15", "16-20", "21-25", "26-30", "31-35", "36+"]`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **match, verbatim** — the second field where our token already equals the spec string                                                                                                                                                                                               |
| 23    | `combustionVentType`                                                                                                                                                          | enum: `induced_draft, power_vented_at_unit, power_vented_at_exterior, direct_vented, other`                                        | —                                                                                                                                                                                                                                                                                                     | Searched the entire document text for `"Induced Draft"`, `"Power Vented"`, `"Direct Vented"`, `"ventSystemType"` — **zero matches**; `caz` (`/jobs/{jobId}/caz`) is **GET-only**, no write verb at all                                                                                                                                                                                                                                                                                                                 | **not found**                                                                                                                                                                                                                                                                       |
| 24–34 | `healthSafety.{ambientCo, venting, naturalConditionSpillage, worstCaseDepressurization, worstCaseSpillage, draftPressure, gasLeak, moldMoisture, asbestos, lead, electrical}` | `HealthTestState`: `passed, failed, warning, not_tested`                                                                           | `healthAmbientCarbonMonoxide`, `healthVenting`, `healthNaturalConditionSpillage`, `healthWorstCaseDepressurization`, `healthWorstCaseSpillage`, `healthDraftPressure`, `healthGasLeak`, `healthMoldMoisture`, `healthAsbestos`, `healthLead`, `healthElectrical` (all on `POST /jobs/{jobId}/health`) | Each: `["Passed", "Failed", "Warning", "Not Tested"]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | match (format), all 11                                                                                                                                                                                                                                                              |

**Located:** 33 of 34 leaves have some corresponding named property in the spec (exact match,
format match, partial match, or a named-but-empty/dynamic enum). **Not found:** 1
(`combustionVentType`).

### Bonus finding not in our 34 leaves: the health matrix is 13 tests, not 11

`POST /jobs/{jobId}/health` has **13** fields on the `Passed/Failed/Warning/Not Tested` enum, not 11. Missing entirely: `healthUndilutedFlueCo` and `healthRadon` (both
`["Passed", "Failed", "Warning", "Not Tested"]`). This independently confirms doc 15's own
superseding note over doc 12 — the spec bears it out directly. The same endpoint also carries three
more health-related fields on _different_ (non-4-state) enums we don't capture at all:
`healthRoofCondition` / `healthDrainageSystemCondition`: `["Good", "Potential Issues", "NA"]`, and
`healthSafetyQuestionsDisclosed`: `["Yes", "No"]`.

---

## 3. Enum-format verdict

Of our 34 leaves, 27 are enum-typed (16 top-level enums + `HealthTestState` reused across the
11-test health matrix). Of those 27:

- **2 already match the spec's literal strings** — `atticInsulationDepthIn` and `dhwAgeBand`. These
  happen to already be spec-format because the underlying vocabulary is numeric bands, not English
  words — there's no "Title Case" version of `"10-12"`.
- **The other ~25 are format-mismatched**: our snake_case tokens (`furnace_central_ac`,
  `wood_or_metal_clad`, `not_tested`, `well_sealed`) versus the spec's human-readable strings, which
  consistently use Title Case, spaces, slashes, parentheses, quote marks (inches), and percent signs
  (`"Furnace / Central AC (shared ducts)"`, `"Duct Board 1.5\""`, `"30% - Very leaky"`,
  `"Not Tested"`).
- 1 field (`combustionVentType`) has no spec counterpart to compare against at all.

Roughly **25 of 34 fields (~74%)** carry a systematic token-format mismatch — essentially all
enum-typed leaves except the two numeric-band fields. Because the mismatch is a consistent
transform (our token is always a snake_cased, de-punctuated version of the spec's exact string —
`well_sealed` ↔ `"6% - Well sealed"`, `direct_vented` ↔ would-be `"Direct Vented"`), **this reads as
one normalization/lookup layer (a per-enum `Record<OurToken, SpecString>` map), not 25 separate
per-field problems.** The harder cases are where _membership_ also differs (rows 1, 7, 10, 18, 20
above — the fused heating/cooling equipment field, duct insulation, window glazing, DHW fuel — plus
the missing health tests), which a pure string-format map cannot fix; those need either a richer
enum or an explicit "unsupported, fall back to `other`" policy.

---

## 4. Custom fields — confirmed present, and they matter

The spec has a dedicated `customField` definition:

```json
{
  "type": "object",
  "description": "Job custom fields array if present",
  "properties": {
    "key": {
      "type": "string",
      "example": "unique_custom_field_key",
      "description": "Unique custom field key"
    },
    "valueAsString": {
      "type": "string",
      "example": "10.67",
      "description": "Value is always represented as string"
    },
    "valueType": {
      "type": "string",
      "example": "decimal",
      "description": "Type of value. Can be: string, integer, decimal or datetime"
    },
    "description": {
      "type": "string",
      "example": "Approximate custom value",
      "description": "Custom field description"
    },
    "min": { "type": "number", "example": 0.05, "description": "Minimum value" },
    "max": { "type": "number", "example": 49, "description": "Maximum value" },
    "options": {
      "type": "string",
      "example": "string 1, string 2, string3",
      "description": "List of possible options if available. For example: 'Before 1980, 1980-2010, 2011-Present'"
    }
  }
}
```

`customFields: { type: "array", items: { "$ref": "#/definitions/customField" } }` is attached to the
response schema of `job`, `basedata`, `hvac`, and `attic` (checked directly; very likely all
per-system resources given the parallel structure). The write side confirms it's genuinely dynamic —
`POST /jobs/{jobId}/basedata`'s `customFields` parameter has no `enum`, no fixed shape, just: "It
accepts array of objects with key and value as strings, e.g. `[ { "key": "custom_field_key",
"value": "12.4" } ]`."

The `options` property (`"Before 1980, 1980-2010, 2011-Present"`) shows custom fields can themselves
be enum-like and **account-defined** — a per-company/per-program admin can add a field with its own
label, type, min/max, and option list, none of which is knowable from a static spec fetch. This is
independent evidence (distinct from the empty `enum: []` fields in §2, which are fixed Snugg-defined
fields whose value lists just aren't published) that Snugg Pro's writable surface is **not fully
closed at build time**.

**Bearing on codegen vs. runtime schema:** a real argument for generating (or augmenting) the
extraction schema per-account at runtime rather than purely at build time — a given company/program
may have custom fields no static, checked-in schema can enumerate. It doesn't invalidate a static
schema for the fixed/native field set (rows 1–34 above are all named, stable properties in this spec
even where the value list isn't published); it specifically argues for a supplementary, per-account
custom-field layer on top of a static base.

---

## 5. Auth and the write body

**Auth:** the spec declares none. `securityDefinitions` is absent, there's no top-level `security`
array, no operation declares per-operation `security`, and no parameter anywhere in any of the 91
paths is `"in": "header"`. A full-text search for `hmac`, `x-api-key`, `authorization`, `apikey`,
`bearer`, `oauth` (case-insensitive) returned zero matches. The only auth-adjacent content is one
link in `info.description`: "Read this article for authentication information," pointing at
`https://snuggpro.com/help/article/using-the-snugg-pro-api`. This is consistent with (does not
contradict, but also does not confirm) doc 12's claim of an out-of-band HMAC-SHA256 scheme — the
spec simply says nothing about it either way; that lives entirely outside this artifact.

**Partial vs. whole-document replace, for `POST /jobs/{jobId}/basedata`:** this looks like a genuine
partial update, not a whole-document replace, on direct evidence:

- Every one of its 294 `formData` parameters is declared `"required": false`. There's no wrapper
  request-body schema at all — Swagger 2.0 `formData` parameters are independent, individually
  optional fields, not a single JSON object validated against `#/definitions/basedata` as a whole.
  (`#/definitions/basedata` — same 294 properties — is only referenced as the **response** schema
  for the `GET`, confirming the two are read/write mirrors of the same field set, not a
  request-body-must-match-full-shape contract.)
- The one example given for a related array parameter is explicitly partial-shaped: a single
  key/value pair, not a full-array replace.
- Nothing in any write endpoint's description says "all fields must be present" or "this replaces
  the entire record"; the per-field descriptions ("Enter the year..." / "Select the location...")
  read as edits to individual attributes of an existing home/system record.

This supports mapping our patch write model onto the transport directly: build a request containing
only the keys you want to change and omit the rest — **no read-modify-write required** for
`basedata`. The same reasoning applies to `hvac`/`attic`/`wall`/`window`/`dhw`/`health` (all-optional
formData parameters, same shape as `basedata`), **except** those are per-instance child resources
(each system/attic/wall/window/DHW unit is its own record with its own uuid), so a "patch" there is
scoped to a specific existing instance's uuid path (`POST /jobs/hvac/{uuid}`) — no ambiguity about
replace-vs-merge for the fields you send, but there **is** a first-write problem: creating a
brand-new instance (`POST /jobs/{jobId}/hvac`, no uuid yet) requires the caller to already
know/generate that instance's identity for any subsequent partial update, which the current
adapter's flat field set (one `heatingEquipmentType`, etc.) doesn't model at all — see row 1/7's
note on the fused, per-system nature of the real `hvac` resource.

---

## Summary

- **Enum-format verdict:** confirmed and systematic — ~25 of 34 fields (all enum-typed leaves except
  the two numeric-band fields) use snake_case tokens where the spec expects exact human-readable
  strings. One normalization layer (a per-enum lookup table), not 25 separate fixes — except where
  enum _membership_ also differs (heating/cooling equipment fusion, duct insulation, window
  glazing, DHW fuel, the missing health tests), which needs richer enums or an explicit fallback
  policy.
- **Custom fields:** confirmed present (`key`/`valueAsString`/`valueType`/`min`/`max`/`options`,
  attached to `job`/`basedata`/`hvac`/`attic` responses, freeform on write). A real argument for
  generating/augmenting the extraction schema per account at runtime, on top of a static schema for
  the fixed field set.
- **Partial write:** confirmed — `POST /jobs/{jobId}/basedata` (and the equivalent per-instance
  endpoints) take independently-optional `formData` fields, not a full-object replace; our patch
  model maps directly onto "send only the changed keys."
- **Field location count:** 33 of our 34 leaves found a named counterpart in the spec (exact,
  format-mismatched, partial-membership, or dynamic/empty-enum); 1 not found (`combustionVentType`
  — no CAZ vent-type field or values anywhere in the document, and `caz` has no write verb at all).
- **Notable structural findings beyond the ask:** `heatingEquipmentType` and `coolingEquipmentType`
  are the _same_ `hvacSystemEquipmentType` field on a per-HVAC-system record that can itself
  represent a combined heating+cooling unit; the health matrix is 13 tests, not 11; attic R-value
  (`atticInsulation`) is a genuine direct write target, contradicting our schema's comment that it
  "is NOT a Snugg write target"; and the spec's auth surface is entirely undocumented within the
  Swagger file itself.

---

## Open question carried forward: pinning a spec snapshot for R1.7

R1.7 (`docs/roadmap/index.md`) plans a `pnpm snugg:refresh` script generating wire field names and
leaf types from this spec into a committed `*.generated.ts`. That needs a copy of `swagger.json` to
generate from. **Whether to commit a pinned snapshot of the spec, or commit only its hash/version
and fetch fresh at refresh time, is R1.7's design decision, not this document's** — flagging it here
because this reconciliation pass is what first pulled the spec down locally (~1.2 MB) and it isn't
committed to this repo. Do not commit the spec file as part of this documentation change.

---

## Sources

- **Snugg Pro OpenAPI (Swagger 2.0) specification** — `https://app.snuggpro.com/apidocs/swagger.json`,
  public and unauthenticated, retrieved directly (not from a summarized fetch). Primary source for
  every field/verdict above.
- [12 — Snugg Pro data model & write API](12-snuggpro-data-model.md) — the printed-field-sheet-derived
  model this reconciliation checks against.
- [15 — Snugg Pro API, verified](15-snuggpro-api-verified.md) — the prior architectural-conclusions
  pass, whose redaction policy this document's existence supersedes (see that document's amended
  note).
- [16 — Extraction schema scale](16-extraction-schema-scale.md) — the OpenAI-limits feasibility
  analysis that uses this document's field set as its baseline.

---

## Scoping: why the pilot captures a subset, and what the subset is a subset _of_

Added 2026-08-06. The pilot's bounded field set has always been a deliberate choice, but the
justification used to be "the printed field sheet covers this much". Now that the machine-readable
spec is available, the arithmetic is better and the exclusions can be defended individually.

`POST /jobs/{jobId}/basedata` takes **294** form fields. That is not the capture surface:

|                                |   count | why it is or is not captured                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Total `basedata` fields        |     294 |                                                                                                                                                                                                                                                                                                                                                                                                        |
| `*Improved` variants           |    −122 | The schema is **doubled**: every field has a BASE and an IMPROVED form — "the total R-value of insulation installed (BASE) or to be installed (IMPROVED)". 114 of the 122 pair 1:1 with a base field. An auditor walking a house dictates what is _there_; the IMPROVED column is the proposed retrofit, decided later at a desk. Excluded because it is a different activity, not because it is hard. |
| Self-described auto-calculated |      −9 | Their own descriptions say "This field will be automatically calculated based on the data you entered in the input form." Writing these would be **wrong**, not merely unnecessary.                                                                                                                                                                                                                    |
| **Capture surface**            | **163** | What an auditor could plausibly dictate.                                                                                                                                                                                                                                                                                                                                                               |

So the honest target for full coverage is **163**, not 294 — about 5× today's 34 leaves rather than 9×.
At roughly 489 properties once enveloped, that sits well inside the limits doc 16 establishes; the open
question at that size is extraction _quality_ and output cost, not feasibility.

**The fields group hard by name prefix**, which is nesting waiting to happen and also happens to match
how an auditor moves through a house: `basement*` (35), `ashrae*` (25), `pool*` (18), `floor*` (17),
`clothes*` (16), `ventilation*` (16), `dishwasher*` (14), `crawl*`/`crawlspace*` (22), `ev*` (12).

**281 of the 294 carry descriptions** written for whoever fills the form in ("Select the type of
materials used, if any, on the basement walls of this home"). That is prompt-ready starting prose for
extraction instructions — a real head start, though not a substitute for the domain judgment that has
no counterpart in the spec (the fuel axis-split, the banding rules, the hazard notes).

### The decision, and how to revisit it

**The pilot stays a bounded subset for now.** The 163-field surface is a known, justified target rather
than an unknown, and nothing here argues the current 34 are the _right_ 34 — only that the gap is
smaller and better understood than "294 fields, we do 34".

**Revisit with real fill-rate data, not judgement.** The right way to choose the next tranche is to look
at what auditors actually fill in across real jobs, rather than reasoning about what sounds dictatable.
Roughly 60 fields sit in `pool*`, `ev*`, `dishwasher*` and `clothes*` — appliance specifics that may be
spec-sheet data rather than speech, but that is a hypothesis, not a finding. Two cheap sources: the
14-transcript spike corpus says what auditors _say_, and the API says what real jobs actually _contain_.
"

### Correction (2026-08-06, from the repo owner): auditors narrate recommendations

Two domain corrections that supersede parts of this document and of doc 15, recorded because they came
from someone who knows what auditors actually say, and neither is derivable from the spec.

**1. `hvacUpgradeAction` is extractable — doc 15's B2 is wrong.** Doc 15 ranks it blocking and
recommends a **write-layer constant**, on the reasoning that an upgrade action is a retrofit decision
rather than a walkthrough observation. That reasoning treats an auditor as a pure observer. An energy
auditor's _job_ is recommending retrofits, and they narrate them: _"there's an oil boiler here, we
should get rid of it"_ carries `"Remove a system permanently"` as plainly as it carries `Boiler`. So
this is a real extraction field, not a constant.

**2. Writes are mostly creates, not updates.** So the required-on-create parameters are the common path
rather than a first-time edge case.

**Consequence for the §Scoping table above.** The `*Improved` exclusion (−122) was justified as "the
proposed retrofit, decided later at a desk". That is too broad. The finer cut is that **upgrade
_intent_ is dictated while improved _specs_ are not** — an auditor says the boiler should go, not the
AFUE of the boiler that replaces it. The 163-field capture surface is therefore a floor, not a ceiling,
and the `*Improved` block needs re-examining field by field rather than being excluded wholesale.

### The required-field surface is small, and worth surfacing to the auditor

Requiredness is declared in the spec, so it is generator territory rather than something to
hand-maintain. Across every component create endpoint:

| endpoint                                                                         |                               required (excl. `jobId`) |  of |
| -------------------------------------------------------------------------------- | -----------------------------------------------------: | --: |
| `/jobs/{jobId}/hvac`                                                             | **2** — `hvacSystemEquipmentType`, `hvacUpgradeAction` |  73 |
| `/jobs/{jobId}/stage`                                                            |                  1 — `stageId` (workflow, not capture) |   2 |
| `/jobs/{jobId}/incentives`                                                       |                  1 — `fromTemplateUuid` (template ref) |   3 |
| `/jobs/{jobId}/recommendation`                                                   |             2 — `recDefinitionId`, `status` (workflow) |  10 |
| `basedata`, `attic`, `dhw`, `wall`, `window`, `health`, `report`, `utilities`, … |                                                  **0** |   — |

**HVAC is the only component with required _capture_ fields**, and it needs exactly the two an auditor
would say. Everything else is optional on create, which is why a partial dictation writes cleanly.

**Product direction:** surface requiredness in review. The generator can emit a `required` flag per
leaf, `ReviewField` can carry it, and the review card can mark those leaves and refuse a submit that
leaves one empty — turning a write that would fail at the API into a prompt the auditor can answer
while they are still standing in the basement. It fires on two fields today and scales for free.
