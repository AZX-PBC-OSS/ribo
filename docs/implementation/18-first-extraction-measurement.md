# 18 — First extraction measurement against the rebuilt schema

**Date:** 2026-08-07
**Status:** Result, recorded. No code changed by this document.

Until this run, **no real model had ever been sent the adapter's rebuilt 51-leaf schema.** The
playground falls back to `FakeExtractor` without a key, the acceptance gate had been blocked since the
schema was rebuilt from the vendor spec, and the available `OPENAI_API_KEY` returns 401. So the schema,
the review card built over it and the corpus rebuilt to grade it had all shipped on the strength of
"it should work".

This records what happened when it finally ran, including the parts that failed.

## What was run

Both backends go through `cliChat` (`packages/ribo-adapter-snuggpro/acceptance/cli-chat.ts`), which
shells out to an installed CLI. **Neither has strict structured output.** The API path sends
`response_format: { json_schema: …, strict: true }` and the model _cannot_ emit a non-conforming
shape; a CLI gets the schema as text in the prompt and may return anything, so the harness finds the
JSON, validates it, and retries.

That difference is why the results below separate **shape conformance** from **content accuracy**.
Without it a failure is ambiguous between "extracted badly" and "could not produce the shape", and
those have completely different fixes.

- `claude-cli` — Anthropic, via the `claude` CLI
- `codex-cli` — OpenAI, via the `codex` CLI. **Note this is an OpenAI model without strict mode**, so
  it does _not_ answer whether the production strict-mode path works.

Corpus: the 13 double-annotated transcripts plus the worked example (`spikes/extraction-snuggpro/`).

## Shape conformance — the question this run existed to answer

| Backend      | First try | Retried, then conforming | Never conforming | Scored |
| ------------ | --------- | ------------------------ | ---------------- | ------ |
| `claude-cli` | 13 / 14   | 1 / 14                   | **0**            | 14/14  |
| `codex-cli`  | 14 / 14   | 0                        | **0**            | 14/14  |

**28 of 28 outputs carried the schema's exact shape** — all seven groups, every leaf, clean
`{ value, confidence, sourceSpan }` envelopes. Verified twice: by `score.mjs`'s own conformance check
and by parsing every result file independently.

**This retires a real risk.** [Doc 16](16-extraction-schema-scale.md) established the hard limits that
closed whole-spec extraction; the open worry was that 211 properties might be too large or too
intricate to follow _unaided_. It is not — at least for models of this class, from a plain-text prompt.

It is also the precise bar a local offline model must clear, since it will not have strict mode either.
Shape conformance is therefore the **first** gate to run against any candidate local model, before
looking at content at all.

## Content accuracy — a separate axis

| Metric                                  | `claude-cli`                | `codex-cli`                 |
| --------------------------------------- | --------------------------- | --------------------------- |
| Hazard 1 — fuel axis dropped / invented | pass (0 / 0)                | pass (0 / 0)                |
| Hazard 2 — hallucinated health pass     | pass (0)                    | pass (0)                    |
| Hazard 3 — forbidden R→band conversion  | pass (0)                    | pass (0)                    |
| Hazard 4 — enum wrong-member / invalid  | **FAIL (1 / 0)**            | pass (0 / 0)                |
| Span fidelity                           | 100% verbatim, 0 fabricated | 100% verbatim, 0 fabricated |
| Hallucination rate                      | 0.5% (2/398 GT-null)        | 0.8% (3/398 GT-null)        |
| Miss rate                               | 5.4% (7/130, 4 excused)     | 1.5% (2/132, 2 excused)     |
| Enum accuracy                           | 98.9% (86/87)               | 100% (92/92)                |

`claude-cli`'s hazard-4 failure is real and was not softened: `wall.wallsInsulated` on
`05-full-walkthrough`, expected `"Well"`, got `"Yes"`. Because the gate only writes a baseline after
every hazard passes, **no `baseline.claude-cli.json` exists** — see "A gap this exposed" below.

**The misses cluster where the corpus predicted they would.** Four of `claude-cli`'s seven are
`hvac.hvacSystemEquipmentType` dropped to null — the field whose enum conflates equipment identity
with duct-sharing, which independent annotators flagged as ambiguous on three separate transcripts and
which [the R1.6 design](../roadmap/design/r1.6-instance-modeling-design.md) exists to address. The
corpus predicted where a model would struggle, and it struggled there.

## The vocabulary result

**100% API-literal enum strings. Zero slug drift. Both backends.**

This answers a question that had been decided on design grounds and explicitly flagged as unmeasured.
When `schema.ts` was rebuilt from the vendor spec, the enum members changed from snake_cased tokens
(`well_sealed`) to the API's literal strings (`"6% - Well sealed"`). That deleted a translation layer,
but nobody knew whether a model would reproduce punctuated, cased, multi-word strings as reliably as
identifiers. On this evidence it does — every correct enum match used the literal wire string, and not
one used a slug.

**Caveat that matters for the offline goal:** this is evidence for models of this class. Reproducing an
exact string supplied in context is closer to copying than generating, which is a point in favour of it
transferring down to smaller models — but that is an argument, not a measurement.

## A gap this exposed in the gate

**A failing run leaves no durable artifact.** The gate writes a baseline only after every hazard
passes, which is right — you must not enshrine a failing state as the accepted bar. But
`acceptance/results/` is gitignored as regenerable, so a run that _fails_ records nothing at all, and
the failing run is usually the informative one. `claude-cli`'s numbers survive only in this document.

The fix is to separate the two concepts: every run writes a **run record** of what happened; only a
clean pass updates the **baseline** of what is accepted. Not done here; recorded so it is not
rediscovered.

## What this does and does not settle

**Settled:** the rebuilt schema is producible unaided; provenance spans come back verbatim; the
literal enum vocabulary is reproduced reliably; the corpus and scorer work end to end on real output.

**Not settled:** whether the production **strict-mode** path works at 211 properties — only a working
API key answers that, and "the JSON Schema is pinned and strict-verified" is a _should_, not evidence.
Nor does anything here predict a **small local model**, which is a capability question rather than a
schema-size one.
