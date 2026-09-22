# 0009 — Shaping a real API POST body

**Status:** Answered · **Date:** 2026-09-21 · **Target:** Snugg Pro's public Swagger
(`https://app.snuggpro.com/apidocs/swagger.json`), read-only, fetched at runtime and not committed

## The question

`proposeShapeOperations` asks a model to turn a plain zod schema into a workable extraction
target — dropping fields nobody dictates, retyping form-input strings that mean numbers,
regrouping leaves that extract better together. Its first live run used an eleven-leaf
fixture that was **already sensibly grouped**, so it proposed only drops and retypes, and
`regroup` — the operation the whole reversible-mapping design exists to make safe — never
ran against a model at all.

So: hand it a real API's POST body, flat and unshaped, the way a generated schema actually
arrives. Does `regroup` fire? Does the result map back to something the API would accept?
And **is the operation set missing anything a real schema needs?**

`definitions.basedata` is the body for `POST /jobs/{jobId}/basedata`: **294 flat
properties**, 99 carrying real enum lists, 284 carrying descriptions, ~114 KB.

## The answer

**The vocabulary is one operation short, and the probe named it.**

The model proposed **19 `regroup`s** — `thermostat`, `lighting`, `pool`, `basement`,
`crawlspace`, `hvac`, `ventilation`, `waterHeater`, `electrical`, `airSealing` and more.
**Eighteen were refused by the applier**, because `regroup` re-nests leaves _inside an
existing_ top-level group and this schema is flat: there is no `thermostat` object to move
anything into. The structural intuition was right and the vocabulary could not express it.

What is missing is an operation that **creates** the group — call it `nest` — as distinct
from `regroup`, which rearranges within one. That decision is not yet recorded in an ADR
because the operation is not built; when it is, its ADR should cite this spike as the
evidence.

Two secondary findings, both since fixed:

- The **leaf inventory the model reads was mangled for a flat schema** — a phantom group
  header per leaf, and the leaf's own name rendered as the empty string. The model was
  shown `- yearBuilt (object)` followed by `-  (string)`, 294 times.
- A **429 consumed the repair budget**, so a brief rate limit silently returned an empty
  operation set — an unshaped extraction — when the model could have produced a clean one.

Scoping agreement with the human answer key was high: **124 of the 131 drops** recorded in
[doc 17](../../implementation/17-snuggpro-field-reconciliation.md)'s field-by-field
reconciliation, with 9 missed and 2 added, from a model with no fill-rate data.

## The correction — read this before trusting any retype count

**This spike's retype scoring was wrong, and the model did better than the raw numbers
say.** The probe's own analysis script graded each retype by reading the leaf's _outer_ zod
wrapper and reported `kind=ZodOptional` for 20 of them. The applier does no such thing: it
calls `stripOptionalNullable` first and checks the inner type.

The naive converter emits every leaf as `.nullable().optional()` — the patch discipline
`enveloped()` requires — so every leaf looks like `ZodOptional` from outside. Checked
against the spec, `heatingSetpointHigh`, `heatingSetpointLow` and `coolingSetpointHigh` are
all `type: string`: form-input strings meaning numbers, exactly what the closed
string→number set exists for. Those retypes were **correct**.

So: treat every retype count here as unverified. The `regroup` finding is unaffected —
those were refused by the applier itself, not by the analysis script. The mis-grading
`score.json` and the empty `proposal.json` are deliberately not committed, and neither is
the results tree.

Worth noting the shape of that mistake — checking a surface property without unwrapping —
is the same one that produced several wrong claims in this feature's plans. It is just as
easy to write into a scoring script as into prose.

## What is here

| File            | What it does                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `naive-zod.mjs` | Mechanical Swagger→zod translation of one definition — the conversion a codegen tool would emit |
| `run.mjs`       | Fetch → convert → propose → apply → extract → reverse → validate against the original body      |

Needs `pnpm build:packages` and a gitignored `.env.local` at the repo root carrying
`HELIX_DEV_TOKEN`. The route is the OpenAI-compatible surface; `openAiChat` needs an
origin-injecting `fetchImpl` against the dev gateway.

## What it does not establish

The pilot adapter's scoping was "grown from real fill-rate data" — which fields auditors
actually speak. A model given only a schema cannot reproduce that, and this probe does not
show that it can. The honest claim is that a proposal gets a newcomer to a **working**
extraction over their own schema, not one matching a shape somebody tuned against a corpus.
