# 0029. Transport-agnostic extraction lives in core, not a sibling package

Status: Accepted
Date: 2026-09-24

Amends ADR 0020. Applies ADR 0010's criterion to its conclusion.

## Context

ADR 0020 fixed the package naming rule and named the refactor it implied:

```
ribo-chat-openai          openAiChat                     dialect
ribo-chat-helix           helixChat                      dialect
ribo-extractor-chat       single-shot, per-group, schema-retry, instance-ladder,
                          gap-fill, three-phase          over any ChatClient
```

Two of those three are right and are built here. The third is not, and the reason only became
visible once the files were counted.

**Of `ribo-extractor-openai`'s 28 source files, exactly two were vendor-bound** —
`chat/openai-chat.ts` and `chat/helix-chat.ts`. Every other file depended on the injected
`ChatClient` seam and nothing else. The handful that named a transport did so in doc comments;
`operations-proposer.ts` says so outright: "output works on any route (`openAiChat`, `helixChat`,
an in-browser or …)".

So `ribo-extractor-chat` would have been a package holding 26 files whose only shared property is
"transport-agnostic extraction" — which is what `ribo-core` already is. Core owns the `Extractor`
seam, `ExtractionTarget`, `enveloped()`, the closing trust-boundary parse, and the combinators
these strategies are built out of: `groupedExtractor`, `fallbackExtractor`, `compositeExtractor`,
`consensusExtractor`, `retryExtractor`, `budgetExtractor`. `perGroupExtractor` is literally
`groupedExtractor` over a plan. Putting it in a sibling package separates it from the combinator it
is composed of.

ADR 0010 had already settled the criterion, and it is not the one used to stop short here first
time. That ADR moved the chat seam and three phases into core because "nothing in them is
on-device", and kept `threePhaseExtractor` out for a stated reason:

> It is **genuinely device-specific**: device-tuned per-call ceilings, zero retry delay.

The test is genuine specificity, not whether something is a phase rather than a preset. Reading it
as a phase/preset line is what produced a first pass that moved `presenceFillPhase` and stopped,
leaving `perGroupExtractor` — equally transport-agnostic — behind.

## Decision

**Transport-agnostic extraction lives in `@azx/ribo-core`. A package exists for a transport, a
runtime, a library or a vendor — not for a layer of core's own seam.**

`ribo-extractor-chat` is not built. The 26 files move into core: `*-phase.ts` factories into
`phases/` beside `presencePhase`, `spanPhase` and `classifyPhase`; the rest mirroring their
subdirectories under `extraction/` beside the combinators.

`ribo-extractor-openai` is **deleted**, not renamed. Its two transports become `ribo-chat-openai`
and `ribo-chat-helix`, as ADR 0020's table already said. They stay apart because they are already
separable and ADR 0020's second-segment rule needs something to name — a merged package would have
no honest second segment, since "chat" is the seam, not an implementation.

`threePhaseExtractor` stays in `ribo-extractor-ondevice`, on ADR 0010's unchanged reasoning.

## Consequences

**This is breaking, and deliberately so.** Every consumer importing `@azx/ribo-extractor-openai`
repoints: `ribo-extractor-ondevice`, `ribo-adapter-snuggpro`, the playground, `docs/typedoc.json`,
both pack-and-consume scripts, and the published-package count. The field app lives in its own
repository and is not updated by this change; a major version is what makes that an expected cost
rather than a surprise. A deprecated re-export shell was available and rejected — it preserves the
misnaming this exists to remove, and nothing would ever delete it.

**Core's public surface grows by roughly 26 modules**, and ADR 0010 already named this cost: "a
permanently wider public surface … now supported API and a compatibility commitment." That is the
price, and it is worth stating plainly rather than discovering later. The mitigation is not a
smaller core but honest semver: these are now core's compatibility promises.

**Bundle size is not the counter-argument.** ADR 0020 settled that: "Under ESM a consumer importing
one tree-shakes the others, so bundle size is not an argument either way."

**The naming rule in ADR 0020 is unchanged and is what produced this.** `ribo-<seam-or-role>-<implementation>`
with a second segment that names what actually distinguishes an implementation. Applying it
honestly is what revealed that 26 of 28 files had no distinguishing implementation at all — they
were not an implementation of anything, they were the seam's own logic sitting in the wrong
package.

**What this does not license.** "It only depends on core" is not sufficient grounds to move code
into core. `ribo-adapter-snuggpro` depends only on core and belongs outside it, because a vendor's
field mapping is genuinely Snugg Pro's. The test remains ADR 0010's: is there something _genuinely
specific_ — a vendor, a runtime, a device, a library — that the code is an implementation of? If
not, it is core's.
