# 15 — Snugg Pro API, verified (architectural conclusions)

**Status:** Research findings + an actionable delta list, for review. **No code or schema was
changed by this pass.**

> **Redaction note.** An earlier version of this document transcribed Snugg Pro's proprietary API
> surface directly — endpoint/verb tables, verbatim enum member lists, exact wire tokens, and the
> request-signing recipe. Snugg Pro is a third-party commercial product and that material is their
> IP, so it has been moved out of this public repo. **The full, unredacted findings live in the
> private integration notes** kept alongside the team's working copy (`ribo-private-notes/`). What
> remains here is the **design-level delta**: the architectural conclusions that drive our adapter,
> stated without reproducing the vendor's spec. Wherever a specific endpoint, enum member, or wire
> token is needed to act, **see the private integration notes**.

**Primary source (private):** Snugg Pro's machine-readable OpenAPI (Swagger 2.0) spec, obtained from
the vendor. It supersedes doc 12's `[unknown]` tags: doc 12 was built from Snugg Pro's public
**printed field sheet** and public KB and was explicit that the exact **API key names and serialized
enum tokens** were `[unknown]` because the Swagger UI was login-gated. The machine-readable spec
resolves those. Doc 12 stays as the dated research record of what was knowable from the public field
sheet alone; where the two disagree, **this document wins**. (The spec itself is not committed to
this repo — see the private notes.)

---

## The one thing to take away

**Doc 12's headline claim — "efficiency is not a capture field, there is no AFUE slot" — is wrong,
and our schema encodes that wrongness deliberately.** The API exposes writable heating-efficiency,
cooling-efficiency, and steady-state (combustion-analyzer) efficiency fields, and a writable attic
R-value field. Both "capture what Snugg captures, discard what it doesn't" decisions baked into
`schema.ts` (`heatingAfue` removed, `atticInsulationSpokenRValue` demoted to a "holding pen") were
**correct given the public field sheet and wrong given the API**.

The field sheet is a _paper intake form_. The API is the _model_. The model accepts strictly more.
Everything in the delta list below flows from that one sentence.

---

## 1. Resource model (shape, not surface)

A **job** (Snugg's word for an assessment) is the root, identified by an **integer id**; every child
resource hangs off it. Beneath a job the API has three shapes of child resource:

- **Singletons** (e.g. base data, the health matrix, report, utilities) — one per job; "update" is an
  upsert.
- **Collections** (e.g. HVAC systems, attic, water heater, walls, windows, doors, appliances,
  concerns, recommendations) — each item identified by its own **uuid**; create / update / delete.
- **Read-only rollups** (modelled outputs, exports, the combustion-appliance-zone read, alerts) —
  fetch only.

Design consequences that matter to the adapter (the exact paths and verbs are in the private notes):

1. **Update on a collection item is a POST, not PATCH/PUT.** Doc 05's placeholder
   `PATCH /assessments/{jobId}` matches nothing in this API — wrong verb and wrong noun. The real
   write is a per-component sequence, several of which need a **uuid** discovered by a prior read.
2. **The component update path is keyed by the item uuid, not the job.** A writer holding the uuid
   does not restate the job.
3. **An "everything at once" read exists but is discouraged by its own description** — prefer
   per-resource reads.

Everything our adapter cares about maps onto roughly five components: HVAC (heating + cooling
equipment **and** its ductwork — ducts are fields on the HVAC record, there is **no** separate duct
component), attic insulation, the water heater, walls/windows, the blower-door reading (a field on
the base-data singleton), and the health & safety matrix (a singleton).

**The realistic write sequence** for "an auditor dictated an HVAC system + attic + health findings"
against an existing job is: read current state per component (to find existing uuids and the current
health matrix, which we must not blank), then create-or-update each component, then upsert the health
singleton sending only the tests we heard. Two hard constraints this surfaces, neither satisfied by
our adapter today:

- **An "upgrade action" field is REQUIRED when creating an HVAC system** and has no analogue in our
  extraction schema. For a "describe what's there" audit it is a **constant** the write layer must
  supply — the auditor never says it. (Exact field name and the constant value: private notes.)
- **Equipment type is REQUIRED on create and unavailable on update.** Changing a system's equipment
  type is a delete-and-recreate, not an edit.

---

## 2. Auth — design-level only

The spec models **no** authentication (no security scheme at all), so the auth story is carried over
from Snugg Pro's public KB, unchanged: **auth is an AWS-style HMAC-SHA256 signed scheme** over a
timestamped request, with keys provisioned per company or per program. **The exact signing-string
construction, header names, and token format are proprietary and live in the private integration
notes.**

The load-bearing design conclusion (correcting docs 05/06): the egress must **sign each request
server-side** — hold the private key, compute the signature per call — **not** inject a static
`X-Api-Key`. This is a concrete change to the Helix egress design.

**One open wire-format risk:** the spec's declared content type and its per-parameter encoding are
internally inconsistent, which changes both the request encoding and what the signature covers. This
must be settled against a live key before `write()` is built.

---

## 3. Field model — the design-level facts

The per-field enum member lists, exact key names, and wire tokens are **not reproduced here** (private
notes). What matters architecturally:

- **Fuel is its own axis.** Heating energy source is a separate field from equipment type — an "oil
  boiler" is `equipmentType = boiler` + a distinct `fuel` value, exactly as doc 12 concluded from the
  public field sheet. Our fused `HeatingSystemType` enum is wrong in both directions.
- **Efficiency IS writable** (the correction to doc 12). Heating efficiency (AFUE/HSPF), cooling
  efficiency (SEER/EER), and combustion steady-state efficiency are all writable numbers, with a
  standing caveat that writing them overrides a calibrated model default — an argument for a
  confidence gate on the write, not for discarding the utterance. Duct efficiency, by contrast, is
  **derived and not writable**.
- **Attic R-value has a direct write target.** Snugg stores **both** the insulation R-value (the
  modelling input) **and** a depth band (the intake shorthand). Doc 12's premise that "auditors say
  R-values but there's nowhere to put it" is false — the R→depth-band conversion we refused to
  perform is **not needed** for the R-value path.
- **Several "assembly R-value" / ACH50 / effective-leakage fields are derived** — present in the
  parameter list but documented as calculated. Never write an ACH50 an auditor speaks; write the
  blower-door CFM50 and let the engine derive.
- **Manufacturer is a closed enum, and a dirty one** — it contains its own typos, the same brand
  under two spellings across two fields, and is missing common real brands. So snapping cannot be
  "nearest member wins"; the correct fallback is the explicit `Other` member with the spoken string
  preserved. (The measured failure mode motivating this — every wrong extraction value was a
  mis-transcribed brand name — is in doc 14.)
- **Duct "Measured" modes are coupled**: a measured leakage or insulation value is ignored unless its
  companion mode field is also set. A write-layer invariant, not a schema change.
- **Some capture concepts have no write target at all** — notably a combustion vent-system type
  (the combustion-appliance-zone resource is read-only). These must go to a `customField` or be
  marked non-writable; never silently dropped and never mis-mapped onto whole-house ventilation.

### 3.1 Health & safety is a discrete 4-state matrix

The health resource is a **singleton** carrying **13** named tests (doc 12 estimated ~11), each on
one shared 4-state enum (Passed / Failed / Warning / Not Tested), plus a few condition fields on
different state domains. The design-critical finding is that **the four states do not mean what our
schema says they mean**:

- **`Warning` is "not tested, but flagged"** — not "tested with a borderline result". Our `schema.ts`
  defines it as the opposite pole of the tested/untested axis.
- **`Not Tested` is a report-visibility switch** ("suppress this row from the homeowner report"), not
  merely an absence.

A useful corollary: our extraction's `null` ("never came up") vs `not_tested` ("explicitly skipped")
split maps correctly onto Snugg after all — defaulting an unmentioned test to `Not Tested` is safe,
while a mentioned-but-skipped test with a concern is `Warning`.

### 3.2 The six computed-at-runtime enums

Six fields declare an empty enum in the spec (fuel source, duct location, the efficiency rating
units, exterior wall construction, an indirect-water-heater boiler picker, and a per-program audit
type). **Hypothesis, well-supported by the set itself:** the spec generator emits an empty enum for
any field whose option list is **computed at request time** rather than being a static constant. The
boiler-picker proves it (its options are _this job's_ boiler records); the audit type is explicitly
per-program; fuel availability is plausibly program/utility-configurable.

**This matters more than the missing strings:** a hard-coded fuel-token list in our extraction schema
could be wrong for a given program. **The mapping must be validated at write time against a live
read, not assumed at extraction time.** (The recovered working-assumption member lists are in the
private notes.)

---

## 4. The `Improved` dimension

Roughly one in five properties (and closer to one in two among writable modelling fields) is an
`…Improved` twin. **Snugg models every job as two parallel buildings** — the _Base_ home (what
exists) and the _Improved_ home (what it becomes after the recommended work); savings are the
difference.

Three rules that follow:

1. **Our extractor writes the Base side only.** An audit walkthrough describes what is there; every
   field this adapter targets is the un-suffixed one.
2. **The "upgrade action" field is what tells Snugg how to relate the two sides.** Getting it wrong
   silently produces a savings number.
3. **A retrofit-verification product would use the Improved side** and double the field count — out
   of scope for the pilot, but the reason the schema should not name its fields as if Base were the
   only side.

---

## 5. The `customField` mechanism

Every writable component carries a `customFields` array — the sanctioned escape hatch for anything the
fixed model cannot hold (the spoken manufacturer string when the enum forces `Other`, a combustion
vent type with no native field, a "voice-captured, unreviewed" provenance marker). Keys are
provisioned by the program/company admin. Separately, per-program checklist **questions** are
writable but a job's checklist **answers** are read-only — a voice product cannot answer the
program's intake questions today. (Exact object shapes: private notes.)

---

## 6. What a pilot needs that we don't model

Ranked by how likely it is to block a real write:

1. **The required HVAC "upgrade action" constant** (§1).
2. **Cardinality.** The API is collections with percentage budgets that must sum; our schema is flat
   and assumes exactly one of each. A two-system home cannot be written from our extraction.
3. **HVAC system name** — free text, the only way a human tells two systems apart in the UI. The
   auditor says "the basement furnace"; we drop it.
4. **Base-data identity fields** — year built, conditioned area, storeys, home type, foundation
   split — frequently spoken, not extracted; and the blower-door reading lands in this same singleton.
5. **Homeowner concerns** — a dedicated endpoint exists; "upstairs is always cold" is the single most
   common non-measurement utterance and is currently unmodelled.
6. **Blower-door "tested vs estimate"** — without it, a reading can't be told from a guess.
7. **"Is condensing" (Yes/No)** — auditors state it constantly and it sets the AFUE default.
8. **Water-heater tank size and location** — both routinely spoken, both simple.
9. **Serial numbers** — required by some rebate programs; voice is a poor channel for them.
10. **Per-orientation window areas** — a real product question, not just a schema gap.

---

## 7. What we would have got badly wrong without this pass

The justification for having done it — stated at a design level:

1. We would have shipped an extractor **instructed to throw away every efficiency the auditor states**
   (prompt Rule 10) into an API with three writable efficiency fields.
2. We would have kept every spoken R-value in a "holding pen" when a direct write target exists.
3. We would have written the wrong verb/noun/shape/granularity for the write path.
4. We would have shipped an 11-test health matrix into a 13-test API, with `Warning` defined
   backwards.
5. We would have sent free-text manufacturer strings into a closed enum — the exact failure mode we
   measured (doc 14) that an enum could have caught.
6. We would have modelled a 4-state insulation-quality field as 3-state.
7. We would have forced every triple-pane window to `other`.
8. We would have written a measured duct value without its companion mode field, and had it ignored.
9. We would have carried a combustion vent type with nowhere to put it.
10. **We would have asserted a shared-duct central AC for every furnace-only home** — a wrong fact
    written into an energy model from a correct extraction, the worst class of bug here (§ M1 below).
11. We would have gone on believing the write path was the last unknown. It was the smallest one; the
    capture model was wrong in six places.

---

## 8. Delta list → `@azx/ribo-adapter-snuggpro`

**Nothing in this pass modified `schema.ts`, `prompt.md`, `spikes/` or any adapter code** — by
design, so these can be reviewed before the extraction schema moves.

### 8.0 The constraint that shapes every recommendation

The spike's committed corpus + ground-truth are the regression gate the extractor is judged against,
so **every change is priced in ground-truth**. Adding an enum member is free; renaming a token,
splitting a field, or changing what the model emits invalidates the baseline and requires re-authoring
the affected cases. That price, not correctness alone, is why several "obviously right" changes rank
below the line — and the reason for the architectural recommendation in H1: **do the wire-token
mapping at write time, not in the extraction schema** (pure new code with its own tests, zero effect
on the gate).

### BLOCKING — the adapter cannot write correctly without these

- **B1. Efficiency has a write target; Rule 10 must be reversed.** Add value+unit fields for heating
  and cooling efficiency (value and unit as **two** fields, mirroring the fuel-axis split, so the
  model never has to infer the unit from the number). Rewrite the prompt rule from "let the efficiency
  go" to "record only what was said, with its unit; never convert scales; never infer the unit".
  **Ground-truth cost is larger than "add null keys"** because two transcripts put the now-wrong
  "efficiency is a lookup, don't type it" belief into the auditor's mouth — one of those lines must be
  rewritten. Gate the write on a confidence threshold (writing efficiency overrides a calibrated
  default).
- **B2. The HVAC "upgrade action" is required on create** — a **write-layer constant**, not a schema
  change.
- **B3. Combustion vent type has no write target** — retarget to a `customField`, or keep extracting
  and mark non-writable; do **not** map it onto whole-house ventilation.
- **B4. `SnuggWriteContext` is wrong in name, type, and completeness.** The job identifier is an
  **integer** (rename `assessmentId → jobId`, type `number` not `string`), and a **program id** must
  be added (some enums are program-scoped and keys can be program-scoped). No component uuid belongs
  in the context — uuids are discovered per write. Type-level breaking change → needs a changeset;
  does not touch the extraction schema or gate.
- **B5. Replace `PATCH /assessments/{jobId}`** with the per-component read-then-write sequence (§1).
  It is a multi-request operation **with no transaction** — partial failure is a real state and the
  adapter's error type must be able to say "3 of 5 components written". (Settle the wire-format
  question first, §2.)
- **B6. Health matrix 11 → 13, and `Warning` means something else.** Add the two missing tests
  (mechanical ground-truth cost). Separately, our `Warning` doc-comment conflicts with Snugg's
  meaning and **the corpus uses ours** — this is a **product decision, not a mechanical fix**; confirm
  with a Snugg contact before changing corpus values, and for now correct only the doc comment to
  state both readings and the open question.

### HIGH — wrong data written, or good data lost

- **H1. Enum→wire-token mapping belongs in the write layer, not the extraction schema.** Keep our
  easy-to-emit snake_case tokens; add a write-time map. Reasons, weighed: an enum rename would
  invalidate the committed baseline; the wire vocabulary is **not stable** (six enums are computed at
  runtime); the wire tokens are hostile as model targets (embedded quote characters, numeric-looking
  strings); some of our members have **no** wire equivalent and must be _resolved_, not renamed; and
  the repo already decided this (`normalization.ts` lists enum→wire-token as a write-time concern).
  Mitigate map rot by asserting, in a test, that every wire value in the map is a valid member of the
  corresponding enum — checkable against the private spec on each refresh.
- **H2. Manufacturer snapper at write time** (exact match → alias table → phonetic + bounded
  edit-distance → `Other` with the spoken string preserved). Never auto-accept a fuzzy match — surface
  it on the review card ("heard _Linux_, writing **Lennox**"). Write-time, not an extraction enum,
  because three different lists exist and the right one depends on the target component. Secondary
  mitigation: seed the transcriber's hint vocabulary with the brand strings.
- **H3. Members with no wire equivalent** — resolve, don't rename: "no insulation" writes a depth of
  zero and omits the type; `other` maps to `Don't Know` or is omitted-and-flagged; "no cooling" means
  **don't create a cooling record**. Also **add a fourth insulation-quality state** (`well`) — the API
  distinguishes "all cavities full-depth" from "confirmed present, quality unknown" and our `yes`
  currently absorbs both.
- **H4. Coupled "Measured" modes** — writing a measured value ⇒ also write its companion mode field
  (leakage, insulation, blower-door). Write-layer invariants.
- **H5. Never write derived fields** — an explicit write-layer denylist (assembly R-values, ACH50,
  effective leakage area, conditioned air volume, duct efficiency). The dangerous one is a spoken
  ACH50, which would fight the engine's own calculation.

### MEDIUM — real gaps, no wrong write

- **M1. Equipment type is a superset, and the one delta that changes what "correct" means.** The API
  enum is a **superset** of the field sheet's (it adds standalone-duct furnace, steam boiler, ductless
  and ground-source heat pumps, solar thermal). Our single `furnace_central_ac` member **always**
  implies a shared-duct central AC — **wrong for a gas furnace with no AC**, and our own ground truth
  contains cases annotated "no AC mentioned" that use it. Add `furnace_standalone_ducts`,
  `steam_boiler`, `ductless_heat_pump` (leave ground-source variants to `other` — the auditor rarely
  distinguishes them by voice). **Re-read all eight affected ground-truth cases before touching
  anything** — at least two change value. Note: heating and cooling equipment type are the **same** API
  field; keep our two schema fields separate (that's what lets the model describe a furnace and a room
  AC in one utterance) and let the write layer decide record cardinality.
- **M2. Cardinality** — accept the single-system limit for the pilot and **document it** as a known
  boundary; add an HVAC system-name field; don't silently write a second system's facts onto the
  first record.
- **M3. Five missing high-value, low-risk capture fields** — blower-door tested/estimate, "is
  condensing", tank size, water-heater location, homeowner concern summary/detail, and (with a ×100
  no-decimal transform) the water-heater energy factor.
- **M4. Window glazing 3 → 6 members** (add storm and low-e variants) — purely additive, no
  ground-truth change.
- **M5. Model year is a string in the API** — keep the schema a number, stringify at write time.

### COSMETIC / DOC-ONLY

Several in-code comments in `schema.ts`, `normalization.ts`, `context.ts` and doc 05 are now provably
wrong (they assert efficiency/R-value have no write target, or point at the old placeholder endpoint).
Even if the fields don't change this week, the comments must, or the next reader inherits the error.

### Ranked summary

| #     | Delta                                                      | Rank     | Touches schema?           | Touches ground truth?           |
| ----- | ---------------------------------------------------------- | -------- | ------------------------- | ------------------------------- |
| B1    | Efficiency fields + reverse Rule 10                        | Blocking | **yes** (+3)              | **rewrite one transcript line** |
| B2    | HVAC "upgrade action" write constant                       | Blocking | no                        | no                              |
| B3    | Combustion vent type has no target                         | Blocking | no (retarget)             | no                              |
| B4    | `SnuggWriteContext`: integer `jobId`, `+programId`         | Blocking | no                        | no                              |
| B5    | Replace the placeholder PATCH with the per-component seq   | Blocking | no                        | no                              |
| B6    | Health matrix 11 → 13; `Warning` semantics — **ask Snugg** | Blocking | **yes** (+2) / doc        | mechanical + open question      |
| H1    | Wire-token map at write time (+ spec-membership test)      | High     | **no** (that's the point) | no                              |
| H2    | Manufacturer snapper + STT hint vocabulary                 | High     | no                        | no                              |
| H3    | Members with no wire equivalent; += 4th insulation state   | High     | **yes** (+1)              | mechanical                      |
| H4    | Coupled "Measured" modes                                   | High     | no                        | no                              |
| H5    | Derived-field denylist                                     | High     | no                        | no                              |
| M1    | Equipment-type superset + standalone-duct furnace et al.   | Medium\* | **yes** (+3)              | **≥2 of 8 cases change value**  |
| M2    | Cardinality: document the single-system boundary           | Medium   | **yes** (+1 name)         | mechanical                      |
| M3    | 5 missing capture fields                                   | Medium   | **yes** (+5)              | mechanical                      |
| M4    | Window glazing 3 → 6                                       | Medium   | **yes** (+3)              | no                              |
| M5    | Model year stringify at write                              | Medium   | no                        | no                              |
| C1–C6 | Stale in-code comments now provably wrong                  | Cosmetic | comments                  | no                              |

\* **M1 is Medium on effort and Blocking on data quality** — it is the only delta that causes a
_correct_ extraction to write a _false_ fact into the energy model.

**Suggested sequencing.** Land the non-schema blockers first (B2–B5) plus H1/H2/H4/H5 — pure
write-layer code that cannot move the extraction gate. Then take the schema changes as **one** batched
release (B1, B6, H3, M1, M3, M4) with a single deliberate ground-truth re-baseline, so the corpus is
re-authored once and the accuracy delta is measured once.

---

## Sources

- **Snugg Pro OpenAPI (Swagger 2.0) specification** — vendor-supplied; **not committed to this repo**
  (third-party IP). Held in the private integration notes; the primary source for every design-level
  claim above.
- **Snugg Pro public KB — API Access** — the only source for the HMAC auth scheme (the spec models no
  auth). Details of the signing recipe are in the private notes.
- [12](12-snuggpro-data-model.md) — the public-field-sheet-derived model this document supersedes.
- [14](14-transcription-measurement.md) — the measured brand-name failure mode motivating the
manufacturer-snapping proposal.
</content>

</invoke>
