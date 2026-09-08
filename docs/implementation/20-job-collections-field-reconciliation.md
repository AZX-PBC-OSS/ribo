# 20 — Snugg Pro job collections: field reconciliation beyond `basedata`

**Status:** Research findings, no code changed. `schema.ts` and every extraction path are untouched.

This is the companion to [17 — Snugg Pro field reconciliation](17-snuggpro-field-reconciliation.md).
Doc 17 reconciled our schema against **one** endpoint — `POST /jobs/{jobId}/basedata`, 293 form
fields, of which ~163 are the honest capture surface. This document does the same job for
**everything else**: the 544 distinct writable wire names spread across the other 25 write
operations — job metadata, utilities, the report, the per-instance component collections
(`hvac`, `dhw`, `attic`, `wall`, `window`, `door`, `vault`, `clothesDryer`, `freezer`, `range`,
`refrigerator`, `pv`), the proposal side (`recommendation`, line items, direct installs,
`incentives`, `concern`), and the workflow verbs (`stage`, `tickets`).

**Source:** `https://app.snuggpro.com/apidocs/swagger.json` — Swagger 2.0, public and
unauthenticated, fetched directly and parsed, not summarized. Every field name, type and enum
member below is copy-pasted from the parsed JSON. This matters here more than it did in doc 17:
the vendor's descriptions are hand-maintained and demonstrably wrong in a dozen places (§4.7), so
a list built from anything but the machine-readable spec would inherit those errors and add its
own.

**Curation stance: broad.** Doc 17's `basedata` cut was narrow — 294 fields down to 51, then a
163-field "honest capture" target. This pass deliberately goes the other way. A field is
**`capture`** if a contractor might plausibly say it aloud on a job; **`capture?`** if it is
borderline and is included with a flag saying why; **`exclude`** only for things clearly never
spoken — internal ids and uuids, timestamps, self-described auto-calculated values, and system
metadata. When in doubt the field is included and flagged, not silently dropped. A fourth verdict,
**`lookup`**, appears only in the proposal domain (§5.7): a value that must be resolved against a
per-program catalog rather than extracted.

---

## 1. What this changes

Seven findings that change design, not just vocabulary. Each is developed in §4.

1. **The BASE/IMPROVED doubling is the whole surface's rule, not `basedata`'s quirk.** 248 of the
   837 distinct writable names carry an `Improved` suffix; **126 of them are outside `basedata`**.
   Doc 17 excluded all 122 `basedata` twins wholesale and its own owner correction later called
   that too broad. Outside `basedata` the wholesale cut is clearly wrong: `hvacUpgradeAction`'s
   member `"Install a new non-existing system"` puts the _entire_ new system on the improved side,
   and `windowAreaNorthImproved` is how the vendor encodes _which windows get replaced_. Improved
   fields are where retrofit intent lives, and intent is dictated.

2. **Almost nothing has a human-facing instance label.** Of the twelve repeating component
   resources, exactly **three** offer a name field — `hvacSystemName`, `freezerName`,
   `refrigeratorName`. Nine do not: `attic`, `wall`, `window`, `door`, `vault`, `dhw`,
   `clothesDryer`, `range`, `pv`. "The back attic over the garage" and "the west-facing bedroom
   windows" have nowhere on the wire to land. R1.6's instance modeling assumed a matching problem;
   the spec says it is mostly an _identity-does-not-exist_ problem.

3. **A new problem class: template references.** `POST /jobs/{jobId}/recommendation` requires
   `recDefinitionId`, an integer naming a row in a per-program catalog the auditor never says out
   loud. `POST /jobs/{jobId}/incentives` requires `fromTemplateUuid` likewise. Extraction can be
   perfect and the write still fails. Nothing in the current schema — which only ever writes
   literal values — has this shape.

4. **The proposal side nests two levels deep**, and the current model has exactly one.
   Recommendations own line items; direct installs own line items. Child writes are parented by a
   uuid that exists only after the parent create returns, so those writes are inherently
   sequenced. The incentive `recommendations[]` array reaches sideways into level 2, so it is a
   graph, not a tree.

5. **Four more `combustionVentType`-class dead ends, and one is an appliance.** `caz` was already
   known GET-only. Now also: **`oven`** (`ovenFuelType` has no write path anywhere, while all four
   sibling appliances do), **`checklist-answers`** (the only checklist write edits a _program's
   question set_, not a job's answers), the **direct-install header** (line items are writable, the
   container that owns them is not creatable), and **`job.auditStarted` / `job.auditEnded`**.

6. **`customFields` is malformed in the spec on 35 write endpoints** — the parameter has no `in`
   key at all, so a strict Swagger validator rejects it and a code generator will drop it silently.
   It is simultaneously the most widely available extension point in the API and the least
   reliably described. Doc 17 §4 argued custom fields are a real reason to generate schema per
   account at runtime; this strengthens that, and adds that a `snugg:refresh` generator must
   special-case these 35 parameters or lose them.

7. **The per-group call decomposition R3 already uses scales to this whole surface, with exactly
   two exceptions.** Every one of the 23 write endpoints beyond `basedata` fits under the
   structured-output route's 32,768-character schema cap on its own. Only `utilities` (~64k) and
   `report` (~37k) do not, and both split cleanly along a seam the vendor's own naming already
   marks (§8).

---

## 2. Inventory, and the drift since doc 17

Counts measured directly from the parsed document:

|                                                | this pass (2026-09-08) |                             doc 17 / doc 16 |
| ---------------------------------------------- | ---------------------: | ------------------------------------------: |
| paths                                          |                 **92** |                                          91 |
| operations (`get`/`post`/`put`/`delete`)       |                **121** |                                         117 |
| definitions                                    |                 **63** |                                          61 |
| `patch` operations                             |                  **0** |                                           0 |
| distinct write operations carrying `formData`  |                 **42** |                                           — |
| total `formData` parameters over all write ops |              **1,169** |                                           — |
| distinct `formData` parameter _names_          |                **837** |                                           — |
| — on `basedata`                                |                    293 | 294 (doc 17 counted the `jobId` path param) |
| — **beyond `basedata`**                        |                **544** |                                           — |
| GET-only paths                                 |                     48 |                                           — |

**The spec has drifted since doc 16 walked it**: +1 path, +4 operations, +2 definitions. Doc 16's
headline `allJobData` figure of ~1,326 leaves was measured against the older snapshot and is not
re-derived here — this document measures the **writable** surface, which is a different and
smaller set (`allJobData` includes every computed rollup in `totals`, every `*Saved*` figure, and
the whole read-only surface of §6). The drift is small but it is real, and it is the concrete
argument for R1.7 pinning a spec snapshot rather than fetching fresh at generation time.

Doc 17's structural claims all re-confirm on the current snapshot: zero `patch` operations; no
`securityDefinitions`, no top-level or per-operation `security`, and zero `in: header` parameters
anywhere; every field on every write endpoint `required: false` except the 18 listed in §4.6.

**One doc-17 claim is refuted.** Doc 17 §1 says "every write operation's parameters are declared
`in: formData`". Three exceptions:

- **37 parameters carry no `in` key at all** — 35 of them the `customFields` parameter (see §1.6),
  plus `templateUuid`/`name`/`category` on `POST /jobs/direct-installs/{directInstallUuid}/line-item`
  and `templateUuid`/`name` on `POST /jobs/recommendations/{recommendationUuid}/line-item`.
- **5 write operations take a JSON `body`**, not form fields: the three
  `/programs/{programId}/direct-install-line-item-templates` verbs (`templatesPayload`) and the two
  `/programs/{programId}/checklist` verbs (`checklistPayload`) — including two `DELETE`s with a body.
- **22 write operations carry no `formData` at all**, including all 16
  `DELETE /jobs/<resource>/{uuid}` operations, whose `parameters` array is literally empty (not even
  the `uuid`), and `PUT /jobs/{jobId}/utilities` (`updateUtilitiesLegacy`), which declares no
  parameters whatsoever yet returns the full 136-property `utilities` schema.

Path parameters are declared inconsistently: only **4** `path` parameters exist in the entire
document, despite 60+ templated paths — and `POST /jobs/{jobId}/stage` declares `jobId` as
`formData` while `PUT /jobs/{jobId}` declares the same variable as `path`.

---

## 3. The writable surface beyond `basedata`, at a glance

23 write endpoints (excluding the `/{uuid}` update twins, which mirror their creates), 544
distinct wire names. `covered` counts leaves already in `snuggValuesSchema`.

| endpoint                                            |  leaves | covered | `capture` | `capture?` | `exclude`/`lookup` | repeats per job?           |
| --------------------------------------------------- | ------: | ------: | --------: | ---------: | -----------------: | -------------------------- |
| `POST /jobs` + `PUT /jobs/{jobId}`                  |      37 |       0 |        27 |          7 |                  3 | singleton                  |
| `POST /jobs/{jobId}/stage`                          |       2 |       0 |         2 |          0 |                  0 | singleton (a transition)   |
| `PUT /jobs/{jobId}/tickets/{ticketId}`              |       2 |       0 |         2 |          0 |                  0 | **repeats**, update-only   |
| `POST /jobs/{jobId}/utilities`                      |      99 |       0 |        29 |         70 |                  0 | singleton                  |
| `POST /jobs/{jobId}/report`                         |      76 |       0 |         4 |         18 |                 54 | singleton                  |
| `POST /jobs/{jobId}/hvac`                           |      72 |      12 |        23 |         11 |                 26 | **repeats**                |
| `POST /jobs/{jobId}/dhw`                            |      47 |       6 |        13 |         18 |                 10 | **repeats** (capped at 2?) |
| `POST /jobs/{jobId}/attic`                          |      34 |       5 |        10 |         15 |                  4 | **repeats**                |
| `POST /jobs/{jobId}/window`                         |      33 |       3 |        21 |          8 |                  1 | **repeats**                |
| `POST /jobs/{jobId}/vault`                          |      22 |       0 |         9 |         11 |                  2 | **repeats**                |
| `POST /jobs/{jobId}/wall`                           |      16 |       4 |         4 |          6 |                  2 | **repeats**                |
| `POST /jobs/{jobId}/door`                           |       7 |       0 |         3 |          4 |                  0 | **repeats**                |
| `POST /jobs/{jobId}/refrigerator`                   |      14 |       0 |         6 |          3 |         5 improved | **repeats**                |
| `POST /jobs/{jobId}/clothesDryer`                   |      12 |       0 |         3 |          3 |         6 improved | **repeats**                |
| `POST /jobs/{jobId}/freezer`                        |      11 |       0 |         4 |          2 |         5 improved | **repeats**                |
| `POST /jobs/{jobId}/pv`                             |      11 |       0 |         3 |          3 |         5 improved | **repeats**                |
| `POST /jobs/{jobId}/range`                          |      10 |       0 |         3 |          2 |         5 improved | **repeats**                |
| `POST /jobs/{jobId}/health`                         |      16 |      14 |         2 |          0 |                  0 | singleton                  |
| `POST /jobs/direct-installs/{uuid}/line-item`       |      13 |       0 |         7 |          4 |                  2 | **repeats, level 2**       |
| `POST /jobs/{jobId}/recommendation`                 |       9 |       0 |         5 |          3 |                  1 | **repeats**                |
| `POST /jobs/recommendations/{uuid}/line-item`       |       7 |       0 |         4 |          1 |                  2 | **repeats, level 2**       |
| `POST /jobs/{jobId}/incentives`                     |       3 |       0 |         1 |          0 |                  2 | **repeats**                |
| `POST /jobs/{jobId}/concern`                        |       2 |       0 |         2 |          0 |                  0 | **repeats**                |
| _(update-twin-only fields:_ `name`_,_ `category`_)_ |       2 |       0 |         1 |          1 |                  0 | —                          |
| **total**                                           | **557** |  **44** |   **188** |    **190** |            **135** | 16 of 23 repeat            |

_(557 counts each operation's fields; 544 counts distinct names — `PUT /jobs/{jobId}`'s 5 fields and
`PUT .../incentives/{uuid}`'s 2 are all duplicates of their create's.)_

**The broad-stance candidate surface beyond `basedata` is 378 leaves** — 188 `capture` plus 190
`capture?`. Add `basedata`'s 163-field honest-capture target and full coverage of the writable job
surface is roughly **540 leaves**, against the 51 committed today.

---

## 4. Cross-cutting findings

### 4.1 The BASE/IMPROVED doubling, outside `basedata`

248 of 837 distinct names end in `Improved`; **126 of those sit outside `basedata`**. The pattern is
mechanical — a literal `…Improved` name suffix, with base and improved sharing a byte-identical
`description`, `type` and enum. `dhwType2`'s description states the convention: _"Enter the type of
water heater installed (BASE) or to be installed (IMPROVED)."_

Doc 17 excluded all 122 `basedata` twins on the grounds that the improved column "is the proposed
retrofit, decided later at a desk," and its own 2026-08-06 owner correction then called that too
broad, reframing the cut as **upgrade _intent_ is dictated while improved _specs_ are not**. Outside
`basedata` that refinement is load-bearing, and in two places it breaks down entirely:

- **`hvacUpgradeAction: "Install a new non-existing system"`** — the description says _"A brand new
  system that replaces the system that was removed when you chose: Remove a system permanently."_
  For such an instance the improved side is the **only** place the new system exists. Its type,
  fuel, capacity and share of load are exactly the dictated recommendation.
- **`windowAreaNorthImproved`** (and its E/S/W siblings) is _"the area of north windows actually
  being replaced"_ — the vendor encodes **which windows get replaced** as an improved-side area, not
  as a separate measure record. Dropping the improved side drops the retrofit scope.

Structural asymmetries worth knowing before modelling the doubling as a mechanical mirror:

- **`hvacSystemEquipmentType` has no improved twin.** A retrofit that changes equipment class is
  therefore _two hvac instances_, not one row with two sides.
- Condition/maintenance star ratings, `dhwAge`, `dhwLocation`, `dhwTemperatureSettings`,
  `hvacSystemName`, `freezerName`, `refrigeratorName`, `refrigeratorAge`, `refrigeratorSize` are
  base-only — you cannot rate the condition of a thing not yet installed.
- Two fields are **improved-only with no base twin**: `dhwPipeWrapLengthImproved` and
  `dhwPipeWrapPercentageImproved`. Pipe insulation is asymmetric in both directions.

### 4.2 Instance identity barely exists on the wire

| resource                                             | repeats                                     | human label on the wire                                                                                                                                 | practical discriminator                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `hvac`                                               | yes, open-ended                             | **`hvacSystemName`** — _"Give this system a name that you can use to easily differentiate it from the others like: Old Heat Pump or Basement Furnace."_ | name, equipment type, `hvacPercentOfTotalHeatingLoad`                                                                                      |
| `freezer`                                            | yes                                         | **`freezerName`** — free text, _no description at all_, no length cap                                                                                   | name only                                                                                                                                  |
| `refrigerator`                                       | yes                                         | **`refrigeratorName`** — `maxLength: 30`, description is a copy-paste of the Age/Size help text                                                         | name, plus a hard ordering rule (below)                                                                                                    |
| `dhw`                                                | yes, "**both** systems must add up to 100%" | **none**                                                                                                                                                | `dhwType2` + `dhwFuel2` + `dhwLocation` + `dhwPercentLoad`                                                                                 |
| `attic`, `vault`                                     | yes                                         | **none**                                                                                                                                                | `atticPercent` / `vaultPercent` — a share of footprint, not an identity                                                                    |
| `wall`                                               | yes                                         | **none**                                                                                                                                                | `wallSystemPercentOfTotal`, which must sum to 100% across systems                                                                          |
| `window`                                             | yes                                         | **none**                                                                                                                                                | orientation is baked in as a _field suffix_ (North/East/South/West), so "the west windows" is addressable as a field, never as an instance |
| `door`                                               | yes                                         | **none, and no count either**                                                                                                                           | `doorArea` is a single aggregate "for the home"                                                                                            |
| `clothesDryer`, `range`, `pv`                        | yes                                         | **none**                                                                                                                                                | fuel / manufacturer / model only                                                                                                           |
| `ticket`                                             | yes                                         | **none** — only `message` free text                                                                                                                     | must bind to a pre-existing `ticketId`                                                                                                     |
| `recommendation`, line items, `incentive`, `concern` | yes                                         | `title` / `description` / `name`                                                                                                                        | free text                                                                                                                                  |

Three consequences for
[R1.6 instance modeling](../roadmap/design/r1.6-instance-modeling-design.md):

1. **`hvacSystemName` is load-bearing, not decorative.** It is the only human-readable handle on an
   hvac instance, it is exactly what an auditor says out loud, _and_ it is the resolution target of
   `dhwSidearmBoiler` (_"Choose the boiler from the HVAC section that this indirect water heater tank
   is attached to"_) — a cross-resource reference whose enum the spec declares and then leaves empty.
2. **For the nine label-less resources, R1.6 §10.4's "the reviewer sees the candidate existing
   records beside the dictated instance and either picks one or creates a new record" has nothing to
   render.** Two anonymous attics differ only by a percentage. Any human-facing label has to live on
   Ribo's side and be mapped to a `uuid` — which the design already needs for other reasons, but the
   spec offers no help at all.
3. **`refrigerator` carries a hard ordering constraint** the design has no analogue for: _"For HPXML
   purposes, always enter the house's 'primary' refrigerator first."_ Instance _order_ is
   semantically significant on exactly one resource.

`hvacPercentOfTotalCoolingLoad` explicitly permits a total below 100% (the remainder is modelled as
unconditioned), while heating shares must total 100% — so a validator must not treat the two alike.

### 4.3 Template references — a problem class the current schema has no shape for

An auditor says _"there's an oil boiler here, we should get rid of it."_ That is a complete
recommendation in speech, and doc 17's owner correction established it as extractable. It is still
not a well-formed create: `POST /jobs/{jobId}/recommendation` **requires** `recDefinitionId`, an
integer naming one row of a per-program catalog. Extraction is correct and the write fails.

| field                       | operation                               | required | resolve against                                                                                                                                            |
| --------------------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recDefinitionId` (integer) | `POST /jobs/{jobId}/recommendation`     | **yes**  | **no listing endpoint exists.** None of the spec's three template-list endpoints lists recommendation definitions. Highest-risk open gap in this document. |
| `fromTemplateUuid` (string) | `POST /jobs/{jobId}/incentives`         | **yes**  | `GET /programs/{programId}/incentive-templates` — **program-scoped**, so it needs a job→program hop first                                                  |
| `code` (string)             | both line-item creates and both updates | no       | `GET /jobs/{jobId}/recommendation-line-item-templates` / `GET /jobs/{jobId}/direct-install-line-item-templates`                                            |
| `measureCode` (string)      | `POST /jobs/{jobId}/recommendation`     | no       | company-defined; no endpoint identified                                                                                                                    |

**Two tiers, needing different handling.** The hard FKs block the write outright, and resolution
must be able to **fail visibly** — a spoken measure matching nothing in the program's catalog has to
surface to the auditor for disambiguation rather than be guessed. The soft codes do not block:
notably, **the line-item creates take no template id at all** and are fully self-describing
(`description`, `costPerUnit`, `quantity`, `unit` are writable literals), so the template lists are a
_value source_ rather than an enforced FK. Line items can be written from speech alone with degraded
catalog linkage; the recommendation create cannot.

A third, different reference: `recommendations[]` on both incentive operations is an array of
`{uuid, selectedLineItems: [uuid]}` pointing at records **created earlier in the same write
sequence**. _"The fifteen-hundred rebate covers the attic and the boiler"_ is a spoken statement
about that join, and honouring it means holding a name→minted-uuid map across the sequence — a
sequencing concern, not a lookup one, and one R1.6 §10.5's per-instance idempotency work touches.

### 4.4 Two-level nesting on the proposal side

```
job
├── recommendation            (0..n)   ← recDefinitionId, status, title, cost, notes…
│   └── line item             (0..n)   ← code, description, costPerUnit, quantity, unit
├── directInstall             (0..n)   ← NO CREATE ENDPOINT
│   └── line item             (0..n)   ← code, costs, quantity, unit, fuelType, efficiency…
├── incentive                 (0..n)   ← fromTemplateUuid, amount, recommendations[]
└── concern                   (0..n)   ← flat; the only resource today's model absorbs unchanged
```

`snuggValuesSchema` models a flat array of instances per resource — one level. Child writes here are
parented by a uuid in the _path_ that exists only after the parent create returns, so the writes are
inherently **sequenced**, not a parallel fan-out. Getting the fields right but the grouping wrong
(line items attached to the wrong measure) produces a structurally valid, semantically wrong
estimate — a defect field-level review cannot see, which is the same failure shape R1.6 §10.4 argues
about for cross-record linking.

**Create-then-update is mandatory for some children.** `name` is update-only on recommendation line
items; `category` is update-only on direct-install line items. A fully specified child needs two
calls, which doubles the write count under a parent and makes partial-failure states real.

### 4.5 Enum vocabulary at scale

- **1,485 enum values across the writable surface** (440 on `basedata`, 1,045 beyond it) in 284
  enum-typed parameters. Doc 16's 1,000-value structured-output cap therefore binds on the
  beyond-`basedata` surface _alone_ if it were ever submitted as one schema.
- **`enum: false` is the vendor's "not an enum" marker**, present on 741 of the 1,169 parameters.
  Only **16 parameters on the deduped write surface declare `enum: []`** — a named dropdown whose
  member list Snugg does not publish. Doc 17 found 3 of them; the full list is `auditType`,
  `electricRatePlan`, `electricRatePlanImproved`, `fuelRatePlan`, `hvacHeatingEnergySource`,
  `hvacHeatingEnergySourceImproved`, `hvacDuctLocation`, `hvacDuctLocationImproved`,
  `hvacCoolingSystemEfficiencyRatingUnit(+Improved)`, `hvacHeatingSystemEfficiencyRatingUnit(+Improved)`,
  `dhwSidearmBoiler(+Improved)`, `wallExteriorWallConstruction`, `directInstallType`. Two of these
  (`hvacHeatingEnergySource`, `hvacDuctLocation`) are **already in `snuggValuesSchema`**, whose
  allowed values therefore came from somewhere other than this spec — doc 17 §2 row 2 says as much,
  and flags `hvacHeatingEnergySource` as the one enum in the file that is inferred rather than
  copied. Worth reconciling before the surface grows.
- **Nine parameters carry no `enum` key at all**, including `stageId` and ticket `status`, whose
  value lists exist **only in prose inside the description string**. `POST /jobs` documents 3 of the
  10 stage codes; `POST /jobs/{jobId}/stage` documents all 10. A generator reading `enum` alone
  produces two untyped integers.
- **`null` appears as a literal enum member** on `wallCavityInsulationType(+Improved)` and on all
  four maintenance star ratings. Doc 17's schema already handles the wall case by expressing it as
  the leaf's `.nullable()` rather than an enum member — a mixed-type `enum` array is rejected by
  strict structured-output mode — and the same treatment extends to the star ratings.
- **Brand vocabularies do not agree across resources and contain live typos.** `Frigidaire` **and**
  `Fridgidaire` are both members of `hvacCoolingSystemManufacturer`, `freezerManufacturer` and
  `refrigeratorManufacturer`; heating uses `Comfort Master` where cooling and DHW use
  `Comfort Maker`; `dhwManufacturer` lists `Takaji` (almost certainly Takagi); the freezer and
  refrigerator lists are different sets. A normaliser must map to these exact strings, typos
  included, and one shared brand vocabulary will not work.
- **Type declarations lie.** `energyStarColdClimateHeatPump(+Improved)`, `renterOwner` and
  `useStrictBpi2400Calibration` are `type: string` with JSON _integer_ members. `freezerModelYear`,
  `refrigeratorModelYear`, `pvModuleYear`, `dhwModelYear`, `hvacCoolingSystemModelYear` are
  `type: string` carrying numeric `min`/`max`/`precision: 0` — the same divergence doc 17 records
  for `yearBuilt` and `hvacHeatingSystemModelYear`, now at nine fields rather than two.

### 4.6 Requiredness

18 parameters are `required: true` on the deduped write surface. Doc 17's table listed the component
creates; this adds the job-level ones, which are the larger constraint:

| endpoint                               | required (excl. path params)                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /jobs`                           | **11** — `firstName`, `lastName`, `address1`, `city`, `state`, `zip`, `accountId`, `stageId`, `jobType`, `companyId`, `programId` |
| `POST /jobs/{jobId}/hvac`              | 2 — `hvacSystemEquipmentType`, `hvacUpgradeAction`                                                                                |
| `POST /jobs/{jobId}/recommendation`    | 2 — `recDefinitionId`, `status`                                                                                                   |
| `POST /jobs/{jobId}/stage`             | 1 — `stageId`                                                                                                                     |
| `PUT /jobs/{jobId}/tickets/{ticketId}` | 1 — `status`                                                                                                                      |
| `POST /jobs/{jobId}/incentives`        | 1 — `fromTemplateUuid`                                                                                                            |
| everything else                        | **0**                                                                                                                             |

**A job cannot be created from dictation alone.** Five of `POST /jobs`'s eleven required fields are
system configuration (`accountId`, `companyId`, `programId`, `stageId`, `jobType`; `programId` uses
`1` as a "no program" sentinel). The other six are the customer's name and address, which _are_
dictated. Doc 17's product suggestion — surface requiredness in review and refuse a submit that
leaves a required leaf empty — scales here from 2 fields to 18, and is worth more at that size.

Note also that **`PUT /jobs/{jobId}` exposes only 5 of the create's 32 fields.** Name, address,
phone, email, `renterOwner`, `jobType`, `auditType` and the entire 9-field property-owner block are
**create-only**: a dictated correction to a customer's name has no job-level write path.

### 4.7 The spec is hand-maintained, and it shows

Recorded because a generator will otherwise propagate these, and because several are traps rather
than cosmetics.

- **`basedata` casing bug.** The response returns `demandKw` / `demandKwImproved` /
  `demandKwSavings`; the write accepts **`demandKW` / `demandKWImproved` / `demandKWSavings`**. These
  are the only write-only names anywhere; a round-trip keyed on the response name silently drops
  electrical demand.
- **`hvacSystemEquipmentType` is accepted on create but not on update** (`POST /jobs/hvac/{uuid}` has
  71 fields to the create's 72) — the only such create/update asymmetry in the document, and it lands
  on one of only two required capture fields.
- **Copy-pasted descriptions, verbatim:** `company.name`'s description is attic-insulation help text;
  `company.state`'s begins with the literal string `undefined`; `wallAssemblyRValue` describes "the
  basement wall system"; `atticKneeWallContinuousInsulation` repeats the cavity sentence;
  `refrigeratorName`'s description is the Age/Size help text; `dhwSidearmStandbyLoss` reads "Enter the
  temperature of the water produced"; `serviceDateTitle` and `servicedByTitle` are byte-identical;
  `fuelBillUnits` tells you to "utilize the kWh option" when `kWh` is not in its enum;
  `titleGlossary` says "gloassary"; `pvArraySlope` says "degress"; `pvModuleYear` says
  "condieration".
- **Overlapping band:** `refrigeratorAge` has both `35-42` and `42+`.
- **Missing definitions:** `ticket` and `stage` have no response definition at all; `checklist` and
  `jobSnapshot` are defined and referenced by nothing.
- **`concernsSidebar` is described as page "text" and capped at 32 characters.** A prose generator
  pointed at it will overflow.
- **Fields with no description whatsoever:** 22 on `utilities` (all 18 `delivery*`, both electric rate
  plans, `utilityRatePlanPriceElectricity`), 6 on `hvac` and 1 on `dhw` (the four
  `…EfficiencyRatingUnit` fields and the three maintenance star ratings), `freezerName`, and
  `refrigeratorMaintenanceStarRating` — whose response-side description begins with the word
  "undefined".

---

## 5. Per-domain reconciliation

Each subsection below tables every field of its endpoints with the verbatim wire name, spec type,
verbatim enum members, `required` flag, condensed vendor description, and a verdict. Fields already
present in `snuggValuesSchema` are listed as covered and excluded from the new-field tables.

### 5.0 Shared enum vocabularies

Eleven value lists recur across several resources. Each is written out verbatim once here and
referenced by its bold token in the tables below. Where two resources share a token they share
the _identical_ member list; where they do not — the heating and cooling brand lists, the
freezer and refrigerator brand lists — they get separate tokens, because the differences are
real and are exactly the kind of thing a shared normaliser would get wrong (§4.5).

**CAVITY-INSULATION-TYPES** — `Fiberglass or Rockwool Batt` · `Blown Fiberglass or Rockwool` · `Cellulose` · `Open Cell Spray Foam` · `Closed Cell Spray Foam` · `Other`

**DHW-BRANDS** — `Unknown`, `A.O. Smith`, `American`, `Bosch`, `Bradford White`, `Bryant`, `Comfort Maker`, `GE`, `LG`, `Navien`, `Noritz`, `Rinnai`, `Sears`, `Rheem`, `State Industries`, `Stiebel Eltron`, `Takaji`, `Triangle Tube`, `Other`

**DUCT-INSULATION-TYPES** — `No Insulation`, `Duct Board 1"`, `Duct Board 1.5"`, `Duct Board 2"`, `Fiberglass 1.25"`, `Fiberglass 2"`, `Fiberglass 2.5"`, `Reflective bubble wrap`, `Measured (R Value)`

**FREEZER-BRANDS** — `Amana`, `Unknown`, `Asko`, `Bosch`, `Frigidaire`, `GE`, `Igloo`, `LG`, `Maytag`, `Samsung`, `Sears`, `Sub-Zero`, `Thermador`, `Whirlpool`, `Other`, `Fridgidaire`

**FRIDGE-BRANDS** — `Unknown`, `Amana`, `Asko`, `Bosch`, `Frigidaire`, `GE`, `Hotpoint`, `KitchenAid`, `LG`, `Maytag`, `Samsung`, `Sears`, `Sub-Zero`, `Thermador`, `Whirlpool`, `Fisher & Paykel`, `Ikea`, `Liebherr`, `Other`, `Fridgidaire`

**HVAC-COOLING-BRANDS** — `Unknown`, `AirEase`, `Amana`, `American Standard`, `Bosch`, `Bryant`, `Carrier`, `Coleman`, `Comfort Maker`, `Coolerado`, `Daikin`, `Day & Night`, `Frigidaire`, `Fujitsu`, `General Electric`, `Goodman`, `Janitrol`, `Lennox`, `LG`, `Luxaire`, `Mitsubishi`, `Panasonic`, `Payne`, `Peerless`, `Rheem`, `RUUD`, `Samsung`, `Sears Kenmore`, `Tappan`, `Trane`, `Utica`, `York`, `Other`, `Fridgidaire`

**HVAC-HEATING-BRANDS** — `Unknown`, `AirEase`, `Amana`, `American Standard`, `Bosch`, `Bryant`, `Carrier`, `Coleman`, `Comfort Master`, `Daikin`, `Day & Night`, `Fujitsu`, `General Electric`, `Goodman`, `Janitrol`, `Lennox`, `LG`, `Luxaire`, `Mitsubishi`, `Navien`, `New Yorker`, `Payne`, `Panasonic`, `Peerless`, `Rheem`, `RUUD`, `Samsung`, `Sears Kenmore`, `Tappan`, `Trane`, `Triangle Tube`, `Utica`, `York`, `Other`

**INCOME-TIERS** — `Any`, `Less than 80% AMI`, `Between 80% and 150% AMI`, `80% AMI and Greater`, `Greater than 150% AMI`, `LMI`, `LMI 80 - 120`

**LINE-ITEM-UNITS** — `lf`, `sq. ft`, `cu. ft`, `BDFT`, `hour`, `each`, `$ per kBtu/h`, `$ per lf Pipe Length`, `mile`, `job`, `%`, `day`, `kBtuH`

**RIGID-INSULATION-TYPES** — `Rigid XPS` · `Rigid EPS` · `Rigid Polyisocyanurate` · `Open Cell Spray Foam` · `Closed Cell Spray Foam` · `Other`

**WINDOW-EXTERIOR-TREATMENT** — `Insect Screen (full)` · `Insect Screen (half)` · `Solar Screen (summer only)` · `Solar Screen (all year)` · `Solar Shades, Vertical Roller (summer only)` · `Solar Shades, Vertical Roller (all year)` · `Solar Shades, Louvered (summer only)` · `Solar Shades, Louvered (all year)` · `Solar Film (all year)` · `No Treatment`

### 5.1 Job, stage and tickets — `POST /jobs`, `PUT /jobs/{jobId}`, `POST /jobs/{jobId}/stage`, `PUT /jobs/{jobId}/tickets/{ticketId}`

Four write operations, 41 `formData` fields total. None of these are covered by the existing
51-leaf house-audit schema (basedata/hvac/attic/wall/window/dhw/health) — all are new.

Verdict key: `capture` = dictation-plausible, include; `capture?` = borderline, include and flag;
`exclude` = never spoken (id / fk / timestamp / computed / system).

Shorthand used in enum cells: **STATES** = the 51-member state enum, listed verbatim once below and
referenced by the three fields that share it.

**STATES** (verbatim, all 51 members, identical in `state`, `propertyOwnerState`, and `company.state`):
`AL`, `AK`, `AZ`, `AR`, `CA`, `CO`, `CT`, `DE`, `DC`, `FL`, `GA`, `HI`, `ID`, `IL`, `IN`, `IA`, `KS`, `KY`, `LA`, `ME`, `MD`, `MA`, `MI`, `MN`, `MS`, `MO`, `MT`, `NE`, `NV`, `NH`, `NJ`, `NM`, `NY`, `NC`, `ND`, `OH`, `OK`, `OR`, `PA`, `RI`, `SC`, `SD`, `TN`, `TX`, `UT`, `VT`, `VA`, `WA`, `WV`, `WI`, `WY`

---

##### `POST /jobs` — createJob (32 formData fields)

| #   | wire name                     | type                  | enum (verbatim)                                   | req     | description (condensed)                                                                                                             | verdict                                                                                                                                   |
| --- | ----------------------------- | --------------------- | ------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fromTemplateId`              | integer               | —                                                 | no      | Job template ID to base this new job on.                                                                                            | exclude — fk to a job-template resource; a template is picked in setup, never dictated                                                    |
| 2   | `firstName`                   | string                | —                                                 | **yes** | (no description) — customer first name.                                                                                             | capture                                                                                                                                   |
| 3   | `lastName`                    | string                | —                                                 | **yes** | (no description) — customer last name.                                                                                              | capture                                                                                                                                   |
| 4   | `renterOwner`                 | string                | `0`, `1`                                          | no      | Does the customer own or rent this property. (Definition adds: 0 → Renter, 1 → Owner.)                                              | capture — spoken as "she owns it" / "tenant"; needs word→code mapping                                                                     |
| 5   | `serviceTime`                 | string                | —                                                 | no      | Appointment time. Format: `YYYY-MM-DD HH:MM:SS`.                                                                                    | capture — scheduling is spoken; needs date normalisation from relative speech                                                             |
| 6   | `email`                       | string                | —                                                 | no      | Email of the homeowner (or tenant).                                                                                                 | capture                                                                                                                                   |
| 7   | `homePhone`                   | string                | —                                                 | no      | Phone of the home, format `(555) 555-5555`.                                                                                         | capture — needs formatting normalisation                                                                                                  |
| 8   | `address1`                    | string                | —                                                 | **yes** | First line of the home address.                                                                                                     | capture                                                                                                                                   |
| 9   | `address2`                    | string                | —                                                 | no      | Second line of the home address.                                                                                                    | capture                                                                                                                                   |
| 10  | `city`                        | string                | —                                                 | **yes** | City of the home.                                                                                                                   | capture                                                                                                                                   |
| 11  | `state`                       | string                | **STATES**                                        | **yes** | State of the home.                                                                                                                  | capture — spoken as a full state name, enum is 2-letter codes                                                                             |
| 12  | `zip`                         | string                | —                                                 | **yes** | Zip code of the home.                                                                                                               | capture                                                                                                                                   |
| 13  | `accountId`                   | integer               | —                                                 | **yes** | "Account Id" (in `PUT`: the Snugg Pro user who owns this job).                                                                      | capture? — the _assignee_ is plausibly named aloud ("give this to Dave"); the integer is not. Needs a name→account lookup, not extraction |
| 14  | `stageId`                     | integer               | `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10` | **yes** | Current stage ID of the job. Description here documents only `1 (Lead), 2 (Audit), 7 (QA)`.                                         | capture — workflow stage is spoken; label→code table only fully published on the stage op                                                 |
| 15  | `jobType`                     | integer               | `1`, `2`                                          | **yes** | Job Type ID. `1 (Audit)`, `2 (Score)`.                                                                                              | capture                                                                                                                                   |
| 16  | `companyId`                   | integer               | —                                                 | **yes** | Unique identifier of the Snugg Pro company who owns the job.                                                                        | exclude — system/tenancy fk; fixed per credential                                                                                         |
| 17  | `programId`                   | integer               | —                                                 | **yes** | Program this job is in. Pass `"1"` for no program.                                                                                  | capture? — program _name_ is plausibly spoken ("this one's NYSERDA"); needs name→id lookup. Sentinel value `1` = no program               |
| 18  | `altId`                       | string (maxLength 44) | —                                                 | no      | Your own alternate job ID; does not affect the Snugg Pro job ID.                                                                    | capture? — a work-order/job number read aloud is plausible; free text, high transcription risk                                            |
| 19  | `buildingId`                  | string (maxLength 44) | —                                                 | no      | Arbitrary building ID; emitted as HPXML `Building/extension/HESExternalID`; used as external building ID for DOE Home Energy Score. | capture? — externally-assigned identifier, occasionally read aloud; otherwise system                                                      |
| 20  | `propertyOwnerFirstName`      | string                | —                                                 | no      | (no description)                                                                                                                    | capture                                                                                                                                   |
| 21  | `propertyOwnerLastName`       | string                | —                                                 | no      | (no description)                                                                                                                    | capture                                                                                                                                   |
| 22  | `propertyOwnerAddress1`       | string                | —                                                 | no      | First line of the property owner's address (non-owner-occupied, or different contact address).                                      | capture                                                                                                                                   |
| 23  | `propertyOwnerAddress2`       | string                | —                                                 | no      | Second line of the property owner's address.                                                                                        | capture                                                                                                                                   |
| 24  | `propertyOwnerEmail`          | string                | —                                                 | no      | Email of the property owner; use when the job email holds the tenant's.                                                             | capture                                                                                                                                   |
| 25  | `propertyOwnerPhone`          | string                | —                                                 | no      | Phone of the property owner, format `(555) 555-5555`.                                                                               | capture                                                                                                                                   |
| 26  | `propertyOwnerCity`           | string                | —                                                 | no      | City of the property owner (tenant-occupied homes).                                                                                 | capture                                                                                                                                   |
| 27  | `propertyOwnerState`          | string                | **STATES**                                        | no      | State of the property owner.                                                                                                        | capture                                                                                                                                   |
| 28  | `propertyOwnerZip`            | string                | —                                                 | no      | Zip of the property owner.                                                                                                          | capture                                                                                                                                   |
| 29  | `auditType`                   | string                | `enum: []` (declared, **empty**)                  | no      | "This field is only enabled for select programs."                                                                                   | capture? — named enum with no published members; treat as free-text-into-review                                                           |
| 30  | `note`                        | string                | —                                                 | no      | Note to assignee or assigned user.                                                                                                  | capture — the most obviously dictated field on this endpoint; free text                                                                   |
| 31  | `useStrictBpi2400Calibration` | string                | `1`, `0`                                          | no      | Enhanced calibration for BPI 2400. (Definition: 1 → Yes, 0 → No.)                                                                   | capture? — a jargon toggle an auditor could say ("use strict 2400 cal"), but usually a program setting                                    |
| 32  | `householdIncomeTier`         | string                | **INCOME-TIERS**                                  | no      | Household income tier for the job.                                                                                                  | capture — verbatim strings carry `%`, spaces, and a spaced hyphen in `LMI 80 - 120`                                                       |

**Counts — `POST /jobs`: 32 total · 24 capture · 6 capture? · 2 exclude.**

---

##### `PUT /jobs/{jobId}` — updateJob (5 formData fields)

| #   | wire name             | type    | enum (verbatim)  | req | description (condensed)                                      | verdict                                                                 |
| --- | --------------------- | ------- | ---------------- | --- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1   | `serviceTime`         | string  | —                | no  | Appointment time. Format: `YYYY-MM-DD HH:MM:SS`.             | capture — reschedules are spoken                                        |
| 2   | `accountId`           | integer | —                | no  | Unique identifier of the Snugg Pro user who owns this job.   | capture? — reassignment by name is plausible; needs name→account lookup |
| 3   | `companyId`           | integer | —                | no  | Unique identifier of the Snugg Pro company who owns the job. | exclude — system/tenancy fk                                             |
| 4   | `note`                | string  | —                | no  | Note to assignee or assigned user.                           | capture                                                                 |
| 5   | `householdIncomeTier` | string  | **INCOME-TIERS** | no  | Household income tier for the job.                           | capture                                                                 |

**Counts — `PUT /jobs/{jobId}`: 5 total · 3 capture · 1 capture? · 1 exclude.**

Note: the update surface is a strict, tiny subset of create — name, address, phone, email, `renterOwner`,
`jobType`, `auditType`, and the whole property-owner block are **create-only**. A dictated correction to
a customer's name or address has no job-level write path at all.

---

##### `POST /jobs/{jobId}/stage` — change job stage (2 formData fields)

| #   | wire name           | type    | enum (verbatim)                                                                                                                                                                                                                                | req     | description (condensed)                                                                              | verdict                                                                                      |
| --- | ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `stageId`           | integer | _(no `enum` key at all — values only in prose)_: `1 (Lead)`, `2 (Audit)`, `3 (Bid Proposed)`, `4 (Bid Approved)`, `5 (Retrofit In Progress)`, `6 (Retrofit Complete)`, `7 (QA)`, `8 (Uncategorized)`, `9 (Archived Won)`, `10 (Archived Lost)` | **yes** | Valid stage IDs, as listed.                                                                          | capture — "mark it bid proposed" maps cleanly; label→code table must be hardcoded from prose |
| 2   | `stageChangeReason` | string  | —                                                                                                                                                                                                                                              | no      | Reason for the stage change. Required by some programs when moving a job to the Archived Lost stage. | capture — free text, conditionally required (spec does not encode the condition)             |

**Counts — `POST /jobs/{jobId}/stage`: 2 total · 2 capture · 0 capture? · 0 exclude.**

---

##### `PUT /jobs/{jobId}/tickets/{ticketId}` — update ticket (2 formData fields)

| #   | wire name | type   | enum (verbatim)                                                                                                               | req     | description (condensed)                 | verdict                                                                     |
| --- | --------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `status`  | string | _(no `enum` key — values only in prose)_: `Submitted for Review`, `Changes Requested`, `Closed Resolved`, `Closed Unresolved` | **yes** | Valid values as listed.                 | capture — QA workflow language is spoken; Title Case strings, no separators |
| 2   | `message` | string | —                                                                                                                             | no      | (no description) — ticket message body. | capture — free text, the natural dictation target                           |

**Counts — `PUT /jobs/{jobId}/tickets/{ticketId}`: 2 total · 2 capture · 0 capture? · 0 exclude.**

Path parameter `ticketId` is not a formData field but is **mandatory to address the write** — see cardinality.

---

##### Structural notes

**Reference-by-id fields (need a lookup, not extraction)**

| field                   | points at                                                                                                | notes                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fromTemplateId`        | job template                                                                                             | create-only                                                                                                                                                                    |
| `accountId`             | Snugg Pro user (`account` definition: `id`, `firstName`, `lastName`, `email`, `title`, `certifications`) | a spoken assignee name could resolve via a name→id lookup over accounts                                                                                                        |
| `companyId`             | company (`company` definition)                                                                           | fixed per credential in practice                                                                                                                                               |
| `programId`             | program (`program` definition: `id`, `name`, `website`, `phone`, `creationHelperText`)                   | spoken program name ("NYSERDA") → id lookup; `1` is the "no program" sentinel                                                                                                  |
| `{jobId}` path param    | job                                                                                                      | the session must already know which job it is writing to                                                                                                                       |
| `{ticketId}` path param | ticket                                                                                                   | **no `POST /jobs/{jobId}/tickets` exists anywhere in the spec** — `/jobs/{jobId}/tickets` is GET-only, so tickets can only be _updated_, so the id must come from a prior read |

**Empty enums (free-text-into-review)**

- `auditType` — declared `enum: []`. Named as an enum, no published members, "only enabled for select programs". Per project convention, free text routed to review.

**Enums that exist only in prose (no machine-readable list)**

- `POST /jobs/{jobId}/stage` → `stageId`: the 10 label→code pairs appear only in the description string; the parameter object has no `enum` key.
- `PUT .../tickets/{ticketId}` → `status`: the 4 values appear only in the description string.
- These two operations' parameters also omit the `enum: false` marker the `/jobs` parameters carry — a different parameter shape in the same spec.

**Type inconsistencies between formData and the `job` response definition**

- `stageId`: `integer` in `POST /jobs` formData, `string` in the `job` definition.
- `jobType`: `integer` in formData, `string` in the definition.
- `renterOwner` and `useStrictBpi2400Calibration`: `type: string` with **numeric** enum members (`0`/`1`); `useStrictBpi2400Calibration` lists them in the order `1`, `0`.
- `stageId` enum documented differently per operation: `POST /jobs` names only 3 of 10 codes, the stage op names all 10, the `job` definition names all 10 with arrow formatting.

**Array-typed fields**

- Only one: `job.customFields` — `array` of `#/definitions/customField`. Unlike almost every component create, **`POST /jobs` carries no `customFields` parameter at all** (verified against the full spec), so the job's own custom fields are read-only.

**Defaults**

- None. No parameter or definition property in these four operations declares a `default`. `programId` documents a sentinel (`"1"` = no program) rather than a default.

**Length constraints (from the `job` definition, absent from the formData params)**

- `altId`: `maxLength 44`. `buildingId`: `maxLength 44`.

**Read-only job properties (in the `job` definition, no formData write path here)**
Excluded from any capture surface, but two are dictation-plausible and worth flagging as _currently unwritable_:

- `doeWap` — enum `Yes`, `No`, "Mark yes if this job is an official DOE weatherization job" → plausibly spoken, **no write path anywhere in the spec**.
- `completionDate` — appears on the certificate of completion → plausibly spoken, **no write path anywhere in the spec**.
- Genuinely system/computed: `id`, `hasCalculated`, `hasUnmodeledChanges`, `hasOutdatedHpxml`, `firstModeledAt`, `lastModeledDate`, `bpiCalibrationStatus`, `auditStarted`, `auditEnded`.

**Spec defects observed**

- `company.name`'s description is copy-pasted attic/ceiling-insulation-depth help text ("Enter the depth of all installed attic or ceiling insulation…").
- `company.state`'s description begins with the literal string `undefined`.
- `company.disabled` and `company.demoCompany` are `integer` with examples `42861` / `36127` — almost certainly booleans with junk generated examples.
- `job.serviceTime` documents format `YYYY-MM-DD HH:MM:SS` but its example is ISO-8601 `2000-12-16T23:20:01.000Z`; `lastModeledDate`, `auditStarted`, and `auditEnded` examples are JS `Date.toString()` output (`Mon Sep 25 2017 20:00:00 GMT-0400 (EDT)`) — three date formats in one definition.
- Response definitions for `ticket` and `stage` are **missing** from the spec entirely.

---

##### Cardinality

| resource                                                 | cardinality per job                                                                                                                                                                       | instance modeling needed?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **job** (`POST /jobs`, `PUT /jobs/{jobId}`)              | **singleton.** One job per recording session. Every field above is a single-valued job attribute.                                                                                         | No. Flat leaves, like `basedata`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **property-owner block** (the 9 `propertyOwner*` fields) | **singleton sub-group.** One owner per job, not a collection — modelled as a second contact on the same job, distinguished from the occupant only by field-name prefix.                   | No — but it needs a _disambiguation_ rule: the same spoken utterance ("her number is …") can target either the occupant or the owner, and `renterOwner` is the hint.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **stage** (`POST /jobs/{jobId}/stage`)                   | **singleton, one at a time.** The job holds exactly one current `stageId`; the endpoint is a state _transition_, not an instance create. History (if any) is server-side and not exposed. | No. But it is the only **verb-like** write in the job domain — idempotency and ordering matter in a way the attribute writes do not, and `stageChangeReason` is conditionally required (Archived Lost, program-dependent), which the spec does not encode.                                                                                                                                                                                                                                                                                                                                                                         |
| **ticket** (`PUT /jobs/{jobId}/tickets/{ticketId}`)      | **repeats.** The `{ticketId}` path segment proves a job holds many tickets.                                                                                                               | **Yes, if more than one ticket is ever touched per session** — same instance-modeling problem already solved for repeating hvac/attic/wall/window/dhw instances. Two extra wrinkles those did not have: (a) tickets are **update-only** — no create endpoint exists anywhere in the spec — so each instance must bind to a pre-existing `ticketId` fetched from the API, i.e. speech must _select_ an existing instance rather than mint a new one; (b) the only distinguishing content is `message` free text, so there is no natural key (like "the attic over the garage") to anchor a spoken reference to a particular ticket. |
| **customFields**                                         | **repeats** (`array` of `customField` on the job).                                                                                                                                        | Not applicable here — `POST /jobs` has no `customFields` parameter; flagged for a later pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

##### Totals

| operation                              | total  | capture | capture? | exclude |
| -------------------------------------- | ------ | ------- | -------- | ------- |
| `POST /jobs`                           | 32     | 24      | 6        | 2       |
| `PUT /jobs/{jobId}`                    | 5      | 3       | 1        | 1       |
| `POST /jobs/{jobId}/stage`             | 2      | 2       | 0        | 0       |
| `PUT /jobs/{jobId}/tickets/{ticketId}` | 2      | 2       | 0        | 0       |
| **all four**                           | **41** | **31**  | **7**    | **3**   |

Excluded (3, with reason): `fromTemplateId` (fk to job template, setup-time choice), `companyId` ×2
(system/tenancy fk, fixed per credential).

Flagged `capture?` (7): `accountId` ×2 (assignee spoken by name, needs id lookup), `programId`
(program spoken by name, needs id lookup, `1` = none), `altId` (external job number read aloud),
`buildingId` (external HES id), `auditType` (`enum: []`, free-text-into-review),
`useStrictBpi2400Calibration` (jargon toggle, usually a program setting).

### 5.2 Utilities — `POST /jobs/{jobId}/utilities`

Write endpoint: `POST /jobs/{jobId}/utilities` (99 `formData` params). Response definition: `utilities`.

##### 1. Structure — the axes

The 99 fields are **not** 99 independent concepts. They decompose into **8 families along 3 axes**:

| Axis                           | Values it ranges over                                                    | Where it shows up                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Bill-entry mode**         | `Detailed` / `Simple` / `No Bills`                                       | `billEntryType` selects which of two mutually-exclusive field families is live. ~40 descriptions end with a literal ``Applicable to bills of `Simple` entry type`` or ``…`Detailed` entry type`` marker. |
| **B. Energy stream**           | `electric` vs `fuel` (+ `additionalFuel` for provider/account only)      | Two parallel, near-identical field families: `*Electric*` and `*Fuel*`. The "fuel" stream is generic — which fuel it is comes from `primaryHeatingFuelType`.                                             |
| **C. Fuel enumerated by name** | NaturalGas, Propane, FuelOil, Electricity, Wood, Pellets, Coal, Kerosene | Only in two places: the `utilityPrice<Fuel>` octet and the `delivery<Fuel>{Start,End}Date/Usage` sextet.                                                                                                 |
| **D. Bill index 1..12**        | 12 billing intervals                                                     | The detailed-series block only.                                                                                                                                                                          |

Field-count arithmetic:

```
  3  mode / data-provenance selectors
  6  provider names + account numbers   (electric | fuel | additionalFuel) x (name | account)
  7  Simple-bill scalars                (high/low x summer/winter x electric/gas, + simple fuel total & units)
  3  units + primary fuel type
  8  utilityPrice<Fuel>                 axis C x 8 fuels
  4  rate plans / rate-plan price
 18  delivery<Fuel>{StartDate,EndDate,Usage}   axis C x 6 deliverable fuels x 3
 50  detailed bill series               axis B x 2 streams x (1 start date + 12 end dates + 12 amounts)
 ---
  99
```

So the honest shape is roughly **~25 distinct concepts**, two of which are cross-products (8 fuels x price; 6 fuels x 3 delivery fields) and one of which is a 12-slot time series duplicated across two streams.

**Every one of the 99 fields is `required: false`.** There is no `required` array on the `utilities` definition either. Requiredness is expressed only in prose ("This is a required field if you're going to use Detailed Bills").

##### 2. Cardinality — **per-job singleton**

Evidence:

1. The path is `/jobs/{jobId}/utilities` — **no `utilityId` segment**, and no `POST /utilities` collection-create anywhere in the spec.
2. The `utilities` definition is a **flat object of scalars** (136 properties, all scalar except `customFields`). It is not an array, has no `id` / `jobId` property, and contains no nested per-fuel sub-object.
3. Multiple fuels are modelled by **name-mangling, not repetition**: `electric*` vs `fuel*` vs `additionalFuel*` for provider/account; `utilityPrice<Fuel>` and `delivery<Fuel>*` for the 8/6 fuels. If a job could carry N utility records this duplication would be unnecessary.
4. The only `$ref` anywhere in the resource is `#/definitions/customField`. There is no singular `utility` definition in the spec's 63, and nothing `$ref`s one — no evidence of a per-fuel child record type.
5. Consequence: **one electric stream + one primary fuel stream + one "additional fuel" account reference, per job.** A three-fuel home cannot be represented at full fidelity; a second fuel gets a provider/account only.

###### The `PUT` is a stub

`PUT /jobs/{jobId}/utilities` (summary "Update job utilities", tag `Utilities PUT`) has **`params: []`** — zero formData, zero query, zero body, and the spec does not even declare the `jobId` path parameter on it. It documents no input of any kind. Treat `POST` as the only usable write path; the `POST` is itself named "Update Utilities" and is upsert-shaped.

##### 3. Fields

Verdict key: `capture` / `capture?` (flagged) / `exclude`. All fields below are `required: false`.

###### 3.1 Mode & data provenance (3)

| Wire name                    | Type   | Enum (verbatim)                  | Verdict  | Note                                                                                                                                                  |
| ---------------------------- | ------ | -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billEntryType`              | string | `Detailed`, `Simple`, `No Bills` | capture? | Control field gating families B/C, not something an auditor utters. Best **derived** from which fields the extraction actually filled, not extracted. |
| `detailedElectricDataSource` | string | `Manual`, `Green Button`         | capture? | Provenance of the import mechanism, not a fact about the home. Ribo would always write `Manual`; consider hardcoding rather than extracting.          |
| `detailedFuelDataSource`     | string | `Manual`, `Green Button`         | capture? | Same as above.                                                                                                                                        |

###### 3.2 Providers & account references (6) — axis B

| Wire name                           | Type                   | Enum | Verdict  | Note                                                                                                                                          |
| ----------------------------------- | ---------------------- | ---- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `electricUtilityProviderName`       | string (maxLength 255) | —    | capture  | "they're on National Grid". Prime dictation target.                                                                                           |
| `fuelUtilityProviderName`           | string (maxLength 255) | —    | capture  | Name of the fuel utility provider.                                                                                                            |
| `additionalFuelUtilityProviderName` | string (maxLength 255) | —    | capture  | Second fuel provider, if any — the _only_ second-fuel affordance.                                                                             |
| `electricAccountNumber`             | string (maxLength 255) | —    | capture? | Human-spoken account reference, but a 10–16 digit string is a high-ASR-error target; capture with low confidence / require confirmation.      |
| `fuelAccountNumber`                 | string (maxLength 255) | —    | capture? | Same risk.                                                                                                                                    |
| `additionalFuelAccountNumber`       | string (maxLength 255) | —    | capture? | Same risk. Description is garbled in the spec: "Enter the utility additional account number for the meter that the fuel bills correspond to." |

###### 3.3 Simple-bill scalars (7) — the highest-value dictation surface

All carry ``Applicable to bills of `Simple` entry type``.

| Wire name                            | Type   | Enum (verbatim)      | Verdict | Condensed description                                                                                                             |
| ------------------------------------ | ------ | -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `highestMonthlySummerElectricBill`   | number | —                    | capture | Highest monthly summertime electric bill in past 12 months; if on a budget plan, estimate from highest-usage summer month x rate. |
| `highestMonthlyWinterElectricBill`   | number | —                    | capture | Highest monthly winter electric bill in past 12 months; same budget-plan estimation note.                                         |
| `lowestMonthlyElectricBill`          | number | —                    | capture | Lowest of all monthly electric bills in past 12 months.                                                                           |
| `highestMonthlyWinterNaturalGasBill` | number | —                    | capture | Highest monthly winter gas bill in past 12 months; if multi-fuel, use the fuel heating the largest area.                          |
| `lowestMonthlyNaturalGasBill`        | number | —                    | capture | Typically summer, hot-water/cooking only; if multi-fuel use the most-used type.                                                   |
| `simpleFuelUnits`                    | string | `Gallons`, `Dollars` | capture | (Description is only the applicability note.)                                                                                     |
| `totalSimpleFuelUsedInLast12Months`  | number | —                    | capture | Total gallons delivered over past 12 months from delivery receipts, or total dollars spent from bank statements.                  |

###### 3.4 Units & primary fuel (3)

| Wire name                | Type   | Enum (verbatim)                                                                                     | Verdict | Condensed description                                                                                                                                                  |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primaryHeatingFuelType` | string | `Natural Gas`, `Electricity`, `Fuel Oil`, `Propane`, `Wood`, `Pellets`, `Solar`, `Coal`, `Kerosene` | capture | Primary fuel source; sets prices and energy content. (Oddly marked ``Applicable to bills of `Detailed` entry type``.)                                                  |
| `electricBillUnits`      | string | `kWh`, `Dollars`                                                                                    | capture | Units for the electric bills; required for Detailed bills; prefer `kWh` over dollars.                                                                                  |
| `fuelBillUnits`          | string | `Therms`, `Gallons`, `Dollars`, `MCFs`, `Cords`, `Pounds`, `Tons`                                   | capture | Units for the fuel bills; required for Detailed bills. **Description is a copy-paste bug** — it says "utilize the kWh option", but `kWh` is not a member of this enum. |

###### 3.5 Fuel prices (8) — axis C, full 8-fuel cross-product

All: "Enter a your own price for X to override the software's existing regional defaults from the EIA." (sic). Wood/Pellets/Coal/Kerosene instead say Snugg Pro has **no** default cost, so the field must be filled if that fuel is selected.

| Wire name                 | Type   | Enum | Example | Verdict | Note                                                                   |
| ------------------------- | ------ | ---- | ------- | ------- | ---------------------------------------------------------------------- |
| `utilityPriceNaturalGas`  | number | —    | 0.82    | capture | Overrides EIA regional default.                                        |
| `utilityPricePropane`     | number | —    | 1.54    | capture | Overrides EIA regional default.                                        |
| `utilityPriceFuelOil`     | number | —    | 2.32    | capture | Overrides EIA regional default.                                        |
| `utilityPriceElectricity` | number | —    | 0.09    | capture | "electric is nine cents a kilowatt hour" — canonical dictation target. |
| `utilityPriceWood`        | number | —    | 0.09    | capture | No default exists; must be filled unless wood is free.                 |
| `utilityPricePellets`     | number | —    | 0.09    | capture | No default exists; required if pellets chosen.                         |
| `utilityPriceCoal`        | number | —    | 0.09    | capture | No default exists; required if coal chosen.                            |
| `utilityPriceKerosene`    | number | —    | 0.09    | capture | No default exists; required if kerosene chosen.                        |

Note: **no unit is specified anywhere** for these prices. It is implicitly $/therm, $/gal, $/kWh, $/cord etc. per fuel — a build effort must hardcode the per-fuel unit, since the auditor will say "a dollar fifty a gallon" and the field wants a bare number.

###### 3.6 Rate plans (4)

| Wire name                         | Type   | Enum | Verdict  | Note                                                                                                                                                                       |
| --------------------------------- | ------ | ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electricRatePlan`                | string | —    | capture  | **No description in the spec** (example `null`). Inferred: name of the electric utility rate plan.                                                                         |
| `fuelRatePlan`                    | string | —    | capture  | "Enter the name of the utility fuel rate plan. For gas, the same rate plan is used for both Base and Improved; separate Improved Fuel Rate Plans are not supported."       |
| `electricRatePlanImproved`        | string | —    | capture? | No description. Post-retrofit _proposal_ scenario, not an observed site condition — likely out of scope for a field-recording extractor.                                   |
| `utilityRatePlanPriceElectricity` | number | —    | capture? | No description; example `2937.32`. Magnitude suggests an **annual dollar total**, not a $/kWh rate — semantics unresolved from the spec alone. Do not map until confirmed. |

###### 3.7 Delivered-fuel windows (18) — axis C x 6 deliverable fuels x 3 — **per-period sub-category**

**None of these 18 have any description in the spec.** Shape inferred from names and examples (dates `2026-08-25`, usage `614.59`). Covers the 6 _delivered_ fuels only — `Natural Gas` and `Electricity` are absent because they are metered, not delivered; `Solar` is absent despite being in `primaryHeatingFuelType`.

| Wire name                   | Type          | Enum | Verdict  | Note                                                                |
| --------------------------- | ------------- | ---- | -------- | ------------------------------------------------------------------- |
| `deliveryPropaneStartDate`  | string (date) | —    | capture? | Per-period. Undocumented. Plausible from a spoken delivery receipt. |
| `deliveryPropaneEndDate`    | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryPropaneUsage`      | number        | —    | capture  | "two hundred gallons of propane" — dictatable.                      |
| `deliveryFuelOilStartDate`  | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryFuelOilEndDate`    | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryFuelOilUsage`      | number        | —    | capture  | Dictatable.                                                         |
| `deliveryWoodStartDate`     | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryWoodEndDate`       | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryWoodUsage`         | number        | —    | capture  | Dictatable (cords).                                                 |
| `deliveryPelletsStartDate`  | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryPelletsEndDate`    | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryPelletsUsage`      | number        | —    | capture  | Dictatable (tons/pounds).                                           |
| `deliveryKeroseneStartDate` | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryKeroseneEndDate`   | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryKeroseneUsage`     | number        | —    | capture  | Dictatable.                                                         |
| `deliveryCoalStartDate`     | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryCoalEndDate`       | string (date) | —    | capture? | Per-period. Undocumented.                                           |
| `deliveryCoalUsage`         | number        | —    | capture  | Dictatable.                                                         |

Unlike §3.8 this is a **single** window per fuel, not a 12-slot series — which is why it stays dictatable.

###### 3.8 Detailed 12-month bill series (50) — **DISTINCT SUB-CATEGORY, not dictation data**

Axis B (2 streams) x (1 start date + 12 end dates + 12 amounts) = 50. All carry ``Applicable to bills of `Detailed` entry type``. Verdict for **all 50: `capture?`**, with one shared reason: this is a **13-meter-read / 12-interval bill history**. An auditor will not read 24 dates and 24 amounts aloud; this arrives by photograph of the bills, a Green Button import, or a utility-service phone call. It should be treated as an **import path, explicitly out of scope for voice extraction**, not as 50 schema leaves.

Naming pattern (`N` = 1..12):

| Wire name pattern                        | Type          | Enum | Count | Verdict  | Condensed description                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------- | ---- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startElectricDate1`                     | string (date) | —    | 1     | capture? | "**Start with the oldest bill first.**" Enter **meter read dates, not billing dates**. With 13 bills, the oldest meter-read date; with 12, the read date prior to the oldest bill (or oldest read date minus "number of days in billing period"). |
| `endElectricDate1`                       | string (date) | —    | 1     | capture? | With 12 bills: the read date of the oldest bill. With 13: the read date of the **2nd** oldest.                                                                                                                                                    |
| `endElectricDate2` … `endElectricDate12` | string (date) | —    | 11    | capture? | "Fill out as many of these meter read dates as you have available… Enter zero for missing or abnormal bills… To include a bill with actual zero usage, enter 0.01."                                                                               |
| `endElectricBill1` … `endElectricBill12` | number        | —    | 12    | capture? | Usage/amount for the interval ending at the corresponding date, in the unit set by `electricBillUnits`. Descriptions are empty apart from the applicability note.                                                                                 |
| `startFuelDate1`                         | string (date) | —    | 1     | capture? | Fuel-stream mirror of `startElectricDate1`.                                                                                                                                                                                                       |
| `endFuelDate1` … `endFuelDate12`         | string (date) | —    | 12    | capture? | Fuel-stream mirror of the electric end dates.                                                                                                                                                                                                     |
| `endFuelBill1` … `endFuelBill12`         | number        | —    | 12    | capture? | Fuel-stream mirror; unit set by `fuelBillUnits`.                                                                                                                                                                                                  |

Note the **13 dates / 12 amounts** asymmetry: 13 meter-read boundaries define 12 consumption intervals. `startXDate1` is the extra opening boundary.

###### 3.9 Response-only fields — NOT writable, all excluded (37)

Present in the `utilities` response definition (136 properties) but absent from the 99 `formData` params, i.e. read-only output:

| Wire name pattern                        | Type                                 | Count | Verdict | Reason                                                                                                                                |
| ---------------------------------------- | ------------------------------------ | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizedElectricMbtuMonthly01` … `12` | number                               | 12    | exclude | computed — weather-normalized monthly MBtu output of Snugg Pro's utility analysis. Empty descriptions; write-side has no counterpart. |
| `normalizedFuelMbtuMonthly01` … `12`     | number                               | 12    | exclude | computed                                                                                                                              |
| `normalizedTotalMbtuMonthly01` … `12`    | number                               | 12    | exclude | computed (electric + fuel)                                                                                                            |
| `customFields`                           | array of `#/definitions/customField` | 1     | exclude | system — per-tenant custom field bag, not part of the fixed audit surface; see §4.7 on how `customFields` is declared.                |

Heating-degree-day assumptions: **there are none on this endpoint.** The normalization is done server-side and surfaces only as these read-only `normalized*Mbtu*` outputs; no HDD base temperature or weather-station field is exposed here.

##### 4. Counts

| Bucket                                            | Count                           |
| ------------------------------------------------- | ------------------------------- |
| **Total writable `formData` fields (POST)**       | **99**                          |
| `capture`                                         | 29                              |
| `capture?`                                        | 70                              |
| `exclude`                                         | 0                               |
| — of which **monthly/12-period series** (§3.8)    | **50** (all `capture?`)         |
| — of which per-period delivery windows (§3.7)     | 18 (6 `capture`, 12 `capture?`) |
| Non-series `capture?` (i.e. genuinely borderline) | 20                              |
| Response-only fields excluded (§3.9)              | 37 (36 computed + 1 system)     |
| Total properties on `utilities` definition        | 136                             |

Zero of the 99 writable fields is an id, uuid, or timestamp. **The write surface contains no system fields at all** — every exclusion in this endpoint lives on the response side.

Realistic voice-extraction surface, if the 50-field detailed series is treated as an import path and the 3 provenance/mode selectors are derived rather than extracted: **~46 fields, ~20 distinct concepts** — of which the highest-yield are the 7 Simple-bill scalars, the 3 provider names, the 8 fuel prices, `primaryHeatingFuelType`, and the 3 unit enums.

### 5.3 Report — `POST /jobs/{jobId}/report`

#### Cardinality: per-job singleton

- **Path shape** — `/jobs/{jobId}/report` terminates at the resource name; there is no `{reportUuid}` sub-path and no `uuid` among the 76 `formData` params.
- **Verb + summary** — the single operation is `POST` with summary _"Update Report"_, not _"Create Report"_. Upsert-on-the-job semantics.
- **No DELETE, no list** — a collection resource needs a create, a per-item delete and usually a list; this has none of the three.
- **Flat definition** — `#/definitions/report` is a flat object of scalars plus one `customFields` array, not an array of reports.
- **All 76 params `required: false`** — consistent with partial update on an existing row.

No identity resolution, no "which report did the auditor mean" problem — unlike the multi-instance audit resources.

#### Grouping summary

| Group                                          |  Count | % of 76 | `capture` | `capture?` | `exclude` |
| ---------------------------------------------- | -----: | ------: | --------: | ---------: | --------: |
| (a1) long-form narrative prose                 |      3 |      4% |         3 |          0 |         0 |
| (a2) short single-line labels / section titles |     27 |     36% |         1 |          4 |        22 |
| (b) show/hide + display-mode flags             |     46 |     61% |         0 |         14 |        32 |
| (c) computed / derived numbers                 |  **0** |      0% |         — |          — |         — |
| (d) ids / refs / metadata                      |  **0** |      0% |         — |          — |         — |
| **total**                                      | **76** |         |     **4** |     **18** |    **54** |

**The (c)=0 / (d)=0 result is the finding.** The `report` write surface contains no identifiers, no timestamps, no totals and no savings figures at all. Everything computed or metadata-ish lives only in the response definition — `lastPdfUrl` (`maxLength: 2048`, a server-generated artefact URL), `lastPdfGeneratedAt` (a server timestamp), and `customFields`. So `report` is 100% authored content plus display configuration, and is a cleaner extraction target than the physical-audit resources: nothing here has to be reconciled against a calculation engine.

#### Free-text inventory and expected length

Only **3** of the 30 string fields have **no `maxLength`** in `#/definitions/report`. Those three are the only genuine long-form prose targets:

| Field                     | `maxLength` | Expected spoken length                                                              |
| ------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `coverTextArea`           | _(none)_    | Multi-sentence to multi-paragraph. Cover-page intro addressed to the homeowner.     |
| `additionalNotesOverview` | _(none)_    | Multi-sentence. Catch-all notes; likely the longest dictated block in a real audit. |
| `safetyOverview`          | _(none)_    | One to several sentences. Health-and-safety findings narrative.                     |

Two more will mislead a naive generator: `concernsSidebar` is described as _"The text in the sidebar of the concerns page"_ but capped at **32 characters** — do not generate a paragraph into it; and `solutionsTitle` is uncapped yet described as _"Subheader title on the solutions page"_, so treat it as short. The remaining 25 strings are capped at **32** (22 fields), **50** (`titleCertofcompliance`, `titleTermsAndConditionsSigned`) or **255** (`serviceDateTitle`, `servicedByTitle`).

**Build implication:** the long-form problem here is _small_ — 3 prose fields. A prose path is worth building once and reusing across those three; the other 73 fields need no such machinery.

#### (a1) Long-form narrative prose (3)

| Wire name                 | Type   | Enum | Req   | Description (condensed)                                  | Verdict   |
| ------------------------- | ------ | ---- | ----- | -------------------------------------------------------- | --------- |
| `coverTextArea`           | string | —    | false | Introduction text on the cover page.                     | `capture` |
| `additionalNotesOverview` | string | —    | false | The text in the sidebar of the additional notes page(s). | `capture` |
| `safetyOverview`          | string | —    | false | Notes about the health and safety of the home.           | `capture` |

#### (a2) Short single-line labels / section titles (27)

All `required: false`, all `type: string`, no enum. `maxLength` from `#/definitions/report`.

| Wire name                       | maxLength | Description (condensed)                                                                                                       | Verdict                                                                                                |
| ------------------------------- | --------: | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `titleCover`                    |        32 | The title of the cover page.                                                                                                  | `capture?` — the report's own title; an auditor may name the deliverable                               |
| `concernsSidebar`               |        32 | The text in the sidebar of the concerns page.                                                                                 | `capture` — the homeowner's stated comfort concerns are core dictated content, despite the 32-char cap |
| `solutionsTitle`                |  _(none)_ | Subheader title on the solutions page.                                                                                        | `capture?` — uncapped and job-specific-sounding, but likely a template default                         |
| `titleCustom1`                  |        32 | Title of the custom program section. Optional section.                                                                        | `capture?` — custom sections have no template default, so whoever fills one must name it               |
| `titleCustom2`                  |        32 | Title of the second custom program section.                                                                                   | `capture?` — same reasoning                                                                            |
| `titleConcerns`                 |        32 | The title of the concerns page.                                                                                               | `exclude` — presentation-only                                                                          |
| `titleSolutions`                |        32 | The title of the solutions page.                                                                                              | `exclude` — presentation-only                                                                          |
| `titleEnergyUse`                |        32 | The title of the energy use page.                                                                                             | `exclude` — presentation-only                                                                          |
| `titleFinancing`                |        32 | The title of the financing page.                                                                                              | `exclude` — presentation-only                                                                          |
| `additionalNotesOverviewTitle`  |        32 | The title of the additional notes page(s).                                                                                    | `exclude` — presentation-only                                                                          |
| `titleQa`                       |        32 | The title of the qa section. Optional section.                                                                                | `exclude` — presentation-only                                                                          |
| `titleTechSpecs`                |        32 | The title of the tech specs page(s).                                                                                          | `exclude` — presentation-only                                                                          |
| `titleMetrics`                  |        32 | The title of the metrics page(s).                                                                                             | `exclude` — presentation-only                                                                          |
| `titleGlossary`                 |        32 | The title of the gloassary page(s). _(vendor typo verbatim)_                                                                  | `exclude` — presentation-only                                                                          |
| `titleHes`                      |        32 | The title of HES page.                                                                                                        | `exclude` — presentation-only                                                                          |
| `titleCoc`                      |        32 | The title of Certificate of Completion page.                                                                                  | `exclude` — presentation-only                                                                          |
| `titleWorkOrder`                |        32 | The title of work order page.                                                                                                 | `exclude` — presentation-only                                                                          |
| `titleDirectInstalls`           |        32 | The title of direct installs page.                                                                                            | `exclude` — presentation-only                                                                          |
| `serviceDateTitle`              |       255 | Single-line text describing the service date on the cover-page sidebar.                                                       | `exclude` — presentation-only                                                                          |
| `servicedByTitle`               |       255 | _Byte-identical description to `serviceDateTitle`_ — vendor copy-paste bug; almost certainly labels the servicing technician. | `exclude` — presentation-only                                                                          |
| `titleIncentives`               |        32 | The title of the incentives page. Optional section.                                                                           | `exclude` — presentation-only                                                                          |
| `titleIncentiveDetails`         |        32 | The title of the incentive details page. Optional section.                                                                    | `exclude` — presentation-only                                                                          |
| `titleCertofcompliance`         |        50 | The title of Certificate of Compliance page.                                                                                  | `exclude` — presentation-only                                                                          |
| `titleSystemsCheckUp`           |        32 | The title of the systems check up page. Optional section.                                                                     | `exclude` — presentation-only                                                                          |
| `titleTermsAndConditions`       |        32 | The title of the Terms & Conditions page. Optional section.                                                                   | `exclude` — presentation-only                                                                          |
| `titleTermsAndConditionsSigned` |        50 | The title of the Terms & Conditions Signed page.                                                                              | `exclude` — presentation-only                                                                          |
| `titleWorkOrderSigned`          |        32 | The title of the Work Order Signed page.                                                                                      | `exclude` — presentation-only                                                                          |

#### (b1) `element*` display-mode flags (20)

All `required: false`, all `type: integer`. Enum members verbatim, in spec order. The `→` option meanings are verbatim from `#/definitions/report` — **the `formData` parameter descriptions omit them entirely**.

| Wire name                              | Enum (verbatim, spec order) | Option meanings (verbatim)                                 | Description (condensed)                                                                   | Verdict                                                                             |
| -------------------------------------- | --------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `elementCosts`                         | `2`, `1`, `0`               | `2 → Exact`, `1 → Rounded`, `0 → Off`                      | If and how costs are shown throughout the report.                                         | `capture?` — "don't show them prices yet" / "round the numbers" is plausibly voiced |
| `elementSavings`                       | `1`, `4`, `0`               | `1 → Detailed`, `4 → Global`, `0 → Off`                    | If and how savings are shown.                                                             | `capture?` — plausibly voiced alongside costs                                       |
| `elementSir`                           | `1`, `3`, `0`               | `1 → Detailed`, `3 → Global`, `0 → Off`                    | If and how the Savings to Investment Ratio is shown.                                      | `exclude` — program-controlled financial metric                                     |
| `elementSimplePayback`                 | `1`, `3`, `0`               | `1 → Detailed`, `3 → Global`, `0 → Off`                    | If and how Simple Payback is shown. Enabled by the program; replaces SIR.                 | `exclude` — explicitly program-controlled                                           |
| `elementCo2`                           | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Whether CO2 savings are visible.                                                          | `exclude` — presentation-only                                                       |
| `elementElectricityInImpactOfUpgrades` | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Whether electricity savings / MBtu percent is displayed.                                  | `exclude` — presentation-only                                                       |
| `elementWhyItMatters`                  | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Whether the educational 'Why it matters' section is visible.                              | `capture?` — "give them the why-it-matters explanations" is voiceable               |
| `elementPageNumbers`                   | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Page numbers on the ToC and section footers.                                              | `exclude` — presentation-only                                                       |
| `elementAlternativeScore`              | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Alternative Score visibility in the View Score tab.                                       | `exclude` — presentation-only                                                       |
| `elementPaybackYears`                  | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Payback Years visibility in the Solutions columns.                                        | `exclude` — presentation-only                                                       |
| `elementPhotos`                        | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Whether photos are visible in the report.                                                 | `capture?` — "put the attic photos in the report" is a natural field utterance      |
| `elementHomeownerNotes`                | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Whether homeowner notes are visible.                                                      | `capture?` — pairs with dictated notes                                              |
| `elementContractorNotes`               | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Whether contractor notes are visible.                                                     | `capture?` — "keep my contractor notes off the homeowner copy"                      |
| `elementNowAndGoal`                    | `0`, `1`, `2`, `3`          | `0 → Hide`, `1 → Now & Goal`, `2 → Then & Now`, `3 → Auto` | Now & goal section in the upgrade details pages.                                          | `exclude` — presentation-only                                                       |
| `elementNotesNowAndGoal`               | `0`, `1`, `2`               | `0 → Hide`, `1 → Now & Goal`, `2 → Then & Now`             | Now & goal section in the additional notes pages.                                         | `exclude` — presentation-only                                                       |
| `elementEnergyUseSimilar`              | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Whether the Energy Use page compares with similar homes.                                  | `exclude` — presentation-only                                                       |
| `elementEnergyUseElectricityType`      | `1`, `2`                    | `1 → MMBtu`, `2 → kWh`                                     | How the Energy Use page displays electricity. **No `0` member — cannot be switched off.** | `exclude` — presentation-only unit choice                                           |
| `elementWorkOrderCosts`                | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Costs on the work order report page.                                                      | `capture?` — "don't put prices on the work order" is a realistic instruction        |
| `elementIncentives`                    | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Potential Incentives section in the upgrade details pages.                                | `capture?` — rebate talk is common on site                                          |
| `elementTechSpecsUtilityRates`         | `0`, `1`                    | `0 → Hide`, `1 → Show`                                     | Utility Rates on the Tech Specs page.                                                     | `exclude` — presentation-only                                                       |

#### (b2) `page*` section visibility flags (26)

All `type: integer`, all enum `0`, `1`, all `0 → Hide` / `1 → Show`.

| Wire name                      | Description (condensed)                                   | Verdict                                                                   |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pageCover`                    | Cover page visibility.                                    | `exclude`                                                                 |
| `pageConcerns`                 | Concerns page visibility.                                 | `exclude`                                                                 |
| `pageSolutions`                | Solutions page visibility.                                | `exclude`                                                                 |
| `pageEnergyUse`                | Energy use page visibility.                               | `exclude`                                                                 |
| `pageUpgradeDetails`           | Upgrade details section visibility.                       | `exclude`                                                                 |
| `pageHealth`                   | Health and safety section visibility.                     | `capture?` — pairs with `safetyOverview`                                  |
| `pageAdditionalNotes`          | Additional notes section visibility.                      | `capture?` — pairs with `additionalNotesOverview`                         |
| `pageRebates`                  | Rebates & incentives pages. Usually custom program pages. | `capture?` — "show them the rebates"                                      |
| `pageFinancing`                | Financing page visibility.                                | `capture?` — the canonical voiced toggle                                  |
| `pageMetrics`                  | Metrics page visibility.                                  | `exclude`                                                                 |
| `pageTechSpecs`                | Tech specs section visibility.                            | `exclude`                                                                 |
| `pageHes`                      | DOE Home Energy Score page visibility.                    | `exclude`                                                                 |
| `pageCoc`                      | Certificate of **Completion** page. Select programs only. | `exclude`                                                                 |
| `pageWorkOrder`                | Work order page visibility.                               | `capture?` — "print them a work order" is a plausible closing instruction |
| `pageGlossary`                 | Glossary page visibility.                                 | `exclude`                                                                 |
| `pageCustom1`                  | Custom 1 page visibility.                                 | `exclude`                                                                 |
| `pageCustom2`                  | Custom 2 page visibility.                                 | `exclude`                                                                 |
| `pageQa`                       | QA page visibility.                                       | `exclude`                                                                 |
| `pageDirectInstalls`           | Direct install page visibility.                           | `exclude`                                                                 |
| `pageIncentives`               | Incentives page visibility.                               | `capture?` — incentives are routinely discussed with the homeowner        |
| `pageIncentiveDetails`         | Incentive details pages visibility.                       | `capture?` — same reasoning                                               |
| `pageCertofcompliance`         | Certificate of **Compliance** page visibility.            | `exclude`                                                                 |
| `pageSystemsCheckUp`           | Systems check up page visibility.                         | `exclude`                                                                 |
| `pageTermsAndConditions`       | Terms & Conditions page visibility.                       | `exclude`                                                                 |
| `pageTermsAndConditionsSigned` | Terms & Conditions Signed page visibility.                | `exclude`                                                                 |
| `pageWorkOrderSigned`          | Work Order Signed page visibility.                        | `exclude`                                                                 |

#### Notes specific to `report`

1. **The `formData` parameter descriptions strip the enum semantics.** `#/definitions/report` documents `elementCosts` as `2 → Exact / 1 → Rounded / 0 → Off`; the parameter says only _"Defines if and how costs are shown throughout the report."_ Generating from the operation parameters alone yields 46 meaningless integers. **Read enum semantics from the definition, not the params.**
2. **Enum values are non-monotonic.** `elementSavings` is `1, 4, 0`; `elementSir`/`elementSimplePayback` are `1, 3, 0`. `0` is consistently Off/Hide, but `1 → Detailed` while the _larger_ `3`/`4` means the _lesser_ `Global`.
3. **Naming breaks prefix-based mapping.** Most titles are `title<Section>`, but four invert the order: `additionalNotesOverviewTitle`, `solutionsTitle`, `serviceDateTitle`, `servicedByTitle`.
4. **Two near-homograph pages that are different documents:** `pageCoc` / `titleCoc` = Certificate of **Completion**; `pageCertofcompliance` / `titleCertofcompliance` = Certificate of **Compliance**.
5. **The page/title sets are not symmetric.** `pageUpgradeDetails`, `pageRebates` and `pageHealth` have no matching `title*`, and `pageAdditionalNotes`' title lives under the inverted `additionalNotesOverviewTitle`. Do not model page and title as one paired structure.

### 5.4 HVAC and DHW — `POST /jobs/{jobId}/hvac`, `POST /jobs/{jobId}/dhw`

Source: `POST /jobs/{jobId}/hvac` (72 `formData` params) and `POST /jobs/{jobId}/dhw` (47 `formData` params),
plus the `hvac` (100 props) and `dhw` (59 props) response definitions. Swagger 2.0.

##### 0. Counts

|                                                               |   hvac |    dhw |   total |
| ------------------------------------------------------------- | -----: | -----: | ------: |
| Total `formData` fields                                       |     72 |     47 |     119 |
| Already covered by existing schema                            |     12 |      6 |      18 |
| **Uncovered (subject of this doc)**                           | **60** | **41** | **101** |
| — base-side uncovered                                         |     27 |     20 |      47 |
| — improved-side uncovered                                     |     33 |     21 |      54 |
| Verdict `capture`                                             |     23 |     13 |      36 |
| Verdict `capture?`                                            |     11 |     18 |      29 |
| Verdict `exclude`                                             |     26 |     10 |      36 |
| Efficiency-rating fields (flagged, incl. covered)             |     10 |      9 |      19 |
| `enum: []` (named, unpublished value list)                    |      8 |      2 |      10 |
| `required: true`                                              |      2 |      0 |       2 |
| Response-only props (not writable; excluded, outside the 119) |     28 |     12 |      40 |

Both `required` fields (`hvacSystemEquipmentType`, `hvacUpgradeAction`) are already covered.
`dhw` has **no required field at all**.

##### 1. Already covered — excluded from the tables below

**hvac (12):** `hvacSystemEquipmentType`, `hvacUpgradeAction`, `hvacHeatingEnergySource`,
`hvacHeatingSystemManufacturer`, `hvacHeatingSystemModel`, `hvacHeatingSystemModelYear`,
`hvacHeatingCapacity`, `hvacCoolingCapacity`, `hvacDuctLocation`, `hvacDuctLeakage`,
`hvacDuctLeakageValue`, `hvacDuctInsulation`

**dhw (6):** `dhwType2`, `dhwFuel2`, `dhwAge`, `dhwLocation`, `dhwTankSize`, `dhwManufacturer`

All 18 are base-side. Ten of them have an `…Improved` twin that is **not** covered
(`hvacHeatingEnergySourceImproved`, `hvacHeatingCapacityImproved`, `hvacCoolingCapacityImproved`,
`hvacDuctLocationImproved`, `hvacDuctLeakageImproved`, `hvacDuctLeakageValueImproved`,
`hvacDuctInsulationImproved`, `hvacHeatingSystemManufacturerImproved`, `hvacHeatingSystemModelImproved`,
`hvacHeatingSystemModelYearImproved`, `dhwType2Improved`, `dhwFuel2Improved`, `dhwTankSizeImproved`,
`dhwManufacturerImproved`) — see §3 and §5.

##### 2. The BASE / IMPROVED doubling

Confirmed. The pattern is a literal `…Improved` name suffix, with the base and improved member sharing a
byte-identical `description`, `type` and enum. `dhwType2`'s description spells the convention out:

> "Enter the type of water heater installed (BASE) or to be installed (IMPROVED)."

and the efficiency fields carry the operating rule:

> "Edit **Base** fields in the Details section only if you're confident of the actual value that is entered.
> The modeling engine utilizes utility data and input form data to determine the 'effective' values on the Base side.
> Edit **Improved** fields in the Details section with the details of what you recommend be installed in the house.
> These values are only used if the item is Recommended."

**Pair census**

|      | pairs | unpaired base                                                                                                                                                           | orphan improved                                                  |
| ---- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| hvac |    33 | 6 — `hvacSystemName`, `hvacSystemEquipmentType`, `hvacUpgradeAction`, `hvacHeatingIsCondensing`, `hvacHeatingMaintenanceStarRating`, `hvacCoolingMaintenanceStarRating` | 0                                                                |
| dhw  |    20 | 7 — `dhwAge`, `dhwLocation`, `dhwTemperatureSettings`, `dhwTankWrapRValue`, `dhwPipeWrapRValue`, `hesDhwEnergyFactor`, `dhwMaintenanceStarRating`                       | 2 — `dhwPipeWrapLengthImproved`, `dhwPipeWrapPercentageImproved` |

Notable asymmetries:

- **`hvacSystemEquipmentType` has no improved twin.** A retrofit that changes equipment class is therefore
  modelled as _two hvac instances_, not one row with two sides — see `hvacUpgradeAction` below.
- Condition/maintenance star ratings are base-only in both resources (you cannot rate the condition of a
  thing that is not installed yet). Same for `dhwAge`, `dhwLocation`, `dhwTemperatureSettings`.
- `dhwTankWrapRValue` / `dhwPipeWrapRValue` are base-only, but the _recommended_ pipe-wrap measure gets two
  improved-only fields (`…LengthImproved`, `…PercentageImproved`) with no base counterpart. So tank/pipe
  insulation is asymmetric in both directions.

**How `hvacUpgradeAction` interacts with the two sides** (verbatim from its description):

- `Replace with a newer model` — same system, both sides populated.
- `Keep an existing system as is` — "Do nothing to a system or just change the percent of total load".
- `Remove a system permanently` — "you will have a system that is described on the base side, and the
  improved side will be blank."
- `Install a new non-existing system` — "A brand new system that replaces the system that was removed
  when you chose: Remove a system permanently."

⚠️ **This qualifies the "improved specs are not dictated" stance.** For an `Install a new non-existing system`
instance, the improved side is the _only_ place the new system exists, and its content is exactly the
dictated intent ("rip out the oil boiler, put in a cold-climate heat pump"). Improved-side verdicts below
are graded on that basis: fields that carry _intent_ (fuel, type, sizing, share of load, ENERGY STAR,
insulate-the-pipes) are `capture?`; fields that are purchase specs of not-yet-bought equipment
(serial numbers, model years, indoor/outdoor model numbers, measured efficiencies) are `exclude`.

##### 3. hvac — uncovered, BASE side (27)

| Wire name                               | Type                        | Enum members (verbatim)                                                                                                                                                                                       | Req | Description (condensed)                                                                                                                 | Verdict                                                                                                                                                          |
| --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hvacSystemName`                        | string (maxLength 255)      | —                                                                                                                                                                                                             | no  | "Give this system a name that you can use to easily differentiate it from the others like: Old Heat Pump or Basement Furnace."          | **capture** — the human instance label; see §7                                                                                                                   |
| `hvacHeatingIsCondensing`               | string                      | `Yes`, `No`                                                                                                                                                                                                   | no  | Condensing unit? PVC combustion venting rather than gravity vent implies ≥90 AFUE; setting it auto-defaults AFUE to a calibrated 90–96. | **capture** — a direct field observation                                                                                                                         |
| `hvacPercentOfTotalHeatingLoad`         | number (0–100, precision 0) | —                                                                                                                                                                                                             | no  | Proportion of total heating load this system represents. Combined heating % across all heating systems must total 100%.                 | **capture**                                                                                                                                                      |
| `hvacPercentOfTotalCoolingLoad`         | number (0–100, precision 0) | —                                                                                                                                                                                                             | no  | Same for cooling; combined cooling % across systems does **not** need to total 100% (the remainder is treated as unconditioned).        | **capture**                                                                                                                                                      |
| `hvacCoolingSystemManufacturer`         | string                      | **HVAC-COOLING-BRANDS**                                                                                                                                                                                       | no  | "Enter the Manufacturer of the Cooling Equipment."                                                                                      | **capture** — mirrors the covered heating manufacturer                                                                                                           |
| `hvacCoolingSystemModel`                | string                      | —                                                                                                                                                                                                             | no  | Model # of the cooling equipment. Pro-tip: photograph the nameplate.                                                                    | **capture**                                                                                                                                                      |
| `hvacCoolingSystemIndoorModel`          | string                      | —                                                                                                                                                                                                             | no  | Indoor model # of the cooling equipment.                                                                                                | **capture**                                                                                                                                                      |
| `hvacCoolingSystemOutdoorModel`         | string                      | —                                                                                                                                                                                                             | no  | Outdoor model # of the cooling equipment.                                                                                               | **capture**                                                                                                                                                      |
| `hvacCoolingSystemModelYear`            | string                      | —                                                                                                                                                                                                             | no  | "Enter the Year the Cooling Equipment was built."                                                                                       | **capture**                                                                                                                                                      |
| `hvacHeatingSystemIndoorModel`          | string                      | —                                                                                                                                                                                                             | no  | Indoor model # of the heating equipment.                                                                                                | **capture**                                                                                                                                                      |
| `hvacHeatingSystemOutdoorModel`         | string                      | —                                                                                                                                                                                                             | no  | Outdoor model # of the heating equipment.                                                                                               | **capture**                                                                                                                                                      |
| `hvacCoolingSystemSerialNumber`         | string                      | —                                                                                                                                                                                                             | no  | "If there is more than one serial number, each serial number should be separated with a comma,"                                         | **capture**                                                                                                                                                      |
| `hvacCoolingSystemIndoorSerialNumber`   | string                      | —                                                                                                                                                                                                             | no  | (same comma-separated note)                                                                                                             | **capture**                                                                                                                                                      |
| `hvacCoolingSystemOutdoorSerialNumber`  | string                      | —                                                                                                                                                                                                             | no  | (same comma-separated note)                                                                                                             | **capture**                                                                                                                                                      |
| `hvacHeatingSystemSerialNumber`         | string                      | —                                                                                                                                                                                                             | no  | (same comma-separated note)                                                                                                             | **capture**                                                                                                                                                      |
| `hvacHeatingSystemIndoorSerialNumber`   | string                      | —                                                                                                                                                                                                             | no  | (same comma-separated note)                                                                                                             | **capture**                                                                                                                                                      |
| `hvacHeatingSystemOutdoorSerialNumber`  | string                      | —                                                                                                                                                                                                             | no  | (same comma-separated note)                                                                                                             | **capture**                                                                                                                                                      |
| `hvacDuctInsulationValue`               | number                      | —                                                                                                                                                                                                             | no  | Actual R-value of the duct insulation, if known. Paired with `hvacDuctInsulation = Measured (R Value)`.                                 | **capture**                                                                                                                                                      |
| `hvacHeatPumpInverter`                  | string                      | `Yes`, `No`                                                                                                                                                                                                   | no  | Yes if variable-speed / inverter-driven compressor; performs to lower OATs and needs little or no resistance backup.                    | **capture**                                                                                                                                                      |
| `energyStarColdClimateHeatPump`         | string                      | `1`, `0` ⚠️ (JSON **integers** on a `type: string` field; definition maps `1 → Yes`, `0 → No`)                                                                                                                | no  | "Choose Yes if Energy Star Cold Climate Heat Pump."                                                                                     | **capture**                                                                                                                                                      |
| `hvacHeatingMaintenanceStarRating`      | string                      | `null` ⚠️ (JSON null), `1`, `2`, `3` — definition maps `1 → Observable issues need to be addressed`, `2 → Standard condition based on the age of the system`, `3 → Well maintained and/or pristine condition` | no  | No description on the param (`undefined` in the definition).                                                                            | **capture** — a condition judgement, the most dictation-shaped field in the resource                                                                             |
| `hvacCoolingMaintenanceStarRating`      | string                      | `null` ⚠️, `1`, `2`, `3` (same mapping)                                                                                                                                                                       | no  | No description.                                                                                                                         | **capture**                                                                                                                                                      |
| `hvacSteadyStateEfficiency`             | number                      | —                                                                                                                                                                                                             | no  | "Measured steady state efficiency as calculated with a combustion gas analyze[r]"                                                       | **capture** — efficiency-named but **the AFUE/SEER precedent does not apply**: this is a value the auditor _measures on site_, not one looked up from make/model |
| `hvacHeatingSystemEfficiency`           | number (0–500, precision 1) | —                                                                                                                                                                                                             | no  | AFUE (combustion + electric resistance) or HSPF (heat pumps). Base side is only to be edited "if you're confident of the actual value". | **capture?** — efficiency; project precedent says AFUE/HSPF is looked up from make/model/year, not read off a plate                                              |
| `hvacCoolingSystemEfficiency`           | number (1–100, precision 1) | —                                                                                                                                                                                                             | no  | SEER, or EER for Room AC only. Units Btu/Wh.                                                                                            | **capture?** — same efficiency precedent (SEER/EER)                                                                                                              |
| `hvacHeatingSystemEfficiencyRatingUnit` | string                      | **`enum: []`** ⚠️                                                                                                                                                                                             | no  | No description at all.                                                                                                                  | **capture?** — efficiency-adjacent (which of AFUE/HSPF the number above means) and the value list is unpublished                                                 |
| `hvacCoolingSystemEfficiencyRatingUnit` | string                      | **`enum: []`** ⚠️                                                                                                                                                                                             | no  | No description at all.                                                                                                                  | **capture?** — as above (SEER vs EER)                                                                                                                            |

##### 4. hvac — uncovered, IMPROVED side (33)

Default verdict for this table is `exclude`: an improved-side value is a _recommended spec_, supplied by the
modeling engine and overridden by the estimator at the desk, not something dictated at the equipment.
The exceptions are the intent-bearing fields, marked `capture?`.

###### 4a. Intent-bearing improved fields (7) — `capture?`

| Wire name                               | Type                                   | Enum members (verbatim)                  | Req | Description (condensed)                                                                 | Verdict                                                                                                                       |
| --------------------------------------- | -------------------------------------- | ---------------------------------------- | --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `hvacHeatingEnergySourceImproved`       | string                                 | **`enum: []`** ⚠️                        | no  | "This is the primary fuel source. It is used to set prices and energy content."         | **capture?** — a fuel switch ("get off the oil") is the single most dictated retrofit intent; blocked on the unpublished enum |
| `hvacHeatingCapacityImproved`           | integer (1 000–1 000 000, precision 0) | —                                        | no  | Output capacity of the heating equipment in Btu/hr (v4+ is Btu/hr, not kBtu/hr).        | **capture?** — sizing intent is spoken ("we'd want a three-ton"), but auditors say tons, not Btu/hr                           |
| `hvacCoolingCapacityImproved`           | integer (1 000–1 000 000, precision 0) | —                                        | no  | Output capacity of the cooling equipment in Btu/hr. "1 ton = 12,000 Btu/hr."            | **capture?** — same; needs a tons→Btu/hr conversion                                                                           |
| `hvacPercentOfTotalHeatingLoadImproved` | number (0–100)                         | —                                        | no  | Share of total heating load the improved system covers; must total 100% across systems. | **capture?** — "the heat pump would carry most of it" is dictated intent, but the value is really a cross-instance allocation |
| `hvacPercentOfTotalCoolingLoadImproved` | number (0–100)                         | —                                        | no  | Share of total cooling load; need not total 100%.                                       | **capture?** — as above                                                                                                       |
| `hvacHeatPumpInverterImproved`          | string                                 | `Yes`, `No`                              | no  | Yes if the proposed heat pump is variable speed / inverter driven.                      | **capture?** — "get a variable-speed unit" is intent, not a purchase spec                                                     |
| `energyStarColdClimateHeatPumpImproved` | string                                 | `1`, `0` ⚠️ (integers on a string field) | no  | "Choose Yes if Energy Star Cold Climate Heat Pump."                                     | **capture?** — a named product-class recommendation, routinely spoken                                                         |

###### 4b. Improved specs (26) — `exclude`

Reason for all rows: improved-side spec of equipment not yet purchased; carried by the estimator, not
dictated in the field. Serial numbers on this side are structurally unfillable at audit time.

| Wire name                                       | Type                         | Enum members (verbatim)                                                                               | Req | Description (condensed)                                                               | Verdict                                                                              |
| ----------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `hvacHeatingSystemManufacturerImproved`         | string                       | **HVAC-HEATING-BRANDS**                                                                               | no  | Manufacturer of the heating equipment.                                                | exclude — improved spec                                                              |
| `hvacCoolingSystemManufacturerImproved`         | string                       | **HVAC-COOLING-BRANDS**                                                                               | no  | Manufacturer of the cooling equipment.                                                | exclude — improved spec                                                              |
| `hvacHeatingSystemModelImproved`                | string                       | —                                                                                                     | no  | Model # of the heating equipment.                                                     | exclude                                                                              |
| `hvacHeatingSystemIndoorModelImproved`          | string                       | —                                                                                                     | no  | Indoor model # of the heating equipment.                                              | exclude                                                                              |
| `hvacHeatingSystemOutdoorModelImproved`         | string                       | —                                                                                                     | no  | Outdoor model # of the heating equipment.                                             | exclude                                                                              |
| `hvacHeatingSystemModelYearImproved`            | string                       | —                                                                                                     | no  | Year the heating equipment was built.                                                 | exclude                                                                              |
| `hvacCoolingSystemModelImproved`                | string                       | —                                                                                                     | no  | Model # of the cooling equipment.                                                     | exclude                                                                              |
| `hvacCoolingSystemIndoorModelImproved`          | string                       | —                                                                                                     | no  | Indoor model # of the cooling equipment.                                              | exclude                                                                              |
| `hvacCoolingSystemOutdoorModelImproved`         | string                       | —                                                                                                     | no  | Outdoor model # of the cooling equipment.                                             | exclude                                                                              |
| `hvacCoolingSystemModelYearImproved`            | string                       | —                                                                                                     | no  | Year the cooling equipment was built.                                                 | exclude                                                                              |
| `hvacHeatingSystemSerialNumberImproved`         | string                       | —                                                                                                     | no  | Comma-separate multiple serials.                                                      | exclude — serial of unbought equipment                                               |
| `hvacHeatingSystemIndoorSerialNumberImproved`   | string                       | —                                                                                                     | no  | Comma-separate multiple serials.                                                      | exclude                                                                              |
| `hvacHeatingSystemOutdoorSerialNumberImproved`  | string                       | —                                                                                                     | no  | Comma-separate multiple serials.                                                      | exclude                                                                              |
| `hvacCoolingSystemSerialNumberImproved`         | string                       | —                                                                                                     | no  | Comma-separate multiple serials.                                                      | exclude                                                                              |
| `hvacCoolingSystemIndoorSerialNumberImproved`   | string                       | —                                                                                                     | no  | Comma-separate multiple serials.                                                      | exclude                                                                              |
| `hvacCoolingSystemOutdoorSerialNumberImproved`  | string                       | —                                                                                                     | no  | Comma-separate multiple serials.                                                      | exclude                                                                              |
| `hvacDuctLocationImproved`                      | string                       | **`enum: []`** ⚠️                                                                                     | no  | Location of the duct work for this system.                                            | exclude — proposed distribution spec                                                 |
| `hvacDuctInsulationImproved`                    | string                       | **DUCT-INSULATION-TYPES**                                                                             | no  | Insulation over the duct work; choose `Measured (R Value)` to enter an R-value below. | exclude — proposed spec (borderline: "we'd insulate those ducts" is dictated intent) |
| `hvacDuctInsulationValueImproved`               | number                       | —                                                                                                     | no  | Actual R-value of the proposed duct insulation.                                       | exclude                                                                              |
| `hvacDuctLeakageImproved`                       | string                       | `30% - Very leaky`, `15% - Somewhat leaky`, `6% - Well sealed`, `3% - Very tight`, `Measured (CFM25)` | no  | Estimated post-retrofit leakage to outside as a % of total air-handler flow.          | exclude — a modelled target, not an observation                                      |
| `hvacDuctLeakageValueImproved`                  | number (0–9999, precision 2) | —                                                                                                     | no  | Post-retrofit duct-blaster leakage to outside at 25 Pa, RESNET §803.7.                | exclude — cannot be measured before the work                                         |
| `hvacHeatingSystemEfficiencyImproved`           | number (0–500, precision 1)  | —                                                                                                     | no  | AFUE / HSPF of the proposed equipment.                                                | exclude — improved **efficiency** spec; see §6                                       |
| `hvacCoolingSystemEfficiencyImproved`           | number (1–100, precision 1)  | —                                                                                                     | no  | SEER / EER of the proposed equipment.                                                 | exclude — improved **efficiency** spec; see §6                                       |
| `hvacSteadyStateEfficiencyImproved`             | number                       | —                                                                                                     | no  | Measured steady state efficiency from a combustion gas analyzer.                      | exclude — unmeasurable pre-install                                                   |
| `hvacHeatingSystemEfficiencyRatingUnitImproved` | string                       | **`enum: []`** ⚠️                                                                                     | no  | No description.                                                                       | exclude — improved efficiency spec, unpublished enum                                 |
| `hvacCoolingSystemEfficiencyRatingUnitImproved` | string                       | **`enum: []`** ⚠️                                                                                     | no  | No description.                                                                       | exclude — improved efficiency spec, unpublished enum                                 |

##### 5. dhw — uncovered (41)

###### 5a. BASE side (20)

| Wire name                  | Type                           | Enum members (verbatim)                                                                                                                                                                                       | Req | Description (condensed)                                                                                                                                                                                          | Verdict                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dhwTemperatureSettings`   | string                         | `Low (120-130 F)`, `Medium (130-140 F)`, `High (140-150 F)`, `Very High (150+ F)`, `Don't Know`                                                                                                               | no  | Temperature setting of the system delivering the DHW. If more than one system, pick the one delivering the most gallons.                                                                                         | **capture** — a dial the auditor reads and calls out                                                                                                                                                                                                                                                            |
| `dhwTemp`                  | integer                        | —                                                                                                                                                                                                             | no  | "Enter the temperature of the water produced by the water heating system."                                                                                                                                       | **capture** — the numeric twin of the band above                                                                                                                                                                                                                                                                |
| `dhwModel`                 | string                         | —                                                                                                                                                                                                             | no  | Model number of the water heater.                                                                                                                                                                                | **capture**                                                                                                                                                                                                                                                                                                     |
| `dhwModelYear`             | string                         | —                                                                                                                                                                                                             | no  | Model year of the water heater.                                                                                                                                                                                  | **capture**                                                                                                                                                                                                                                                                                                     |
| `dhwSerialNumber`          | string                         | —                                                                                                                                                                                                             | no  | "If there is more than one serial number, each serial number should be separated with a comma,"                                                                                                                  | **capture**                                                                                                                                                                                                                                                                                                     |
| `dhwPercentLoad`           | number (0–100, precision 0)    | —                                                                                                                                                                                                             | no  | "Percent of the annual DHW load met by this system. **Both systems** must add up to 100%."                                                                                                                       | **capture** — also the cardinality tell; see §7                                                                                                                                                                                                                                                                 |
| `dhwEnergyStar`            | string                         | `Yes`, `No`                                                                                                                                                                                                   | no  | "Select Yes if this Water Heater is ENERGY STAR Certified."                                                                                                                                                      | **capture** — a label read off the tank                                                                                                                                                                                                                                                                         |
| `dhwHeatingCapacity`       | integer                        | —                                                                                                                                                                                                             | no  | Rated **input** capacity of the water heater in BTU/hr.                                                                                                                                                          | **capture** — note: input, unlike hvac's output capacities                                                                                                                                                                                                                                                      |
| `dhwTankWrap`              | string                         | `Yes`, `No`                                                                                                                                                                                                   | no  | "Select Yes if tank wrap has been applied to this water heater."                                                                                                                                                 | **capture** — a pure visual observation                                                                                                                                                                                                                                                                         |
| `dhwTankWrapRValue`        | integer (1–20, precision 0)    | —                                                                                                                                                                                                             | no  | R-value of the tank wrap applied.                                                                                                                                                                                | **capture**                                                                                                                                                                                                                                                                                                     |
| `dhwPipeWrap`              | string                         | `Yes`, `No`                                                                                                                                                                                                   | no  | "Select Yes if pipe wrap has been applied to the pipes from this water heater."                                                                                                                                  | **capture**                                                                                                                                                                                                                                                                                                     |
| `dhwPipeWrapRValue`        | integer (1–10, precision 0)    | —                                                                                                                                                                                                             | no  | R-value of the pipe wrap applied.                                                                                                                                                                                | **capture**                                                                                                                                                                                                                                                                                                     |
| `dhwMaintenanceStarRating` | string                         | `null` ⚠️ (JSON null), `1`, `2`, `3` — definition maps `1 → Observable issues need to be addressed`, `2 → Standard condition based on the age of the system`, `3 → Well maintained and/or pristine condition` | no  | No description on the param.                                                                                                                                                                                     | **capture** — condition judgement                                                                                                                                                                                                                                                                               |
| `dhwSidearmBoiler`         | string                         | **`enum: []`** ⚠️                                                                                                                                                                                             | no  | "Choose the boiler from the HVAC section that this indirect water heater tank is attached to."                                                                                                                   | **capture?** — dictated in words ("it runs off the basement boiler") but the wire value is a _cross-resource reference to an hvac instance_ with an unpublished enum; needs resolution against the job's hvac list                                                                                              |
| `dhwSidearmStandbyLoss`    | number                         | —                                                                                                                                                                                                             | no  | Description is a copy-paste error — it reads "Enter the temperature of the water produced by the water heating system."                                                                                          | **capture?** — semantics unspecified in the spec; do not model until the real definition of standby loss (units, scale) is confirmed                                                                                                                                                                            |
| `dhwEnergyFactorType`      | string                         | `EF`, `UEF`                                                                                                                                                                                                   | no  | "Enter the type of EnergyFactor"                                                                                                                                                                                 | **capture?** — efficiency-family; a unit selector for the two fields below                                                                                                                                                                                                                                      |
| `dhwEnergyFactor`          | integer                        | —                                                                                                                                                                                                             | no  | Rated Energy Factor **without a decimal** — 0.56 is entered as `56`. Min/max vary by water-heater type. "Energy Factors for most equipment can be found at ahridirectory.org."                                   | **capture?** — efficiency precedent (the description itself says to look it up in the AHRI directory); also a scaling trap ×100                                                                                                                                                                                 |
| `dhwUnifiedEnergyFactor`   | integer                        | —                                                                                                                                                                                                             | no  | Rated Uniform Energy Factor, same ×100 no-decimal convention and AHRI-lookup note.                                                                                                                               | **capture?** — efficiency precedent, same scaling trap                                                                                                                                                                                                                                                          |
| `dhwRecoveryEfficiency`    | number                         | —                                                                                                                                                                                                             | no  | System recovery efficiency. "Optional for modeling but is required for some utility programs such as NYSERDA."                                                                                                   | **capture?** — efficiency precedent, but a named program requires it                                                                                                                                                                                                                                            |
| `hesDhwEnergyFactor`       | number (0.45–4.0, precision 2) | —                                                                                                                                                                                                             | no  | EF of a storage water heater — "**check the EnergyGuide label on the water heater**"; enter as a decimal (e.g. 0.55); "otherwise enter an installed year". Combustion 0.5–0.65, electric 0.8–0.95, HPWH up to 4. | **capture?** — efficiency precedent, but this description explicitly says the value is **read off a label in the field**, which cuts against the "always looked up" rationale. Also a third, differently scaled EF field (decimal, not ×100) with an `hes`-prefixed name — probably the Home Energy Score input |

###### 5b. IMPROVED side (21)

| Wire name                        | Type           | Enum members (verbatim)                                                                 | Req | Description (condensed)                                                                                                    | Verdict                                                                                                    |
| -------------------------------- | -------------- | --------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `dhwType2Improved`               | string         | `Tank Water Heater`, `Tankless Water Heater`, `Heat Pump`, `Sidearm Tank`               | no  | "Enter the type of water heater installed (BASE) or to be installed (IMPROVED)."                                           | **capture?** — pure retrofit intent ("swap it for a heat pump water heater")                               |
| `dhwFuel2Improved`               | string         | `Electricity`, `Natural Gas`, `Fuel Oil`, `Propane`, `Pellets`, `Wood`, `Solar`, `None` | no  | Energy source providing DHW. If several, pick the one providing the most gallons.                                          | **capture?** — fuel-switch intent                                                                          |
| `dhwTankSizeImproved`            | integer        | —                                                                                       | no  | Tank size in gallons.                                                                                                      | **capture?** — "go up to an 80" is spoken sizing intent                                                    |
| `dhwHeatingCapacityImproved`     | integer        | —                                                                                       | no  | Rated input capacity in BTU/hr.                                                                                            | **capture?** — sizing intent, but auditors rarely say BTU/hr for DHW                                       |
| `dhwPercentLoadImproved`         | number (0–100) | —                                                                                       | no  | Percent of annual DHW load met by this system; both systems total 100%.                                                    | **capture?** — allocation intent                                                                           |
| `dhwEnergyStarImproved`          | string         | `Yes`, `No`                                                                             | no  | Yes if ENERGY STAR certified.                                                                                              | **capture?** — "make sure it's an ENERGY STAR one"                                                         |
| `dhwTempImproved`                | integer        | —                                                                                       | no  | Temperature of the water produced.                                                                                         | **capture?** — a setback recommendation ("turn it down to 120") is behavioural advice the auditor dictates |
| `dhwTankWrapImproved`            | string         | `Yes`, `No`                                                                             | no  | Yes if tank wrap has been applied.                                                                                         | **capture?** — "we should wrap that tank" is a dictated measure, not a purchase spec                       |
| `dhwPipeWrapImproved`            | string         | `Yes`, `No`                                                                             | no  | Yes if pipe wrap has been applied to the pipes.                                                                            | **capture?** — same                                                                                        |
| `dhwPipeWrapLengthImproved`      | integer        | —                                                                                       | no  | Length in feet of pipe wrap applied. **Improved-only, no base twin.**                                                      | **capture?** — "about twenty feet of pipe"                                                                 |
| `dhwPipeWrapPercentageImproved`  | number         | —                                                                                       | no  | Percent of total water pipes supplied by this heater that are covered by pipe insulation. **Improved-only, no base twin.** | **capture?** — quantity of a dictated measure                                                              |
| `dhwManufacturerImproved`        | string         | **DHW-BRANDS**                                                                          | no  | Manufacturer of the water heater.                                                                                          | exclude — improved spec                                                                                    |
| `dhwModelImproved`               | string         | —                                                                                       | no  | Model number of the water heater.                                                                                          | exclude — improved spec                                                                                    |
| `dhwModelYearImproved`           | string         | —                                                                                       | no  | Model year of the water heater.                                                                                            | exclude — improved spec                                                                                    |
| `dhwSerialNumberImproved`        | string         | —                                                                                       | no  | Comma-separate multiple serials.                                                                                           | exclude — serial of unbought equipment                                                                     |
| `dhwSidearmBoilerImproved`       | string         | **`enum: []`** ⚠️                                                                       | no  | Boiler from the HVAC section that this indirect tank attaches to.                                                          | exclude — structural reference for a proposed system                                                       |
| `dhwSidearmStandbyLossImproved`  | number         | —                                                                                       | no  | (same copy-paste-wrong description as the base field)                                                                      | exclude — undefined semantics + improved spec                                                              |
| `dhwEnergyFactorTypeImproved`    | string         | `EF`, `UEF`                                                                             | no  | Type of EnergyFactor.                                                                                                      | exclude — improved efficiency spec; see §6                                                                 |
| `dhwEnergyFactorImproved`        | integer        | —                                                                                       | no  | Rated EF without a decimal (0.56 → `56`).                                                                                  | exclude — improved efficiency spec                                                                         |
| `dhwUnifiedEnergyFactorImproved` | integer        | —                                                                                       | no  | Rated UEF without a decimal.                                                                                               | exclude — improved efficiency spec                                                                         |
| `dhwRecoveryEfficiencyImproved`  | number         | —                                                                                       | no  | System recovery efficiency.                                                                                                | exclude — improved efficiency spec                                                                         |

##### 6. Efficiency fields — the precedent, applied

Project precedent: efficiency ratings (AFUE / SEER / HSPF / EF / UEF) were previously ruled **not** capture
fields because they are looked up from make / model / year rather than read off a plate. Every efficiency
field found is listed here rather than dropped.

| Field                                           | Rating        | Side           | Verdict     | Note against the precedent                                                                                                                               |
| ----------------------------------------------- | ------------- | -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hvacHeatingSystemEfficiency`                   | AFUE / HSPF   | base           | capture?    | Precedent applies squarely.                                                                                                                              |
| `hvacHeatingSystemEfficiencyImproved`           | AFUE / HSPF   | improved       | exclude     | Precedent + improved spec.                                                                                                                               |
| `hvacCoolingSystemEfficiency`                   | SEER / EER    | base           | capture?    | Precedent applies squarely.                                                                                                                              |
| `hvacCoolingSystemEfficiencyImproved`           | SEER / EER    | improved       | exclude     | Precedent + improved spec.                                                                                                                               |
| `hvacHeatingSystemEfficiencyRatingUnit`         | which rating  | base           | capture?    | `enum: []`, no description. A unit selector, not a rating — the precedent is arguably silent on it.                                                      |
| `hvacHeatingSystemEfficiencyRatingUnitImproved` | which rating  | improved       | exclude     | As above + improved.                                                                                                                                     |
| `hvacCoolingSystemEfficiencyRatingUnit`         | which rating  | base           | capture?    | `enum: []`, no description.                                                                                                                              |
| `hvacCoolingSystemEfficiencyRatingUnitImproved` | which rating  | improved       | exclude     | As above + improved.                                                                                                                                     |
| `hvacSteadyStateEfficiency`                     | steady state  | base           | **capture** | **Precedent does not apply** — "as calculated with a combustion gas analyze[r]": an on-site instrument reading the auditor speaks aloud.                 |
| `hvacSteadyStateEfficiencyImproved`             | steady state  | improved       | exclude     | Cannot be measured before installation.                                                                                                                  |
| `dhwEnergyFactorType`                           | EF vs UEF     | base           | capture?    | Unit selector.                                                                                                                                           |
| `dhwEnergyFactorTypeImproved`                   | EF vs UEF     | improved       | exclude     |                                                                                                                                                          |
| `dhwEnergyFactor`                               | EF            | base           | capture?    | Precedent applies; description points at ahridirectory.org. ×100 no-decimal encoding.                                                                    |
| `dhwEnergyFactorImproved`                       | EF            | improved       | exclude     |                                                                                                                                                          |
| `dhwUnifiedEnergyFactor`                        | UEF           | base           | capture?    | Precedent applies. ×100 no-decimal encoding.                                                                                                             |
| `dhwUnifiedEnergyFactorImproved`                | UEF           | improved       | exclude     |                                                                                                                                                          |
| `dhwRecoveryEfficiency`                         | recovery eff. | base           | capture?    | Precedent applies, but "required for some utility programs such as NYSERDA" raises the cost of not having it.                                            |
| `dhwRecoveryEfficiencyImproved`                 | recovery eff. | improved       | exclude     |                                                                                                                                                          |
| `hesDhwEnergyFactor`                            | EF (decimal)  | base (no twin) | capture?    | **Precedent is contradicted by the spec text** — "check the EnergyGuide label on the water heater". Decimal 0.45–4.0, unlike the ×100 `dhwEnergyFactor`. |

Not counted as an efficiency field but adjacent: `hvacHeatingIsCondensing` (described purely in terms of the
AFUE it defaults to) and `hvacDuctEfficiency` (response-only, auto-calculated — §8).

##### 7. Cardinality

**Both resources repeat per job. Confirmed from the spec:**

- Both operations are `POST /jobs/{jobId}/<resource>` tagged **"Create Job Collection"** — a create-into-a-collection
  verb under a job, not a job-scoped singleton `PUT`.
- Every instance carries a `uuid` in the response definition ("This is a universally unique ID for this item").
- `hvacSystemName`: "differentiate it from **the others**".
- `hvacPercentOfTotalHeatingLoad`: "The combined heating load percentage for **all heating systems specified**
  must add up to 100%."
- `hvacUpgradeAction = Install a new non-existing system`: "A brand new system that **replaces the system that
  was removed**" — retrofits that change equipment class span two hvac instances.
- `dhwPercentLoad`: "Percent of the annual DHW load met by this system. **Both systems** must add up to 100%."
- `dhwSidearmBoiler`: "Choose **the boiler from the HVAC section**" — a dhw instance can point at an hvac instance.

**How instances are distinguished — the two resources differ, and this matters:**

|                          | hvac                                                                                                        | dhw                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Server identity          | `uuid` (response only)                                                                                      | `uuid` (response only)                                           |
| Human label              | **`hvacSystemName`** — a free-text name, explicitly for telling instances apart                             | **none — there is no `dhwName`**                                 |
| Load share               | `hvacPercentOfTotalHeatingLoad` (must total 100%) and `hvacPercentOfTotalCoolingLoad` (need not total 100%) | `dhwPercentLoad` (must total 100%)                               |
| Practical discriminators | name, equipment type, % of load                                                                             | type (`dhwType2`), fuel (`dhwFuel2`), `dhwPercentLoad`, location |

Consequences worth carrying into the design:

1. **`hvacSystemName` is load-bearing**, not decorative. It is the only human-readable handle on an hvac
   instance, it is what `dhwSidearmBoiler` must resolve against, and it is exactly what an auditor says out
   loud ("the basement furnace", "the old heat pump"). Capture it.
2. **dhw has no name field**, so a second water heater can only be told apart by its type/fuel/location/share.
   Matching a spoken "the one in the garage" to a dhw instance will need `dhwLocation` + `dhwType2` as a
   composite key.
3. `dhwPercentLoad`'s wording — "**Both** systems must add up to 100%" — implies the UI caps DHW at **two**
   instances, whereas hvac's "all heating systems" is open-ended. Worth confirming against the live API
   before assuming a two-item limit.
4. `dhwAge`, `dhwLocation` and `dhwTemperatureSettings` all say "**If more than one type of system is used
   for hot water in the home**, select the … for the one that delivers the most gallons" — i.e. these three
   are documented as _whole-home_ answers even though they sit on a per-instance resource. On a second dhw
   instance their meaning is ambiguous.
5. `hvacPercentOfTotalCoolingLoad` explicitly permits a total below 100% (the remainder is modelled as
   unconditioned), so a validator must not force cooling shares to sum to 100 the way heating shares do.

##### 8. Response-only properties — excluded (40, outside the 119)

Present in the `hvac` / `dhw` definitions but **not** accepted as `formData`. All are ids or engine outputs.

**hvac (28):** `uuid`; `hvacDuctEfficiency`, `hvacDuctEfficiencyImproved` — "It is calculated based on the
above duct leakage, location, and insulation values and **is not editable**";
`hvacHeatingSystemEquivalentFullLoadHours`, `hvacHeatingSystemEquivalentFullLoadHoursImproved`,
`hvacCoolingSystemEquivalentFullLoadHours`, `hvacCoolingSystemEquivalentFullLoadHoursImproved` (no
descriptions; modelled EFLH); the savings block `hvacHeatSavedMbtu`, `hvacHeatSavedKwh`, `hvacHeatSavedTherms`,
`hvacHeatSavedThermsGas`, `hvacHeatSavedThermsPropane`, `hvacHeatSavedThermsOil`, `hvacHeatSavedThermsWood`,
`hvacHeatSavedThermsPellets`, `hvacHeatSavedThermsCoal`, `hvacHeatSavedThermsKerosene`, `hvacCoolSavedMbtu`,
`hvacCoolSavedKwh`, `hvacCoolSavedTherms`, `hvacCoolSavedThermsGas`, `hvacCoolSavedThermsPropane`,
`hvacCoolSavedThermsOil`, `hvacCoolSavedThermsWood`, `hvacCoolSavedThermsPellets`, `hvacCoolSavedThermsCoal`,
`hvacCoolSavedThermsKerosene`; `customFields` (array of `#/definitions/customField`).

**dhw (12):** `uuid`; `dhwSavedMbtu`, `dhwSavedKwh`, `dhwSavedTherms`, `dhwSavedThermsGas`,
`dhwSavedThermsPropane`, `dhwSavedThermsOil`, `dhwSavedThermsWood`, `dhwSavedThermsPellets`,
`dhwSavedThermsCoal`, `dhwSavedThermsKerosene`; `customFields`.

`customFields` is the one row here that is not an engine output — it is a per-tenant extension array. It is
read-only on these endpoints, but it is the escape hatch a program-specific capture field would land in, so
it is worth a separate look.

##### 9. Enum data-quality flags

- **`enum: []` (named but unpublished value list), 10 fields:** `hvacHeatingEnergySource` (covered),
  `hvacHeatingEnergySourceImproved`, `hvacDuctLocation` (covered), `hvacDuctLocationImproved`,
  `hvacHeatingSystemEfficiencyRatingUnit`, `hvacHeatingSystemEfficiencyRatingUnitImproved`,
  `hvacCoolingSystemEfficiencyRatingUnit`, `hvacCoolingSystemEfficiencyRatingUnitImproved`,
  `dhwSidearmBoiler`, `dhwSidearmBoilerImproved`. Two of these (`hvacHeatingEnergySource`, `hvacDuctLocation`)
  are already covered by the existing schema, so its allowed values came from somewhere other than this spec —
  worth reconciling.
- **Typed-wrong enums:** `energyStarColdClimateHeatPump` / `…Improved` declare `type: string` but list the
  JSON **integers** `1` and `0`.
- **`null` as an enum member:** all three maintenance star ratings list a bare JSON `null` alongside the
  strings `"1"`, `"2"`, `"3"`.
- **Duplicate/typo enum members:** `hvacCoolingSystemManufacturer` contains both `Frigidaire` **and**
  `Fridgidaire`; the heating list uses `Comfort Master` where the cooling and dhw lists use `Comfort Maker`;
  `dhwManufacturer` lists `Takaji` (almost certainly Takagi). Any normaliser must map to these exact strings,
  typos included.
- **Cross-resource brand drift:** the heating and cooling manufacturer lists differ (heating adds `Navien`,
  `New Yorker`, `Triangle Tube`; cooling adds `Coolerado`, `Frigidaire`, `Fridgidaire`), and dhw has a third,
  disjoint list. One shared brand vocabulary will not work.
- **Six hvac params and one dhw param carry no description at all** (the four `…EfficiencyRatingUnit` fields
  and the three maintenance star ratings; the star ratings' option meanings exist only in the response
  definition, where the description literally begins with the string `undefined`).

### 5.5 Building envelope — `attic`, `wall`, `window`, `door`, `vault`

Source: Snugg Pro Swagger 2.0, `formData` parameters verbatim. All five resources repeat per job.
Every field in all five creates is `required: false` — see the notes at the end.

#### attic — `POST /jobs/{jobId}/attic`

Total formData fields: **34** — already covered by the existing schema: **5** — new: **29** (14 base-side, 15 improved-side).

**Already covered (excluded from the tables below):** `atticInsulationDepth`, `atticInsulationType`, `atticInsulation`, `atticHasKneeWall`, `atticRoofType`

##### Base side (new)

| field                                   | type   | enum                         | req | description                                                                                                                                                                                                                                     | verdict      |
| --------------------------------------- | ------ | ---------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `atticModeledAtticArea`                 | number | --                           | no  | Interior ceiling surface area (sqft). Self-described auto-calculated from Conditioned Area x Stories, but explicitly overridable -- an auditor does say "the attic is about 1200 square feet". Flagged: writing it overrides the model default. | **capture?** |
| `atticAssemblyRValue`                   | number | --                           | no  | computed -- "not editable since it is calculated from the other fields" (attic insulation + framing/drywall/air film).                                                                                                                          | **exclude**  |
| `atticKneeWallArea`                     | number | --                           | no  | Total surface area of knee wall adjoining this attic space.                                                                                                                                                                                     | **capture**  |
| `atticKneeWallInsulation`               | number | --                           | no  | Total R-value installed (BASE) in the knee wall cavity.                                                                                                                                                                                         | **capture**  |
| `atticKneeWallContinuousInsulation`     | number | --                           | no  | Total R-value of continuous insulation on the knee wall. NOTE: vendor reuses the cavity description verbatim here.                                                                                                                              | **capture**  |
| `atticKneeWallAssemblyRValue`           | number | --                           | no  | computed -- "not editable since it is calculated from the other fields".                                                                                                                                                                        | **exclude**  |
| `atticRadiantBarrier`                   | string | `Yes` · `No`                 | no  | Attic has a radiant barrier. Directly observable and commonly called out on the recording.                                                                                                                                                      | **capture**  |
| `atticPercent`                          | number | --                           | no  | % of total footprint attributed to this attic/vault area. Only meaningful with multiple attic/vault instances; auditors say "about half the attic" rather than a number.                                                                        | **capture?** |
| `atticRoofAbsorptance`                  | number | --                           | no  | Solar absorptance of the roofing above (1 - reflectance). "Default numbers will be supplied automatically" -- a lab coefficient nobody dictates; only in play with a cool-roof spec.                                                            | **capture?** |
| `atticRoofEmissivity`                   | number | --                           | no  | Thermal emittance of the roofing above. Same as absorptance: auto-defaulted coefficient, not speech.                                                                                                                                            | **capture?** |
| `atticCoolRoof`                         | string | `Yes` · `No`                 | no  | Whether to specify cool-roof characteristics. Auditors do say "it is a cool roof".                                                                                                                                                              | **capture**  |
| `atticKneeWallInsulationType`           | string | **CAVITY-INSULATION-TYPES**  | no  | Insulation type in the knee wall cavity (largest-area wins).                                                                                                                                                                                    | **capture**  |
| `atticKneeWallContinuousInsulationType` | string | **RIGID-INSULATION-TYPES**   | no  | Continuous insulation type on the knee wall (largest-area wins).                                                                                                                                                                                | **capture**  |
| `atticRoofColor`                        | string | `White` · `Light` · `Medium` | no  | Roofing colour for this roof section. Trivially dictated; note enum has no Dark member.                                                                                                                                                         | **capture**  |

##### IMPROVED side (new) — proposed-retrofit twins

15 improved-side fields, i.e. 15 BASE/IMPROVED pairs in this resource. Project stance: upgrade _intent_ is dictated, improved _specs_ are not.

| field                                           | type   | enum                                                                                  | req | description                                                                                                                                                    | verdict      |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `atticInsulationTypeImproved`                   | string | `Fiberglass or Rockwool (batts or blown)` · `Cellulose` · `Spray Foam` · `Don't Know` | no  | Retrofit insulation type -- "we will blow cellulose" is intent, and intent is dictated.                                                                        | **capture**  |
| `atticModeledAtticAreaImproved`                 | number | --                                                                                    | no  | New attic sqft after retrofit. Used to model attic->conditioned conversions (set base 1000, improved 0). Structural intent, but a modelled number, not speech. | **capture?** |
| `atticInsulationImproved`                       | number | --                                                                                    | no  | Target R-value to be installed. Borders on intent ("bring it to R-49") but is the spec side of it.                                                             | **capture?** |
| `atticAssemblyRValueImproved`                   | number | --                                                                                    | no  | computed, not editable.                                                                                                                                        | **exclude**  |
| `atticKneeWallAreaImproved`                     | number | --                                                                                    | no  | Improved knee wall area -- spec side.                                                                                                                          | **capture?** |
| `atticKneeWallInsulationImproved`               | number | --                                                                                    | no  | Target knee wall cavity R-value -- spec side.                                                                                                                  | **capture?** |
| `atticKneeWallContinuousInsulationImproved`     | number | --                                                                                    | no  | Target knee wall continuous R-value -- spec side.                                                                                                              | **capture?** |
| `atticKneeWallAssemblyRValueImproved`           | number | --                                                                                    | no  | computed, not editable.                                                                                                                                        | **exclude**  |
| `atticHasKneeWallImproved`                      | string | `Yes` · `No`                                                                          | no  | Knee wall present on the improved side. Odd field: a retrofit rarely creates or removes a knee wall; likely a modelling artefact of the doubling.              | **capture?** |
| `atticRadiantBarrierImproved`                   | string | `Yes` · `No`                                                                          | no  | Add a radiant barrier -- clean upgrade intent.                                                                                                                 | **capture**  |
| `atticRoofAbsorptanceImproved`                  | number | --                                                                                    | no  | Cool-roof spec coefficient -- auto-defaulted, not dictated.                                                                                                    | **capture?** |
| `atticRoofEmissivityImproved`                   | number | --                                                                                    | no  | Cool-roof spec coefficient -- auto-defaulted, not dictated.                                                                                                    | **capture?** |
| `atticCoolRoofImproved`                         | string | `Yes` · `No`                                                                          | no  | Specify a cool roof as the improvement. Intent-shaped, but only used when a roof replacement is actually in the package.                                       | **capture?** |
| `atticKneeWallInsulationTypeImproved`           | string | **CAVITY-INSULATION-TYPES**                                                           | no  | Retrofit knee wall cavity insulation type -- spec side.                                                                                                        | **capture?** |
| `atticKneeWallContinuousInsulationTypeImproved` | string | **RIGID-INSULATION-TYPES**                                                            | no  | Retrofit knee wall continuous insulation type -- spec side.                                                                                                    | **capture?** |

**Cardinality / instance label:** NONE. The attic create accepts 34 formData fields and not one of them is a name, label, description, location or tag. The response definition adds only `uuid` and `customFields[]`; `customFields` is response-only here (not a formData parameter), so via this endpoint an attic instance is addressable only by an opaque server-issued UUID. A dictated "the back attic over the garage" has nowhere to land. The only positional discriminator in the whole resource is `atticPercent` (share of footprint) — a proportion, not an identity.

#### wall — `POST /jobs/{jobId}/wall`

Total formData fields: **16** — already covered by the existing schema: **4** — new: **12** (6 base-side, 6 improved-side).

**Already covered (excluded from the tables below):** `wallsInsulated`, `wallExteriorWallSiding`, `wallCavityInsulation`, `wallCavityInsulationType`

##### Base side (new)

| field                          | type   | enum                         | req | description                                                                                                                                     | verdict      |
| ------------------------------ | ------ | ---------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `wallExteriorWallConstruction` | string | **`enum: []`** (unpublished) | no  | Above-grade exterior wall construction material. UNPUBLISHED ENUM (`enum: []`) -- named but no member list, so free-text into review.           | **capture**  |
| `wallContinuousInsulation`     | number | --                           | no  | Total R-value of continuous insulation (foam/rigid, unbroken across framing) in this wall system.                                               | **capture**  |
| `wallAssemblyRValue`           | number | --                           | no  | computed, not editable. (Description is copy-pasted from the BASEMENT wall field -- says "basement wall system".)                               | **exclude**  |
| `wallModeledWallArea`          | number | --                           | no  | Gross exterior wall area incl. openings; auto-calculated from length x width x height, overridable. +1 ft per storey auto-added for rim joists. | **capture?** |
| `wallSystemPercentOfTotal`     | number | --                           | no  | % of all walls this system represents; systems must total 100%. Only meaningful with 2+ wall systems.                                           | **capture?** |
| `wallContinuousInsulationType` | string | **RIGID-INSULATION-TYPES**   | no  | Type of continuous insulation on the wall (largest-area wins).                                                                                  | **capture**  |

##### IMPROVED side (new) — proposed-retrofit twins

6 improved-side fields, i.e. 6 BASE/IMPROVED pairs in this resource. Project stance: upgrade _intent_ is dictated, improved _specs_ are not.

| field                                  | type   | enum                                                                                                                                                | req | description                                                                                                                                      | verdict      |
| -------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `wallCavityInsulationImproved`         | number | --                                                                                                                                                  | no  | Target cavity R-value -- spec side of the intent.                                                                                                | **capture?** |
| `wallContinuousInsulationImproved`     | number | --                                                                                                                                                  | no  | Target continuous R-value -- spec side.                                                                                                          | **capture?** |
| `wallAssemblyRValueImproved`           | number | --                                                                                                                                                  | no  | computed, not editable.                                                                                                                          | **exclude**  |
| `wallModeledWallAreaImproved`          | number | --                                                                                                                                                  | no  | Improved wall sqft. Partial wall retrofits require building a SECOND wall system rather than a partial area -- an instance-modelling constraint. | **capture?** |
| `wallCavityInsulationTypeImproved`     | string | `null` · `Fiberglass or Rockwool Batt` · `Blown Fiberglass or Rockwool` · `Cellulose` · `Open Cell Spray Foam` · `Closed Cell Spray Foam` · `Other` | no  | Retrofit cavity insulation type -- "dense-pack the walls with cellulose" is dictated intent.                                                     | **capture**  |
| `wallContinuousInsulationTypeImproved` | string | **RIGID-INSULATION-TYPES**                                                                                                                          | no  | Retrofit continuous insulation type -- spec side.                                                                                                | **capture?** |

**Cardinality / instance label:** NONE. No name/label/description field. The spec expects multiple wall _systems_ (`wallSystemPercentOfTotal` must sum to 100% across them, and `wallModeledWallAreaImproved` says a partial retrofit requires building "a second wall system"), yet gives them no human-facing identity — only `uuid` in the response. "The north wall" and "the addition walls" both become anonymous systems distinguished by a percentage.

#### window — `POST /jobs/{jobId}/window`

Total formData fields: **33** — already covered by the existing schema: **3** — new: **30** (19 base-side, 11 improved-side).

**Already covered (excluded from the tables below):** `windowType`, `windowFrame`, `windowEnergyStar`

##### Base side (new)

| field                            | type   | enum                          | req | description                                                                                                                                                                                                                                                                                                                        | verdict      |
| -------------------------------- | ------ | ----------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `windowNorthAreaPercent`         | number | --                            | no  | % of EXPOSED north wall area that is glass. Alternative to the absolute area field; auditors give counts/sizes, not percentages.                                                                                                                                                                                                   | **capture?** |
| `windowEfficiency`               | number | --                            | no  | Average gross window U-value incl. frame effects. Off an NFRC sticker if the auditor reads one; otherwise modelled.                                                                                                                                                                                                                | **capture?** |
| `windowAreaNorth`                | number | --                            | no  | Total existing window area on the north elevation of this window system.                                                                                                                                                                                                                                                           | **capture**  |
| `windowAreaEast`                 | number | --                            | no  | Total existing window area on the east elevation.                                                                                                                                                                                                                                                                                  | **capture**  |
| `windowAreaSouth`                | number | --                            | no  | Total existing window area on the south elevation.                                                                                                                                                                                                                                                                                 | **capture**  |
| `windowAreaWest`                 | number | --                            | no  | Total existing window area on the west elevation.                                                                                                                                                                                                                                                                                  | **capture**  |
| `windowSolarHeatGainCoefficient` | number | --                            | no  | Average gross SHGC. Explicitly must NOT be adjusted for screens/shades (use the Exterior Treatment fields) -- a real mis-mapping risk for dictated "it has solar screens".                                                                                                                                                         | **capture?** |
| `windowEastAreaPercent`          | number | --                            | no  | % of EXPOSED east wall area that is glass.                                                                                                                                                                                                                                                                                         | **capture?** |
| `windowSouthAreaPercent`         | number | --                            | no  | % of EXPOSED south wall area that is glass.                                                                                                                                                                                                                                                                                        | **capture?** |
| `windowWestAreaPercent`          | number | --                            | no  | % of EXPOSED west wall area that is glass.                                                                                                                                                                                                                                                                                         | **capture?** |
| `windowNorthOverhangDepth`       | number | --                            | no  | Average overhang width in feet, north elevation.                                                                                                                                                                                                                                                                                   | **capture**  |
| `windowEastOverhangDepth`        | number | --                            | no  | Average overhang width in feet, east elevation.                                                                                                                                                                                                                                                                                    | **capture**  |
| `windowSouthOverhangDepth`       | number | --                            | no  | Average overhang width in feet, south elevation.                                                                                                                                                                                                                                                                                   | **capture**  |
| `windowWestOverhangDepth`        | number | --                            | no  | Average overhang width in feet, west elevation.                                                                                                                                                                                                                                                                                    | **capture**  |
| `windowExteriorTreatmentNorth`   | string | **WINDOW-EXTERIOR-TREATMENT** | no  | Exterior shading device on north windows. Highly dictatable ("solar screens on the west side").                                                                                                                                                                                                                                    | **capture**  |
| `windowExteriorTreatmentEast`    | string | **WINDOW-EXTERIOR-TREATMENT** | no  | Exterior shading device on east windows.                                                                                                                                                                                                                                                                                           | **capture**  |
| `windowExteriorTreatmentSouth`   | string | **WINDOW-EXTERIOR-TREATMENT** | no  | Exterior shading device on south windows.                                                                                                                                                                                                                                                                                          | **capture**  |
| `windowExteriorTreatmentWest`    | string | **WINDOW-EXTERIOR-TREATMENT** | no  | Exterior shading device on west windows.                                                                                                                                                                                                                                                                                           | **capture**  |
| `windowHesSpecs`                 | string | `Yes` · `No`                  | no  | Excluded for a fourth reason beyond id/timestamp/computed: this is a product-MODE flag ("used for Snugg Score jobs, not audits") that switches which other fields the API demands (Yes => U-value + SHGC required; No => type + frame required). Not a house observation; it should be set by the writer, never by the transcript. | **exclude**  |

##### IMPROVED side (new) — proposed-retrofit twins

11 improved-side fields, i.e. 11 BASE/IMPROVED pairs in this resource. Project stance: upgrade _intent_ is dictated, improved _specs_ are not.

| field                                    | type   | enum                          | req | description                                                                                                                                                                                 | verdict      |
| ---------------------------------------- | ------ | ----------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `windowEfficiencyImproved`               | number | --                            | no  | Target U-value of replacement glazing -- improved spec.                                                                                                                                     | **capture?** |
| `windowAreaNorthImproved`                | number | --                            | no  | Area of north windows ACTUALLY being replaced; the base/improved delta is assumed unchanged. This is how the vendor encodes which windows get replaced -- i.e. dictated intent, not a spec. | **capture**  |
| `windowAreaEastImproved`                 | number | --                            | no  | Area of east windows actually being replaced (intent encoding).                                                                                                                             | **capture**  |
| `windowAreaSouthImproved`                | number | --                            | no  | Area of south windows actually being replaced (intent encoding).                                                                                                                            | **capture**  |
| `windowAreaWestImproved`                 | number | --                            | no  | Area of west windows actually being replaced (intent encoding).                                                                                                                             | **capture**  |
| `windowSolarHeatGainCoefficientImproved` | number | --                            | no  | Target SHGC of replacement glazing -- improved spec.                                                                                                                                        | **capture?** |
| `windowExteriorTreatmentNorthImproved`   | string | **WINDOW-EXTERIOR-TREATMENT** | no  | Shading device to be added on the north -- upgrade intent.                                                                                                                                  | **capture**  |
| `windowExteriorTreatmentEastImproved`    | string | **WINDOW-EXTERIOR-TREATMENT** | no  | Shading device to be added on the east -- upgrade intent.                                                                                                                                   | **capture**  |
| `windowExteriorTreatmentSouthImproved`   | string | **WINDOW-EXTERIOR-TREATMENT** | no  | Shading device to be added on the south -- upgrade intent.                                                                                                                                  | **capture**  |
| `windowExteriorTreatmentWestImproved`    | string | **WINDOW-EXTERIOR-TREATMENT** | no  | Shading device to be added on the west -- upgrade intent.                                                                                                                                   | **capture**  |
| `windowEnergyStarImproved`               | string | `Yes` · `No`                  | no  | "Replace with ENERGY STAR windows" -- upgrade intent.                                                                                                                                       | **capture**  |

**Cardinality / instance label:** NONE, but this is the one resource with a built-in spatial axis: every area, percent, overhang and exterior-treatment field is quadrupled by orientation (North/East/South/West). So "the west windows" IS addressable — as a _field suffix_, not as an instance. "The front bedroom windows" is not addressable at all. Multiple window _systems_ per job are expected ("If more than one type of window is installed, add a second window system") and are unnamed; only `uuid` distinguishes them.

#### door — `POST /jobs/{jobId}/door`

Total formData fields: **7** — already covered by the existing schema: **0** — new: **7** (4 base-side, 3 improved-side).

**Already covered:** none — every field is new.

##### Base side (new)

| field            | type   | enum                                                                                                                                                                                                                                                                                                                                                     | req | description                                                                                                                                                            | verdict      |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `doorType`       | string | `Steel, hollow` · `Steel, hollow with storm` · `Steel, insulated` · `Steel, insulated with Storm` · `Wood` · `Wood with Storm` · `Fiberglass` · `Fiberglass with Storm` · `1/2-Lite Steel, insulated` · `1/2-Lite Steel, insulated with Storm` · `1/2-Lite Wood` · `1/2-Lite Wood with Storm` · `1/2-Lite Fiberglass` · `1/2-Lite Fiberglass with Storm` | no  | Door construction. Rich 14-member enum encoding material, insulation, half-lite glazing and storm door in one string -- an auditor says these as three separate facts. | **capture**  |
| `doorUValue`     | number | --                                                                                                                                                                                                                                                                                                                                                       | no  | Auto-calculated from the input form, overridable with the actual U-value.                                                                                              | **capture?** |
| `doorArea`       | number | --                                                                                                                                                                                                                                                                                                                                                       | no  | Auto-calculated, overridable with actual door sizes. Doors >=50% glazing must be modelled as WINDOWS at rough-opening area -- a routing rule, not a field rule.        | **capture?** |
| `doorEnergyStar` | string | `Yes` · `No`                                                                                                                                                                                                                                                                                                                                             | no  | This door is ENERGY STAR certified.                                                                                                                                    | **capture**  |

##### IMPROVED side (new) — proposed-retrofit twins

3 improved-side fields, i.e. 3 BASE/IMPROVED pairs in this resource. Project stance: upgrade _intent_ is dictated, improved _specs_ are not.

| field                    | type   | enum         | req | description                                              | verdict      |
| ------------------------ | ------ | ------------ | --- | -------------------------------------------------------- | ------------ |
| `doorUValueImproved`     | number | --           | no  | Target U-value of the replacement door -- improved spec. | **capture?** |
| `doorAreaImproved`       | number | --           | no  | Door area on the improved side -- improved spec.         | **capture?** |
| `doorEnergyStarImproved` | string | `Yes` · `No` | no  | "Put in an ENERGY STAR door" -- upgrade intent.          | **capture**  |

**Cardinality / instance label:** NONE — and worse than the others. There is no name, no label, no location, AND no count/quantity field: `doorArea` is a single aggregate area that "you may override with the actual door sizes for the home" (plural). So the resource is closer to a door _aggregate_ than a door instance, and "the front door" cannot be identified or even separated from the back door without creating two instances that look identical on the wire.

#### vault (vaulted / cathedral ceiling) — `POST /jobs/{jobId}/vault`

Total formData fields: **22** — already covered by the existing schema: **0** — new: **22** (13 base-side, 9 improved-side).

**Already covered:** none — every field is new.

##### Base side (new)

| field                           | type   | enum                                                                        | req | description                                                                                                                                                                                                                                                                                                                                           | verdict      |
| ------------------------------- | ------ | --------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `vaultModeledVaultArea`         | number | --                                                                          | no  | Interior surface area of the vaulted ceiling; auto-calculated with a default 5/12 roof pitch, overridable.                                                                                                                                                                                                                                            | **capture?** |
| `vaultCavityInsulation`         | number | --                                                                          | no  | Total R-value installed in the vaulted ceiling cavity.                                                                                                                                                                                                                                                                                                | **capture**  |
| `vaultContinuousInsulation`     | number | --                                                                          | no  | Total R-value of continuous insulation on the vaulted ceiling.                                                                                                                                                                                                                                                                                        | **capture**  |
| `vaultAssemblyRValue`           | number | --                                                                          | no  | computed, not editable.                                                                                                                                                                                                                                                                                                                               | **exclude**  |
| `vault`                         | string | `Well` · `Yes` · `Poorly` · `No`                                            | no  | Insulation quality of the vaulted cavities -- the sibling of `wallsInsulated`, but the wire name is bare `vault`, identical to the resource name. Well = full depth, <=5% voids; Poorly = majority filled but low density/depth/quality suspected; Yes = confirmed present, quality unknown; No = no insulation value applied. Leave blank if unsure. | **capture**  |
| `vaultPercent`                  | number | --                                                                          | no  | % of total footprint attributed to this attic/vault area (shared description with atticPercent).                                                                                                                                                                                                                                                      | **capture?** |
| `vaultRoofAbsorptance`          | number | --                                                                          | no  | Solar absorptance of roofing above the vault -- auto-defaulted coefficient.                                                                                                                                                                                                                                                                           | **capture?** |
| `vaultRoofEmissivity`           | number | --                                                                          | no  | Thermal emittance of roofing above the vault -- auto-defaulted coefficient.                                                                                                                                                                                                                                                                           | **capture?** |
| `vaultCoolRoof`                 | string | `Yes` · `No`                                                                | no  | Specify cool-roof characteristics for this vault section.                                                                                                                                                                                                                                                                                             | **capture**  |
| `vaultCavityInsulationType`     | string | **CAVITY-INSULATION-TYPES**                                                 | no  | Insulation type in the vault cavity (largest-area wins).                                                                                                                                                                                                                                                                                              | **capture**  |
| `vaultContinuousInsulationType` | string | **RIGID-INSULATION-TYPES**                                                  | no  | Continuous insulation type on the vault.                                                                                                                                                                                                                                                                                                              | **capture**  |
| `vaultRoofType`                 | string | `Composition Shingles` · `Concrete Tile` · `Wood Shakes` · `Tar and Gravel` | no  | Roofing material for this roof section (same enum as atticRoofType, which IS already covered -- reuse it).                                                                                                                                                                                                                                            | **capture**  |
| `vaultRoofColor`                | string | `White` · `Light` · `Medium`                                                | no  | Roofing colour for this roof section.                                                                                                                                                                                                                                                                                                                 | **capture**  |

##### IMPROVED side (new) — proposed-retrofit twins

9 improved-side fields, i.e. 9 BASE/IMPROVED pairs in this resource. Project stance: upgrade _intent_ is dictated, improved _specs_ are not.

| field                                   | type   | enum                        | req | description                                                                                    | verdict      |
| --------------------------------------- | ------ | --------------------------- | --- | ---------------------------------------------------------------------------------------------- | ------------ |
| `vaultModeledVaultAreaImproved`         | number | --                          | no  | New vault sqft; increased when converting an unconditioned attic to conditioned vaulted space. | **capture?** |
| `vaultCavityInsulationImproved`         | number | --                          | no  | Target cavity R-value -- spec side.                                                            | **capture?** |
| `vaultContinuousInsulationImproved`     | number | --                          | no  | Target continuous R-value -- spec side.                                                        | **capture?** |
| `vaultAssemblyRValueImproved`           | number | --                          | no  | computed, not editable.                                                                        | **exclude**  |
| `vaultRoofAbsorptanceImproved`          | number | --                          | no  | Cool-roof spec coefficient -- not dictated.                                                    | **capture?** |
| `vaultRoofEmissivityImproved`           | number | --                          | no  | Cool-roof spec coefficient -- not dictated.                                                    | **capture?** |
| `vaultCoolRoofImproved`                 | string | `Yes` · `No`                | no  | Cool roof as the improvement -- only with an actual roof replacement.                          | **capture?** |
| `vaultCavityInsulationTypeImproved`     | string | **CAVITY-INSULATION-TYPES** | no  | Retrofit cavity insulation type -- "spray foam the vault" is dictated intent.                  | **capture**  |
| `vaultContinuousInsulationTypeImproved` | string | **RIGID-INSULATION-TYPES**  | no  | Retrofit continuous insulation type -- spec side.                                              | **capture?** |

**Cardinality / instance label:** NONE. Same shape as attic: no name/label field, `uuid` only, and `vaultPercent` (share of footprint) as the sole discriminator between multiple vault instances.

#### Counts

| resource     |   total | already covered | new `capture` | new `capture?` | `exclude` | improved-side |
| ------------ | ------: | --------------: | ------------: | -------------: | --------: | ------------: |
| attic        |      34 |               5 |            10 |             15 |         4 |            15 |
| wall         |      16 |               4 |             4 |              6 |         2 |             6 |
| window       |      33 |               3 |            21 |              8 |         1 |            11 |
| door         |       7 |               0 |             3 |              4 |         0 |             3 |
| vault        |      22 |               0 |             9 |             11 |         2 |             9 |
| **all five** | **112** |          **12** |        **47** |         **44** |     **9** |        **44** |

#### Cross-cutting notes

**Unpublished enums (`enum: []` — free-text into review).** Exactly one across these five resources: `wallExteriorWallConstruction`. It is a named dropdown ("Select the type of construction material used to build the exterior walls of the home that are above grade") with no member list published, so a dictated "two-by-four stick frame" or "block" has to go through review rather than be validated.

**Null enum member.** `wallCavityInsulationType` and `wallCavityInsulationTypeImproved` publish a literal `null` as the FIRST enum member, ahead of `Fiberglass or Rockwool Batt`. No other enum across these five resources does this. Both are on the already-covered list, so check the existing schema tolerates an explicit null.

**Nothing is required.** All 112 formData parameters across the five creates are `required: false`. A create with an empty body is legal, so the API will not catch a dropped field — validation is entirely Ribo's problem.

**No instance labels anywhere.** Zero of the five resources offers a name, label, title, description, location or tag field. The only per-instance identity is the server-issued `uuid` in the response, and `customFields[]` appears in the response definitions but is not a formData parameter on these creates. Instance modelling therefore cannot round-trip "the back attic" or "the front bedroom windows" through the vendor — any human-facing label has to live on Ribo's side and be mapped to a `uuid`.

**`Don't Know` is a first-class enum member** in `atticInsulationDepth`, `atticInsulationType`(`Improved`), `wallExteriorWallSiding`, `windowType` and `windowFrame` — an honest target for auditor hedging, but note it exists only on those five and not on the knee-wall, continuous-insulation or roof enums, which instead offer `Other`.

**Same enum, different member order.** The insulation-quality enum is `Well` · `Poorly` · `Yes` · `No` on `wallsInsulated` (covered) but `Well` · `Yes` · `Poorly` · `No` on `vault` (new), with identical descriptions. Anything that treats enum position as ordinal, or shares one value list between the two, will silently swap `Poorly` and `Yes`.

**Cross-resource leak.** `atticInsulationDepth` (covered) tells the auditor: "If there is no attic and instead vaulted ceilings, enter an estimate of the thickness of insulation in the vaulted cavity." The vault resource has no depth field at all, so vault insulation depth is dictated into an _attic_ field. Extraction routing must know this.

**Copy-paste errors in the vendor's own descriptions.** `wallAssemblyRValue`/`Improved` describe "the entire basement wall system"; `atticKneeWallContinuousInsulation` reuses the cavity-insulation sentence verbatim ("in this Knee Wall cavity") instead of describing continuous insulation. Treat descriptions as approximate.

### 5.6 Appliances and PV — `clothesDryer`, `freezer`, `range`, `refrigerator`, `pv`

Five repeating job-collection resources, all `POST /jobs/{jobId}/<resource>`, all fields `required: false`.
Companion write endpoints confirmed present for all five: `POST /jobs/<resource>/{uuid}` (update) and `DELETE /jobs/<resource>/{uuid}`; read via `GET /jobs/{jobId}/<resource>s`.

**Conventions used below**

- **IMPROVED/BASE doubling.** This vendor pairs "what is installed" (base) with "what you recommend installing" (`…Improved`). Improved fields are labelled `improved-side` and counted in their own column; they are observationally identical in type/enum/description to their base twin unless noted. They are **deferred to tranche 18, not excluded** — §4.1 sets out why the improved side carries dictated retrofit intent rather than desk-side specs ("I'd swap that for a heat-pump dryer").
- **`enum: false`** is the vendor's _no enum published_ marker (§4.5). **No field on these five resources has `enum: []`** — checked programmatically across both the `formData` params and the response definitions; zero hits. The nearest thing is `refrigeratorMaintenanceStarRating`, whose enum contains a literal JSON `null` as its first member.
- Response definitions add exactly two properties per resource that are absent from the create form: `uuid` (internal id — exclude) and `customFields` (array of `#/definitions/customField` — exclude, not a scalar target). These are response-only and are not counted in the per-resource totals, which count `formData` params.

---

##### clothesDryer — `POST /jobs/{jobId}/clothesDryer` (12 fields)

| #   | wire name                          | type   | enum (verbatim)                                               | req   | description (condensed)                                                                                                       | verdict                                                                                                                                                          |
| --- | ---------------------------------- | ------ | ------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `clothesDryerFuelType`             | string | `Natural Gas`, `Electricity`, `Propane`, `None`, `Don't Know` | false | Type of clothes dryer used in the home; if more than one, the one used most often.                                            | **capture**                                                                                                                                                      |
| 2   | `clothesDryerFuelTypeImproved`     | string | `Natural Gas`, `Electricity`, `Propane`, `None`, `Don't Know` | false | (identical text)                                                                                                              | improved-side                                                                                                                                                    |
| 3   | `clothesDryerHeatPump`             | string | `Yes`, `No`                                                   | false | Yes if this is a ventless/heat pump dryer.                                                                                    | **capture**                                                                                                                                                      |
| 4   | `clothesDryerHeatPumpImproved`     | string | `Yes`, `No`                                                   | false | (identical text)                                                                                                              | improved-side                                                                                                                                                    |
| 5   | `clothesDryerEfficiency`           | number | — (`enum: false`)                                             | false | Rated Combined Energy Factor per the Energy Star website. If only EF available, CEF=EF/1.15. Def: min 0, max 20, precision 2. | **capture?** — pure spec-sheet/lookup value with an inline hand-computation; almost never spoken. Not auto-calculated by the vendor, so not an outright exclude. |
| 6   | `clothesDryerEfficiencyImproved`   | number | —                                                             | false | (identical text)                                                                                                              | improved-side                                                                                                                                                    |
| 7   | `clothesDryerManufacturer`         | string | — (free text — **not** an enum, unlike freezer/refrigerator)  | false | Manufacturer of the Clothes Dryer.                                                                                            | **capture**                                                                                                                                                      |
| 8   | `clothesDryerManufacturerImproved` | string | —                                                             | false | (identical text)                                                                                                              | improved-side                                                                                                                                                    |
| 9   | `clothesDryerModel`                | string | —                                                             | false | Model of the Clothes Dryer.                                                                                                   | **capture?** — nameplate read-aloud; alphanumeric, high ASR error rate.                                                                                          |
| 10  | `clothesDryerModelImproved`        | string | —                                                             | false | (identical text)                                                                                                              | improved-side                                                                                                                                                    |
| 11  | `clothesDryerSerialNumber`         | string | —                                                             | false | Serial number of the Clothes Dryer.                                                                                           | **capture?** — long alphanumeric, rarely dictated, worst ASR case of any field here. Include-and-flag per the broad stance.                                      |
| 12  | `clothesDryerSerialNumberImproved` | string | —                                                             | false | (identical text)                                                                                                              | improved-side                                                                                                                                                    |

**Cardinality / instance label: NONE.** There is no name, label, or location field. Two dryers on one job are indistinguishable except by fuel/manufacturer/model. A dictated "the dryer in the basement" has no writable home — location is unrepresentable.

Counts — total 12 · capture 3 · capture? 3 · exclude 0 · improved-side 6.

---

##### freezer — `POST /jobs/{jobId}/freezer` (11 fields)

| #   | wire name                     | type   | enum (verbatim)    | req   | description (condensed)                                                                                                                                                                                                                                                   | verdict                                                                                                                                                                                                                         |
| --- | ----------------------------- | ------ | ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `freezerUsage`                | number | —                  | false | Annual energy consumption in kWh/yr. Note: "Edit this Base field … only if you're confident of the actual value… The modeling engine utilizes utility data and input form data to determine the 'effective' values on the Base side." Def: min 0, max 10000, precision 2. | **capture?** — borders the auto-calculated exclusion: the vendor says the modeling engine supplies it and warns against overriding. Kept as capture? only because it is explicitly overridable. Auditors do not dictate kWh/yr. |
| 2   | `freezerUsageImproved`        | number | —                  | false | Same text; adds "Default values are supplied by the modeling engine, but can be overridden."                                                                                                                                                                              | improved-side                                                                                                                                                                                                                   |
| 3   | `freezerManufacturer`         | string | **FREEZER-BRANDS** | false | Manufacturer of the Freezer.                                                                                                                                                                                                                                              | **capture** — closed list. ⚠ contains BOTH `Frigidaire` and the misspelling `Fridgidaire`.                                                                                                                                      |
| 4   | `freezerManufacturerImproved` | string | **FREEZER-BRANDS** | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                   |
| 5   | `freezerModelYear`            | string | —                  | false | Model Year of the Freezer. Def: `type: string` but min 1900, max 2027, precision 0.                                                                                                                                                                                       | **capture** — "probably from the nineties" is a canonical auditor utterance. ⚠ string-typed number; needs a decade→year decision and a wire-format check.                                                                       |
| 6   | `freezerModelYearImproved`    | string | —                  | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                   |
| 7   | `freezerModel`                | string | —                  | false | Model number for the Freezer.                                                                                                                                                                                                                                             | **capture?** — nameplate read-aloud.                                                                                                                                                                                            |
| 8   | `freezerModelImproved`        | string | —                  | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                   |
| 9   | `freezerName`                 | string | —                  | false | **No description at all** on the create param; `""` in the response definition. No maxLength published.                                                                                                                                                                   | **capture** — the only human-facing instance label on this resource.                                                                                                                                                            |
| 10  | `freezerEnergyStar`           | string | `Yes`, `No`        | false | If a Freezer is installed in the home, choose if it is an ENERGY STAR model.                                                                                                                                                                                              | **capture**                                                                                                                                                                                                                     |
| 11  | `freezerEnergyStarImproved`   | string | `Yes`, `No`        | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                   |

**Cardinality / instance label: YES — `freezerName`,** free text, undocumented, no length cap. It is the only place "garage chest freezer" could land, and it is doing double duty as both label _and_ the missing location field _and_ the missing type field (there is no chest-vs-upright field anywhere). Note `freezerName` is the one base field with **no** `…Improved` twin.

Counts — total 11 · capture 4 · capture? 2 · exclude 0 · improved-side 5.

---

##### range — `POST /jobs/{jobId}/range` (10 fields)

| #   | wire name                   | type   | enum (verbatim)                                               | req   | description (condensed)                                                                                                                                                                                                                                   | verdict                                                                                            |
| --- | --------------------------- | ------ | ------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `rangeFuelType`             | string | `Natural Gas`, `Electricity`, `Propane`, `None`, `Don't Know` | false | "Select the type of energy source used by the range **and oven** in the home. If the home has more than one range and oven, select the one that is used the most. If the range and oven are dual fuel … select the type that is used to cook most often." | **capture** — see the oven section: this single field is the only writable home for oven fuel too. |
| 2   | `rangeFuelTypeImproved`     | string | `Natural Gas`, `Electricity`, `Propane`, `None`, `Don't Know` | false | (identical text)                                                                                                                                                                                                                                          | improved-side                                                                                      |
| 3   | `rangeInduction`            | string | `Yes`, `No`                                                   | false | Yes if the electric cooktop is induction (not electric resistance).                                                                                                                                                                                       | **capture**                                                                                        |
| 4   | `rangeInductionImproved`    | string | `Yes`, `No`                                                   | false | (identical text)                                                                                                                                                                                                                                          | improved-side                                                                                      |
| 5   | `rangeManufacturer`         | string | — (free text)                                                 | false | Manufacturer of the Range.                                                                                                                                                                                                                                | **capture**                                                                                        |
| 6   | `rangeManufacturerImproved` | string | —                                                             | false | (identical text)                                                                                                                                                                                                                                          | improved-side                                                                                      |
| 7   | `rangeModel`                | string | —                                                             | false | Model of the Range.                                                                                                                                                                                                                                       | **capture?** — nameplate.                                                                          |
| 8   | `rangeModelImproved`        | string | —                                                             | false | (identical text)                                                                                                                                                                                                                                          | improved-side                                                                                      |
| 9   | `rangeSerialNumber`         | string | —                                                             | false | Serial number of the Range.                                                                                                                                                                                                                               | **capture?** — rarely dictated, high ASR error.                                                    |
| 10  | `rangeSerialNumberImproved` | string | —                                                             | false | (identical text)                                                                                                                                                                                                                                          | improved-side                                                                                      |

**Cardinality / instance label: NONE.** No name, label, or location field. Also no field for a standing pilot — "gas range with a standing pilot" degrades to `Natural Gas` and the pilot detail is lost (no writable target).

Counts — total 10 · capture 3 · capture? 2 · exclude 0 · improved-side 5.

---

##### refrigerator — `POST /jobs/{jobId}/refrigerator` (14 fields)

| #   | wire name                           | type   | enum (verbatim)                                                                   | req   | description (condensed)                                                                                                                                                                                                                                                   | verdict                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------- | ------ | --------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `refrigeratorAge`                   | string | `0-14`, `15-21`, `22-24`, `25-26`, `27-30`, `31-34`, `35-42`, `42+`, `Don't Know` | false | Select the age range of this refrigerator.                                                                                                                                                                                                                                | **capture** — banded, speech-shaped. ⚠ `35-42` and `42+` overlap at 42; bands are irregular in width. Also note there is **no** `…Improved` twin for Age.                                                                                                                           |
| 2   | `refrigeratorSize`                  | string | `1-5`, `6-12`, `13-15`, `16-18`, `19-21`, `22+`, `Don't Know`                     | false | Select the size range of this refrigerator. (Cubic feet — unit stated only in `refrigeratorName`'s description.)                                                                                                                                                          | **capture** — banded. No `…Improved` twin.                                                                                                                                                                                                                                          |
| 3   | `refrigeratorName`                  | string | —                                                                                 | false | ⚠ Description is a copy-paste bug — it reads "Select the age range and the size range in cubic feet of the refrigerator. For HPXML purposes, always enter the house's \"primary\" refrigerator first." Def: maxLength 30.                                                 | **capture** — the instance label, despite the wrong help text. The HPXML sentence is a real ordering constraint: the primary fridge must be POSTed first.                                                                                                                           |
| 4   | `refrigeratorUsage`                 | number | —                                                                                 | false | Annual energy consumption in kWh/yr; same modeling-engine note as `freezerUsage`. Def: min 0, max 10000, precision 2.                                                                                                                                                     | **capture?** — borders auto-calculated; not narrated.                                                                                                                                                                                                                               |
| 5   | `refrigeratorUsageImproved`         | number | —                                                                                 | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                                                                       |
| 6   | `refrigeratorManufacturer`          | string | **FRIDGE-BRANDS**                                                                 | false | Manufacturer of the Refrigerator.                                                                                                                                                                                                                                         | **capture** — ⚠ again both `Frigidaire` and `Fridgidaire`; ⚠ this list is **not** the freezer list (adds `Hotpoint`, `KitchenAid`, `Fisher & Paykel`, `Ikea`, `Liebherr`; drops `Igloo`; different leading member).                                                                 |
| 7   | `refrigeratorManufacturerImproved`  | string | **FRIDGE-BRANDS**                                                                 | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                                                                       |
| 8   | `refrigeratorModel`                 | string | —                                                                                 | false | Model number for the Refrigerator. Def: maxLength 255.                                                                                                                                                                                                                    | **capture?** — nameplate.                                                                                                                                                                                                                                                           |
| 9   | `refrigeratorModelImproved`         | string | —                                                                                 | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                                                                       |
| 10  | `refrigeratorEnergyStar`            | string | `Yes`, `No`                                                                       | false | If a Refrigerator is installed in the home, choose if it is an ENERGY STAR model.                                                                                                                                                                                         | **capture**                                                                                                                                                                                                                                                                         |
| 11  | `refrigeratorEnergyStarImproved`    | string | `Yes`, `No`                                                                       | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                                                                       |
| 12  | `refrigeratorModelYear`             | string | —                                                                                 | false | Model Year of the Refrigerator. Def: `type: string`, min 1900, max 2027, precision 0, no example.                                                                                                                                                                         | **capture** — ⚠ redundant with `refrigeratorAge`; a dictated age can populate either, and the two can contradict. Pick one as primary.                                                                                                                                              |
| 13  | `refrigeratorModelYearImproved`     | string | —                                                                                 | false | (identical text)                                                                                                                                                                                                                                                          | improved-side                                                                                                                                                                                                                                                                       |
| 14  | `refrigeratorMaintenanceStarRating` | string | `null` (literal JSON null), `1`, `2`, `3`                                         | false | ⚠ **No description at all on the create param.** The response definition carries: "undefined / Field options: null → ; 1 → Observable issues need to be addressed; 2 → Standard condition based on the age of the system; 3 → Well maintained and/or pristine condition". | **capture?** — condition is narrated constantly ("it's in rough shape"), so semantically a strong capture; flagged because the create endpoint publishes no meaning, the enum carries a literal `null` member, and the vendor's own description begins with the string "undefined". |

**Cardinality / instance label: YES — `refrigeratorName`,** free text, maxLength 30, with a wrong description. Plus a hard ordering rule: the primary refrigerator must be created first for HPXML. No location field (kitchen vs garage beer fridge is unrepresentable except inside the Name string), and no type field (no mini-fridge/beverage-centre distinction; `refrigeratorSize` bands are the only proxy).

Counts — total 14 · capture 6 · capture? 3 · exclude 0 · improved-side 5.

---

##### pv — `POST /jobs/{jobId}/pv` (11 fields) — rooftop solar PV array

| #   | wire name                    | type    | enum (verbatim) | req   | description (condensed)                                                                                                                                      | verdict                                                                                                                                                                                                                                     |
| --- | ---------------------------- | ------- | --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pv`                         | string  | `Yes`, `No`     | false | Does the home have a Solar PV System?                                                                                                                        | **capture** — ⚠ a whole-home presence flag living on a _per-instance repeating_ resource; creating a `pv` record with `pv: No` is semantically odd. Treat as "this array exists".                                                           |
| 2   | `pvImproved`                 | string  | `Yes`, `No`     | false | (identical text)                                                                                                                                             | improved-side                                                                                                                                                                                                                               |
| 3   | `pvArraySize`                | number  | —               | false | PV array system size in kW = watts per panel × number of panels / 1000 (e.g. 265 W × 15 = 3.975 kW). Def: min 0.01, max 999, precision 2.                    | **capture** — "six kilowatt array on the south slope" is the canonical utterance. Also derivable from a dictated panel count × wattage.                                                                                                     |
| 4   | `pvArraySizeImproved`        | number  | —               | false | (identical text)                                                                                                                                             | improved-side                                                                                                                                                                                                                               |
| 5   | `pvAnnualProduction`         | integer | —               | false | PV system annual production in kWh.                                                                                                                          | **capture?** — comes off a bill or a monitoring app; sometimes stated, often not. Integer, no min/max.                                                                                                                                      |
| 6   | `pvAnnualProductionImproved` | integer | —               | false | (identical text)                                                                                                                                             | improved-side                                                                                                                                                                                                                               |
| 7   | `pvArraySlope`               | number  | —               | false | "Slope in degress of the collector surface." (vendor's typo). Def: min 0, max 90.                                                                            | **capture?** — unit mismatch with speech: auditors say roof _pitch_ ("four-twelve") or nothing at all, not "32 degrees". Needs a pitch→degrees conversion layer.                                                                            |
| 8   | `pvArraySlopeImproved`       | number  | —               | false | (identical text)                                                                                                                                             | improved-side                                                                                                                                                                                                                               |
| 9   | `pvArrayOrientation`         | integer | —               | false | Orientation of the PV array from North. North is 0 degrees. East is 90. South is 180. West is 270. Def: min 0, max 359.                                      | **capture?** — semantically a strong capture ("south-facing" is always narrated) but the wire type is integer degrees, so it needs a cardinal→degrees mapping (`south` → 180, `southwest` → 225). Flag: a mapping table, not a passthrough. |
| 10  | `pvArrayOrientationImproved` | integer | —               | false | (identical text)                                                                                                                                             | improved-side                                                                                                                                                                                                                               |
| 11  | `pvModuleYear`               | string  | —               | false | "Year the PV modules were manufactured. Taken into condieration for derating of system over time." (vendor's typo). Def: `type: string`, min 1950, max 2027. | **capture** — install/vintage year is commonly narrated. ⚠ string-typed number again.                                                                                                                                                       |

**Cardinality / instance label: NONE.** This is the sharpest gap of the five: `pvArraySlope` and `pvArrayOrientation` are _per record_, which is the schema telling you a home can have several arrays on different roof planes — yet there is no name, label, roof-plane, or location field to say which one is which. "Six kilowatt on the south slope, another two on the garage" produces two indistinguishable records. `pvModuleYear` also has no `…Improved` twin.

Counts — total 11 · capture 3 · capture? 3 · exclude 0 · improved-side 5.

---

##### Oven: a no-write-target finding

**What exists.** `GET /jobs/{jobId}/ovens` (tag `Job GET`, summary "Ovens", description "All available ovens for a job") returns `array of #/definitions/oven`. The `oven` definition has exactly four properties: `uuid`, `ovenFuelType`, `ovenFuelTypeImproved`, `customFields`.

`ovenFuelType` / `ovenFuelTypeImproved` — string, enum `Natural Gas`, `Electricity`, `Propane`, `None`, `Don't Know`, description: "Select the type of energy source used by the oven. If the home has more than oven, select the one that is used the most. If the range and oven are dual fuel (i.e., have both a fuel heating source and an electricity heating source) select the type that is used to cook most often."

**What does not exist.** Verified against the full spec:

- `/jobs/{jobId}/ovens` carries **only** a `get`. There is no `/jobs/{jobId}/oven` path at all, and no `/jobs/oven/{uuid}` — so no create, no update, no delete.
- The name `oven` appears in **zero** `parameters` entries anywhere in the spec (searched every path × method × parameter name, case-insensitive). `ovenFuelType` is never a `formData`, query, or body parameter.
- Contrast with all five siblings, each of which has the complete triple: `POST /jobs/{jobId}/X` + `POST /jobs/X/{uuid}` + `DELETE /jobs/X/{uuid}`, plus the `GET /jobs/{jobId}/Xs` list.

**Verdict: oven is a read-only projection with no write target.** This matches the project's existing precedent of a field that exists in a display sense but cannot be written. Ribo must not add `ovenFuelType` to the extraction schema as a writable slot; there is nowhere to PUT it.

**Does `range` subsume ovens? Yes — and the spec says so out loud, but lossily.**

Supporting evidence: `rangeFuelType`'s description is not about the range alone — it reads "the type of energy source used by the **range and oven** in the home", and it carries the _same_ dual-fuel sentence as `ovenFuelType` ("If the range and oven are dual fuel … select the type that is used to cook most often"). The two descriptions are near-duplicates that differ only in which appliance they name. The natural reading is that the writable `range` record is the combined range+oven cooking-fuel record, and `GET …/ovens` exposes a separate (legacy or derived) oven row that the API will not let you author.

The loss: a genuinely dual-fuel kitchen — gas cooktop, electric wall oven, which is common — **cannot be expressed through the write API**. `rangeFuelType` is single-valued and its own help text instructs you to collapse the ambiguity by picking whichever is used to cook most often. So a dictated "gas cooktop but the wall oven is electric" must degrade to one enum member, and the discarded half has no writable home. Worth recording as a known extraction-fidelity ceiling rather than a bug to fix.

---

##### Totals across the five write resources

| resource     | total  | capture | capture? | exclude | improved-side | instance label              |
| ------------ | ------ | ------- | -------- | ------- | ------------- | --------------------------- |
| clothesDryer | 12     | 3       | 3        | 0       | 6             | none                        |
| freezer      | 11     | 4       | 2        | 0       | 5             | `freezerName`               |
| range        | 10     | 3       | 2        | 0       | 5             | none                        |
| refrigerator | 14     | 6       | 3        | 0       | 5             | `refrigeratorName` (max 30) |
| pv           | 11     | 3       | 3        | 0       | 5             | none                        |
| **total**    | **58** | **19**  | **13**   | **0**   | **26**        | 2 of 5                      |

Plus, response-definition-only and excluded: `uuid` and `customFields` on each of the five (10 fields), and the whole `oven` definition (4 fields, no write target).

Base-side (non-improved) field count: 32. Of these, the fields that are genuinely spec-sheet-only — 4 model numbers, 2 serial numbers, 1 CEF efficiency, 2 kWh/yr usage figures — number **9 of 32 (28%)**. The remaining 23 are fuel type, heat-pump, induction, energy-star, manufacturer, age band, size band, model year, condition rating, name, and the five PV geometry/size fields.

### 5.7 Proposal, estimate and workflow — `recommendation`, line items, direct installs, `incentives`, `concern`

All fields below are `formData` parameters unless noted. Verdicts: **capture** (extractable from a spoken audit),
**capture?** (extractable but flagged), **lookup** (must be resolved against a template list),
**exclude** (never extractable).

Field totals across the nine operations in this domain (creates plus their update twins): **65** —
see the per-operation counts below. Deduplicated to distinct wire names the domain is 36 leaves
(§3).

---

##### POST `/jobs/{jobId}/recommendation` — Create Recommendation (9 fields)

| Field             | Type    | Enum (verbatim) | Req     | Description (condensed)                                                                                                                                                                                                | Verdict                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------- | --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recDefinitionId` | integer | —               | **yes** | (none)                                                                                                                                                                                                                 | **lookup** — points at a program/company-defined recommendation definition. See the template-reference section below; **no listing endpoint for these exists anywhere in the spec** (verified: no path contains "definition", and none of the five `*template*` paths enumerates recommendation definitions). |
| `status`          | string  | `1`, `2`, `3`   | **yes** | Recommend = feature in the report's upgrade-details section, counts toward job total cost/savings/SIR. Note = list under 'Additional Notes', excluded from totals. Decline = hide from report, excluded from totals.   | capture — auditors narrate exactly this three-way ("we should do this" / "worth mentioning" / "they don't want it"). Numeric mapping is in the `recommendation` definition, not the formData doc: `0 → Default System Recommend`, `1 → Recommend`, `2 → Note`, `3 → Decline`.                                 |
| `title`           | string  | —               | no      | "The title will appear throughout the audit report. When appropriate, consider wording this as an actionable sentence. For instance, instead of 'Programmable Thermostat', you could write 'Program your thermostat'." | capture — this is the spoken measure name. **`maxLength: 32`** per the `recommendation` definition.                                                                                                                                                                                                           |
| `cost`            | number  | —               | no      | (none); `precision: 2` in the definition                                                                                                                                                                               | capture — "that'll be about twenty-two hundred for the attic".                                                                                                                                                                                                                                                |
| `costType`        | string  | `0`, `1`        | no      | (none in formData); definition: `0 → Simple`, `1 → Detailed`                                                                                                                                                           | capture? — structural, not spoken. Derivable: `Simple` when only `cost` is set, `Detailed` when line items are attached.                                                                                                                                                                                      |
| `measureCode`     | string  | —               | no      | "Used to identify a measure with a custom code."                                                                                                                                                                       | capture? — a company/program code, rarely dictated; may instead arrive with the resolved definition.                                                                                                                                                                                                          |
| `homeownerNotes`  | string  | —               | no      | "Add a note to the homeowner about this recommendation"                                                                                                                                                                | capture — dictated verbatim.                                                                                                                                                                                                                                                                                  |
| `contractorNotes` | string  | —               | no      | "Intended to communicate details with other professionals. Can be turned on or off in the report so you can chose to hide technical jargon..."                                                                         | capture — the natural home for technical asides in the narration.                                                                                                                                                                                                                                             |
| `whyItMatters`    | string  | —               | no      | "Best kept short and concise, this field is largely educational and appears in the sidebar of the recommendation."                                                                                                     | capture? — educational boilerplate; usually template-supplied rather than spoken, but an auditor explaining rationale on tape lands here.                                                                                                                                                                     |

**Counts: total 9 — capture 5, capture? 3, lookup 1, exclude 0.**

---

##### POST `/jobs/recommendation/{uuid}` — Update Recommendation (8 fields)

**Twin diff, verified directly against the spec: the update drops exactly one field,
`recDefinitionId`.** The other eight (`status`, `title`, `cost`, `costType`, `measureCode`,
`homeownerNotes`, `contractorNotes`, `whyItMatters`) are identical to the create's, with the same
types, enums and descriptions. So the recommendation _definition_ an existing recommendation was
instantiated from is immutable — the same drop-the-FK pattern the incentive twin shows
(`POST /jobs/{jobId}/incentives` 3 fields → `PUT /jobs/{jobId}/incentives/{uuid}` 2 fields,
dropping `fromTemplateUuid`).

**Counts: total 8 — capture 5, capture? 3, lookup 0, exclude 0** (the same verdicts as the create,
minus the `lookup`).

---

##### POST `/jobs/recommendations/{recommendationUuid}/line-item` — Create Recommendation Line Item (7 fields)

| Field            | Type   | Enum (verbatim)                                | Req | Description | Verdict                                                                                                                                                                                                                                         |
| ---------------- | ------ | ---------------------------------------------- | --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`           | string | —                                              | no  | (none)      | **lookup** (soft) — the catalog code of the line-item template. Resolve via `GET /jobs/{jobId}/recommendation-line-item-templates`. Not required, so a create can succeed without it, but omitting it decouples the line item from the catalog. |
| `category`       | string | `directInstalls`, `rebatesIncentives`, `costs` | no  | (none)      | capture? — a report bucket, not spoken; inferable from context (a rebate line vs a cost line). Note this enum is **disjoint** from the update twin's category enum on direct-install line items.                                                |
| `description`    | string | —                                              | no  | (none)      | capture — "insulate the attic to R-49".                                                                                                                                                                                                         |
| `costPerUnit`    | number | —                                              | no  | (none)      | capture — spoken as a rate ("about four bucks a square foot").                                                                                                                                                                                  |
| `quantity`       | number | —                                              | no  | (none)      | capture — spoken ("twelve hundred square feet").                                                                                                                                                                                                |
| `unit`           | string | **LINE-ITEM-UNITS**                            | no  | (none)      | capture — spoken alongside the quantity; needs normalising ("square feet" → `sq. ft`).                                                                                                                                                          |
| `collectionUuid` | string | —                                              | no  | (none)      | **exclude** — internal FK to a line-item collection/grouping.                                                                                                                                                                                   |

**Counts: total 7 — capture 4, capture? 1, lookup 1, exclude 1.**

---

##### POST `/jobs/recommendation-line-items/{uuid}` — Update Recommendation Line Item (7 fields)

| Field            | Type   | Enum (verbatim)     | Req | Description | Verdict                                                                     |
| ---------------- | ------ | ------------------- | --- | ----------- | --------------------------------------------------------------------------- |
| `name`           | string | —                   | no  | (none)      | capture — **update-only**; see the twin diff below.                         |
| `code`           | string | —                   | no  | (none)      | **lookup** (soft) — `GET /jobs/{jobId}/recommendation-line-item-templates`. |
| `description`    | string | —                   | no  | (none)      | capture                                                                     |
| `costPerUnit`    | number | —                   | no  | (none)      | capture                                                                     |
| `quantity`       | number | —                   | no  | (none)      | capture                                                                     |
| `unit`           | string | **LINE-ITEM-UNITS** | no  | "(none)"    | capture                                                                     |
| `collectionUuid` | string | —                   | no  | (none)      | **exclude** — internal FK.                                                  |

**Twin diff (both 7 fields, but not the same 7):** create has `category`
(`directInstalls` / `rebatesIncentives` / `costs`) and **no** `name`; update has `name` and
**no** `category`. So a line item's _name_ cannot be set at creation and its _category_ cannot
be changed after creation — a spoken line item that needs both requires **two calls**:
create-then-update.

**Counts: total 7 — capture 5, capture? 0, lookup 1, exclude 1.**

---

##### POST `/jobs/direct-installs/{directInstallUuid}/line-item` — Create Direct Install Line Item (13 fields)

| Field                     | Type   | Enum (verbatim)                                                                               | Req | Description                                                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                                             |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`                    | string | —                                                                                             | no  | (none)                                                                                                                                                                                                                                                                       | **lookup** (soft) — `GET /jobs/{jobId}/direct-install-line-item-templates`.                                                                                                                         |
| `directInstallType`       | string | `[]` — **enum declared but EMPTY in the spec**                                                | no  | (none)                                                                                                                                                                                                                                                                       | capture? — the spec advertises a closed vocabulary and then ships none of it. Values must be discovered from the direct-install template list or live data before this field can be written safely. |
| `description`             | string | —                                                                                             | no  | (none)                                                                                                                                                                                                                                                                       | capture — "swapped out ten LED bulbs".                                                                                                                                                              |
| `fixedCost`               | number | —                                                                                             | no  | "This is the fixed cost."                                                                                                                                                                                                                                                    | capture                                                                                                                                                                                             |
| `costPerUnit`             | number | —                                                                                             | no  | "This is the cost for a single measure. If there is a separate labor cost defined for this line item, then this value (costPerUnit) is understood to be the material cost excluding labor. The complete unit cost of a line item is always: costPerUnit + laborCostPerUnit." | capture — but note the material/labor split: a single spoken price ("thirty bucks apiece") is ambiguous between `costPerUnit` alone and `costPerUnit + laborCostPerUnit`.                           |
| `laborCostPerUnit`        | number | —                                                                                             | no  | "Cost for the labor / installation of a single measure."                                                                                                                                                                                                                     | capture                                                                                                                                                                                             |
| `quantity`                | number | —                                                                                             | no  | (none)                                                                                                                                                                                                                                                                       | capture — "ten of them".                                                                                                                                                                            |
| `unit`                    | string | **LINE-ITEM-UNITS**                                                                           | no  | "This is the unit that the quantiy refers to." (sic)                                                                                                                                                                                                                         | capture                                                                                                                                                                                             |
| `efficiencyLevel`         | string | —                                                                                             | no  | (none)                                                                                                                                                                                                                                                                       | capture? — free string with no documented vocabulary; auditors do say "it's an 80 AFUE" but the expected format is unknown.                                                                         |
| `efficiencyLevelImproved` | string | —                                                                                             | no  | (none)                                                                                                                                                                                                                                                                       | capture? — same, for the post-install state ("we put in a 95").                                                                                                                                     |
| `lifeInMonths`            | number | —                                                                                             | no  | "This is the life of the measure expressed in months."                                                                                                                                                                                                                       | capture? — a spec-book number, essentially never spoken; and when spoken it is spoken in _years_, so it needs a ×12 conversion.                                                                     |
| `sir`                     | number | —                                                                                             | no  | "This is calculated based on cost and measure life."                                                                                                                                                                                                                         | **exclude** — self-described auto-calculated.                                                                                                                                                       |
| `fuelType`                | string | `Natural Gas`, `Electricity`, `Fuel Oil`, `Propane`, `Wood`, `Pellets`, `Solar`, `Don't Know` | no  | (none)                                                                                                                                                                                                                                                                       | capture — routinely narrated. Note `Don't Know` is a first-class member, which is unusually forgiving for an extraction target.                                                                     |

**Counts: total 13 — capture 7, capture? 4, lookup 1, exclude 1.**

---

##### POST `/jobs/direct-install-line-items/{uuid}` — Update Direct Install Line Item (14 fields)

Identical to the create above, **plus one extra field**:

| Field      | Type   | Enum (verbatim)              | Req | Description | Verdict                                                  |
| ---------- | ------ | ---------------------------- | --- | ----------- | -------------------------------------------------------- |
| `category` | string | `installedMeasures`, `other` | no  | (none)      | capture? — **update-only.** A report bucket, not spoken. |

**Twin diff (13 create → 14 update): the extra field is `category`, enum
`installedMeasures` / `other`.** As with the recommendation line item, the category cannot be
set on the create — it can only be assigned by a follow-up update. Note also that this enum
(`installedMeasures`, `other`) is a completely different vocabulary from the recommendation
line item's `category` (`directInstalls`, `rebatesIncentives`, `costs`), despite the shared
field name. Any shared line-item model must keep the two categories distinct.

**Counts: total 14 — capture 7, capture? 5, lookup 1, exclude 1.**

---

##### POST `/jobs/{jobId}/incentives` — Create Incentive from template (3 fields)

| Field              | Type                                                   | Enum | Req     | Description                      | Verdict                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------ | ---- | ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fromTemplateUuid` | string                                                 | —    | **yes** | "UUID of the incentive template" | **lookup** — `GET /programs/{programId}/incentive-templates`. Note the list is keyed by **programId, not jobId**, so resolving it needs the job's program first.                                                                                 |
| `amount`           | number                                                 | —    | no      | (none)                           | capture — "there's a fifteen hundred dollar rebate on that".                                                                                                                                                                                     |
| `recommendations`  | array of `{uuid: string, selectedLineItems: string[]}` | —    | no      | (none)                           | **exclude** from extraction — arrays of same-job UUIDs. But see the cross-reference note below: semantically this _is_ spoken ("the rebate applies to the attic job") and has to be resolved to UUIDs minted earlier in the same write sequence. |

The operation is named "Create Incentive **from template**" and carries **no name, no
description, and no title**. The incentive's identity comes entirely from the template. The
spoken rebate name is therefore not a value to store — it is the _lookup key_, and the only
thing an extractor can contribute besides the amount.

**Counts: total 3 — capture 1, capture? 0, lookup 1, exclude 1.**

---

##### PUT `/jobs/{jobId}/incentives/{uuid}` — Update Incentive (2 fields)

| Field             | Type                                                   | Enum | Req | Description | Verdict                                      |
| ----------------- | ------------------------------------------------------ | ---- | --- | ----------- | -------------------------------------------- |
| `amount`          | number                                                 | —    | no  | (none)      | capture                                      |
| `recommendations` | array of `{uuid: string, selectedLineItems: string[]}` | —    | no  | (none)      | **exclude** — same-job UUID cross-reference. |

**Twin diff (3 create → 2 update): the update drops `fromTemplateUuid`.** The template an
incentive was instantiated from is immutable. This is the clean case of the pattern the
recommendation twin is presumed to follow.

Also the **only PUT in this group** — every other update here is a POST. Whatever issues these
writes must not assume verb-by-operation-kind.

**Counts: total 2 — capture 1, capture? 0, lookup 0, exclude 1.**

---

##### POST `/jobs/{jobId}/concern` — Create Concern (2 fields)

| Field            | Type   | Enum | Req | Description                                                                                                                                                                                                                                           | Verdict                                                                      |
| ---------------- | ------ | ---- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `concernSummary` | string | —    | no  | "Type a short sentence that details a concern from the homeowner. This could be regarding comfort, health and safety, energy savings, aesthetics, noise, etc. There is no right or wrong answer." `maxLength: 255`; example `"Heating system is old"` | capture — the single most speech-native field in the whole writable surface. |
| `concernDetail`  | string | —    | no  | "Type a more detailed description of this concern from the homeowner." Example: `"Furnace needs to be replaced for additional comfort and health & safety issues."`                                                                                   | capture                                                                      |

No template reference, no enum, no required field, no id. **The purest extraction target in the
group** — "she says the back bedroom is always freezing" maps to a summary/detail pair with no
resolution step at all. `POST /jobs/concern/{uuid}` and `DELETE /jobs/concern/{uuid}` exist and take the same two fields, so a concern is fully CRUD-able — the only proposal-domain resource that is.

**Counts: total 2 — capture 2, capture? 0, lookup 0, exclude 0.**

---

#### The template-reference problem class

**Spoken measure name must be resolved to a template id via a lookup against a per-program
list.** This is a distinct problem class from field extraction and it has no analogue anywhere
in the existing schema, which only ever writes literal values.

An auditor says _"there's an oil boiler here, we should get rid of it."_ That is a complete,
well-formed recommendation in speech. It is **not** a well-formed create: the API demands
`recDefinitionId`, an integer naming one row of a catalog the auditor never says out loud and
probably could not recite. The extraction is correct and the write still fails. No amount of
better prompting fixes this — the missing value does not exist in the audio.

##### Every reference field in the group

| Field                       | Operation                                                   | Required                          | Kind                                                   | Resolve against                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recDefinitionId` (integer) | POST `/jobs/{jobId}/recommendation`                         | **YES — create fails without it** | hard FK to a program/company recommendation definition | **No listing endpoint exists anywhere in the spec.** The three template-list endpoints named in the spec (`GET /jobs/{jobId}/recommendation-line-item-templates`, `GET /jobs/{jobId}/direct-install-line-item-templates`, `GET /programs/{programId}/incentive-templates`) cover line items and incentives — **none of them lists recommendation definitions.** This is an open gap and the single highest-risk item in the group. |
| `fromTemplateUuid` (string) | POST `/jobs/{jobId}/incentives`                             | **YES — create fails without it** | hard FK to an incentive template                       | `GET /programs/{programId}/incentive-templates` — **program-scoped, not job-scoped**: needs a job→program resolution step first.                                                                                                                                                                                                                                                                                                   |
| `code` (string)             | POST `/jobs/recommendations/{recommendationUuid}/line-item` | no                                | soft catalog code                                      | `GET /jobs/{jobId}/recommendation-line-item-templates`                                                                                                                                                                                                                                                                                                                                                                             |
| `code` (string)             | POST `/jobs/recommendation-line-items/{uuid}`               | no                                | soft catalog code                                      | `GET /jobs/{jobId}/recommendation-line-item-templates`                                                                                                                                                                                                                                                                                                                                                                             |
| `code` (string)             | POST `/jobs/direct-installs/{directInstallUuid}/line-item`  | no                                | soft catalog code                                      | `GET /jobs/{jobId}/direct-install-line-item-templates`                                                                                                                                                                                                                                                                                                                                                                             |
| `code` (string)             | POST `/jobs/direct-install-line-items/{uuid}`               | no                                | soft catalog code                                      | `GET /jobs/{jobId}/direct-install-line-item-templates`                                                                                                                                                                                                                                                                                                                                                                             |
| `measureCode` (string)      | POST `/jobs/{jobId}/recommendation`                         | no                                | soft custom code                                       | (company-defined; no endpoint identified)                                                                                                                                                                                                                                                                                                                                                                                          |

##### Two tiers, and they need different handling

**Hard FKs (`recDefinitionId`, `fromTemplateUuid`) — blocking.** No id, no create. Resolution
must happen before the write, and it must be able to fail visibly: a spoken measure that
matches nothing in the program's catalog needs to surface to the auditor for disambiguation
rather than being silently dropped or guessed. Fuzzy name→template matching against a
per-program list is a real component with real failure modes (near-duplicates like "Attic
insulation" vs "Attic insulation — blown", programs with hundreds of definitions).

**Soft codes (`code`, `measureCode`) — non-blocking but lossy.** Notably, **the line-item
creates take no template id at all.** They are fully self-describing: `description`,
`costPerUnit`, `quantity`, `unit` are all writable literals. So the line-item template lists
function as a _value source_ (look up the template, copy its code/unit/default cost) rather
than as an FK the API enforces. That is a meaningfully easier problem than the hard FKs, and
it means line items can be written from speech alone with degraded catalog linkage — a viable
fallback the recommendation create does not have.

##### A third, different reference: same-job cross-reference

`recommendations` on both incentive operations is an array of
`{uuid, selectedLineItems: [uuid]}` pointing at recommendations and line items **created
earlier in the same session**. This is not a template lookup — the ids do not exist in any
catalog; they are minted by earlier writes in the same batch. "The fifteen-hundred rebate
covers the attic and the boiler" is a spoken statement about the join. Honouring it requires
holding a name→minted-uuid map across the write sequence, which is a sequencing/state concern
rather than a lookup concern.

---

#### Nesting and cardinality

Every resource here repeats per job, and — the important part — **they nest two levels deep**:

```
job
├── recommendation            (0..n)   ← recDefinitionId, status, title, cost, notes…
│   └── line item             (0..n)   ← code, description, costPerUnit, quantity, unit
├── directInstall             (0..n)   ← NO CREATE ENDPOINT (see below)
│   └── line item             (0..n)   ← code, costs, quantity, unit, fuelType, efficiency…
├── incentive                 (0..n)   ← fromTemplateUuid, amount
│   └── recommendations[]              ← cross-refs INTO the recommendation subtree
└── concern                   (0..n)   ← flat, one level, no children
```

**This is two-level instance modeling, and the existing schema handles exactly one level** — a
flat array of instances per resource. Recommendations contain line items; direct installs
contain line items. Nothing in the current model expresses "an instance that owns a collection
of sub-instances," and nothing expresses the ordering constraint that falls out of it.

Concrete consequences:

1. **Child writes need a parent uuid in the path.** `/jobs/recommendations/{recommendationUuid}/line-item` and `/jobs/direct-installs/{directInstallUuid}/line-item` are both parented by a uuid that only exists after the parent create returns. Writes are therefore **inherently sequenced**, not a parallel fan-out: create parent → read uuid → create each child. A flat one-level model has no place to put that dependency.

2. **Extraction must group, not just list.** "Twenty-two hundred for the attic, that's twelve hundred square feet at a dollar-forty for the material plus labor" is one recommendation and one-or-more line items. Getting the fields right but the _grouping_ wrong (line items attached to the wrong measure, or flattened into a single list) produces a structurally valid, semantically wrong estimate.

3. **Create-then-update is mandatory for some children.** Because `name` is update-only on recommendation line items and `category` is update-only on direct-install line items, a fully-specified child can require two calls. That doubles the write count under the parent and makes partial-failure states real.

4. **The incentive `recommendations` array is a fourth edge** that reaches sideways across the tree into recommendations _and_ into their line items (`selectedLineItems`), i.e. it references level 2 directly. The graph is not a pure tree.

5. **Concerns are the only flat resource here** and the only one the existing one-level model could absorb unchanged.

---

#### The `directInstall` container: add-only, create-never

**Finding: there is no create endpoint for a `directInstall` container anywhere in the spec — only for
its line items.**

- The only direct-install writes present are `POST /jobs/direct-installs/{directInstallUuid}/line-item` (create child) and `POST /jobs/direct-install-line-items/{uuid}` (update child).
- Both require a `directInstallUuid` / line-item `uuid` that must already exist. **No operation anywhere in the spec mints a `directInstallUuid`**; `GET /jobs/{jobId}/direct-installs` can only discover one that already exists.
- Compare the sibling resources, all of which _do_ have a job-scoped create: recommendations (`POST /jobs/{jobId}/recommendation`), incentives (`POST /jobs/{jobId}/incentives`), concerns (`POST /jobs/{jobId}/concern`). Direct installs are the sole exception.
- Corroborating: there is no singular `directInstall` definition among the spec's 63 — only the plural read-side `directInstalls` (28 properties, all response-only).

**Why this is a real constraint, not a curiosity.** Direct installs are measures performed _on
the spot during the visit_ — precisely the thing an auditor narrates in the moment ("swapped
out ten LEDs and a couple of aerators while I was in there"). If the container can only be
created through the Snugg Pro UI, or is auto-created by the program, then a job with no
existing direct-install container **cannot receive any spoken direct-install content at all**,
regardless of extraction quality. The line items have nowhere to attach.

Open questions to resolve against the full spec before relying on this path:

- Is the container auto-created per job, or per program enrolment?
- Is there a `GET` that lists a job's direct installs (which would at least let a client discover an existing `directInstallUuid`)?
- Is a container created as a side effect of some other write, or only through the Snugg Pro UI? (Confirmed absent from the spec; this is a question for the vendor or a live account.)

Until those are answered, treat direct-install line items as **conditionally writable**: viable
when a container already exists, dead-ended when it does not. Recommendation line items have no
such problem — their parent is creatable.

### 5.8 Health — the two remaining fields of `POST /jobs/{jobId}/health`

`POST /jobs/{jobId}/health` carries 16 `formData` parameters (plus the malformed 17th `customFields`,
§4.7). Doc 17 found the matrix was 13 tests rather than 11 and `snuggValuesSchema` now covers 14 of
the 16. The remaining two:

| Wire name                        | Type   | Enum (verbatim)                  | Req   | Description (condensed)                                                                                | Verdict                                                                                                                                                                                                             |
| -------------------------------- | ------ | -------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `healthDrainageSystemCondition`  | string | `Good`, `Potential Issues`, `NA` | false | Condition of the drainage system.                                                                      | `capture` — shares the exact enum of the already-covered `healthRoofCondition`, so this is a one-line extension of whatever handles that field. "Gutters and grading look fine" maps straight to `Good`.            |
| `healthSafetyQuestionsDisclosed` | string | `Yes`, `No`                      | false | _"IRA programs require answers to applicable Safety Testing questions be disclosed to the homeowner."_ | `capture?` — **different in kind.** A compliance attestation about a conversation with the homeowner, not a measurement. Recommend explicit operator confirmation in review rather than inference from a recording. |

Also worth carrying forward: **all 14 `Passed`/`Failed`/`Warning`/`Not Tested` fields share one
identical description** explaining that `Warning` means a condition was observed _without a formal
test_. That is the mapping rule for hedged speech — "looked a bit sooty, didn't test it" is
`Warning`, not `Failed` — and it belongs in the extraction prompt.

---

## 6. Dropped-field precedents: what is readable and never writable

Doc 17 row 23 dropped `combustionVentType` because the `caz` resource is GET-only and no vent-type
field exists anywhere. That was one instance of a class. Systematically diffing all 48 GET-only paths
and all 63 definitions against the union of 837 writable `formData` names finds **seven
dictation-plausible resources with no write target**, of which the appliance one is the most
surprising.

The audit below is the evidence. It also does the inverse check — response-only _fields_ inside
otherwise-writable resources — and finds that class almost entirely benign (`uuid`, `customFields`,
modeled outputs), with two exceptions named in §6.C.

Source: Swagger 2.0, `info.title` = `Snugg Pro API`, `info.version` = `1.0.0`, `basePath` = `https://api.snuggpro.com/`, `schemes: ["https"]`, `consumes/produces: ["application/json"]`.

All findings below are measured directly from the spec document; nothing was fetched from the network.

---

#### A. The read-only surface

**48 of 92 paths have a `get` and no `post`/`put`/`delete`/`patch`.** Every one of them resolves to exactly one `$ref` definition (no inline response schemas anywhere in the read-only set).

The critical distinction is between a GET-only path that has a **sibling write path under a different (singular) URL** — `/jobs/{jobId}/attics` reads, `POST /jobs/{jobId}/attic` writes — and a GET-only path whose data has **no write target anywhere**. Only the second class is the `combustionVentType` failure mode.

##### A.1 — GET-only collection readers that DO have a singular write sibling (not a gap)

| Read path                                          | Definition               | Write sibling                                                                     | formData fields                                     | Coverage                           |
| -------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `/jobs/{jobId}/attics`                             | `attic`                  | `POST /jobs/{jobId}/attic`, `POST /jobs/attic/{uuid}`                             | 34                                                  | 34/36 props                        |
| `/jobs/{jobId}/clothesDryers`                      | `clothesDryer`           | `POST /jobs/{jobId}/clothesDryer`                                                 | 12                                                  | 12/14                              |
| `/jobs/{jobId}/concerns`                           | `concern`                | `POST /jobs/{jobId}/concern`                                                      | 2                                                   | 2/4                                |
| `/jobs/{jobId}/dhws`                               | `dhw`                    | `POST /jobs/{jobId}/dhw`                                                          | 47                                                  | 47/59                              |
| `/jobs/{jobId}/doors`                              | `door`                   | `POST /jobs/{jobId}/door`                                                         | 7                                                   | 7/9                                |
| `/jobs/{jobId}/freezers`                           | `freezer`                | `POST /jobs/{jobId}/freezer`                                                      | 11                                                  | 11/13                              |
| `/jobs/{jobId}/hvacs`                              | `hvac`                   | `POST /jobs/{jobId}/hvac`                                                         | 72                                                  | 72/100                             |
| `/jobs/{jobId}/pvs`                                | `pv`                     | `POST /jobs/{jobId}/pv`                                                           | 11                                                  | 11/13                              |
| `/jobs/{jobId}/ranges`                             | `range`                  | `POST /jobs/{jobId}/range`                                                        | 10                                                  | 10/12                              |
| `/jobs/{jobId}/refrigerators`                      | `refrigerator`           | `POST /jobs/{jobId}/refrigerator`                                                 | 14                                                  | 14/16                              |
| `/jobs/{jobId}/vaults`                             | `vault`                  | `POST /jobs/{jobId}/vault`                                                        | 22                                                  | 22/24                              |
| `/jobs/{jobId}/walls`                              | `wall`                   | `POST /jobs/{jobId}/wall`                                                         | 16                                                  | 16/18                              |
| `/jobs/{jobId}/windows`                            | `window`                 | `POST /jobs/{jobId}/window`                                                       | 33                                                  | 33/35                              |
| `/jobs/{jobId}/recommendations`                    | `recommendation`         | `POST /jobs/{jobId}/recommendation`                                               | 9                                                   | 9/25                               |
| `/jobs/{jobId}/job-stage-history`                  | `jobStageHistory`        | `POST /jobs/{jobId}/stage`                                                        | 2 (`stageId`, `stageChangeReason`)                  | 2/7                                |
| `/jobs/{jobId}/rebates-incentives`                 | `rebatesIncentives`      | `POST /jobs/{jobId}/incentives`                                                   | 3 (`fromTemplateUuid`, `amount`, `recommendations`) | partial, different shape           |
| `/jobs/{jobId}/tickets`                            | `tickets`                | `PUT /jobs/{jobId}/tickets/{ticketId}`                                            | 2 (`status`, `message`)                             | 2/16                               |
| `/jobs/{jobId}/direct-install-line-item-templates` | `directInstallLineItems` | `POST`/`PUT /programs/{programId}/direct-install-line-item-templates` (JSON body) | —                                                   | program-scoped only                |
| `/jobs/{jobId}/checklist-answers`                  | `jobChecklistAnswer`     | `PUT /programs/{programId}/checklist` (JSON body)                                 | —                                                   | **defines questions, not answers** |

Note that `ovens` is conspicuously absent from this table: **`/jobs/{jobId}/oven` does not exist.** Every other appliance in the family (`range`, `refrigerator`, `freezer`, `clothesDryer`) has a singular write path. `oven` does not.

##### A.2 — Dictation-plausible but genuinely unwritable

| Read path                         | Definition                         | What it exposes                                                                                                                                                                                                                                                                    | Why it is dictation-plausible                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/jobs/{jobId}/caz`               | `caz` (10 props) + `cazSystem` (4) | `cazName`, `cazAmbientCo`, `cazAmbientCoImproved`, `cazPoorCaseTest`, `cazPoorCaseTestImproved`, `cazNotes`, `cazNotesImproved`, `cazSystems[]` → `cazApplianceCoCurrentCondition`, `cazApplianceCoCurrentConditionImproved`                                                       | The established precedent. An auditor dictates CAZ names, ambient CO ppm, worst-case depressurization numbers and free-text notes. **Zero write targets.**                                                                               |
| `/jobs/{jobId}/ovens`             | `oven` (4 props)                   | `ovenFuelType`, `ovenFuelTypeImproved` — enum `["Natural Gas", "Electricity", "Propane", "None", "Don't Know"]`                                                                                                                                                                    | "The oven is gas" is one of the most natural things an auditor says. Sibling appliances are all writable; the oven is not. **A second confirmed `combustionVentType`-class case.**                                                       |
| `/jobs/{jobId}/checklist-answers` | `jobChecklistAnswer` (3 props)     | `questionId`, `answerAsString`, `valueType`; GET takes an `archived` query param                                                                                                                                                                                                   | Program checklist answers are exactly the kind of thing dictated in the field. The only checklist write, `PUT /programs/{programId}/checklist`, edits the **question set** for a program, not a job's answers. No path writes an answer. |
| `/jobs/{jobId}/work-orders`       | `workOrders` (16 props)            | `altId`, `workOrderDate`, `paymentInfo`, `legalInfo`, `discountPercentage`, `discountDollar`, `stateTax`, `countyTax`, `cityTax`, `amountPaid`, `subTotal`, `discountAmount`, `applicableTax`, `total`                                                                             | Dates and amounts an auditor could dictate on site. No write op touches any of these.                                                                                                                                                    |
| `/jobs/{jobId}/direct-installs`   | `directInstalls` (28 props)        | Header + pricing: `installDate`, `discountPercentage`, `discountDollar`, `stateTax`/`countyTax`/`cityTax`, `electricUtilityCopay`, `gasUtilityCopay`, `waterUtilityCopay`, `programCopay`, `otherCopay`, `type`, `laborIsTaxable`, all derived totals, `payments[]`, `lineItems[]` | Only `POST /jobs/direct-installs/{directInstallUuid}/line-item` writes, and only line items — and it requires a `directInstallUuid` that no endpoint can create. The direct-install **header itself is uncreatable and unwritable.**     |
| `/jobs/{jobId}/snapshots`         | `jobSnapshots` (7 props)           | `fromJobId`, `jobId`, `name`, `createdAt`, `isAutoGenerated`, `hpxmlUrl`, `snapshotTags[]`                                                                                                                                                                                         | An auditor could name a snapshot ("pre-retrofit"), but there is no snapshot-create or snapshot-tag write.                                                                                                                                |
| `/jobs/{jobId}/job-financings`    | `jobFinancing` (17 props)          | `title`, `description`, `contactInfo`, `eligibility`, `isShown`, `cashDown`, `rate`, `closingCost`, `term`, `minFicoScore`, `minCashDown`, `minPurchase`, `maxPurchase`, `principalAmount`, `invalidLoanProduct`                                                                   | Marginal — mostly program-level product config, but `cashDown`/`principalAmount` are job-specific and unwritable.                                                                                                                        |

##### A.3 — GET-only and correctly so (computed, exported, or org-directory data)

| Read path                                                                                                                                                                                                  | Definition                       | What it exposes                                                                                                                                                                                                                       | Dictation-plausible?                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/jobs/{jobId}/all-data`                                                                                                                                                                                   | `allJobData` (28 refs)           | The whole job graph in one payload — `job`, `basedata`, `health`, `report`, `totals`, `utilities`, plus arrays of every child resource including `ovens`, `caz`, `directInstalls`, `workOrders`, `jobFinancings`, `rebatesIncentives` | No — aggregate reader. Useful as the canonical inventory of what the API models.                                  |
| `/jobs/{jobId}/metrics-summary`                                                                                                                                                                            | `totals` (103 props)             | Modeled energy/cost/CO2 rollups: `annualFuelThermsUsed`, `savedKwh`, `mbtuBase`, `yearlyEnergyCost`, `totalCo2Tons`, `installedCosts`, `sir`, …                                                                                       | No — engine output.                                                                                               |
| `/jobs/{jobId}/model`                                                                                                                                                                                      | `jobModelingResponse` (3)        | `errors[]`, `warnings[]` (both `jobAlert`), `requestUuid`                                                                                                                                                                             | No — modeling run result.                                                                                         |
| `/jobs/{jobId}/alerts`                                                                                                                                                                                     | `jobAlerts` (2) → `jobAlert`     | `errors[]`/`warnings[]` of `{code, title, summary}`                                                                                                                                                                                   | No — validation output.                                                                                           |
| `/jobs/{jobId}/hes-score`                                                                                                                                                                                  | `hesScores` (28)                 | DOE Home Energy Score: `hesBaseScore`, `hesAssessmentType`, `hesAssessmentDate`, `hesQualifiedAssessorId`, `hesLabelNumber`, `hesConditionedFloorArea`, `hesYearBuilt`, utility flags, …                                              | Borderline — `hesAssessmentDate` and `hesQualifiedAssessorId` are dictatable, but the score is externally issued. |
| `/jobs/{jobId}/hpxml`                                                                                                                                                                                      | `jobLatestHpxml` (3)             | `stageId` (enum `[1..10]`), `hpxmlUrl`, `createdAt`                                                                                                                                                                                   | No — export link.                                                                                                 |
| `/jobs/{jobId}/custom-lifetime-savings`                                                                                                                                                                    | `customLifetimeSavings` (2)      | `measures[]`, `systems{}`                                                                                                                                                                                                             | No — computed.                                                                                                    |
| `/jobs/{jobId}/recommendation-line-item-templates`                                                                                                                                                         | `recommendationLineItems`        | Program-level line-item templates                                                                                                                                                                                                     | No — template catalog.                                                                                            |
| `/jobs/{jobId}/account`, `/jobs/{jobId}/company`, `/jobs/{jobId}/program`                                                                                                                                  | `account`, `company`, `program`  | Job's owning org records                                                                                                                                                                                                              | No.                                                                                                               |
| `/accounts`, `/accounts/{accountId}`, `/companies`, `/companies/{companyId}/accounts`, `/companies/{companyId}/programs`, `/programs`, `/programs/{programId}/accounts`, `/programs/{programId}/companies` | `account`, `company`, `program`  | Org directory                                                                                                                                                                                                                         | No.                                                                                                               |
| `/companies/{companyId}/snapshot-tags`, `/programs/{programId}/snapshot-tags`                                                                                                                              | `snapshotTag`                    | Tag vocabulary                                                                                                                                                                                                                        | No.                                                                                                               |
| `/programs/{programId}/incentive-templates`                                                                                                                                                                | `programIncentiveTemplates` (38) | Incentive template catalog                                                                                                                                                                                                            | No.                                                                                                               |
| `/job-templates`                                                                                                                                                                                           | `job`                            | Job templates                                                                                                                                                                                                                         | No.                                                                                                               |

---

#### B. Definitions with no write path

Of the **63 definitions**, **57 are never used as a parameter schema at all** (only 4 appear as request bodies: `programChecklistQuestion`, `programChecklistDeleteQuestion`, `programDirectInstallLineItemTemplates`, `programDirectInstallLineItemTemplateDelete`). So "response-only" in the literal Swagger sense is the norm here — the writable surface is expressed exclusively as flat `formData` parameter lists, never as a schema.

The meaningful test is therefore: **do this definition's property names appear anywhere in the union of all 837 distinct `formData` parameter names?**

##### B.1 — Definitions with ZERO writable properties (14)

| Definition                                   | Props | What it is                                                         | Matters for dictation?                                           |
| -------------------------------------------- | ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `caz`                                        | 10    | Combustion appliance zone: name, ambient CO, poor-case test, notes | **Yes — the precedent case.**                                    |
| `cazSystem`                                  | 4     | Per-appliance CO readings inside a CAZ                             | **Yes.**                                                         |
| `oven`                                       | 4     | Oven fuel type (base + improved)                                   | **Yes — new finding.**                                           |
| `hesScores`                                  | 28    | DOE Home Energy Score record                                       | Partly (`hesAssessmentDate`, `hesQualifiedAssessorId`)           |
| `jobChecklistAnswer`                         | 3     | A job's answer to a program checklist question                     | **Yes.**                                                         |
| `customLifetimeSavings`                      | 2     | Computed lifetime savings by measure/system                        | No                                                               |
| `jobAlerts`                                  | 2     | Wrapper for `errors[]`/`warnings[]`                                | No                                                               |
| `jobModelingResponse`                        | 3     | Result of a modeling run                                           | No                                                               |
| `checklist`                                  | 2     | `{type, items}` — **unreferenced by any path or definition**       | No (dead)                                                        |
| `createJob`                                  | 1     | `{id}` — job-creation response envelope                            | No                                                               |
| `deletedCollection`                          | 1     | `{deletedAt}` — delete response envelope                           | No                                                               |
| `recommendationCaption`                      | 4     | `uuid`, `caption`, `leftPhotoUrl`, `rightPhotoUrl`                 | **Yes, marginally** — auditors narrate photo captions; no write. |
| `programChecklistDeleteQuestion`             | 1     | Delete-question payload                                            | No                                                               |
| `programDirectInstallLineItemTemplateDelete` | 1     | Delete-template payload                                            | No                                                               |

##### B.2 — Definitions with ≤3 writable properties (effectively unwritable, 21)

Several of these "hits" are coincidental name collisions with an unrelated endpoint's `formData` (e.g. `totals.sir` collides with the line-item `sir`, `allJobData.recommendations` with the incentives `recommendations`), so the real coverage is lower still.

| Definition                                                       | Props   | Writable props found                                           | What it is                                          | Matters?                       |
| ---------------------------------------------------------------- | ------- | -------------------------------------------------------------- | --------------------------------------------------- | ------------------------------ |
| `totals`                                                         | 103     | `sir` (collision)                                              | Modeled energy/cost/CO2 rollups                     | No — engine output             |
| `allJobData`                                                     | 28      | `recommendations` (collision)                                  | Aggregate job graph                                 | No                             |
| `directInstalls`                                                 | 28      | `altId`                                                        | Direct-install header + pricing                     | **Yes**                        |
| `workOrders`                                                     | 16      | `altId`                                                        | Work order header + pricing                         | **Yes**                        |
| `jobFinancing`                                                   | 17      | `title`, `description` (collisions)                            | Financing product offered on a job                  | Marginal                       |
| `tickets`                                                        | 16      | `title`, `status`, `type`, `description`, … via `updateTicket` | Support/QA ticket; only `status`+`message` writable | Marginal                       |
| `incentives`                                                     | 40      | 9 (mostly collisions)                                          | Full incentive record; only 3 fields postable       | No                             |
| `programIncentiveTemplates`                                      | 38      | 8                                                              | Program incentive catalog                           | No                             |
| `incentivesFile`, `ticketsFile`                                  | 14 each | `name`, `category`                                             | File attachments                                    | No — no upload endpoint exists |
| `ticketsActivity`                                                | 6       | `message`                                                      | Ticket comment stream                               | No                             |
| `jobSnapshots`, `jobSnapshot`, `jobSnapshotsTags`, `snapshotTag` | 7/5/7/5 | `name`, `description`                                          | Snapshot + tag records                              | Marginal                       |
| `jobStageHistory`                                                | 7       | `stageId`, `stageChangeReason`                                 | Stage transition log                                | No                             |
| `jobLatestHpxml`                                                 | 3       | `stageId`                                                      | HPXML export pointer                                | No                             |
| `account`, `company`, `program`                                  | 9/14/5  | 4/6/1                                                          | Org directory records                               | No                             |
| `jobAlert`                                                       | 3       | `code`, `title` (collisions)                                   | One validation alert                                | No                             |
| `concern`                                                        | 4       | `concernSummary`, `concernDetail`                              | Homeowner concern — **actually writable**           | Covered                        |
| `customField`                                                    | 7       | `description`                                                  | Custom-field descriptor                             | See note in E                  |
| `appliesToCollection`                                            | 2       | `name`                                                         | Applicability helper                                | No                             |
| `programChecklistQuestion`                                       | 6       | `category`                                                     | Program checklist question (writable via JSON body) | No                             |
| `updateTicket`                                                   | 4       | `status`, `message`                                            | Ticket-update response                              | No                             |

`checklist` and `jobSnapshot` are **referenced by nothing at all** — dead definitions in the spec.

---

#### C. Response-only fields within writable resources

For each resource, the resource's response `definition` properties were diffed against the union of `formData` parameter names on its own create and update endpoints. Names below are verbatim.

| Resource    | Def props | formData union                                                 | Response-only fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | --------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hvac`      | 100       | 72 (`POST /jobs/{jobId}/hvac` 72; `POST /jobs/hvac/{uuid}` 71) | **28**: `uuid`, `customFields`, `hvacDuctEfficiency`, `hvacDuctEfficiencyImproved`, `hvacHeatingSystemEquivalentFullLoadHours`, `hvacHeatingSystemEquivalentFullLoadHoursImproved`, `hvacCoolingSystemEquivalentFullLoadHours`, `hvacCoolingSystemEquivalentFullLoadHoursImproved`, `hvacHeatSavedMbtu`, `hvacHeatSavedKwh`, `hvacHeatSavedTherms`, `hvacHeatSavedThermsGas`, `hvacHeatSavedThermsPropane`, `hvacHeatSavedThermsOil`, `hvacHeatSavedThermsWood`, `hvacHeatSavedThermsPellets`, `hvacHeatSavedThermsCoal`, `hvacHeatSavedThermsKerosene`, `hvacCoolSavedMbtu`, `hvacCoolSavedKwh`, `hvacCoolSavedTherms`, `hvacCoolSavedThermsGas`, `hvacCoolSavedThermsPropane`, `hvacCoolSavedThermsOil`, `hvacCoolSavedThermsWood`, `hvacCoolSavedThermsPellets`, `hvacCoolSavedThermsCoal`, `hvacCoolSavedThermsKerosene` |
| `dhw`       | 59        | 47                                                             | **12**: `uuid`, `customFields`, `dhwSavedMbtu`, `dhwSavedKwh`, `dhwSavedTherms`, `dhwSavedThermsGas`, `dhwSavedThermsPropane`, `dhwSavedThermsOil`, `dhwSavedThermsWood`, `dhwSavedThermsPellets`, `dhwSavedThermsCoal`, `dhwSavedThermsKerosene`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `attic`     | 36        | 34                                                             | **2**: `uuid`, `customFields`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `window`    | 35        | 33                                                             | **2**: `uuid`, `customFields`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `basedata`  | 294       | 293                                                            | **4**: `customFields`, `demandKw`, `demandKwImproved`, `demandKwSavings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `report`    | 79        | 76                                                             | **3**: `customFields`, `lastPdfUrl`, `lastPdfGeneratedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `utilities` | 136       | 99 (`POST` only; `PUT` has **no parameters at all**)           | **37**: `customFields` plus `normalizedElectricMbtuMonthly01`–`12`, `normalizedFuelMbtuMonthly01`–`12`, `normalizedTotalMbtuMonthly01`–`12`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**`basedata` casing bug.** The three `demandKw*` response-only fields are not truly unwritable — the write endpoint spells them with a capital `W`. The response says `demandKw`, `demandKwImproved`, `demandKwSavings`; the `formData` says **`demandKW`, `demandKWImproved`, `demandKWSavings`**. These are the only three write-only-but-not-in-response names anywhere in the C set. Any round-trip mapping keyed on the response name will silently drop electrical demand.

**Additional C-class finds outside the requested set:**

| Resource                                                                                                                           | Response-only fields                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `job` (`POST /jobs` 32 fields, `PUT /jobs/{jobId}` only 5: `serviceTime`, `accountId`, `companyId`, `note`, `householdIncomeTier`) | `id`, `doeWap`, `hasCalculated`, `hasUnmodeledChanges`, `completionDate`, `firstModeledAt`, `hasOutdatedHpxml`, `lastModeledDate`, `bpiCalibrationStatus`, **`auditStarted`**, **`auditEnded`**, `customFields`                                        |
| `recommendation` (9 writable of 25)                                                                                                | `uuid`, `savings`, `sir`, `savedMbtu`, `savedKwh`, `savedTherms`, `savedThermsGas`, `savedThermsPropane`, `savedThermsOil`, `savedThermsWood`, `savedThermsPellets`, `savedThermsCoal`, `savedThermsKerosene`, `category`, `captions`, `detailedCosts` |
| `hvac` create/update asymmetry                                                                                                     | `hvacSystemEquipmentType` is accepted by `POST /jobs/{jobId}/hvac` (create) but **not** by `POST /jobs/hvac/{uuid}` (update) — the only such field in the whole spec.                                                                                  |

`auditStarted` and `auditEnded` are the notable ones: an auditor plausibly dictates when the audit began and ended, and neither can be written.

The dominant pattern is benign — response-only fields are almost entirely (a) `uuid`, (b) `customFields`, and (c) modeled outputs (`*Saved*`, `normalized*`, `*EquivalentFullLoadHours`, `*Efficiency`). Nothing in the C set except `auditStarted`/`auditEnded` is a `combustionVentType`-class trap; the real traps are at the resource level (task A), not the field level.

---

#### D. The health endpoint remainder

`POST /jobs/{jobId}/health` carries **16 `formData` parameters** (plus a malformed 17th, `customFields`, which has no `in` — see E). All 16 are `type: string`, all `required: false`. The `health` definition mirrors them exactly, 1:1, plus `customFields`.

| #   | Field                                | Enum (verbatim)                             | Covered? |
| --- | ------------------------------------ | ------------------------------------------- | -------- |
| 1   | `healthAmbientCarbonMonoxide`        | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 2   | `healthNaturalConditionSpillage`     | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 3   | `healthWorstCaseDepressurization`    | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 4   | `healthWorstCaseSpillage`            | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 5   | `healthUndilutedFlueCo`              | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 6   | `healthDraftPressure`                | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 7   | `healthGasLeak`                      | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 8   | `healthVenting`                      | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 9   | `healthMoldMoisture`                 | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 10  | `healthRadon`                        | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 11  | `healthAsbestos`                     | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 12  | `healthLead`                         | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 13  | `healthElectrical`                   | `Passed`, `Failed`, `Warning`, `Not Tested` | yes      |
| 14  | `healthRoofCondition`                | `Good`, `Potential Issues`, `NA`            | yes      |
| 15  | **`healthDrainageSystemCondition`**  | `Good`, `Potential Issues`, `NA`            | **NO**   |
| 16  | **`healthSafetyQuestionsDisclosed`** | `Yes`, `No`                                 | **NO**   |

**The 2 uncovered fields are `healthDrainageSystemCondition` and `healthSafetyQuestionsDisclosed`.**

`healthDrainageSystemCondition` shares the exact enum shape of the already-covered `healthRoofCondition` (`Good` / `Potential Issues` / `NA`), so extending coverage is a one-line addition to whatever handles the roof field — an auditor dictating "gutters and grading look fine" maps straight to `Good`.

`healthSafetyQuestionsDisclosed` is different in kind: a boolean-ish `Yes`/`No` attestation. Per its description, _"IRA programs require answers to applicable Safety Testing questions be disclosed to the homeowner."_ This is a compliance attestation about a conversation with the homeowner, not a measurement — it is the one health field that should probably **not** be inferred from a recording. Recommend explicit operator confirmation rather than dictation capture.

Note also that all 14 `Passed`/`Failed`/`Warning`/`Not Tested` fields share an identical description explaining that `Warning` means a condition was observed without a formal test — which matters for mapping hedged speech ("looked a bit sooty, didn't test it") to `Warning` rather than `Failed`.

---

#### E. Spec drift check

##### E.1 — Measured counts

| Metric                                         | Count                                 |
| ---------------------------------------------- | ------------------------------------- |
| Paths                                          | **92**                                |
| Operations (`get`/`post`/`put`/`delete`)       | **121**                               |
| — `get`                                        | 57                                    |
| — `post`                                       | 40                                    |
| — `delete`                                     | 18                                    |
| — `put`                                        | 6                                     |
| — `patch`                                      | 0                                     |
| Definitions                                    | **63**                                |
| Write operations total (`post`/`put`/`delete`) | 64                                    |
| Distinct write operations carrying `formData`  | **42** (41 `post` + 1 `put`)          |
| Total `formData` parameters over all write ops | **1169** (1160 on `post`, 9 on `put`) |
| Distinct `formData` parameter **names**        | 837                                   |
| GET-only paths                                 | 48                                    |

##### E.2 — Claim (1): zero `patch` operations — **CONFIRMED**

The substring `"patch"` occurs **0 times** in the raw 1.2 MB document. The method counter over all 92 paths yields no `patch` key.

##### E.3 — Claim (2): no `securityDefinitions`, no top-level `security`, no `in: header` parameter — **CONFIRMED**

| Probe                                       | Raw occurrences |
| ------------------------------------------- | --------------- |
| `securityDefinitions`                       | 0               |
| `"security"` (top-level or operation-level) | 0               |
| `"in": "header"` / `"in":"header"`          | 0               |
| `Authorization`                             | 0               |
| `apiKey`                                    | 0               |
| `oauth`                                     | 0               |
| `basic`                                     | 0               |

Top-level keys are exactly `swagger`, `info`, `basePath`, `schemes`, `consumes`, `produces`, `paths`, `definitions` — no `security` block. No operation carries a `security` key. Authentication is described only in prose: `info.description` links to _"Read this article for authentication information."_ **The spec is unusable as a source of auth wiring; the scheme must come from the help article.**

##### E.4 — Claim (3): every write operation's params are `in: formData` — **REFUTED, three ways**

Parameter `in` distribution across the whole spec:

| Method   | `in`                | Count  |
| -------- | ------------------- | ------ |
| `post`   | `formData`          | 1160   |
| `post`   | **`null` (absent)** | **37** |
| `post`   | `body`              | 1      |
| `post`   | `path`              | 1      |
| `put`    | `formData`          | 9      |
| `put`    | `path`              | 3      |
| `put`    | `body`              | 2      |
| `delete` | `body`              | 2      |
| `get`    | `query`             | 4      |

**(a) 37 parameters have no `in` key at all.** This is a spec bug, not a design choice. 35 of them are the `customFields` parameter, which is attached to nearly every write endpoint (`basedata`, `attic`, `clothesDryer`, `concern`, `dhw`, `door`, `freezer`, `hvac`, `pv`, `range`, `recommendation`, `refrigerator`, `vault`, `wall`, `window`, `health`, `report`, `utilities`, and all the `/{uuid}` update twins) with the description _"It accepts array of objects with key and value as strings, e.g. `[ { "key": "custom_field_key", "value": "12.4" } ]"*. The other 2+3 are `templateUuid`, `name`, `category`on`POST /jobs/direct-installs/{directInstallUuid}/line-item`and`templateUuid`, `name`on`POST /jobs/recommendations/{recommendationUuid}/line-item`. A strict Swagger 2.0 validator rejects all 37 (`in` is required); a generator will most likely drop them silently. **`customFields` is therefore the single most widely-available escape hatch in the API and the least reliably described._*

**(b) 5 write operations use a JSON `body` parameter instead of `formData`:**

| Operation                                                         | Body param         |
| ----------------------------------------------------------------- | ------------------ |
| `POST /programs/{programId}/direct-install-line-item-templates`   | `templatesPayload` |
| `PUT /programs/{programId}/direct-install-line-item-templates`    | `templatesPayload` |
| `DELETE /programs/{programId}/direct-install-line-item-templates` | `templatesPayload` |
| `PUT /programs/{programId}/checklist`                             | `checklistPayload` |
| `DELETE /programs/{programId}/checklist`                          | `checklistPayload` |

These are the only operations whose request shape is described by a definition rather than a flat field list. Note that two of them are `DELETE` with a body.

**(c) 22 write operations carry no `formData` at all** — the 16 `DELETE /jobs/<resource>/{uuid}` ops (which have a literally empty `parameters: []`, not even the `uuid` path param; each returns `deletedCollection`), the 5 body-based program ops above, and:

- **`PUT /jobs/{jobId}/utilities`** (`operationId: updateUtilitiesLegacy`) has an **empty `parameters` list** — no `jobId` path parameter, no fields — yet returns the full 136-property `utilities` schema. It is undocumented in every practical sense. Use `POST /jobs/{jobId}/utilities` (99 `formData` fields) instead.

**(d) Path parameters are declared inconsistently.** Only 4 `path` parameters are declared in the entire spec (`PUT /jobs/{jobId}` → `jobId`; `POST /jobs/{jobId}/stage` → `jobId`; `PUT /jobs/{jobId}/tickets/{ticketId}` → `jobId`, `ticketId`), despite 60+ paths containing `{...}` templates. Every other path variable is undeclared. Additionally, `POST /jobs/{jobId}/stage` declares `jobId` as **`formData`**, not `path`, while `PUT /jobs/{jobId}` declares it as `path` — the same variable, two different locations, in the same spec.

Only 4 `query` parameters exist: `altId` and `stageId` on `GET /jobs`, `archived` on `GET /jobs/{jobId}/checklist-answers`, and `status` on `GET /jobs/{jobId}/recommendations`. There is no pagination parameter anywhere.

---

## 7. What instance modeling has to handle that it does not today

[R1.6's instance-modeling design](../roadmap/design/r1.6-instance-modeling-design.md) solved a flat,
one-level array of instances per resource for `hvac`, `attic`, `wall`, `window` and `dhw`, with
review-scoped stable keys, create-by-default linking and per-instance idempotency. Extending capture
beyond `basedata` adds four things that design does not express. None is solved here; each is flagged
with the evidence that makes it real.

1. **A second nesting level, with sequenced writes.** Recommendations and direct installs own line
   items whose create path is parented by a uuid that only exists after the parent create returns
   (§4.4). `resolveReview`'s key→position mapping is one level deep; a child's position is meaningless
   without its parent's identity. The incentive `recommendations[]` array reaches sideways into level
   2, so the shape is a graph.

2. **Instances with no wire-side identity at all.** Nine of the twelve repeating component resources
   have no name/label/location field (§4.2). R1.6 §10.4's reviewer affordance — "the reviewer sees the
   candidate existing records beside the dictated instance" — renders two anonymous attics that differ
   only by `atticPercent`. Whatever label the review card shows has to be Ribo's, held against a
   `uuid`.

3. **Update-only and create-only resources.** Tickets can only be updated (`PUT
/jobs/{jobId}/tickets/{ticketId}`; no create exists), so a dictated ticket must _select_ an existing
   `ticketId` fetched from the API — the reverse of R1.6's create-by-default policy, and with no
   natural key to select on. Conversely 27 of `POST /jobs`'s 32 fields are **create-only** (§4.6), so a
   dictated correction to a customer's name has no write path. And `hvacSystemEquipmentType` — one of
   the two required capture fields — is accepted on create but not on update (§4.7).

4. **Order that is semantically significant, on exactly one resource.** `refrigeratorName`'s
   description carries _"For HPXML purposes, always enter the house's 'primary' refrigerator first."_
   R1.6 §10.2 deliberately separates order (presentation) from key (identity); this is the one place
   the vendor makes order load-bearing.

Two smaller cardinality facts worth recording: `dhwPercentLoad`'s wording — _"**Both** systems must add
up to 100%"_ — implies the UI caps DHW at **two** instances where `hvac`'s _"all heating systems"_ is
open-ended (confirm against the live API before assuming a limit); and `dhwAge`, `dhwLocation` and
`dhwTemperatureSettings` are all documented as _whole-home_ answers ("if more than one system, select
the one that delivers the most gallons") despite living on a per-instance resource, so their meaning on
a second instance is ambiguous.

---

## 8. Sizing, and proposed build tranches

### 8.1 How these numbers were derived

`schema.ts` records a measured figure: the full `snuggExtractionSchema` with vendor descriptions
serializes to **39,741 characters** for its 51 leaves, against the structured-output route's
`SCHEMA_SERIALIZED_CHAR_CAP` of **32,768**. Those same 51 leaves carry 877 characters of wire names,
15,296 of vendor descriptions and 3,377 of enum members — 19,550 characters of _material_. The
residual, 20,191 characters, is envelope boilerplate (`value` / `confidence` / `sourceSpan`, `type`,
`required`, `additionalProperties: false`) plus Ribo's own added per-leaf notes: **396 characters per
leaf**.

> **estimated serialized chars ≈ 396 × leaves + (wire names + vendor descriptions + enum members)**

Cross-checked against the repo's other measured point: applying it to the 14 covered `health` leaves
predicts 12,409 characters against the ~13.3k `schema.ts` records for that group — within 7%. Every
figure below is that estimate, and every figure is an **upper bound for its tranche**, because it sizes
the whole endpoint half rather than only the curated `capture` / `capture?` subset.

Two ceilings matter, and they are independent: the route's 32,768-character schema cap (`schema.ts`),
and OpenAI's documented 1,000-enum-value cap ([doc 16 §1](16-extraction-schema-scale.md)).

### 8.2 The scale problem, stated

| scope                                                | leaves | enum values | est. serialized chars | vs. 32,768 cap                                   |
| ---------------------------------------------------- | -----: | ----------: | --------------------: | ------------------------------------------------ |
| the whole new surface beyond `basedata`, as one call |    506 |       1,095 |          **~311,000** | **9.5× over** — and over the enum cap on its own |
| base side only                                       |    380 |         547 |          **~224,000** | 6.8× over                                        |
| the largest single endpoint (`utilities`)            |     99 |          27 |               ~63,800 | 1.9× over                                        |
| the second largest (`report`)                        |     76 |          99 |               ~37,000 | 1.1× over                                        |
| **every other endpoint, individually**               |    ≤72 |        ≤203 |           **≤21,700** | **under**                                        |

**That last row is the useful finding.** The per-group decomposition R3 already ships — one
structured-output call per write endpoint, which exists precisely because the 39,741-character
whole-schema call was over — extends to the entire job surface with exactly two exceptions, and both
split along a seam the vendor's own naming already marks:

- **`utilities`** splits into a 50-field **12-month detailed bill series** (`start|end`
  `Electric|Fuel` `Date|Bill` `1..12`, ~36.8k on its own) and a 49-field remainder (~27.0k, under the
  cap). The series is not dictation data at all — 13 meter-read dates and 12 amounts per stream, which
  arrive by photograph, Green Button import or a phone call to the utility. Treating it as an import
  path rather than schema leaves both fixes the size problem and removes 50 forced-`null` triples from
  every extraction (doc 16 §4's economics argument).
- **`report`** splits into 30 authored-text fields (~14.3k) and 46 `element*`/`page*` display flags
  (~22.7k). Both halves fit; they are separate tranches because their extraction problems are
  unrelated.

### 8.3 Proposed tranches

Ordered roughly by value-per-byte — smallest, highest-dictation-density first. "leaves" is the whole
endpoint half; the curated `capture` + `capture?` subset is smaller in every row.

|   # | tranche                                              | endpoints                                                |              leaves |   est. chars | fits one call                                                                                                               |
| --: | ---------------------------------------------------- | -------------------------------------------------------- | ------------------: | -----------: | --------------------------------------------------------------------------------------------------------------------------- |
|   1 | **Health completion**                                | `health`                                                 |                   2 |        ~1.4k | yes — merges into the existing `health` group, no new group needed                                                          |
|   2 | **Homeowner concerns**                               | `concern`                                                |                   2 |        ~1.1k | yes — the purest extraction target in the whole surface; two free-text fields, no enum, no FK, no template                  |
|   3 | **Incentives**                                       | `incentives`                                             |                   3 |        ~1.3k | yes — but blocked on `fromTemplateUuid` resolution (§4.3)                                                                   |
|   4 | **Workflow verbs**                                   | `stage`, `tickets`                                       |                   4 |        ~2.0k | yes — value lists live in prose, not `enum` (§4.5)                                                                          |
|   5 | **Recommendations, level 1**                         | `recommendation`                                         |                   9 |        ~4.7k | yes — but blocked on `recDefinitionId`, which has no listing endpoint                                                       |
|   6 | **Wall + door, base**                                | `wall`, `door`                                           |                  10 |        ~7.7k | yes                                                                                                                         |
|   7 | **Utilities — delivery windows**                     | `utilities` `delivery*`                                  |                  18 |        ~7.5k | yes; 22 of these fields have no vendor description at all                                                                   |
|   8 | **Window, base**                                     | `window`                                                 |                  19 |       ~16.4k | yes; orientation is a field suffix, so this is 19 leaves over a 4-way spatial axis                                          |
|   9 | **DHW, base remainder**                              | `dhw`                                                    |                  20 |       ~10.9k | yes                                                                                                                         |
|  10 | **Line items, level 2**                              | rec + direct-install line items                          | 20 (+2 update-only) |        ~9.0k | yes — needs the two-level nesting of §4.4 first                                                                             |
|  11 | **HVAC, base remainder**                             | `hvac`                                                   |                  27 |       ~16.9k | yes                                                                                                                         |
|  12 | **Attic + vault, base**                              | `attic`, `vault`                                         |                  27 |       ~19.8k | yes — same roof/insulation vocabulary, and `atticInsulationDepth` is where vault depth is dictated (§5.5)                   |
|  13 | **Report — authored text**                           | `report` (a1 + a2)                                       |                  30 |       ~14.3k | yes — 3 genuine prose fields, 27 short labels                                                                               |
|  14 | **Utilities — core**                                 | `utilities` minus series and delivery                    |                  31 |       ~19.5k | yes — the 7 Simple-bill scalars, 3 provider names, 8 fuel prices and 3 unit enums are the highest-yield block               |
|  15 | **Job identity & scheduling**                        | `POST /jobs`, `PUT /jobs/{jobId}`                        |                  32 |       ~16.1k | yes — 11 required fields, 5 of them system config (§4.6)                                                                    |
|  16 | **Appliances + PV, base**                            | `clothesDryer`, `freezer`, `range`, `refrigerator`, `pv` |                  32 |       ~17.3k | yes — could also split 1:1 per resource, each ≤5.3k                                                                         |
|  17 | **Report — display flags** _(deferred)_              | `report` (b1 + b2)                                       |                  46 |       ~22.7k | yes, but low value: 46 opaque integers whose meanings exist only in the response definition                                 |
|  18 | **The improved side**                                | 12 endpoints                                             |                 126 | ~86.5k total | **no as one call.** Each resource's improved half fits on its own (largest: `hvac` at ~21.7k). Do not treat as one tranche. |
|   — | _Utilities detailed bill series — **not** a tranche_ | `utilities`                                              |                  50 |       ~36.8k | **no.** Import path, not voice extraction (§8.2)                                                                            |

Tranches 1–5 total **20 leaves and ~10.5k characters** and cover concerns, health completion, the
proposal skeleton and the workflow verbs — the highest dictation density in the document. Tranches
1–16 total **286 leaves**; adding 17 and 18 reaches 458; the bill series brings the endpoint-scoped
total to 508.

**On the three-phase question.** No tranche in the table needs a decomposition beyond one call per
tranche, so the parallel three-phase-on-managed effort is not a prerequisite for any of them. Where it
would matter is the _other_ ceiling: doc 16 §4 argues that the anti-hallucination rule's cost scales
with total schema size regardless of what was said, because every leaf emits a `{value, confidence,
sourceSpan}` triple even when null. At 51 leaves that is a rounding error; at 378 candidate leaves
across 18 calls it is the dominant cost, and most of it is `null` padding for sections the auditor
never touched. Sizing says the calls are _possible_; it says nothing about whether they are worth
making, and that is the question worth measuring.

---

## 9. Open questions

Recorded so they are decided rather than rediscovered. The first two block writes outright.

1. **`recDefinitionId` has no listing endpoint.** `POST /jobs/{jobId}/recommendation` requires it, and
   none of the spec's three template-list endpoints enumerates recommendation definitions. Until this
   is answered — from the vendor, or from a live account — **recommendations cannot be created at all**,
   however well they extract. Highest-risk item in this document.
2. **Can a `directInstall` container be created?** Only its line items have a create path, and both
   require a `directInstallUuid` that nothing in the spec mints. `GET /jobs/{jobId}/direct-installs`
   exists, so an _existing_ container is discoverable; whether one is auto-created per job, per program
   enrolment, or only through the Snugg Pro UI is unknown. Direct installs are measures done on the
   spot during the visit — exactly what an auditor narrates in the moment — so this is not a marginal
   path.
3. **Do the 16 `enum: []` fields accept an arbitrary string?** The project's convention treats them as
   free-text-into-review, but that is an inference. Two of them are already in `snuggValuesSchema` with
   value lists sourced from outside this spec (§4.5); `dhwSidearmBoiler` is worse still — a
   cross-resource reference to an hvac instance with no published vocabulary at all.
4. **Is `dhw` really capped at two instances?** `dhwPercentLoad` says "**both** systems must add up to
   100%". If true it is the only such cap in the surface.
5. **Two fields with unknown semantics**, both from vendor copy-paste bugs: `utilityRatePlanPriceElectricity`
   (example `2937.32` reads as an annual dollar total, not a $/kWh rate) and `dhwSidearmStandbyLoss`
   (its description is the water-temperature field's). Do not model either until confirmed.
6. **Is the improved side a parallel schema half, or separate instances?** The vendor is inconsistent:
   most fields double with an `…Improved` suffix, but `hvacSystemEquipmentType` has no twin, so an
   equipment-class change is modelled as _two hvac instances_. Which of the two shapes Ribo adopts
   determines whether the improved side is 126 extra leaves or a second instance per group.
7. **Which of the 190 `capture?` leaves survive contact with reality?** Doc 17's closing advice —
   "revisit with real fill-rate data, not judgement" — applies with more force at 378 candidates than
   it did at 163. The two cheap sources are unchanged: the 14-transcript spike corpus says what auditors
   _say_; the API says what real jobs actually _contain_. The specific hypotheses this pass surfaced and
   could not settle: whether appliance model/serial numbers are ever dictated (the field list argues
   they are the minority — 9 of 32 base-side appliance fields are spec-sheet-only, and `refrigeratorAge`
   and `refrigeratorSize` being _banded_ enums is direct evidence that someone is eyeballing rather than
   reading a plate); whether report display flags are ever voiced; and whether the 12-month bill series
   is ever anything but an import.
8. **The efficiency precedent needs a per-field re-read, not a blanket rule.** `schema.ts`'s HAZARD 4
   excludes AFUE/SEER/HSPF as looked-up rather than dictated. Two fields found here cut against it in
   the vendor's own words: `hvacSteadyStateEfficiency` is _"measured … with a combustion gas analyzer"_
   — an on-site instrument reading — and `hesDhwEnergyFactor` says _"check the EnergyGuide label on the
   water heater"_. Both are read in the field and said aloud. Note also that the three Energy Factor
   fields use two different scales: `dhwEnergyFactor` and `dhwUnifiedEnergyFactor` are integers ×100
   (0.56 is written `56`), while `hesDhwEnergyFactor` is a decimal 0.45–4.0.
9. **Pin a spec snapshot (R1.7).** §2 measures real drift since doc 16 walked this document: +1 path,
   +4 operations, +2 definitions. Doc 17 left "commit a pinned snapshot, or commit only its hash and
   fetch fresh" as R1.7's decision; this pass is the first evidence that the choice has consequences,
   because a generator run against a moved spec produces a diff nobody asked for. As with doc 17, **the
   spec file is not committed as part of this change.**

---

## 10. Sources

- **Snugg Pro OpenAPI (Swagger 2.0) specification** — `https://app.snuggpro.com/apidocs/swagger.json`,
  public and unauthenticated, retrieved and parsed directly (1.2 MB, 92 paths, 121 operations, 63
  definitions) on 2026-09-08. Primary source for every field name, type, enum member, description and
  count above. Not committed to this repo.
- [17 — Snugg Pro field reconciliation](17-snuggpro-field-reconciliation.md) — the `basedata`
  reconciliation this document is the companion to, and the source of its methodology, verdict
  vocabulary and the `combustionVentType` dropped-field precedent.
- [16 — Extraction schema scale](16-extraction-schema-scale.md) — the structured-output limits (5,000
  properties, 1,000 enum values, 10 levels of nesting) and the cost-of-the-anti-hallucination-rule
  argument that §8.3 closes on.
- [15 — Snugg Pro API, verified](15-snuggpro-api-verified.md) — the prior architectural pass, whose
  redaction note doc 17 supersedes.
- `packages/ribo-adapter-snuggpro/src/schema.ts` — the 51 committed leaves, the
  `SCHEMA_SERIALIZED_CHAR_CAP` / `SCHEMA_NESTING_DEPTH_CAP` constants, and the 39,741-character
  measurement §8.1 calibrates against.
- [R1.6 — instance modeling design](../roadmap/design/r1.6-instance-modeling-design.md) and
  [R1.6 — instance extraction design](../roadmap/design/r1.6-instance-extraction-design.md) — the
  one-level instance model §7 measures the gaps against.
