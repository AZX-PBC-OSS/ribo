# Normalization: what the LLM does vs what deterministic code does

**The question this note frames as a testable hypothesis:** is one schema-constrained LLM call
enough, or does Snugg Pro's real data model force a second, deterministic **normalization pass** in
TypeScript? Doc 12's thesis is that "just pass the schema" is materially wrong because the gap
between what an auditor _says_ and what Snugg _stores_ is a set of structural transforms the schema
cannot express. This note draws the line between the transforms that need a language model and the
ones that must **not** touch one, and predicts where each of the four hazards falls. The corpus
authored by a separate agent then tests the predictions.

Docs 03 and 05 already state the intended split as a principle — _"extract what was said, normalize
in code"_, _"normalize in code, not in the prompt."_ This note makes that principle concrete against
the real schema, and flags the one place (the health matrix) where the principle and the provenance
contract pull against each other.

## The dividing line

**The LLM does _semantic_ mapping — judgment about meaning that has no closed-form rule:**

- **Axis decomposition.** "Oil boiler" → `{ equipment: boiler, fuel: fuel_oil }`. There is no lookup
  table from surface string to axis pair; it requires understanding that "oil" is a fuel modifier and
  "boiler" is the equipment. A regex would have to enumerate every spoken fusion ("gas pack", "oil
  burner", "propane furnace", "heat pump", "mini-split") and would still miss the next one.
- **Enum member selection from paraphrase.** "Clad windows" → `wood_or_metal_clad`; "power-vented
  water heater" → `power_vented_at_unit`; "some insulation but thin" → `poorly`. The spoken form
  never equals the stored token; picking the closest member on _meaning_ is exactly what a language
  model is for and exactly what a string match cannot do.
- **Matrix-state inference.** "CO was clean" → `passed`; "high CO, red-tagged it" → `failed`; "a
  little staining, worth watching" → `warning`. Reading a state out of a denial, a hedge, or a
  narrated action is semantic.
- **Assertion vs mention.** Deciding that "there's a gas meter so I'm _assuming_ gas" is not an
  assertion of `heatingFuel`, while "it's on gas" is. This is the anti-hallucination judgment; it
  cannot be delegated to code because code cannot tell a quoted number from an asserted one.

**Deterministic code does _mechanical_ transforms — closed-form, unit-testable, and dangerous to let
a model improvise:**

- **Spoken number → int/float.** "Eighty thousand" → `80000`, "point five eight" → `0.58`. The
  prompt asks the model to do the trivial word→numeral step so a downstream field is a number, but a
  deterministic parser is the belt-and-suspenders layer and the place any residual word-forms are
  fixed.
- **Unit coercion.** CFM25 vs CFM50 vs ACH50 are different fields; if a number lands with the wrong
  reference the fix is a deterministic re-file, not a re-prompt.
- **Band bucketing _given a number_.** Once a raw depth in inches or an age in years exists as an
  int, mapping it to the band whose range contains it (`6` → `4-6`, `12` → `11-15`) is pure
  arithmetic. It must be code: a model doing interval arithmetic is a needless error source, and the
  boundary cases (`exactly 15 years`) want one audited rule, not a model's guess per transcript.
- **Enum → Snugg wire token / API enum.** `wood_or_metal_clad` → whatever Snugg's API serializes.
  Doc 12 marks the exact API tokens `[unknown]`; that final rename is a code concern, gated on a real
  API key, and no reason to complicate the extraction enum.
- **Null defaulting at the matrix.** An un-asserted health test → Snugg's `Not Tested`. Deterministic
  default; see below.

The rule of thumb: **if a competent junior could write the transform as a pure function with a
unit test, it is code's job. If it needs to understand what a sentence means, it is the LLM's job.**
The LLM's output is the closest _faithful_ representation of what was said; code turns that into what
Snugg stores.

## The four hazards, placed

| Hazard                        | LLM does                                                                                | Code does                                                                                    | Prediction                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **1. Fuel axis-split**        | Decompose fused mention onto `heatingEquipmentType` + `heatingFuel`                     | Nothing — both are semantic; code only renames enums to wire tokens                          | **Hardest for a single call.** Fuel silently dropped when spoken only as an adjective. Highest-value rule. |
| **2. Attic depth band**       | Map a stated _depth_ to a band; capture a stated _R-value_ verbatim; never both-convert | R-value → depth conversion (reviewed table, climate/material aware); number → band bucketing | Split deliberately. The R→depth conversion is the one transform we refuse to let the LLM do at all.        |
| **3. Health matrix**          | clean→`passed`, problem→`failed`/`warning`, explicit-skip→`not_tested`, silence→`null`  | `null` → `Not Tested` default at write time                                                  | Model must not invent `passed` on silent tests, and must not drop clean results. Both are the same call.   |
| **4. Efficiency non-capture** | Ignore spoken AFUE/SEER; capture make/model/year/BTU only                               | Nothing to derive at capture; efficiency lookup is a Snugg concern, not ours                 | Low risk _if_ the prompt is explicit; the temptation is a model helpfully parking "92%" somewhere.         |

### Hazard 2 in detail — the split that proves the point

Attic insulation is the cleanest illustration of the LLM/code boundary because it needs **both**
sides and they must not be confused:

- The auditor says **"about six inches of blown-in"** → the LLM maps `six inches` to band `4-6`
  (semantic: it decided "six inches" is a depth, not a joist size). No arithmetic — the band members
  are few enough that the model reads it directly, and code re-validates.
- The auditor says **"R-38 up top"** → the LLM must **refuse to convert** and instead park `38` in
  `atticInsulationSpokenRValue`, leaving the band `null`. The R→depth map is climate- and
  material-dependent and lossy in both directions (doc 12 §4); it belongs in a **reviewed
  deterministic table** or in front of the auditor, never in a per-transcript model guess. This is
  the single place where the design tells the LLM _do not normalize_, precisely because the
  normalization is unsafe.

If the corpus shows models converting R-38 → `10-12` on their own, that is a finding: the prompt's
"do not convert" instruction is not holding, and the schema needs the R-value holding-pen (which it
has) to remain the only sink for spoken R-values.

### Hazard 3 in detail — where the contract tension lives

The provenance envelope's rule is **`null` = not stated**. The health matrix wants a fixed state for
every test, and Snugg has no null — an un-run test is stored as `Not Tested`. These pull against each
other, and the resolution is deliberate:

- The **LLM** keeps the envelope honest: an affirmative clean result is `passed`, an explicit skip is
  `not_tested`, and a test **never mentioned** is `null` (not `passed`, not `not_tested`). This keeps
  "the auditor addressed asbestos and skipped it" distinct from "asbestos never came up" — a
  distinction the review card wants to show.
- **Code** applies the default `null` → `Not Tested` at write time, because Snugg has no null state.

The competing hypothesis — have the LLM emit `not_tested` for silence directly — is rejected here for
a measurement reason: it erases the null, and the null is what makes _hallucinated pass on a silent
test_ observable. If silence were `not_tested` at the LLM layer, a model that stamps `passed` on
tests nobody discussed would be indistinguishable from one that correctly reports nothing. Keeping
silence as `null` is what lets the health-matrix-state metric (README §health) catch the invented
pass. **This is the crux the corpus tests: can a single call hold "clean → passed" and "silence →
null" apart, or does it collapse toward one default?**

## The hypothesis, stated for the corpus to falsify

> **A single schema-constrained call, with a prompt carrying the axis-split / band / matrix rules,
> produces a faithful "what was said" extraction; a thin deterministic pass (number parsing, unit
> coercion, band bucketing from a raw number, R→depth via a reviewed table, enum→wire token, and the
> `null`→`Not Tested` default) turns that into what Snugg stores. No second _LLM_ call is needed.**

The corpus falsifies this if it shows any of:

- **Axis fusion under load** — the model drops `heatingFuel` when the fuel was only an adjective, or
  emits a fused token, especially on dense/long transcripts. → the split may need its own targeted
  call or a validation pass, changing the latency/cost story in doc 03.
- **Unsafe R→depth conversion** — the model converts R-values to bands on its own despite the
  instruction. → prompt is insufficient; the deterministic table is load-bearing and the holding-pen
  field must stay.
- **Matrix collapse** — the model stamps `passed` on silent tests, or drops clean results to `null`.
  → the health matrix may need a per-test grounding check (a second validation call), the exact
  second pass doc 03 flags as the fallback if the one-call design does not hold.
- **Band boundary errors that the model, not code, caused** — off-by-one-bucket on a number the model
  bucketed instead of leaving raw. → move all bucketing to code; the LLM should emit the raw number,
  not the band, for numeric-source bands.

If none of these appear at a material rate, the one-call-plus-deterministic-pass design stands, and
the normalization pass is a small, testable, model-free module — which is the outcome the whole
Snugg adapter design in doc 05 is betting on.

## Recommendation

1. **Keep extraction a single call.** Put all four hazard rules in the prompt (they are semantic).
2. **Build the deterministic pass as a pure module**, unit-tested field by field: number parsing,
   unit re-filing, band bucketing from raw numbers, the reviewed R→depth table, enum→wire tokens, and
   the `null`→`Not Tested` matrix default. It never calls a model.
3. **For numeric-source bands (`dhwAgeBand`, and depth-derived attic bands), prefer the LLM emit the
   raw number and code bucket it** — but the attic band members are so few that direct mapping is
   acceptable if the corpus shows the model does not err at boundaries. Let the data decide which.
4. **Never let the LLM convert R-value → depth band.** That transform is reviewed-table-only. The
   `atticInsulationSpokenRValue` holding-pen exists so a spoken R-value survives without corrupting
   the band.
5. **Keep health-matrix silence as `null` at extraction** and default to `Not Tested` in code, so the
   invented-pass failure mode stays measurable.
6. **Add a second LLM (validation) pass only if the corpus shows the one-call design failing** on
   axis fusion or matrix collapse — not preemptively. Doc 03 already names this as the escalation.
