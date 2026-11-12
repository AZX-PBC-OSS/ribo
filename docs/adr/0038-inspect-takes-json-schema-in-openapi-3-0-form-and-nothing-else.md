# 0038. The inspect command takes JSON Schema in OpenAPI 3.0 form, and nothing else

Status: Accepted
Date: 2026-11-11

## Context

The schema-inspect command (`docs/roadmap/design/ribo-cli-schema-inspect-design.md`) needs a zod
schema to size — its report is `describeExtraction` and `walkLeafInventory` over one — but its
callers hold JSON Schema documents: host-tool exports, OpenAPI specs, generated files. Somewhere
in the pipeline a document becomes zod, and the choice of where and how decides what the report
can honestly claim.

The alternatives each fail:

- **Accept a zod object at the library entry.** A zod object carries refinements and transforms a
  document cannot, so an entry that accepted both would have separate paths reporting different things about
  "the same" schema, and the bin could never share the entry's input at all.
- **Accept any JSON Schema dialect and convert silently.** Nullability is the trap: the same zod
  schema renders `nullable: true` under the OpenAPI 3.0 target and an `anyOf` with a `null` arm
  under draft-2020-12, and the rendering shifts between zod versions — the catalog holds zod back
  on exactly this change. A silent converter guesses at what a null arm means, and a sizing report
  built on a guess is a report that lies.
- **Hand-roll a converter.** A second implementation of the dialect to drift from, against a
  conversion function zod itself documents as semi-experimental — drift is not a risk but a
  certainty.

## Decision

**The inspect command accepts a JSON Schema document only, in OpenAPI 3.0 form (`nullable: true`),
from a file or stdin; it converts the document itself with `z.fromJSONSchema(document,
{ defaultTarget: "openapi-3.0" })` into its own zod copy, with no custom converter; the importable
entry takes the same document the bin takes, never a zod object.**

The rules that ride with the decision:

- **Loud refusal, never silent conversion.** A draft-2020-12-style `anyOf`-null document is
  refused with a message naming the mismatch and pointing at the docs page showing the OpenAPI 3.0
  export one-liner (`z.toJSONSchema(schema, { target: "openapi-3.0" })`).
- **Honesty about what the input cannot carry.** Constructs JSON Schema cannot express — zod
  refinements and transforms — are reported as _not visible in the input_, never guessed, never
  reconstructed, never silently dropped.

The design doc carries the full failure-mode table, the exact messages, and the agreement tests.

## Consequences

What this buys: one input, one conversion path, one set of caveats — every reported number traces
to a document the caller can diff, and the round trip (zod → `toJSONSchema` at the OpenAPI 3.0
target → document → `fromJSONSchema`) closes inside one zod version. The Snugg round-trip equality
test runs on every zod bump precisely because zod documents `fromJSONSchema` as semi-experimental;
the guard is the tripwire the warning demands.

What it costs: callers holding draft-2020-12 documents must re-export before inspecting — the
refusal message tells them how, but the step is theirs. And the CLI's honesty rule means its
report is about the document, not about whatever richer schema produced it: refinements the caller
knows are there will read as not visible, which is correct and will still feel like a gap until
they read the caveat the report carries.
