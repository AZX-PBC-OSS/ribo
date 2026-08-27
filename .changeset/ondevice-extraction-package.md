---
"@azx/ribo-extractor-ondevice": minor
---

New package: extraction on Chrome's built-in Prompt API, so an offline auditor's queued item
reaches review instead of parking.

Until now an item captured without signal transcribed on-device and then stopped, because
extraction needed the network. This package supplies the missing engine.

**`OnDeviceChat`** implements `CapableChatClient` over `globalThis.LanguageModel`. It reports
capability without downloading anything, and `prime(onProgress?)` is the only thing that fetches
the model — a rule Chrome enforces for us by refusing a gesture-less download. It streams
internally so it can abort a degenerate generation early and enforce its own deadline, while
`complete()` still returns a whole string and the seam stays non-streaming.

**`threePhaseExtractor`** is the extraction strategy, and it is not the obvious one. Asking the
model for a whole field group in a single constrained call loses roughly 4 of 14 transcripts to a
degenerate loop that no retry budget fixes. Asking three smaller questions instead — is this field
discussed, quote it, classify the quote — completed every transcript with **zero** degenerations
in 283 calls, at a third of the wall clock. `docs/implementation/19-ondevice-extraction-strategies.md`
records all four strategies that were measured and why this one won.

Spans are checked with `isSpanGrounded` before they are kept: a quote that is not a verbatim
substring of the transcript drops both itself and the value it was supposed to justify. That takes
source-span fidelity to 100%, which is what makes human review meaningful — a reviewer who finds
one fabricated citation has no reason to trust the others.

**Ships as beta.** On the annotated corpus it hallucinates at 1.1% against a frontier baseline of
0.5%, but leaves **more than half of stated values null**. That is the right direction of error
here — a reviewer can fill a blank, but cannot easily catch a plausible invention carrying a
citation — and it is strictly better than the current offline behaviour of extracting nothing at
all. It is not equivalent to the managed path and should not be described as such.
