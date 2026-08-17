# On-device extraction: unblocking the offline queue

**Date:** 2026-08-17
**Status:** Design, approved in conversation. Revised after external review — see §9.
No code written.
**Ships as:** beta — see §7 for what "beta" constrains and what it does not.

## The one thing to take away

An auditor working offline today gets capture and on-device transcription, and then the
item **parks in `extracting`** until signal returns. The relay is not connectivity-gated
(`queue/relay.ts` — `syncNow()` and `start()` drain unconditionally; connectivity is only
an extra trigger), so the drain runs offline and fails at the one step that needs the
network. Giving extraction an engine that runs on-device makes that step succeed and
carries the item all the way to `awaiting-review` with the radio off.

The engine is **Chrome's Prompt API** (Gemini Nano), reached as a `ChatClient` so it
inherits the whole per-group extraction pipeline unchanged. Two `perGroupExtractor`
instances — one per transport, each configured honestly for its own timing — sit behind a
thin composite `Extractor` that picks between them per extraction.

The gating risk is context window, not quality — see §6.1. If the largest group schema
does not fit in Nano's context, this design does not ship as written and sub-group
extraction becomes a roadmap item.

---

## 1. Context: what already exists

| Piece | Where | Relevance |
| --- | --- | --- |
| `Extractor<F>` seam | `ribo-core/src/extractor.ts` | Explicitly "a plain builder, not a capability contract". Stays that way. |
| `ExtractStep` | `ribo-core/src/queue/relay.ts:25` | What the relay actually calls. Currently drops everything but `fields` — see §3.6. |
| `ChatClient` seam | `ribo-extractor-openai/src/chat-client.ts` | The injected transport. This is where on-device plugs in. |
| `perGroupExtractor` | `ribo-extractor-openai/src/per-group.ts` | Takes an injected `ChatClient`; owns the seven-group split, prompt assembly, examples, envelope parsing, merge, the bounded pool and the retry-budget derivation. |
| `deriveMaxRetries` | `ribo-extractor-openai/src/per-group.ts:200` | Sizes the retry budget from `ceil(G / concurrency)`. Load-bearing — see §3.5. |
| `helixChat()` | `ribo-extractor-openai/src/helix-chat.ts:98` | The managed transport. Returns a bare `ChatClient` with no capability notion. |
| `firstCapable` | `ribo-core/src/first-capable.ts` | Sequential selection, TTL-cached capability, `invalidate()`, never auto-selects `needs-download`. The pattern this design copies. |
| `hedged` | `ribo-core/src/hedged.ts` | Races primary against fallback on a latency budget. **Does not apply here** — see §3.4. |
| `OnDeviceTranscriber.prime()` | `ribo-transcriber-ondevice/src/index.ts` | The download-on-explicit-request pattern, with progress. Copied in spirit. |
| RTF verdict / `too-slow` | `ribo-transcriber-ondevice/src/rtf-verdict.ts` | A measured-throughput gate on `capability()`. Its lesson transfers; its remedy does not — see §3.5. |

Two constraints from outside the code. `ribo-ui-react` is headless — no components beyond
the provider — and the consuming field app lives in a separate repo. So this repo ships
capability states and a `prime()` affordance; it does not ship a download screen. The
playground is this repo's stand-in for that consumer, exactly as `whisper-store.ts` /
`TranscribePanel.tsx` already are for transcription.

## 2. Decision

On-device extraction is a **`ChatClient`**. Two `perGroupExtractor` instances are built over
it and over the managed transport, and a **composite `Extractor`** selects between them per
extraction.

**Why on-device is a `ChatClient` and not its own extraction strategy.**
`perGroupExtractor` sits above the `ChatClient` seam and owns the seven-group split, prompt
assembly, few-shot examples, envelope parsing and merge. A strategy-level implementation
would re-implement all of it, or force it out into a shared package first. Plugging in at
the transport means the on-device path inherits the pipeline that is already measured.

**Why selection is nonetheless at the `Extractor` level, not the transport level.** The
first draft of this design selected between transports per *call*, inside a composite
`ChatClient`. External review killed that (§9, finding 2). `perGroupExtractor` derives its
retry budget from `ceil(G / concurrency)` using the **configured** `concurrency`, so a
single instance cannot be simultaneously correct for a four-wide managed path and a
serialized on-device one. Two instances, each configured for its own transport, are honest;
one instance switching underneath is not.

**Why this does not become a capability contract on `Extractor<F>`.** The composite reads
capability from the `ChatClient`s it was handed, not from its delegate extractors. So
`Extractor`'s "a plain builder, not a capability contract (the transcriber's `capability()`
roster is for runtime device variance; strategy choice here is configuration)" **remains
true and stays as written.** Runtime device variance lives in the transport, which is where
it belongs; the composite is configuration built over it.

**Provenance.** `ExtractionResult.usage` gains an **optional** `engine`. It must be optional:
`FakeExtractor`, `singleShotExtractor` and `perGroupExtractor` all return `{ calls }` today
(`extractor.ts:103`, `single-shot.ts:127`, `per-group.ts:508`), and a required field breaks
every one. Getting that value as far as the review card needs more than the extractor —
see §3.6.

## 3. Design

### 3.1 The `ChatClient` translation

`ChatRequest.messages` splits by role. The `system` message and any few-shot turns become
`initialPrompts` at session creation; only the transcript turn goes to the prompt call.
`response_format.json_schema.schema` becomes the `responseConstraint` option — it accepts a
JSON Schema object directly, so the schema the adapter already emits passes through
unmodified. Sampling is pinned to the most predictable mode; the seam exposes no
temperature knob and extraction does not want one.

**Sessions and the seven-group loop.** Reusing one session across the seven calls would put
groups 1–6 in context for group 7 — burning context window and creating exactly the
cross-context bleed doc 16 §5 names as an existing failure mode. Instead, one base session
carries the system prompt and examples, and each call runs on a **clone** of it. Every group
gets a fresh context with the shared preamble already paid for.

The `ChatClient` seam is stateless and has nowhere to put that lifecycle. Rather than widen
the seam, the client owns it internally: base session built lazily on first call, cloned per
call, destroyed after an idle timeout.

**Error mapping.**

| Prompt API | `ChatClient` |
| --- | --- |
| `NotSupportedError` (unsupported JSON Schema feature) | `ChatError.unsupported` |
| `SyntaxError` (constraint unsatisfiable) | `ChatError.malformed` |
| `AbortError` | `ChatError.aborted` |
| `NetworkError` (model fetch failed) | `ChatError.transport` |

**`QuotaExceededError` does not appear in that table, deliberately.** An earlier draft mapped
it to a completion with `finishReason: "length"`, which was incoherent: the error is thrown
*before* any response exists, so honouring that mapping would mean synthesising a completion
that never happened. Context pressure is instead caught by the **pre-flight measurement**
below and raised as a `ChatError`. If a `QuotaExceededError` still escapes at runtime it is a
`ChatError` too — a bug in the pre-flight, not a truncated answer.

**Pre-flight.** Before the first call the client measures the prepared input against the
session's context window and fails with a clear `ChatError` if it does not fit. This is what
turns §6.1 from a hope into a checked precondition.

**Two honest gaps.** `ChatUsage.completionTokens` is not reported directly; it is derived
from a context-usage delta across the call, which is close but not authoritative, and the
code must say so. And download progress reports a fraction between 0 and 1 with the total
**always** 1 — so unlike Whisper, no real byte count is available (§3.3).

`finishReason` is documented at `chat-client.ts:81` as required-of-implementations even
though it is optional on the type. This client honours that: every completion carries one.

### 3.2 Packaging

A new `@azx/ribo-extractor-ondevice`, matching the `-ondevice` / `-managed` naming axis the
repo already uses for transcribers. It depends on `ribo-extractor-openai` for `ChatClient`.
That is an ordinary runtime dependency, not a type-only one — `perGroupExtractor` is a
runtime function (`per-group.ts:322`), and whichever package composes the two must import it
for real.

**The dependency direction is a known wart, accepted deliberately.**
`ribo-extractor-openai` is already misnamed: it holds the generic `ChatClient` seam and the
transport-agnostic `perGroupExtractor` alongside the OpenAI-compatible transport. An
on-device package importing from a package called `-openai` reads like a mistake, and a
reader is right to flinch. Splitting the seam into a neutral home now costs a package
rename, import churn across the playground and the acceptance harness, and fresh
`check:pkg` / `check:resolve` / pack-and-consume surface — spent on a beta whose dominant
risk is that the model cannot do the job at all. **The seam moves the moment a third
transport appears.** Until then this paragraph is the record of why it did not.

Public surface of the new package, three things:

- **`OnDeviceChat`** — implements `ChatClient`; adds `capability()` and
  `prime(onProgress?)`. Mirrors `OnDeviceTranscriber` including its "there is **no**
  background or automatic download; `prime` is called only when the user asks" rule.
- **`ChatCapability`** — the three states of `TranscriberCapability` (`ready` /
  `needs-download` / `unavailable`), minus `downloadBytes`.
- **A stable engine id**, mirroring `ONDEVICE_WHISPER_ENGINE`.

Two things live elsewhere. The **composite `Extractor`** goes beside `perGroupExtractor` in
`ribo-extractor-openai`, since it belongs to neither transport. And the **provenance
plumbing** of §3.6 goes in `ribo-core`.

### 3.3 Capability

Chrome's four availability values collapse onto the three states:

| Prompt API | `ChatCapability` |
| --- | --- |
| `available` | `ready` |
| `downloadable`, `downloading` | `needs-download` |
| `unavailable` | `unavailable`, with a reason |

`needs-download` carries no byte count, for the reason in §3.1. The capability says the
download is Chrome-managed and of unknown size rather than quoting a number this repo made
up. This is a real regression against the Whisper consent screen, which quotes a measured
~290 MB, and the consuming app's copy has to be honest about it.

### 3.4 Selection

**Preference order is inverted relative to the transcriber, deliberately.** Transcription is
device-first, because on-device is free and private and the managed path is the fallback.
Extraction is **managed-first**: Helix when online, on-device only when Helix cannot run. A
~3B model is worse than the managed one, so it is accepted only when the alternative is
nothing.

`firstCapable`'s file comment reasons about fallback rescuing the *online* path. Here
selection rescues the *offline* path. Same shape, opposite direction. **Write that reasoning
into the code**, because the ordering reads like a bug otherwise and someone will helpfully
correct it.

`hedged` does not apply. It races a preferred engine against a fallback on a latency budget,
which presumes both can run. Here they never can simultaneously: Helix needs exactly the
network whose absence is the reason on-device exists. There is nothing to race.

**Selection is per extraction, not per call.** The composite probes capability once, picks a
delegate, and that delegate runs all seven groups. This is forced by §3.5 — the two delegates
have different, individually-correct timing budgets, and switching mid-run would invalidate
whichever one started. It also makes provenance single-valued for free: an extraction has one
engine, so the earlier draft's "if any group ran on-device, label the whole thing on-device"
rule is no longer needed and is dropped.

The cost is real and worth naming: if the uplink dies after group 3, the managed delegate
fails the whole extraction and the item parks through normal backoff, where per-call
selection would have finished it on-device. The next drain re-probes, selects on-device, and
starts over. Losing that resilience is the price of an honest retry budget.

**Helix reports capability by subscribing to the connectivity model, not by reading
`navigator.onLine` and not by sampling once at construction.** `Connectivity.subscribe`
emits immediately and on every change (`connectivity.ts:144-151`); a snapshot taken at
construction would go stale and the composite would keep choosing a dead uplink.
`helixChat()` gains an optional connectivity source and returns a capability-reporting
client — additive, since existing callers only touch `.complete()`.

**Cache invalidation must be wired, not assumed.** The composite caches capability on a TTL,
as `firstCapable` does. `firstCapable` pairs that with `invalidate()` precisely because a TTL
alone is too slow, and the relay's connectivity watch only triggers drains — it invalidates
nothing (`relay.ts:324-333`). The composite therefore exposes `invalidate()` and the consumer
wires it to the same connectivity transitions it already watches. Without that, a stale
`ready` for the managed path survives up to a full TTL after the uplink drops.

### 3.5 Timing: two instances, two honest budgets

`perGroupExtractor` computes `batches = ceil(G / concurrency)` and derives its retry budget
so that `batches × ((maxRetries + 1) × PER_CALL_CEILING_MS + backoff) ≤ stepTimeoutMs`
(`per-group.ts:200-212, 386-395`). With the defaults — 7 groups, `concurrency: 4`,
`PER_CALL_CEILING_MS` 120,000, `stepTimeoutMs` 900,000 — that is 2 batches and a granted
budget of 2 retries.

**The managed delegate keeps those defaults.** They were derived for it and are unchanged.

**The on-device delegate is constructed with `concurrency: 1`.** One model on one device does
not benefit from four concurrent sessions and may thrash or fail under them. Setting it
explicitly is also what keeps `deriveMaxRetries` honest: at `batches = 7` it grants **zero**
retries, because 7 × 120,000 = 840,000 already consumes 93% of the 15-minute step timeout on
first attempts alone.

That is the correct answer, and it is a tight one. It means an on-device extraction gets one
attempt per group and no retry budget at all, and it only fits if every group completes
inside the 120-second per-call ceiling. §6.3 is the measurement that says whether this is
survivable; if it is not, the levers are a larger `stepTimeoutMs` for the on-device delegate
or the sub-group split of §6.1.

**What the earlier draft got wrong**, recorded so it is not re-proposed: it kept one
extractor at `concurrency: 4` and had the on-device *client* serialize internally. The pool
would then believe 2 batches while reality ran 7, granting 2 retries against a worst case of
7 × (2 × 120,000 + 1,000) ≈ 1,687,000 ms — nearly double the step timeout. The derivation
reads configured concurrency, not observed parallelism, so hiding serialization below the
seam corrupts it silently.

**No throughput gate, for beta.** #24 added a measured RTF verdict and a permanent
`too-slow` reason because a slow device always reported ready and the managed fallback was
unreachable. The defect transfers — deciding `ready` on availability alone says nothing about
speed — but the remedy does not. When the transcriber demotes on `too-slow` it falls back to
a managed engine that is reachable, because the device is online. When the extractor would
demote there is by definition nothing to fall back to: it is running because the network is
gone. Demoting converts "slow extraction" into "no extraction", which is what this design
exists to prevent. The step timeout is the bound; if real devices cluster badly, the RTF
pattern is the proven next step and this repo now has a working example to copy.

### 3.6 Getting the engine to the review card

`ExtractionResult.usage.engine` alone is not enough, and the first draft wrongly claimed it
was. The relay calls `ExtractStep`, and `toExtractStep` returns `result.fields` and discards
everything else (`extractor.ts:72-76`); the outbox's `extracted` column is a bare
`z.record(z.string(), z.unknown())` (`queue/schema.ts:200`). Nothing carries `usage` across
that boundary, so as originally specified the engine was computed and then thrown away —
which would have removed the entire reason for preferring this shape over a plain transport
swap.

The fix, in three additive pieces:

1. `ExtractionResult.usage` gains an optional `engine` (§2).
2. `ExtractStep`'s return widens so the step can report it alongside the field map, and
   `toExtractStep` passes it through instead of dropping it.
3. The outbox gains a column recording which engine extracted the item, which the relay
   patches at the same point it already patches `extracted`.

Step 3 is a schema change, and this repo's position is that **schema migrations are free** —
there are no users, so outbox schema changes carry no back-compat burden. That makes the
honest fix also the cheap one.

This does mean a small relay change, contradicting the first draft's claim that there would
be none. §5 is corrected accordingly.

### 3.7 End-to-end flow

Consumer probes `capability()` at app start. If `needs-download`, it renders its own "arm
this device for offline" affordance and calls `prime()` with progress. Thereafter: the relay
drains → the composite probes capability and picks a delegate → that delegate runs all seven
groups through its own transport → parsed fields plus the engine reach the outbox → the
review card can badge a beta-extracted item.

## 4. Testing

Three tiers, because the Prompt API exists only in a browser and the real model is not
deterministic.

**Unit (vitest, Node) — a fake `LanguageModel` global.** Where nearly all the must-fail
tests live:

- A prepared input measured larger than the session's context window fails pre-flight with a
  clear `ChatError`. A `QuotaExceededError` escaping the client is the failure.
- An unsupported JSON Schema feature surfaces as `ChatError.unsupported`, not as a generic
  transport error.
- Online, the composite selects the managed delegate. Offline, it selects on-device. **Both
  directions asserted**, so the inverted preference order of §3.4 cannot be silently "fixed".
- The composite never selects a delegate whose transport reports `needs-download`.
- Constructing the client and probing `capability()` download nothing. Only `prime()` does.
- Group 7's call cannot observe group 1's content — session isolation via clone.
- The on-device delegate is constructed such that `deriveMaxRetries` yields **zero** retries;
  a change to `concurrency`, `stepTimeoutMs` or `PER_CALL_CEILING_MS` that silently restores
  a retry budget fails this test. This is the regression guard for §3.5's whole argument.
- The engine reaches the outbox: after an extraction, the persisted item records which engine
  produced it. This is the guard against §3.6's original defect returning.
- A capability change published by the connectivity model, followed by `invalidate()`, flips
  the composite's next selection without waiting out the TTL.

**Browser (vitest browser mode).** The repo already has this infrastructure. Thin: shape
conformance and one real end-to-end extraction against a real `LanguageModel`, skipped
rather than failed where the model is absent.

**Acceptance (quality).** `score.mjs` and `cli-chat.ts` are Node; the Prompt API is
browser-only. The on-device acceptance run therefore executes in browser mode and emits the
**same result JSON**, so `score.mjs` grades it **untouched** — what doc 16 §5 asks for, and
the only way these numbers sit honestly beside the codex and claude baselines.

**How the gate behaves**, following doc 18's own split:

- **Shape conformance is a hard gate.** Constrained decoding should make non-conforming
  output impossible; a shape failure means a bug in the translation, not a weak model.
- **Content accuracy is recorded, not gated.** Requiring codex's 0.5% hallucination rate
  from a ~3B model would block the beta permanently. The gate exists to make the delta
  visible, not to hold the door.

**One targeted fix to existing code.** Doc 18 records that a failing acceptance run writes no
artifact — `acceptance/results/` is gitignored and the baseline updates only on a clean pass,
so `claude-cli`'s failing numbers survive only in prose. For a beta model where nearly every
run is a failing run, that gap makes this feature unmeasurable. Split the two concepts as doc
18 already recommends: **every run writes a run record; only a clean pass updates the
baseline.** In scope because the work is unmeasurable without it, not as opportunistic
cleanup.

## 5. What this design does not change

- **The relay's drain policy.** Already unconditional; connectivity is only an extra trigger.
  (The relay does gain the small provenance patch of §3.6 — that is a change to what it
  records, not to when it runs.)
- **The `Extractor<F>` interface.** Stays a plain builder — no `engine`, no `capability()`.
  Its comment about capability contracts stays true as written.
- **`perGroupExtractor`'s internals.** Unchanged. Two instances are *configured* differently;
  no code inside it moves.
- **`firstCapable` and `hedged`.** Untouched; the composite is a sibling, not an edit.
- **`score.mjs`.** Reused verbatim, per doc 16 §5.

## 6. Open questions and risks

### 6.1 Does the largest group fit in context? (gating)

The largest per-group schema is **13,273 bytes** of JSON Schema — roughly 3.3k tokens before
the transcript, system prompt or few-shot examples. Gemini Nano's context window is small and
this may not fit.

**And 3.3k is a lower bound, not the figure to plan against.** The Prompt API explainer notes
that an implementation may include the response constraint itself in the message sent to the
model, consuming context — which is why it directs callers to measure usage *with* the
constraint applied. The real per-group prompt may therefore exceed the window even where the
raw schema size looks safe.

**This is measured before anything else is built**, using the same measurement the pre-flight
of §3.1 performs. If it does not fit, this design **does not ship as written** and sub-group
extraction — splitting below the seven-group boundary — becomes a roadmap item with its own
design. Everything downstream assumes a "yes".

### 6.2 Which JSON Schema features does Chrome's constraint support?

`responseConstraint` errors with `NotSupportedError` on schema features the user agent does
not implement. The enveloped extraction schema uses nested objects, closed objects,
all-keys-required, nullable leaves and enums. Which of those Chrome honours is unverified.
Measured in the same pre-flight as 6.1 — equally fatal, equally cheap to check.

### 6.3 Do seven serialized on-device calls fit the step timeout?

§3.5 grants the on-device delegate **zero** retries, and 7 × 120,000 ms of first attempts
already consumes 93% of the default 900,000 ms step timeout. Whether real calls land inside
the 120-second per-call ceiling is unmeasured and depends entirely on Nano's decode rate for
a few hundred output tokens against a ~3.3k-token prompt. Same pre-flight session as §6.1 and
§6.2. If it does not fit: raise `stepTimeoutMs` for the on-device delegate, or fall back to
the sub-group split of §6.1.

### 6.4 Is the Prompt API reachable from where extraction actually runs?

The explainer states the API is **not available in workers**, and that cross-origin iframes
need a permissions-policy grant. On-device transcription already runs in a worker
(`whisper.worker.ts`), so "the on-device path runs in a worker" is a live assumption in this
codebase and must not be carried over unchecked. Confirm extraction runs on a context where
the API exists, and confirm the consuming field app does not host Ribo in a cross-origin
iframe without the grant.

### 6.5 Multi-tab contention

The relay claims items under `navigator.locks`, so two tabs will not extract the same item.
But two tabs each hold their own `OnDeviceChat`, and the browser may serve both from one
underlying model. Whether that contends, queues or fails is unknown. The lock makes this a
performance question rather than a correctness one, which is why it is here and not in §3.

### 6.6 Nano's language coverage

The Prompt API advertises a limited output-language set. English-only field audits are
unaffected, but this is a hard ceiling on any future multilingual capture, and a property of
the model rather than of this design.

### 6.7 Quality is genuinely unknown

Doc 18's caveat stands: nothing measured so far predicts a small local model. Doc 16 §5's
baseline — 0.5–1% hard hallucination, 0–0.8% miss, 100% enum accuracy, 100% verbatim spans —
is the bar, and a ~3B model is not expected to meet it. Abstention is the specific expected
weakness: emitting an explicit `null` for the large majority of leaves a single dictation
never mentions. Constrained decoding does not help with that; it is a capability question.

**The mitigation is already in the product.** Every extraction goes through human review
before it is written back. A beta-quality extractor produces a worse first draft, not a wrong
write.

## 7. What "beta" constrains

Beta means content accuracy is recorded rather than gated (§4), the throughput gate is
deferred (§3.5), and the consuming app is expected to badge on-device extractions in review
(§3.6). It does **not** relax the shape gate, the provenance rule, the
no-background-download rule, or the trust boundary: model output is still parsed through the
adapter's schema before it becomes field data, exactly as the managed path is.

## 8. Sources

- `packages/ribo-core/src/{extractor,first-capable,hedged,transcriber,connectivity}.ts`,
  `packages/ribo-core/src/queue/{relay,schema}.ts` — the seams, the drain policy and the
  outbox shape this design reads.
- `packages/ribo-extractor-openai/src/{chat-client,per-group,helix-chat,split-schema}.ts` —
  the transport seam, the pipeline above it, and the retry-budget derivation of §3.5.
- `packages/ribo-transcriber-ondevice/src/{index,rtf-verdict}.ts` — the `prime()` and
  measured-capability patterns.
- `docs/implementation/16-extraction-schema-scale.md` §5 — the baseline to beat and the
  instruction to reuse `score.mjs` untouched.
- `docs/implementation/18-first-extraction-measurement.md` — the shape-versus-accuracy split,
  the corpus-contamination correction, and the missing-run-record gap §4 adopts.
- Prompt API explainer, `https://github.com/webmachinelearning/prompt-api` — fetched
  2026-08-17 for the availability values, session and constraint options, progress shape,
  token accounting, worker/iframe availability and exception types quoted throughout.

## 9. Review history

**2026-08-17, external review** (OpenCode / `kimi-k2p7-code`, read-only; Codex was
unavailable — HTTP 402 `deactivated_workspace`). Findings verified against the source before
being accepted. Two invalidated the first draft:

1. **Provenance never reached the outbox.** `toExtractStep` discards `usage`, and the outbox
   has no engine column — so the engine was computed and thrown away, removing the reason for
   preferring this shape at all. Fixed in §3.6, at the cost of a small relay change the first
   draft claimed would not be needed.
2. **Serializing below the seam corrupted the retry budget.** The first draft kept one
   extractor at `concurrency: 4` and serialized inside the on-device client, so
   `deriveMaxRetries` sized a budget for 2 batches while reality ran 7 — granting 2 retries
   against a worst case of nearly double the step timeout. Fixed by splitting into two
   correctly-configured delegates and moving selection up to the `Extractor` level (§2, §3.5),
   which also made §3.4's mixed-run provenance rule unnecessary.

Also adopted: `usage.engine` must be optional or it breaks every existing implementation
(§2); `helixChat` must subscribe to connectivity rather than sample it (§3.4); the composite
must expose `invalidate()` because a TTL alone lags reality (§3.4); the `QuotaExceededError`
mapping was incoherent and is dropped (§3.1); "type-only dependency" was wrong for a runtime
function (§3.2); and the constraint may itself consume context window (§6.1). Worker/iframe
availability (§6.4) and multi-tab model contention (§6.5) were unnamed risks and are now
recorded.

The review confirmed the design's other factual claims about existing code.
