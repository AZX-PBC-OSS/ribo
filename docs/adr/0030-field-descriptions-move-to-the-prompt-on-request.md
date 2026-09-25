# 0030. Field descriptions move to the prompt on request, and ribo does the strip

Status: Accepted
Date: 2026-09-25

## Context

Hosted structured-output routes cap the schema in `response_format`, not the messages. The
adapters' field descriptions are prompt material, about half the wire schema, sitting in the
capped budget. A consumer app stripped them to fit and lost accuracy: a furnace with no central
AC came back as `"Furnace / Central AC (shared ducts)"`, and the sentence telling the two apart
was one of the stripped descriptions. The app has since fitted the full schema by passing
`maxSerializedCharsPerGroup`, but its worst piece sits 129 chars under the cap.

## Decision

**`fieldDescriptions: "prompt" | "schema"` moves the descriptions from the wire schema into the
system message as one switch. It defaults to `"schema"`, and ribo does the strip.**

- **One switch, both halves.** Emitting without stripping pays both budgets; stripping without
  emitting is the furnace bug. There is no way to ask for only one. On the scoped-instance path
  the switch is `prepareGroups`' option and each `PreparedGroup` records its mode, so
  `fillPhase` cannot be set differently from the schema it sends.
- **Ribo strips, not the caller.** The caller hands over zod; the JSON rendering happens inside
  the extractors, so only ribo sees the bytes that go on the wire. The strip treats
  `description` as a keyword only at schema positions, never as a key inside `properties`, so a
  field named `description` keeps its `required` entry.
- **Opt-in.** The prompt mode changes every prompt, and nobody has measured whether guidance
  works as well in the system message as in the schema. The furnace case shows descriptions
  matter, not where they work best. A tier also sends more bytes in total (about 141K chars off
  the schema, 162K onto the prompt, across 22 calls), so the mode only pays where the schema cap
  binds.

## Consequences

- Existing callers are unaffected: the default wire schema and prompts are byte-identical to
  before.
- A caller near the cap sets `fieldDescriptions: "prompt"` and gains headroom (worst piece
  32,639 → 20,300 chars) at ~40k prompt tokens a tier. Call count does not change, because the
  split still packs against the full rendering.
- Flipping the default is a separate decision, and it needs an accuracy comparison of the two
  placements on real transcripts first.
