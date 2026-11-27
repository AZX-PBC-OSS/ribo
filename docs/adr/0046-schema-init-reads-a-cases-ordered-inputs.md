# 0046. Schema init reads a case's ordered inputs

Status: Accepted
Date: 2026-11-27

## Context

ADR 0045 built `ribo schema init` around one sample per named source and refused a case folder
whose `inputs` list was not exactly one entry, on the reasoning that merging inputs was authoring
work init should not do. Real jobs, though, are several documents per case: ADR 0042 made the
ordered multi-input list the corpus format, and eval already runs such cases through one shared
join (`eval/case-text.ts`'s `caseTextOf`). With init refusing the format the corpus already uses,
init could not draft from cases eval can run, and the eval work that needs a multi-input sample
was blocked.

## Decision

Schema init loads a case folder with any number of declared inputs as one sample, in the case's
declared order. A sample carries an ordered input list — each entry with its file, kind, exact
text, original bytes and, for a document, its declared capture — and the sample's text is the
marked join produced by one exported join function in `eval/case-text.ts` that `caseTextOf` also
calls. There is one join implementation: eval's case text is byte-identical before and after this
change.

Evidence validation matches per input, never against the joined text. A quote is accepted when it
matches inside any one input under that input's own rule — exact substring for text and
transcript inputs, the layout fold for documents — so acceptance never depends on input order,
and a non-matching input can never reject a quote that another input matches. An enum member's
fold follows the input that matched its quote. Because every marker line and every cross-input
span exists only in the joined text and never inside one input, a quote can never name a marker
or span two inputs.

The prompt lists each sample's inputs and kinds in declared order, and tells the model that a
quote must come from inside one capture and that marker lines are not quotable. The scaffold
writes every input in order, each document with its own capture block; publication stays one
rename, all-or-nothing. Every sample still loads and transcribes before any estimate or backend
preparation, and documents are transcribed once each, in sample order then input order.

This supersedes exactly one statement of ADR 0045: that a case folder with multiple inputs is
refused by schema init rather than merged. Every other 0045 decision remains in force here —
evidence linking, the spend ceiling, all-or-nothing corpus publication, and no inferred
expectations — and nothing in this change edits that record.

## Consequences

Init now drafts from — and scaffolds — the same multi-input cases eval runs, so the series built
on it (bare PDFs, plain job folders, draft/scaffold splitting) starts from a sample shape that
needs no migration. The `SchemaInitSample` shape breaks for any consumer that read a sample's
singular `source`; the ordered `inputs` list replaces it. A duplicate declared file is refused
where the corpus loader refuses one, before transcription, so a malformed case never spends.
Evidence grounding stays as bounded as 0045 said: a quote is verified against one input's text,
not against the model's reading of the whole sample.
