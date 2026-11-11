# Write-back

Capture, transcription, extraction, and review produce one thing: a patch of plain values a human
has signed off on. Write-back turns that patch into a real record in a host tool. This page covers
the seam that knows how, the place the patch is checked before it's trusted, and the gate that
decides whether any of it can happen yet.

## `ToolAdapter` is the only tool-specific surface

Everything this SDK does before write-back — the derived extraction schema, the review contract, the
storage and relay — has no idea what tool it's writing into. All of that tool-specific knowledge lives
in exactly one place, declared against the real signature:

```ts
export interface ToolAdapter<V extends Record<string, unknown>, C, P = NoProvenance> {
  readonly name: string;
  readonly schema: ValuesSchema<V>;
  readonly extractionSchema: ZodType<Enveloped<V, P>>;
  readonly ctxSchema: ZodType<C>;
  readonly requiredOnCreate?: RequiredOnCreate;
  readonly instructions: string;
  readonly examples?: readonly ToolAdapterExample<Enveloped<V, P>>[];
  write: (fields: V, ctx: C, meta: WriteMetadata) => Promise<{ readonly uuid: string }>;
}
```

(`packages/ribo-core/src/adapter.ts`.) `V` is the plain field values the adapter writes — the
same type [Typesafety](/guide/typesafety) covers `schema` as the source of truth for, with
`extractionSchema` derived from it via `enveloped()`, never hand-declared beside it. `C` is the host
context `write` needs to reach the right destination — a job id, a session handle, whatever
identifies where these fields go — and it is a real type parameter rather than `unknown`, so a
caller missing a field the adapter actually needs fails at compile time instead of showing up as a
runtime crash inside `write`.

**What belongs on an adapter:** the field schema, the natural-language `instructions` an extractor
folds into its prompt, optional few-shot `examples` in the enveloped shape the model emits,
`requiredOnCreate` (leaf names, grouped by the group that owns the create endpoint, that the host
tool refuses to create a record without — surfaced to review as `ReviewField.required` so a write
that would fail at the host becomes a question asked while the auditor is still on site), and the
`write` function itself.

**What must never leak out of one:** anything about the pipeline that got the values here. An
adapter's `write` receives a plain `V` and a plain `C` — never an `AudioCapture`, a `Transcript`, a
`ReviewOutcome`, or storage document. It does not know whether the fields it's writing came from a
microphone or a scanned PDF, whether the session had one capture or five, or what a human rejected
along the way; all of that was already resolved before `write` is ever called. An adapter that
reached backward into pipeline internals would couple tool-specific code to shapes that are free to
change without it.

## `toWriteStep`: the one place `schema.parse` runs before a write

`resolveReview` already validates every accepted and edited value against its own leaf's schema
before it returns an outcome — see [Review](/guide/review) — so an outcome it produced is a valid `V`
by construction. But a session's `reviewOutcome` is _persisted_, and persisted data can arrive at the
write step by a route that never went through `resolveReview` at all: a host patching a session
directly, an outcome written by an older build read back after a schema change, a future UI
persisting its own outcome shape. All of those are `unknown` by the time they reach the write step,
and the adapter's schema is the last thing standing between them and a real write.

`toWriteStep(adapter)` installs that boundary:

```ts
import { createRelay, toWriteStep } from "@azx/ribo-core";

const relay = createRelay({
  // ...
  sessionWrite: toWriteStep(adapter),
});
```

Per session, it parses `ctx` with `adapter.ctxSchema`, parses the reviewed patch with `adapter.schema`,
and only then calls `adapter.write(fields, ctx, { idempotencyKey })`. Either parse failing throws a
`TerminalError` — both failures are permanent: the inputs are already persisted, so a retry sees
the exact same invalid data and fails identically. `write`'s own rejection is passed through
untouched and left retryable, because a network failure is what a real adapter throws most often,
and it's exactly what should be retried.

## `toInstanceWriteStep`: per-instance writes that resume after a partial failure

A patch with a collection group — several HVAC systems in one session — is not always safe to write
as a single call. `toInstanceWriteStep` writes singleton fields together under the session's own
idempotency key, then writes each collection instance as its own call, with its own derived key:

```ts
import { toInstanceWriteStep, deriveInstanceIdempotencyKey } from "@azx/ribo-core";

const step = toInstanceWriteStep({
  adapter,
  collectionGroups: ["hvac"],
});
```

`deriveInstanceIdempotencyKey(itemKey, group, index)` combines the item's own idempotency key, the
collection's top-level name, and the instance's position in first-mention order, deterministically —
the same inputs always produce the same key. That's what lets a write interrupted partway through a
collection resume safely: a retry re-derives the same key for every instance already sent, so a
vendor that honors `Idempotency-Key` recognizes the repeat rather than creating a duplicate record,
and only the instances that never went out get written for the first time. The trade made for this is
explicit: there is no positional marker skipping instances already sent, because that marker had its
own bug (a reopened session with a removed instance silently skipped the wrong survivor); the
durable record of what succeeded is `SessionWriteResult.receipts`, keyed by the same instance keys
`resolveReview` assigned, not by array position.

## The write is gated, not merely designed

`toWriteStep` and `toInstanceWriteStep` are the composition every host actually wires a relay
through, and that seam is real and installed. A live write into the reference adapter is not. The
trust boundary between "a human accepted this" and "this is now in the host tool's own database" is
a real boundary this SDK enforces; whether a specific vendor's API will _accept_ the call once it's
made is a separate question, and for the reference adapter that question is still gated on the
platform this SDK's own field app runs on.

Snugg Pro's own authentication is per-request HMAC-SHA256 signing, not a static API key — a fresh
signature computed from a timestamp on every call. A browser cannot do that without holding the
signing key, so signing has to happen at the network egress layer, server-side, and that capability
does not exist yet on the platform this SDK's field app deploys to. Until it does, the reference
adapter's `write` rejects rather than pretending: it throws, naming what it's waiting on, instead of
faking an unsigned write that would teach the wrong lesson about what "written back" means.

## `@azx/ribo-adapter-snuggpro`: a worked example, not the subject

Snugg Pro is a home-energy-audit tool, and `@azx/ribo-adapter-snuggpro` is a real `ToolAdapter` built
against it — worth reading as a worked example of the shape above, not as the thing this page is
about. It declares a values schema nesting several dozen leaves under top-level resource groups
(`basedata`, `hvac`, `attic`, `wall`, `window`, `dhw`, `health`, among others), a `requiredOnCreate`
map naming exactly the leaves Snugg Pro's own create endpoints refuse to omit, and instructions and
examples steering extraction toward Snugg Pro's specific vocabulary. Its `write` is the one described
above — implemented up to the point the platform gate gets in the way, so wiring in a real signed
request is a small change to an existing function rather than a redesign of the adapter itself. Any
other tool's adapter follows the same shape: one values schema, one derived extraction schema, one
`write`, and nothing else this SDK needs to know about it.

**API pages:** [`ToolAdapter`](/api/tool-adapter) and the write steps — the two field schemas, the
receipt, and both compositions that wire an adapter into the queue — plus
[`snuggProAdapter`](/api/snuggpro-adapter), the worked example itself.

## Next

[Sessions](/guide/sessions) covers the session lifecycle `writing` sits inside, from `open` through
to `done`. [Review](/guide/review) covers the contract that produces the patch `toWriteStep` parses.
