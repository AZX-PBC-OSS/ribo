# 0045. Schema init drafts only evidence-linked declarations

Status: Accepted
Date: 2026-11-26

## Context

A new extraction schema is difficult to start from an empty editor, but an installed drafting command
must not turn a plausible model response into an apparently finished artifact. The command also needs
a cost decision before chat and a safe way to turn its samples into an eval corpus without fabricating
the answers that an eval would measure.

The pure drafting API already constrains the model to a declaration language and validates evidence
against named samples. The remaining decisions concern the installed command's artifact boundaries,
spend bound and corpus creation.

## Decision

`ribo schema init` emits only a plain OpenAPI schema rendered from evidence-linked declarations. The
model cannot emit arbitrary JSON Schema, provenance envelopes or call provenance. Code owns rendering,
required/nullable behavior and the closing inspect conversion and field walk. Direct text and transcript
evidence use exact substring matching; document evidence alone uses the deterministic layout fold.
Neither comparison rewrites the stored sample or claims complete source coverage.

The command loads and transcribes every sample before estimating or preparing a backend. Its estimate
measures the complete initial prompt and prices the bounded semantic repairs, transient transport
retries and CLI shape layer through the shared fixed-call policy. An over-ceiling run refuses before
backend preparation or chat. Schema output uses the shared non-destructive file/stdout port.

Optional corpus creation requires an explicit name and provenance. The scaffold carries the exact same
serialized schema bytes, one deterministic case per uniquely named sample, the original input bytes and
kind, and any declared document capture time and page count. Expectations and instructions remain empty,
and defaults are omitted. A case folder with multiple inputs is refused by schema init rather than
merged; the shared corpus loader and eval retain their existing multi-input behavior.

A scaffold is staged in a unique sibling directory and published by one directory rename. Existing
outputs are refused before transcription or chat, a non-empty raced destination is preserved, and every
failed staged write removes the staging tree. Diagnostics name the inspect, plan, corpus-text,
expectation-authoring and eval handoffs only after output succeeds.

## Consequences

The installed starting point is reviewable and cannot silently overwrite an input or publish a partial
scaffold. Over HTTP every request carries the reply cap the estimate priced, so spend stays within the
stated estimate unless the operator overrides the ceiling; a CLI backend that cannot cap its replies
makes the estimate a priced expectation rather than a bound. A generated corpus
is immediately loadable, but it is not yet a measurement: a person must author expectations and prompt
instructions.

Draft quality remains bounded by the samples and the closed declaration vocabulary. Evidence grounding
does not establish field completeness, semantic correctness or real-model quality; no real-model run is
part of this decision. Document normalization can accept layout variation, not paraphrase. The command
also does not merge multi-input cases or infer corpus provenance, so those tasks remain explicit
authoring work.
