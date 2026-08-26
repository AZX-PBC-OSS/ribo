# @azx/ribo-extractor-ondevice

**On-device extraction** through Chrome's Prompt API (Gemini Nano), implemented as a
`ChatClient` so it plugs into the existing `perGroupExtractor` pipeline and can be selected
as a fallback when the managed extractor is unreachable. This is a **separate package** from
`ribo-core` and `ribo-extractor-openai` on purpose: the Prompt API is a browser-only global
with no npm dependency, and the packaging keeps the experimental on-device path opt-in.

This package is currently in early scaffolding. The immediate surface is the whitespace-loop
detector used to kill Nano's degenerate constrained-decoding output before it burns a full
115-second cap.

## Installation

```bash
pnpm add @azx/ribo-extractor-ondevice @azx/ribo-core
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **`isLoopingOutput`** — predicate that returns `true` when the accumulated streaming output has
  tailed into a run of at least 80 whitespace characters. This is the kill signal for the
  degenerate whitespace loop described below.
- **`WHITESPACE_LOOP_THRESHOLD`** — the 80-character threshold, exported so the client and tests
  share one value.

## The whitespace loop

In roughly half of constrained JSON calls, Nano emits valid content and then falls into an
unbounded run of whitespace (`"\n  \n  \n  …"`) until it hits the output cap. A JSON grammar
permits arbitrary whitespace between tokens, so constrained decoding considers this legal and
cannot stop it. The detector watches the streaming tail and aborts as soon as 80 consecutive
whitespace characters appear — measured safe because successful responses are 462–917 characters
of ordinary pretty-printed JSON and never contain 80 consecutive whitespace characters. A false
positive would silently truncate a correct extraction, so the threshold is chosen conservatively.

See the [API Reference](../../docs/reference/) (generated) for the full surface.
