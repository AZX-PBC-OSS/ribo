# 0020. A package's second segment names an implementation, never a vendor

Status: Accepted
Date: 2026-09-21

## Context

Adding a System One client (hosted Jev, a self-hosted `kev.serve`, or a fine-tune — one wire
format, several endpoints) forced a naming question that `ribo-extractor-openai` had already
answered badly.

That package holds **two** transports, and one of them is not OpenAI: `helixChat` documents the
`/_api/llm/chat` route as "provider-neutral and **not** OpenAI-compatible". Every strategy above
them takes the seam, not either transport — `single-shot.ts` says it "depends only on the injected
`ChatClient`", and `per-group`, `schema-extractor` and `schema-retry` do the same. The vendor in
the name is the one thing nothing in the package requires, and a host wanting `helixChat` to drive
core's `askPhase` must today depend on a package called `extractor-openai`.

`ribo-extractor-ondevice` has the same shape: it exports `OnDeviceChat` beside
`threePhaseExtractor`. Core's `CapableChatClient` names the arrangement — "Both the managed and
on-device transports implement this ... lets both extractor packages consume it without a
dependency between them." So there are three `ChatClient` implementations across two
vendor-named packages, and the strategies above all of them are transport-agnostic.

Two alternatives were considered and rejected.

_Vendor naming (`ribo-systemone-typesafe`)._ Wrong the first time the endpoint points at kev,
which implements the same API — the defect `ribo-extractor-openai` already has, freshly made.

_`ribo-client-<seam>`, role first._ Uniform, and the client/extractor grid lines up. But it
inverts the convention every existing package follows — `transcriber-ondevice`, `storage-rxdb`,
`ui-react`, `adapter-snuggpro` are all seam-then-implementation — and it leaves on-device
homeless: it would share `ribo-client-chat` with two `fetch`-and-JSON clients despite differing in
runtime rather than dialect, dragging a session lifecycle, a capability probe and browser-only
tests into a package nothing else needs them in.

## Decision

Keep the existing convention: **`ribo-<seam-or-role>-<implementation>`**. The second segment names
whatever actually distinguishes this implementation from its siblings — a dialect, a deployment
mode, a library, a runtime — and is **never a vendor** when a non-vendor axis does the job.

```
ribo-chat-openai          openAiChat                     dialect
ribo-chat-helix           helixChat                      dialect
ribo-chat-ondevice        OnDeviceChat, session, probe   runtime
ribo-systemone-managed    systemOneClient                deployment mode

ribo-extractor-chat       single-shot, per-group, schema-retry, instance-ladder,
                          gap-fill, three-phase          over any ChatClient
ribo-extractor-systemone  corroborateExtractor
```

`managed` rather than `typesafe` because `ribo-transcriber-managed` already establishes the word
for this exact shape — a remote endpoint behind the seam, credential in the host's transport, no
capacity to authenticate. Hosted Jev and a self-hosted `kev.serve` are indistinguishable from the
package's side, so the segment that separates them from a future in-process rung is the deployment
mode, not the company. It leaves `ribo-systemone-ondevice` free for the WebGPU/ONNX rung, mirroring
`ribo-transcriber-managed` / `ribo-transcriber-ondevice`.

Dialects of one seam that share a runtime may share a package; `openAiChat` and `helixChat` are
kept apart only because they are already separable. Under ESM a consumer importing one
tree-shakes the others, so bundle size is not an argument either way.

**This reaches only families where core owns a transport seam beneath several strategies.** The
transcribers implement `Transcriber` directly and are unaffected, as are `ribo-storage-rxdb`,
`ribo-ui-react` and `ribo-adapter-snuggpro`.

## Consequences

**Two existing packages are misnamed and their renames are breaking.** Splitting
`ribo-extractor-openai` and `ribo-extractor-ondevice` into chat clients plus one shared
`ribo-extractor-chat` changes the import surface for the playground and for the field app in its
own repo, and adding or renaming publishable packages runs the full CI bar — `docs:build`,
`changeset status` and `pack-and-consume` — not just `check.sh`. That refactor is scheduled on its
own and does not ride along with a feature.

**The strategies converge into one package.** `threePhaseExtractor` and `single-shot` both take a
`ChatClient` and have no reason to live apart once the transports are lifted out. Until the
refactor lands the tree is asymmetric: the System One side split by seam, the chat side bundled
under two vendor names.

**The second segment is not one consistent category, and that is deliberate.** `pdfjs` is a
library, `managed` a deployment, `ondevice` a runtime, `rxdb` a library, `react` a framework. The
segment answers "which one", and a rule demanding a single category would have to rename packages
that are already clear.

**A provider that cannot be expressed through an existing seam needs a new seam, not a new
segment.** The rule holds because no vendor is load-bearing today: OpenAI proper, Azure Foundry and
Helix all sit behind `ChatClient`. Whether such a seam belongs in core is ADR 0010's question, not
this one's.
