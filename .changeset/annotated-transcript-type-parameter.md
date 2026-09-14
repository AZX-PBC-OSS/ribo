---
"@azx/ribo-core": minor
---

`AnnotatedTranscript` and `TranscriptCombiner` are now generic over their annotation shape, so a
pipeline can type the bag it passes around instead of reading `unknown` out of it.

`AnnotatedTranscript<P>` defaults `P` to the old open record, so existing code is unaffected.
`TranscriptCombiner<In, Out>` takes two parameters because the combined transcript's annotations
are not any input's — the default combiner emits an empty bag and its type now says
`Record<string, never>` rather than claiming a shape it never produces.

`Extractor` deliberately gains no type parameter. Nothing downstream of the combiner reads
annotations, so the shape only has to flow transcriber to combiner, and every existing combinator
is untouched.

Also exports `CaptureAnnotations`, the shape the relay writes under its reserved `capture.`
prefix.

This types what the pipeline passes; it does not validate it. A transcriber that declares one
shape and writes another is caught at runtime by the combiner's existing guard, not by the
compiler — and annotations arriving from outside this pipeline still want a parse at that edge.
