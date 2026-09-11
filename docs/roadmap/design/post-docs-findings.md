# Findings from the docs repositioning and the Mistral spike

**Date:** 2026-09-11
**Status:** Work list. Nothing here is built.

Everything below surfaced while rewriting the docs or while probing whether Mistral Document AI
and Instructor.js belong inside Ribo rather than beside it. The docs work is merged (#62). This
is what it turned up about the code.

Ordered by whether it is a bug, a decided change, or a proposal.

---

## Bugs

### B1. The shipped on-device model has never been measured

`spikes/transcription-measurement/run-real-ondevice.mjs:23` reads
`const modelId = process.argv[2] ?? "Xenova/whisper-base.en"` — a default independent of the
package's `DEFAULT_MODEL_ID`, which has been `onnx-community/moonshine-base-ONNX` since
2026-08-11. The real-field-audio run (Part D) was measured 2026-09-08, a month after the switch,
and the README's reproduce steps invoke the harness with no override.

So every transcription figure Ribo publishes — RTF 0.159, 8.0% WER, the real-field RTF
0.101/0.108 — describes Whisper, and Moonshine has never been measured on any corpus. The docs
now say so; the harness is still wrong.

**Fix:** default the harness to `DEFAULT_MODEL_ID`, then re-run. Both arms are worth keeping —
comparing the two models on one corpus is more useful than replacing one number with another.

### B2. The acceptance gate's freshness fingerprint does not cover prompts

`packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts` computes its baseline-freshness
fingerprint as a sha256 of the frozen JSON Schema fixture alone. Prompt content —
`instructions.ts`, the few-shot examples — is not in the hash. Change a prompt and the
fingerprint still matches, so a stale baseline is reused while the gate reports itself fresh.

Its own doc comment argues that incomparable runs must not look comparable. That argument applies
to prompts at least as strongly as to schemas: a prompt change is exactly the kind of thing that
moves extraction quality.

**Fix:** fold the prompt inputs into the fingerprint.

### B3. `markCaptures` is unreachable through the relay

`relay.ts:460` calls `joinSessionTranscript(this.#options.outbox, session.id)` with no options
argument, and `RelayOptions` carries no join options. Per-capture attribution markers were
designed, documented at length and shipped — and cannot be turned on by anything using the relay,
which is the primary path. Only a caller invoking `joinSessionTranscript` directly can reach them.

Subsumed by P3 if that lands; worth fixing on its own if it does not.

### B4. `loosen` does not decode HTML entities — **decided: fix in `loosen`**

`spanGroundedness`'s middle tier normalises case, curly quotes and whitespace runs. It does not
decode HTML entities, so a span differing from the transcript only by `&` versus `&amp;` is
neither `grounded` nor `near-miss` — it lands in `ungrounded`, the tier reserved for text the
model invented.

This is the precise failure the near-miss tier exists to prevent; its doc comment motivates the
tier with column padding and warns that once a fabricated citation and a re-spaced one are
indistinguishable, the flag stops meaning anything. Entity escaping is the same problem from a
different source, and it did not exist when the tiers were designed because speech transcripts do
not contain `&amp;`.

Measured: one Wrightsoft Manual J's OCR markdown contains **39** `&amp;` against 2 literal `&`.
In the Mistral spike this accounted for **100%** of remaining ungrounded spans; decoding would
have taken the document from 46/48 to 48/48.

**Decided:** decode entities inside `loosen`. Deliberately _not_ chosen for now: decoding at the
transcriber so `Transcript.text` holds text as a human reads it. That is arguably the better fix
— the transcript is what review displays, and a reviewer shown `&amp;` is being shown an
implementation detail — but it is a statement about what `Transcript.text` means and affects
every document transcriber. Recorded as open.

---

## Decided

### D1. Vocabulary: "contract" replaces "seam", "plasmid" goes

Applied to the package READMEs during the docs pass. The library has not caught up: `AGENTS.md`
§6.1 defines the package-naming scheme in terms of plasmids, "seam" recurs throughout, and both
appear in doc comments across `packages/*/src` and in the design docs here. Prose only — no
identifier changes. Not urgent, but a split vocabulary between the published docs and the repo's
own notes is the drift this project keeps having to correct.

### D2. `Transcript.text` holds rendered text, not escaped markup

Recorded as open under B4; now decided. `transcript.ts` documents `text` as "exactly what the
model saw", and for document transcribers that currently means HTML/markdown-escaped text. Two
consequences, both bad: a reviewer shown `&amp;` is being shown an implementation detail, and a
model asked to quote from escaped text has to choose between copying the escape and copying the
character — so a correct citation can fail the grounding check on an encoding difference.

**Decided:** decode at the transcriber, so the canonical text is already rendered before anything
quotes from it or checks against it. Affects `ribo-transcriber-pdfjs` and
`ribo-transcriber-managed-docs`. B4's decode-inside-`loosen` stays as well — the two are not
alternatives. Rendering at the transcriber fixes the text a human reads; a tolerant near-miss tier
still catches a span that arrives encoded from a provider that returns its own markdown.

Folded into P4, since what `Transcript.text` contains is the same question as what the
transcribe→extract seam carries.

---

## Proposals

### P1. Feed the validation error back on retry

Today a `SchemaParseError` either falls through to another strategy or is resent identically — the
model is never told what it got wrong. Instructor.js's one genuine idea is to return the
validation error to the model so it can self-correct, and `gap-fill.ts` already has the right
shape: a bounded, targeted follow-up call.

A small combinator, no new dependency. The clearest win on this list.

(Instructor.js itself: rejected. It requires an `openai` SDK client with
`dangerouslyAllowBrowser: true`, exposing the key client-side — the thing Ribo's transport design
exists to prevent. ~53 KB gzip floor, no answer to schema scale, last release 2025-01-27.)

### P2. Plugin-scoped storage, swept by core

Plugins get a storage namespace tied to capture lifetime; core deletes a plugin's keys when a
capture is dropped or discarded. This is what makes a transcriber and an extractor from the same
package able to share state without core learning what they share, and it is the same injection
move as `openOutbox({ storage })` and the injected `fetch`.

It must be durable storage, not instance state: `database.ts` registers `multiInstance: true` with
leader election explicitly deferred, so the two halves may run in different tabs, minutes apart.

Lifecycle chosen: plugin-scoped namespace, core sweeps. Considered and not chosen: plugin sweeps
its own (silent leaks), and handing plugins the `Outbox` directly (makes its API a plugin-facing
contract by accident).

### P3. A combiner seam

Replace the hardcoded `joinSessionTranscript` call with a pluggable, **pure** combiner:
`(parts: AnnotatedTranscript[]) => AnnotatedTranscript`. The relay does the I/O — list the
session's transcribed captures, gather plugin annotations, sort by `seq` — and the combiner
transforms an array, so it is testable without a database. Today's version takes the `Outbox` and
cannot be.

The default combiner reproduces current output byte-for-byte and takes `markCaptures` as an
option, which fixes B3.

That `markCaptures` is a boolean bolted onto a policy function is the evidence this wants to be a
seam: someone already felt the pressure here and relieved it with a flag.

### P4. An annotated transcript as the transcribe→extract seam

`Extractor.extract(transcript: string)` becomes `extract(t: AnnotatedTranscript)`, where the type
carries a canonical `text` plus an open annotations bag.

Grounding is unaffected: `isSpanGrounded` needs _a canonical text_, not a seam that _is_ a string.
`isSpanGrounded(span, t.text)` is unchanged.

Blast radius: 6 extractor implementations, the contract, `FakeExtractor`, `toSessionExtractStep`,
two call sites in `arbitration.ts`, `SessionExtractInput`, and their tests. Mechanical — most
implementations take the string and hand it to a prompt builder, so the migration is
`transcript` → `transcript.text`.

**The argument is timing, not design.** Nothing is published. After R4, this is a breaking change
with external consumers; today it is a refactor and a changeset. The code cost is the same
whenever it happens.

Recommendation: change the shape now, do not invent the contents now — a canonical text plus an
open bag, and no annotation schema until something produces one.

### P5. A Mistral Document AI package

Now evidenced rather than speculative. Measured 2026-09-11 against
`mistral-document-ai-2512` on Azure AI Foundry, one Wrightsoft Manual J, 24 pages:

|                                |                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Endpoint                       | `POST {resource}/providers/mistral/azure/ocr?api-version=2024-05-01-preview`                    |
| Round trips                    | **one** — `pages` (OCR markdown) and `document_annotation` in the same response                 |
| Latency                        | ~38s                                                                                            |
| Schema                         | accepted an `enveloped()`-shaped strict JSON schema, `value`/`confidence`/`sourceSpan` per leaf |
| Verbatim spans, generic prompt | bimodal: 31% / 93% / 31% / 98%                                                                  |
| Verbatim spans, pinned prompt  | **95.8%**, stable over five runs                                                                |
| Near-misses                    | zero, every run                                                                                 |
| Remaining failures             | entity encoding only — see B4; would be 48/48 with that fix                                     |

No new provenance kind, no bbox conversion. The values were right in both modes — only the
citation differed, which is why span-checking is the thing that catches this.

Open: whether a Mistral-native path is worth it at all is a _quality_ question this spike did not
answer. It measured shape, not whether native extraction beats flattened text.

---

## Resolved

### The 37% per-cell fabrication figure did not reproduce

Measured 2026-09-11, `spikes/prompt-vs-granularity/`. A 2x2 factorial —
leaf/row granularity x current/pinned prompt wording — five runs per cell, `claude-haiku-4-5`
through `singleShotExtractor`, scored with `spanGroundedness`:

| arm           | verbatim | per-run rates            |
| ------------- | -------- | ------------------------ |
| leaf, current | 99.5%    | 97.7, 100, 100, 100, 100 |
| leaf, pinned  | 100%     | 100, 100, 100, 100       |
| row, current  | 98.8%    | 100, 100, 100, 94.1, 100 |
| row, pinned   | 100%     | 100, 100, 100, 100, 100  |

Three negatives at once. Pinning does not beat the current wording by a wide margin, because
there was nothing to rescue. There is no bimodality — the distribution is unimodal at the top,
not the Mistral spike's two modes. And leaf is marginally _better_ than row, so the row-versus-leaf
gap never appeared at all. Every ungrounded span across all 20 runs was on the house totals; the
room table was perfect in both granularities.

This does **not** show the original 37% was a prompt artifact — too much differs. Different
document, different schema (87 spans against 46), and different extraction mechanism: the original
ran `perGroupExtractor` against the Helix gateway, this ran Anthropic `tool_use` structured output.
That last difference is the one to suspect first.

What it does show: the granularity knob's _empirical_ justification does not hold up as stated. The
knob itself is still right — the token-budget argument (603 per-cell citations against 67 per-row
for a 67-row table) and the reviewer-experience argument are untouched, and neither depends on a
fabrication rate. `group-provenance-granularity-design.md` §1 should cite the 37% as a historical
measurement under specific conditions rather than as a property of cell-level citation.

---

## Open questions

- **TypeDoc residuals.** 21 "resolved but not included" warnings need an export or a
  `typedoc.json` change; 7 more come from `ribo-core` JSDoc inherited into other packages'
  implementing classes and resolve in-package but not when inherited.
- **Package README links** use repo-relative paths that resolve on the forge and 404 from an npm
  tarball. Recorded against R4 in the roadmap.
