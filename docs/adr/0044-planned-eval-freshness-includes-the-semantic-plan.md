# 0044. Planned eval freshness includes the semantic plan

Status: Accepted
Date: 2026-11-26

## Context

ADR 0041 keys an eval measurement on backend, model, settings and a run fingerprint over the
schema document and prompt. A reviewed plan changes the extraction calls and their semantic
guidance without changing either half of that run fingerprint. Two different planned layouts would
therefore look like one measurement unless the settings carry plan identity.

The command also needs the plan before it can know whether the run is constructable or what it may
cost. Loading it after executable preflight, document transcription or credential work would make
an invalid input win races against unrelated side effects. Estimating a planned rung as another
strategy would undercount or misprice the requests core will actually make.

## Decision

`ribo eval --plan <path>` reads one reviewed artifact and shares it with every planned arm. The
`planned` strategy requires the flag, and the flag requires a planned rung. On only those planned
paths, usage validation is followed by corpus/schema loading, membership comparison and a
model-free constructability proof, then CLI preflight, one shared transcription, credential and
spend work, and extraction. Ordinary eval keeps its existing startup and refusal order.

Membership drift is stale: the refusal names the sorted added and removed paths and
`ribo schema plan --update`. Eval never repairs the artifact. A schema-fingerprint change with
unchanged membership emits one note and does not block the run. Construction refusals likewise
precede preflight, transcription, spend and chat.

The version-1 record gains optional `settings.planFingerprint`. This is additive for every
existing v1 record and fixture; no existing bytes or comparison axes change. Core derives the
fingerprint from the contract version, a lexically sorted copy of the complete root field set, and
the ordered pieces with their names, descriptions, keys and ordered paths. Stored schema
fingerprints and planning provenance are excluded. The runner alone derives and issues the value;
callers cannot supply it. Semantic edits therefore move settings and record identity without
moving `runFingerprint`.

The persisted settings schema and `EvalSettings` remain locked by the compile-time
`SettingsParity` assertion. The plain object schema stays structural so it can be extended;
`EvalRunRecordDocumentSchema` wraps it with the cross-field rule that planned settings require the
fingerprint and non-planned settings forbid it. Record stores and compare read through that
wrapper. An older reader with the previous strict v1 settings shape refuses a planned record's
unknown `planFingerprint` key rather than silently discarding the identity and presenting distinct
layouts as equivalent.

Planned spend reads call counts from core's cap-sensitive `plannedPerGroupPlan` dry run and
measures the actual projected targets' messages and wire schemas. Ladder, retry and consensus
multipliers still apply to those counts, and an over-ceiling estimate refuses before chat.

## Consequences

Comparable planned records now retain the semantic layout that produced them, while schema and
prompt fingerprints retain their original meaning. The accuracy page displays the fingerprint as
run metadata; it does not add a fifth comparison axis or change staleness.

The cost is a required artifact and an earlier, deliberately different refusal order for planned
invocations only. Old strict readers must be updated before they can read newly planned v1
records, although all previously valid v1 records remain valid. Spend remains a worst-case bound:
every ladder rung, retry and consensus candidate is priced even when a successful run exits
earlier.
