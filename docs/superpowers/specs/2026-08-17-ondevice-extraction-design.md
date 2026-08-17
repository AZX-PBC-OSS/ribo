# On-device extraction: unblocking the offline queue

**Date:** 2026-08-17
**Status:** Design, approved in conversation. No code written.
**Ships as:** beta — see §7 for what "beta" constrains and what it does not.

## The one thing to take away

An auditor working offline today gets capture and on-device transcription, and then the
item **parks in `extracting`** until signal returns. The relay is not connectivity-gated
(`queue/relay.ts` — `syncNow()` and `start()` drain unconditionally; connectivity is only
an extra trigger), so the drain runs offline and fails at the one step that needs the
network. Giving extraction an engine that runs on-device makes that step succeed and
carries the item all the way to `awaiting-review` with the radio off.

The engine is **Chrome's Prompt API** (Gemini Nano), reached as a `ChatClient` so it
inherits the whole per-group extraction pipeline unchanged. **No relay change. One
additive `ribo-core` change.** The rest is a new package and a selection combinator.

The gating risk is context window, not quality — see §6.1. If the largest group schema
does not fit in Nano's context, this design does not ship as written and sub-group
extraction becomes a roadmap item.

---

## 1. Context: what already exists

| Piece | Where | Relevance |
| --- | --- | --- |
| `Extractor<F>` seam | `ribo-core/src/extractor.ts` | Explicitly "a plain builder, not a capability contract". Stays that way. |
| `ChatClient` seam | `ribo-extractor-openai/src/chat-client.ts` | The injected transport. This is where on-device plugs in. |
| `perGroupExtractor` | `ribo-extractor-openai/src/per-group.ts` | Takes an injected `ChatClient`; owns the seven-group split, prompt assembly, examples, envelope parsing and merge. Transport-agnostic. |
| `helixChat()` | `ribo-extractor-openai/src/helix-chat.ts` | The managed transport. Returns a bare `ChatClient` with no capability notion. |
| `firstCapable` | `ribo-core/src/first-capable.ts` | Sequential selection, TTL-cached capability, never auto-selects `needs-download`. The pattern this design copies. |
| `hedged` | `ribo-core/src/hedged.ts` | Races primary against fallback on a latency budget. **Does not apply here** — see §3.4. |
| `OnDeviceTranscriber.prime()` | `ribo-transcriber-ondevice/src/index.ts` | The download-on-explicit-request pattern, with progress. Copied verbatim in spirit. |
| RTF verdict / `too-slow` | `ribo-transcriber-ondevice/src/rtf-verdict.ts` | A measured-throughput gate on `capability()`. Its lesson transfers; its remedy does not — see §3.5. |

Two constraints from outside the code. `ribo-ui-react` is headless — no components beyond
the provider — and the consuming field app lives in a separate repo. So this repo ships
capability states and a `prime()` affordance; it does not ship a download screen. And the
playground is this repo's stand-in for that consumer, exactly as `whisper-store.ts` /
`TranscribePanel.tsx` already are for transcription.

## 2. Decision

On-device extraction is a **`ChatClient`**, not an `Extractor`, plus engine provenance on
the extraction result.

**Why not an `Extractor` with `capability()`, mirroring the transcriber.** It is the
symmetric choice and it was seriously considered. It loses on reuse: `perGroupExtractor`
sits above the `ChatClient` seam, so an `Extractor`-level implementation either
re-implements the seven-group split, prompt assembly, envelope parsing and merge, or forces
that engine out into a shared package first. It also breaks `Extractor<F>` for every
implementation and test double, and duplicates `firstCapable`'s TTL/caching/demotion logic
in a sibling combinator.

**Why not a plain `ChatClient` with no provenance.** Because then nothing records that an
extraction came from the beta model. For a beta whose entire purpose is to learn whether a
~3B model can do this job on real audits, that is precisely the fact you cannot afford to
discard.

**So:** on-device is a `ChatClient`; the composite reports which delegate served each call;
`ExtractionResult.usage` widens from `{ calls }` to `{ calls, engine }`. That widening is
the only `ribo-core` change in the design and it is additive.

`Extractor`'s "a plain builder, not a capability contract (the transcriber's `capability()`
roster is for runtime device variance; strategy choice here is configuration)" **remains
true and stays as written.** Runtime device variance lives one layer down, in the transport,
which is where it belongs.

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
call, destroyed after an idle timeout. `perGroupExtractor` is unchanged and unaware.

**Error mapping.**

| Prompt API | `ChatClient` |
| --- | --- |
| `NotSupportedError` (unsupported JSON Schema feature) | `ChatError.unsupported` |
| `QuotaExceededError` / context-overflow event | completion with `finishReason: "length"` |
| `SyntaxError` (constraint unsatisfiable) | `ChatError.malformed` |
| `AbortError` | `ChatError.aborted` |
| `NetworkError` (model fetch failed) | `ChatError.transport` |

**Two honest gaps in the translation.** `ChatUsage.completionTokens` is not reported
directly; it is derived from a context-usage delta across the call, which is close but not
authoritative, and the code must say so. And download progress reports a fraction between 0
and 1 with the total **always** 1 — so unlike Whisper, no real byte count is available. The
capability therefore omits a byte figure rather than inventing one; see §3.3.

`finishReason` is documented at `chat-client.ts:81` as required-of-implementations even
though it is optional on the type. This client honours that: every completion carries one.

### 3.2 Packaging

A new `@azx/ribo-extractor-ondevice`, matching the `-ondevice` / `-managed` naming axis the
repo already uses for transcribers. It takes a type-only dependency on
`ribo-extractor-openai` for `ChatClient` and `perGroupExtractor`.

**That dependency is a known wart and is accepted deliberately.** `ribo-extractor-openai` is
already misnamed: it holds the generic `ChatClient` seam and the transport-agnostic
`perGroupExtractor` alongside the OpenAI-compatible transport. An on-device package
importing from a package called `-openai` reads like a mistake, and a reader is right to
flinch. Splitting the seam into a neutral home now costs a package rename, import churn
across the playground and the acceptance harness, and fresh `check:pkg` / `check:resolve` /
pack-and-consume surface — spent on a beta whose dominant risk is that the model cannot do
the job at all. **The seam moves the moment a third transport appears.** Until then this
paragraph is the record of why it did not.

Public surface, three things:

- **`OnDeviceChat`** — implements `ChatClient`; adds `capability()` and
  `prime(onProgress?)`. Mirrors `OnDeviceTranscriber` including its "there is **no**
  background or automatic download; `prime` is called only when the user asks" rule.
- **`ChatCapability`** — the three states of `TranscriberCapability` (`ready` /
  `needs-download` / `unavailable`), minus `downloadBytes`.
- **A stable engine id**, mirroring `ONDEVICE_WHISPER_ENGINE`.

Two things live elsewhere. The **composite** — sequential selection with the TTL cache and
the never-auto-select-`needs-download` rule — goes beside `ChatClient` in
`ribo-extractor-openai`, since it belongs to neither transport. And the **`usage.engine`
widening** goes in `ribo-core`.

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

**The preference order is inverted relative to the transcriber, deliberately.**
Transcription is device-first, because on-device is free and private and the managed path is
the fallback. Extraction is **managed-first**: Helix when online, on-device only when Helix
cannot run. A ~3B model is worse than the managed one, so it is accepted only when the
alternative is nothing.

`firstCapable`'s file comment reasons about fallback rescuing the *online* path. Here
selection rescues the *offline* path. Same combinator shape, opposite direction. **Write
that reasoning into the code**, because the ordering reads like a bug otherwise and someone
will helpfully correct it.

`hedged` does not apply. It races a preferred engine against a fallback on a latency budget,
which presumes both can run. Here they never can simultaneously: Helix needs exactly the
network whose absence is the reason on-device exists. There is nothing to race.

**Helix reports capability from the connectivity model, not `navigator.onLine`.**
`helixChat()` gains an optional connectivity source and returns a capability-reporting
client — additive, since existing callers only touch `.complete()`. The alternative is
learning you are offline by failing a request: seven groups times one doomed round-trip, per
retry, per item. The connectivity model is already what the relay trusts, and it already
distrusts `navigator.onLine` for the captive-portal reason recorded in `relay.ts`.

**Selection is per-call, not per-extraction.** If the uplink dies after group 3, groups 4–7
completing on-device is the wanted behaviour — the item reaches review instead of parking.
The composite's TTL cache keeps this from thrashing.

**Which forces a provenance rule for mixed runs.** `usage.engine` is one string and a run
can now touch two transports. **If any group ran on-device, the whole extraction is labelled
on-device.** A reviewer is not asking which engine produced field 12; they are asking
whether to trust this card less than usual, and "some of this came from the beta model" is
the honest answer. Single-valued, conservative.

### 3.5 Throughput: the `too-slow` lesson, and why its remedy is not copied

#24 exists because `OnDeviceTranscriber.capability()` decided `ready` purely on whether
weights were cached, so a slow device always reported ready and the managed fallback was
unreachable at any threshold. The remedy was a measured real-time-factor verdict, persisted
per model id, surfacing a permanent `too-slow` reason.

**The defect transfers exactly.** Deciding `ready` purely on `availability() === 'available'`
means a device that has Nano but decodes slowly reports ready, then spends a very long time
across seven calls. The relay drains strictly in capture order, so that item blocks the head
of the queue while it runs.

**The remedy does not transfer**, because the direction is reversed. When the transcriber
demotes on `too-slow`, it falls back to a managed engine that is reachable — the device is
online, that is why the fallback exists. When the extractor would demote, there is by
definition nothing to fall back to: it is running because the network is gone. Demoting
converts "slow extraction" into "no extraction", which is what this design exists to
prevent.

**Decision for beta: no throughput gate. The bound already exists.** On-device extraction
is attempted whenever it is `ready`, however slow the device. The wall-clock ceiling is
`perGroupExtractor`'s existing `stepTimeoutMs` (default 900,000 ms, matching the relay's
`DEFAULT_STEP_TIMEOUT_MS`), which the relay already wraps `extract()` in. A device too slow
to finish inside it fails the step and parks through normal backoff — today's behaviour for
any slow extraction, requiring no new machinery. §6.3 asks whether that ceiling is actually
achievable on-device.

If real devices cluster badly, the RTF pattern — a persisted, measured verdict keyed by
model — is the proven next step, and this repo now has a working example of it to copy.

### 3.5.1 Concurrency: on-device must serialize, and cannot do it through config

`perGroupExtractor` runs its group calls through a bounded pool, `concurrency` defaulting to
4, and its own comment records why: "seven sequential calls would not" fit inside
`stepTimeoutMs`. The existing timing budget therefore *depends* on calls overlapping.

On-device breaks that in two ways. One model on one device does not benefit from four
concurrent sessions and may well fail or thrash under them. And `concurrency` is fixed when
the extractor is constructed, while §3.4 selects a transport **per call** — so there is no
configuration value that is correct for both transports on the same instance.

**The on-device client serializes internally.** `OnDeviceChat` admits one `complete()` at a
time and queues the rest. The pool above it still believes four calls are in flight; below
the seam they run one after another. This keeps per-call selection intact, leaves the
managed path's timing math untouched, and needs no new option. The cost is that seven
on-device groups run strictly sequentially inside a ceiling sized for overlapping calls —
which is exactly what §6.3 has to measure.

### 3.6 End-to-end flow

Consumer probes `capability()` at app start. If `needs-download`, it renders its own "arm
this device for offline" affordance and calls `prime()` with progress. Thereafter: the relay
drains → `perGroupExtractor` issues seven `complete()` calls → the composite picks Helix
(online) or on-device (offline) per call → parsed fields land in the outbox with
`usage.engine` recorded → the review card can badge a beta-extracted item.

## 4. Testing

Three tiers, because the Prompt API exists only in a browser and the real model is not
deterministic.

**Unit (vitest, Node) — a fake `LanguageModel` global.** Where nearly all the must-fail
tests live:

- A request whose measured size exceeds the session's context window produces a clear
  `ChatError` from a pre-flight check. A context-overflow error escaping the client is the
  failure.
- An unsupported JSON Schema feature surfaces as `ChatError.unsupported`, not as a generic
  transport error.
- Online, Helix serves. Offline, on-device serves. **Both directions asserted**, so the
  inverted preference order of §3.4 cannot be silently "fixed".
- The composite never auto-selects `needs-download`.
- Constructing the client and probing `capability()` download nothing. Only `prime()` does.
- Group 7's call cannot observe group 1's content — session isolation via clone.
- A run where some groups go to Helix and some go on-device reports the **on-device** engine
  in `usage.engine`.
- Four `complete()` calls issued concurrently against `OnDeviceChat` execute one at a time —
  the second does not begin before the first resolves (§3.5.1).

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

**One targeted fix to existing code.** Doc 18 records that a failing acceptance run writes
no artifact — `acceptance/results/` is gitignored and the baseline updates only on a clean
pass, so `claude-cli`'s failing numbers survive only in prose. For a beta model where nearly
every run is a failing run, that gap makes this feature unmeasurable. Split the two concepts
as doc 18 already recommends: **every run writes a run record; only a clean pass updates the
baseline.** This is in scope because the work is unmeasurable without it, not as opportunistic
cleanup.

## 5. What this design does not change

- **The relay.** Its drain is already unconditional; connectivity is only an extra trigger.
- **The `Extractor<F>` interface.** Stays a plain builder — no `engine`, no `capability()`.
  Its comment about capability contracts stays true as written. (`ExtractionResult.usage`,
  declared in the same file, does widen — see §2. The interface does not.)
- **`perGroupExtractor`.** Unchanged and unaware of which transport serves it. Its existing
  `concurrency`, `maxRetries`, `stepTimeoutMs` and abort plumbing are reused, not extended.
- **`firstCapable` and `hedged`.** Untouched; the chat composite is a sibling, not an edit.
- **`score.mjs`.** Reused verbatim, per doc 16 §5.

## 6. Open questions and risks

### 6.1 Does the largest group fit in context? (gating)

The largest per-group schema is **13,273 bytes** of JSON Schema — roughly 3.3k tokens before
the transcript, system prompt or few-shot examples. Gemini Nano's context window is small
and this may not fit.

**This is measured before anything else is built.** The Prompt API exposes the session's
context window and can price an input before sending it, so this is a direct measurement,
not an estimate. If it does not fit, this design **does not ship as written** and sub-group
extraction — splitting below the seven-group boundary — becomes a roadmap item with its own
design. Recording it here so the dependency is explicit: everything downstream assumes a
"yes".

### 6.2 Which JSON Schema features does Chrome's constraint support?

`responseConstraint` errors with `NotSupportedError` on schema features the user agent does
not implement. The enveloped extraction schema uses nested objects, closed objects, all-keys-
required, nullable leaves and enums. Which of those Chrome's implementation honours is
unverified. Measured in the same pre-flight as 6.1, since a failure here is equally fatal and
equally cheap to check.

### 6.3 Do seven serialized on-device calls fit in the existing step timeout?

`stepTimeoutMs` defaults to 15 minutes and was sized on the assumption that group calls
overlap four-wide. §3.5.1 forces on-device calls to run one at a time, which spends the
whole budget serially: roughly **two minutes per group**, including retries and backoff.

Whether that holds is unmeasured and depends entirely on Nano's decode rate for a few hundred
output tokens against a ~3.3k-token prompt. Measured in the same pre-flight as §6.1 and
§6.2 — the same session answers all three. If it does not fit, the options in preference
order are: raise `stepTimeoutMs` for the on-device path, cut `maxRetries` for it, or fall
back to the sub-group split of §6.1.

### 6.4 Nano's language coverage

The Prompt API advertises a limited output-language set. English-only field audits are
unaffected, but this is a hard ceiling on any future multilingual capture, and it is a
property of the model rather than of this design.

### 6.5 Quality is genuinely unknown

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
(§3.4). It does **not** relax the shape gate, the provenance rule, the
no-background-download rule, or the trust boundary: model output is still parsed through the
adapter's schema before it becomes field data, exactly as the managed path is.

## 8. Sources

- `packages/ribo-core/src/{extractor,first-capable,hedged,transcriber}.ts`,
  `packages/ribo-core/src/queue/relay.ts` — the seams and the drain policy this design reads.
- `packages/ribo-extractor-openai/src/{chat-client,per-group,helix-chat,split-schema}.ts` —
  the transport seam and the pipeline above it.
- `packages/ribo-transcriber-ondevice/src/{index,rtf-verdict}.ts` — the `prime()` and
  measured-capability patterns.
- `docs/implementation/16-extraction-schema-scale.md` §5 — the baseline to beat and the
  instruction to reuse `score.mjs` untouched.
- `docs/implementation/18-first-extraction-measurement.md` — the shape-versus-accuracy split,
  the corpus-contamination correction, and the missing-run-record gap §4 adopts.
- Prompt API explainer, `https://github.com/webmachinelearning/prompt-api` — fetched
  2026-08-17 for the availability values, session and constraint options, progress shape,
  token accounting and exception types quoted throughout §3.
