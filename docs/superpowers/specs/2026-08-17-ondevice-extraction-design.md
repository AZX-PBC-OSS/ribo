# On-device extraction: unblocking the offline queue

**Date:** 2026-08-17
**Status:** Design, **implemented**. Revised three times — after external review (§9), after
bench measurement against real Gemini Nano (§10), and after four corpus runs replaced the
extraction strategy outright ([doc 19](../../implementation/19-ondevice-extraction-strategies.md),
§3.5).
**Ships as:** beta — see §7 for what "beta" constrains and what it does not.

## The one thing to take away

An auditor working offline today gets capture and on-device transcription, and then the item
**parks in `extracting`** until signal returns. The relay is not connectivity-gated
(`queue/relay.ts` — `syncNow()` and `start()` drain unconditionally; connectivity is only an
extra trigger), so the drain runs offline and fails at the one step that needs the network.
Giving extraction an engine that runs on-device makes that step succeed and carries the item
to `awaiting-review` with the radio off.

The engine is **Chrome's Prompt API** (Gemini Nano), reached as a `ChatClient`. The managed
transport keeps `perGroupExtractor`; the on-device one runs a **three-phase extractor** (§3.5).
Both sit behind a composite `Extractor` that picks per extraction.

**It has been measured end to end on the real corpus and it works** (§10, and
[doc 19](../../implementation/19-ondevice-extraction-strategies.md)). Inference is confirmed
local: a full constrained extraction ran with egress blocked. Context window turned out not to
be a constraint and latency is comfortable.

**The thing that decided this design was the shape of the question, not the engineering around
the answer.** One constrained call per field group degenerated into a whitespace loop on ~60% of
calls, and no retry budget fixed it — 4 of 14 transcripts failed twice over. Asking three smaller
questions instead (is this discussed, quote it, classify the quote) produced **zero degenerations
in 283 calls**, completed 14/14, cut hallucination to 1.3% and took source-span fidelity to 100%.
§3.5 specifies that strategy and records what the retry work bought instead.

The number this design is still uncomfortable about is the **53% miss rate** (§6.8).

---

## 1. Context: what already exists

| Piece                         | Where                                          | Relevance                                                                                                     |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Extractor<F>` seam           | `ribo-core/src/extractor.ts`                   | Explicitly "a plain builder, not a capability contract". Stays that way.                                      |
| `ExtractStep`                 | `ribo-core/src/queue/relay.ts:25`              | What the relay calls. Drops everything but `fields` — see §3.6.                                               |
| `ChatClient` seam             | `ribo-extractor-openai/src/chat-client.ts`     | The injected transport. Where on-device plugs in.                                                             |
| `perGroupExtractor`           | `ribo-extractor-openai/src/per-group.ts`       | Seven-group split, prompt assembly, examples, envelope parsing, merge, bounded pool, retry-budget derivation. |
| `deriveMaxRetries`            | `per-group.ts:200`                             | Sizes the retry budget from `ceil(G / concurrency)`. Load-bearing — see §3.5.                                 |
| `PER_CALL_CEILING_MS`         | `per-group.ts:170`                             | Module constant, 120,000. **Must become configurable** — see §3.5.                                            |
| `helixChat()`                 | `helix-chat.ts:98`                             | Managed transport. Returns a bare `ChatClient`, no capability notion.                                         |
| `firstCapable`                | `ribo-core/src/first-capable.ts`               | Sequential selection, TTL cache, `invalidate()`, never auto-selects `needs-download`.                         |
| `hedged`                      | `ribo-core/src/hedged.ts`                      | Races primary against fallback on a latency budget. **Does not apply** — §3.4.                                |
| `OnDeviceTranscriber.prime()` | `ribo-transcriber-ondevice/src/index.ts`       | Download-on-explicit-request, with progress. Copied in spirit.                                                |
| RTF verdict / `too-slow`      | `ribo-transcriber-ondevice/src/rtf-verdict.ts` | A measured-throughput capability gate. Lesson transfers; remedy does not — §3.5.                              |

`ribo-ui-react` is headless and the consuming field app is a separate repo, so this repo ships
capability states and a `prime()` affordance, not a download screen. The playground is the
stand-in consumer, as `whisper-store.ts` / `TranscribePanel.tsx` already are for transcription.

## 2. Decision

On-device extraction is a **`ChatClient`**. A **composite `Extractor`** selects per extraction
between two delegates over it: `perGroupExtractor` on the managed transport, and
`threePhaseExtractor` on the on-device one (§3.5). The delegates differ because the transports
differ — a frontier model answers a whole field group in one call, and a ~3B model does not.

### 2.1 Why Chrome's Prompt API rather than shipping our own weights

Recorded because the first two drafts assumed this choice without arguing it, and it is the
first question a reader asks.

1. **Distribution.** A self-shipped 4B q4 model is ~2.5 GB we serve and version. Chrome manages
   Nano's weights and shares them across every origin. Weaker than it first appears — Nano is
   _also_ a multi-GB download that must land before the auditor goes offline (§3.3), measured
   at **5.4 minutes** (§10) — but it is not bytes we ship, and it may already be present.
2. **Delivery constraints.** Apple's `FoundationModels` is native-only and unreachable from a
   browser at all. Self-hosting weights means serving gigabytes from Helix's static host or
   fetching from a CDN that CSP blocks. **This is the strongest of the four reasons** and the
   one the decision actually rests on.
3. **Constrained decoding is native.** `responseConstraint` needs no extra machinery. Softer
   than it sounds — WebLLM/MLC does grammar-constrained JSON via XGrammar — so this is a work
   difference, not a capability difference.
4. ~~The transcriber's runtime cannot run a useful LLM.~~ **This reason is dead.** It rested on
   `config.ts`'s claim that q4/q8 do not load on the pinned ORT build. #25 re-measured and
   overturned it: the execution provider gates quantization, not the dtype, and a pnpm override
   to onnxruntime-web 1.27.0 makes q8 load on WASM.

**The counter-argument, recorded honestly.** We cannot pin Chrome's model. It changes under us
with browser updates; we cannot version-lock it, swap a better one in, or reproduce a
measurement later. For a beta whose purpose is measuring whether a small model can do this job,
an unpinnable engine means the acceptance baseline can drift with no commit touching the repo.
Combined with §6.6 (no interoperability guarantee) and §6.7 (locality not guaranteed by the
API), the platform gives materially less than it appears to.

The decision still stands on reason 2 alone. It should be revisited — with the numbers in §10
in hand — if this ever graduates from "beta we are learning from" to "offline extraction is a
thing the product promises."

### 2.2 Why a `ChatClient` and not an extraction strategy

`perGroupExtractor` sits above the `ChatClient` seam and owns the seven-group split, prompt
assembly, few-shot examples, envelope parsing and merge. A strategy-level implementation would
re-implement all of it or force it into a shared package first.

**Measurement later required a strategy-level implementation anyway** — `threePhaseExtractor`
(§3.5) — so this reasoning was right about the cost and wrong about the conclusion. It was worth
paying: the per-group pipeline could not be made to work on a small model at any retry budget.
The `ChatClient` choice still stands, because that seam is what let a second strategy be written
without touching transports, capability or selection at all.

### 2.3 Why selection is at the `Extractor` level anyway

The first draft selected between transports per _call_, inside a composite `ChatClient`.
External review killed that (§9). `perGroupExtractor` derives its retry budget from
`ceil(G / concurrency)` using the **configured** concurrency, so one instance cannot be
correct for both a four-wide managed path and a serialized on-device one.

**This does not become a capability contract on `Extractor<F>`.** The composite reads
capability from the `ChatClient`s it was handed, not from its delegate extractors. So
`Extractor`'s "a plain builder, not a capability contract" comment stays true as written.

### 2.4 Provenance

`ExtractionResult.usage` gains an **optional** `engine`. Optional is required: `FakeExtractor`,
`singleShotExtractor` and `perGroupExtractor` all return `{ calls }` today (`extractor.ts:103`,
`single-shot.ts:127`, `per-group.ts:508`). Getting that value to the review card needs more
than the extractor — §3.6.

## 3. Design

### 3.1 The `ChatClient` translation

`ChatRequest.messages` splits by role: the `system` message and few-shot turns become
`initialPrompts` at session creation; only the transcript turn goes to the prompt call.
`response_format.json_schema.schema` becomes `responseConstraint`, which accepts a JSON Schema
object directly — the schema the adapter already emits passes through unmodified, with every
feature it uses accepted (§10.2).

**Sampling is left at the default.** `samplingMode: "most-predictable"` was measured and did
not help — it produced _more_ degenerate loops than the default, and `session.samplingMode`
read back as `n/a`, so it may be silently ignored on a normal web context. Do not re-propose it
without new evidence.

**`omitResponseConstraintInput: true` is set.** Measured to roughly halve the loop rate
(2/8 versus 4/8). The effect is not statistically strong at that sample size, but the option is
free and never worse.

**Sessions and the seven-group loop.** One base session carries the system prompt and examples;
each call runs on a **clone**. Reusing one session across seven calls would put groups 1–6 in
context for group 7 — burning a 9,216-token window (§10.1) and creating the cross-context bleed
doc 16 §5 names. The `ChatClient` seam is stateless, so the client owns this lifecycle
internally: base session built lazily on first call, cloned per call, destroyed after idle.

**The client streams internally.** `complete()` still returns a whole string and the seam stays
non-streaming, but the implementation uses `promptStreaming` so it can watch output and kill a
degenerate loop early, and enforce its own deadline.

This was once load-bearing — the design did not work without it. Under the three-phase strategy
(§3.5) it is a **safety net**: zero degenerations in 283 measured calls. It is kept because the
failure it catches is unbounded (a call that never returns) and the cost of keeping it is a string
comparison per chunk.

**Error mapping.**

| Prompt API                                                             | `ChatClient`                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `NotAllowedError` (no user gesture while `downloadable`/`downloading`) | `ChatError.unsupported`; only `prime()` should ever provoke it |
| `NotSupportedError` (unsupported JSON Schema feature)                  | `ChatError.unsupported`                                        |
| `QuotaExceededError`                                                   | see below — **not** a single mapping                           |
| `SyntaxError` (constraint unsatisfiable)                               | `ChatError.malformed`                                          |
| `AbortError`                                                           | `ChatError.aborted`                                            |
| `NetworkError` (model fetch failed)                                    | `ChatError.transport`                                          |

**`QuotaExceededError` has two distinct causes and the second one matters.** The previous
revision dropped this mapping entirely, reasoning the error was "thrown _before_ any response
exists." **That was wrong, and measurement disproved it** (§10.3): it also fires _after_
generation, with `message` "The response exceeded output limits and was truncated." Input
overflow is caught by the pre-flight below; output truncation is the real case and is treated
as the loop signal of §3.5 — **transient, not terminal.**

**Pre-flight.** Before the first call the client measures the prepared input against
`session.contextWindow`. Note `measureContextUsage` **ignores** `responseConstraint` (§10.2), so
the measurement covers the prompt only — which is sound, because schema size does not consume
input context.

**Two honest gaps.** `ChatUsage.completionTokens` is derived from a context-usage delta, not
authoritative. And download progress reports `loaded` 0..1 with `total` **always 1**, so no real
byte count is available (§3.3).

### 3.2 Packaging

A new `@azx/ribo-extractor-ondevice`, matching the `-ondevice` / `-managed` naming axis. It
depends on `ribo-extractor-openai` for `ChatClient` — an ordinary runtime dependency, not
type-only, since `perGroupExtractor` is a runtime function (`per-group.ts:322`).

**The dependency direction is a known wart, accepted deliberately.** `ribo-extractor-openai`
already holds the generic seam and the transport-agnostic pipeline alongside the OpenAI
transport, so an on-device package importing from `-openai` reads like a mistake. Splitting the
seam now costs a rename, import churn across the playground and acceptance harness, and fresh
`check:pkg` / `check:resolve` / pack-and-consume surface — spent on a beta whose dominant risk
is model quality. **The seam moves the moment a third transport appears.**

**`ChatCapability` belongs to the seam, not to the on-device package.** It is declared beside
`ChatClient` in `ribo-extractor-openai`, along with a `CapableChatClient` interface (a
`ChatClient` that also reports `engine` and `capability()`). Earlier drafts put it in the
on-device package; both reviewers caught that as a dependency cycle (§11), since `helixChat`
and the composite live in `-openai` and would have had to import a type from the package that
depends on _them_. One declaration, at the layer both transports implement.

Public surface of `@azx/ribo-extractor-ondevice`:

- **`OnDeviceChat`** — implements `CapableChatClient`; adds `prime(onProgress?)`. Mirrors
  `OnDeviceTranscriber`, including its "no background or automatic download" rule.
- **A stable engine id**, mirroring `ONDEVICE_WHISPER_ENGINE`.

The **composite `Extractor`** goes beside `perGroupExtractor` in `ribo-extractor-openai`; the
**provenance plumbing** (§3.6) goes in `ribo-core`.

### 3.3 Capability and priming

| Prompt API                    | `ChatCapability`             |
| ----------------------------- | ---------------------------- |
| `available`                   | `ready`                      |
| `downloadable`, `downloading` | `needs-download`             |
| `unavailable`                 | `unavailable`, with a reason |

`needs-download` carries no byte count. The capability says the download is Chrome-managed and
of unknown size rather than quoting an invented number — a real regression against the Whisper
consent screen's measured ~290 MB, which the consuming app's copy must be honest about.
Measured cold `create()` was **323 seconds** (§10.1), so "arming" is a five-minute wait shown as
a bare percentage.

**Chrome enforces the no-background-download rule for us.** `create()` throws
`NotAllowedError: Requires a user gesture when availability is "downloading" or "downloadable"`
(§10.4). This is undocumented in the explainer and was found by measurement. Consequences:

- `prime()` **must be called from a user gesture.** The consuming app's "arm this device"
  affordance has to be a real click, not an effect.
- The lazy base-session build (§3.1) has no gesture, so it can only succeed when the model is
  already `available` — exactly the wanted behaviour, now platform-enforced rather than
  conventional.
- The availability pre-check the previous revision specified as a _guard_ is demoted to a
  _courtesy_: it produces a better error than `NotAllowedError`, but it is no longer the thing
  preventing an unconsented multi-gigabyte fetch.

### 3.4 Selection

**Preference order is inverted relative to the transcriber, deliberately.** Transcription is
device-first because on-device is free and private. Extraction is **managed-first**: Helix when
online, on-device only when Helix cannot run, because a ~3B model is worse and is accepted only
when the alternative is nothing. `firstCapable`'s comment reasons about fallback rescuing the
_online_ path; here selection rescues the _offline_ path. **Write that into the code** — it
reads like a bug otherwise.

`hedged` does not apply: it races two engines on a latency budget, which presumes both can run.
Here they never can simultaneously, since Helix needs exactly the network whose absence is the
reason on-device exists.

**Selection is per extraction, not per call.** The composite probes capability once and that
delegate runs all seven groups. Forced by §3.5 — the delegates have different, individually
correct timing budgets. It also makes provenance single-valued, so the earlier draft's
mixed-run labelling rule is dropped. The cost is real: if the uplink dies after group 3, the
managed delegate fails the whole extraction and the item parks; the next drain re-selects
on-device and starts over.

**Helix reports capability by subscribing to the connectivity model** — not `navigator.onLine`,
and not a snapshot at construction. `Connectivity.subscribe` emits immediately and on change
(`connectivity.ts:144-151`); a construction-time sample goes stale and the composite keeps
choosing a dead uplink.

**Cache invalidation must be wired.** The composite caches capability on a TTL, as
`firstCapable` does, and exposes `invalidate()` — the relay's connectivity watch only triggers
drains and invalidates nothing (`relay.ts:324-333`). Without wiring it, a stale `ready` for the
managed path survives a full TTL after the uplink drops.

### 3.5 How the extraction is asked — three phases, not one call per group

**Superseded by measurement, 2026-08-26.** This section previously specified one constrained
call per field group, with a retry budget and loop-detection machinery to survive the model's
degenerate whitespace loop. That strategy was built, measured on the real corpus, and **lost**.
[Doc 19](../../implementation/19-ondevice-extraction-strategies.md) has all four strategies and
their numbers; the short version is that the engineering around the answer mattered far less than
the shape of the question.

|                       | per-group + retries | three phases + grounding |
| --------------------- | ------------------: | -----------------------: |
| transcripts completed |               10/14 |                **14/14** |
| degenerate loops      |       ~60% of calls |              **0 / 283** |
| wall clock            |            11.2 min |              **4.5 min** |
| hard hallucination    |                3.8% |                 **1.3%** |
| source-span verbatim  |               78.3% |                 **100%** |
| enum member accuracy  |               82.7% |                **95.7%** |

**The strategy.** Per field group, in order:

- **Phase 0 — presence.** One call, constrained to a flat object of leaf → boolean: is this field
  discussed at all? A group where every leaf comes back false is skipped entirely.
- **Phase 1 — spans.** One call, constrained to the leaves phase 0 admitted, each a nullable
  verbatim quote.
- **Phase 2 — classify.** One call per non-null span, constrained to the narrowest thing that leaf
  allows — a bare enum, a bare number, a bare string.

Then **span grounding, unconditionally**: a leaf whose quote is not a verbatim substring of the
transcript loses both the quote and the value it was supposed to justify.
`isSpanGrounded` in `ribo-core` is the check, and until this change **no extraction path had ever
called it** — its only callers were tests asserting the fixtures were grounded.

**Why the presence phase carries most of the win.** Asking for "a verbatim quote, or null" is a
_string-shaped_ question, and a small model asked for a string tends to produce one. Where the
transcript says nothing, returning `null` reads as a refusal and the model would rather invent a
plausible quote — which phase 2 then dutifully classifies, so a wrong value arrives carrying
fabricated evidence. A boolean has no text to invent. Adding phase 0 took hallucination from 4.8%
to 1.6%, the single largest quality move measured. It did not rubber-stamp: the presence-true rate
was 165/714, and 49 of 98 groups were skipped outright.

**Why grounding is worth its cost.** It barely moved hallucination (1.6% → 1.3%) because most
hallucinated values had _grounded_ spans — the model quoted something real and reasoned wrongly
from it. What it bought was categorical: span fidelity 83.7% → **100%**. The provenance envelope
exists so a reviewer can check the quote against the transcript, and at 83.7% a reviewer who finds
one fabricated citation has no reason to trust any of them. Review is this feature's entire safety
net; a citation that cannot be trusted does not provide one.

**What this cost, stated plainly.** The miss rate rose to **53%** — more than half of stated values
come back null, against a frontier baseline of 0.8%. Grounding is strict about case and whitespace,
so it drops near-miss paraphrases along with outright fabrications. That is the right direction of
error here (a reviewer can fill a blank but cannot easily catch a plausible invention) and it is
still strictly better than today's offline behaviour, where the item parks in `extracting` and the
auditor gets nothing at all. It is not a number to quote without the caveat.

**What was retired with the old strategy.** The on-device delegate no longer uses
`perGroupExtractor`, so its `concurrency: 1`, its per-call ceiling, its nine-retry budget and the
near-zero backoff are all gone, along with the regression guards that defended them. Two facts
survive from that work and are worth keeping in mind rather than rediscovering:

1. **`deriveMaxRetries` reads configured concurrency, not observed parallelism.** Hiding
   serialization below the seam corrupts its arithmetic silently. `PER_CALL_CEILING_MS` remains a
   per-instance option because the managed path still depends on it.
2. **Backing off is wrong for a degenerate loop.** It is a sampling accident inside one
   generation, not congestion; waiting only spends the budget that buys attempts. If any future
   strategy needs to retry a generation failure, it should retry immediately.

**`OnDeviceChat` keeps its loop detection and hard deadline.** Zero degenerations in 283 calls
means they are now a safety net rather than a mechanism — but the failure they catch is unbounded
(a call that never returns), and the cost of keeping them is a string comparison per chunk.

### 3.6 Getting the engine to the review card

`ExtractionResult.usage.engine` alone is not enough. `toExtractStep` returns `result.fields` and
discards the rest (`extractor.ts:72-76`), and the outbox's `extracted` column is a bare
`z.record(z.string(), z.unknown())` (`queue/schema.ts:200`). Nothing carries `usage` across that
boundary, so as first specified the engine was computed and thrown away — removing the entire
reason for preferring this shape.

Three additive pieces: `ExtractionResult.usage` gains an optional `engine`; `ExtractStep`'s
return widens so `toExtractStep` passes it through instead of dropping it; and the outbox gains
a column the relay patches where it already patches `extracted`. That last is a schema change,
and this repo's position is that **schema migrations are free** — no users, no back-compat
burden — so the honest fix is also the cheap one. It does mean a small relay change.

### 3.7 End-to-end flow

Consumer probes `capability()` at app start. If `needs-download`, it renders an "arm this
device for offline" affordance — **a real button**, per §3.3 — and calls `prime()`, which takes
minutes. Thereafter: the relay drains → the composite probes capability and picks a delegate →
that delegate runs seven groups through its transport, each call streaming with loop-detection
and retry → fields plus engine reach the outbox → the review card badges a beta extraction.

## 4. Testing

**Unit (vitest, Node) — a fake `LanguageModel` global.** Where nearly all must-fail tests live:

- A tail of pure whitespace past the threshold aborts the call and surfaces a **transient**
  `ChatError`. Surfacing it as truncation/terminal is the failure — that is the bug that would
  silently disable retry.
- Retry after a loop reaches success; a run that loops on every attempt exhausts the budget and
  fails cleanly rather than hanging.
- The loop detector does **not** fire on a well-formed pretty-printed response.
- A prepared input exceeding `contextWindow` fails pre-flight with a clear `ChatError`.
- An unsupported JSON Schema feature surfaces as `ChatError.unsupported`.
- `NotAllowedError` from a gesture-less `create()` surfaces as a capability failure, not a
  transport error.
- Online, the composite selects managed; offline, on-device. **Both directions asserted**, so
  §3.4's inverted order cannot be silently "fixed".
- The composite never selects a delegate reporting `needs-download`.
- Constructing the client and probing `capability()` download nothing; only `prime()` does.
- Group 7's call cannot observe group 1's content — session isolation via clone.
- **A span that is not a verbatim substring of the transcript drops both the span and the value
  it justifies.** Regression guard for §3.5's grounding rule: four lines of code, worth 16 points
  of span fidelity, and entirely invisible if a refactor tidies them away.
- A leaf phase 0 marks absent triggers **no** span or classify call — assert the call count, since
  skipping the work is the point.
- The engine reaches the outbox — guard against §3.6's original defect returning.
- A capability change plus `invalidate()` flips the next selection without waiting out the TTL.

**Browser (vitest browser mode).** Shape conformance and one real end-to-end extraction against
a real `LanguageModel`, skipped rather than failed where the model is absent.

**Acceptance (quality).** `score.mjs` and `cli-chat.ts` are Node; the Prompt API is browser-only.
The on-device acceptance run executes in browser mode and emits the **same result JSON**, so
`score.mjs` grades it **untouched** — doc 16 §5's requirement, and the only way these numbers sit
honestly beside the codex and claude baselines.

**Gate behaviour**, per doc 18's split: **shape conformance is a hard gate** (constrained
decoding should make non-conforming output impossible; a failure means a translation bug);
**content accuracy is recorded, not gated** (requiring codex's 0.5% hallucination rate from a
~3B model would block the beta permanently).

**~~One targeted fix to existing code.~~ Already shipped — do not rebuild it.** Earlier
revisions carried doc 18's "a failing run writes no artifact" into scope. **That is stale**:
`1b2d003` ("Extraction accuracy as committed run records", #10) landed it. `gate.manual.ts`
persists a run record _before_ any assertion, `run-store.ts` writes `runs/current-<label>.json`
and `history-<label>.jsonl`, those artifacts are committed, and per-hazard outcomes are already
captured. Both reviewers caught this independently (§11); doc 18's closing note predates the fix.

The genuinely remaining work is narrower: **the browser-mode acceptance runner must emit run
records in that existing format**, so on-device runs land in the same store as the CLI backends
rather than in a parallel one.

## 5. What this design does not change

- **The relay's drain policy.** Already unconditional. (It gains §3.6's provenance patch — a
  change to what it records, not when it runs.)
- **The `Extractor<F>` interface.** Stays a plain builder; its capability-contract comment stays
  true.
- **`perGroupExtractor`'s structure.** Two instances are _configured_ differently. One genuine
  edit is required: `PER_CALL_CEILING_MS` becomes a per-instance option (§3.5). Earlier
  revisions claimed no edit at all; that was wrong.
- **`firstCapable` and `hedged`.** Untouched; the composite is a sibling.
- **`score.mjs`.** Reused verbatim.

## 6. Open questions and risks

### 6.1 ~~Does the largest group fit in context?~~ ANSWERED — no longer a risk

Measured: `contextWindow` is **9,216** tokens, and `responseConstraint` does **not** consume it.
A 26,393-byte schema — twice the largest real group — completed successfully, which it could not
have done had the schema entered a 9,216-token window. Schema size is not a constraint on this
design. See §10.2.

### 6.2 ~~Which JSON Schema features does Chrome support?~~ ANSWERED for our shape

Nested objects, `additionalProperties: false`, all-keys-required, nullable leaves and string
enums were all accepted, with no `NotSupportedError` across schemas from 1.5 KB to 26 KB (§10.2).
Not exhaustive — the real schema carries vendor descriptions and deeper nesting — but every
feature the envelope transform emits is covered.

### 6.3 Does this hold on a weak device?

Every measured number — §10's bench and doc 19's four corpus runs alike — comes from an M-series
laptop. The target is a Surface Go 3, which #24's RTF work already treats as the weak-device case.

A full corpus run takes 4.5 minutes and ~283 calls there, against a 900s step timeout per
extraction, so the latency margin is generous. What is genuinely unknown is whether the
**degeneration rate** holds: the three-phase strategy saw zero loops on this hardware, and that is
the property the design now leans on rather than a retry budget. **Re-run the corpus harness on
target hardware before trusting it.**

### 6.4 Is the Prompt API reachable from where extraction runs? — not a blocker

`createRelay` is called from React components (`QueuePanel.tsx:241`, `TranscribePanel.tsx:304`),
so the extract step already runs on the main thread. The only worker is `whisper.worker.ts`,
owned _inside_ `OnDeviceTranscriber`. The reason transcription needs a worker does not transfer:
transformers.js runs the model in the JS context, whereas the Prompt API hands inference to the
browser and `prompt()` is an awaited promise.

Two constraints survive. **This closes a door**: moving the relay into a worker, or wanting
background sync via a service worker, rules the API out — it is unavailable in workers.
**And tab throttling is the likelier problem**: seven groups with retries is ~45s of main-thread
work, and an auditor who backgrounds the tab or lets the screen sleep hits Chrome's background
throttling mid-extraction. Cross-origin iframes additionally need Permissions Policy
`allow="language-model"`.

### 6.5 Multi-tab contention

The relay claims items under `navigator.locks`, so two tabs will not extract the same item. But
each tab holds its own `OnDeviceChat` and the browser may serve both from one model instance.
Whether that contends, queues or fails is unknown. The lock makes this a performance question,
not a correctness one.

### 6.6 The API is not a standard, and guarantees nothing across browsers

It sits in the Web Machine Learning **Community Group** — not a Working Group, not on the
standards track, self-described as a proposal "seeking feedback and support ... to gain Working
Group and implementer adoption," with features already being renamed. **Mozilla's standards
position is negative** (#1213, closed May 2026), as it is for the sibling Writing Assistance and
Translation APIs. Implementations exist in Chrome and Edge only.

The explainer states plainly: _"We do not intend to provide guarantees of language model quality,
stability, or interoperability between browsers."_

**Consequence for this design:** Edge having the API does not mean Edge behaves like Chrome —
different model, context window, schema support, decode rate and loop rate. **§10's measurements
are per-browser and must be repeated per browser**, not inherited.

This is survivable because the design treats on-device as a capability that may be absent: where
it is missing, the composite reports `unavailable`, selection falls through to managed, and
offline items park exactly as today. A non-standard API is a **soft** dependency here.

### 6.7 Locality is not guaranteed by the API — but is confirmed for Chrome today

The explainer permits cloud-backed implementations: _"it may also be viable to implement this API
entirely by using cloud services instead of on-device models."_ `availability()` returns
`available` either way, so **the API cannot tell us whether inference is local.**

Measured, with egress genuinely blocked (§10.4): `availability()` returned `available`,
`create()` succeeded in 8,040 ms, and a constrained prompt generated output until it hit the
model's own cap. A cloud-backed implementation cannot produce that sequence. Corroborated by
sustained fan noise — thermal load being the one signal the API cannot misreport.

This holds for this Chrome build. It is not a promise, so the **offline path must stay in the
acceptance suite** rather than be assumed once and inherited.

### 6.8 Quality is still unknown, and abstention is the expected weakness

Doc 18's caveat stands. Doc 16 §5's bar — 0.5–1% hard hallucination, 0–0.8% miss, 100% enum
accuracy, 100% verbatim spans — is not expected from a ~3B model.

Two early signals, neither scored. On the very first sample the model returned `"Yes"` for a
duct-sealing field whose transcript said _"I'd call that well sealed"_ with `"Well"` available in
the enum — **the identical failure doc 18 recorded for `claude-cli`** on
`wall.wallsInsulated`. That confusion is not small-model weakness; it is the enum design R1.6
exists to fix. Separately, a 57-leaf run on meaningless generated field names left only 31 null,
implying substantial over-filling — but those field names carried no real semantics, so it is not
a fair abstention test. The real corpus and `score.mjs` settle this.

**The mitigation is already in the product**: every extraction goes through human review before
write-back. A beta-quality extractor produces a worse first draft, not a wrong write.

### 6.9 Nano's language coverage

The advertised output-language set is limited (`de, en, es, fr, ja`). English-only field audits
are unaffected; this is a hard ceiling on multilingual capture and a property of the model.

## 7. What "beta" constrains

Content accuracy is recorded rather than gated (§4), the throughput gate is deferred (§3.5), and
the consuming app is expected to badge on-device extractions in review (§3.6). It does **not**
relax the shape gate, the provenance rule, the no-background-download rule, or the trust
boundary: model output is still parsed through the adapter's schema before it becomes field data.

## 8. Sources

- `packages/ribo-core/src/{extractor,first-capable,hedged,transcriber,connectivity}.ts`,
  `queue/{relay,schema}.ts` — seams, drain policy, outbox shape.
- `packages/ribo-extractor-openai/src/{chat-client,per-group,helix-chat,split-schema}.ts` —
  transport seam, pipeline, retry-budget derivation.
- `packages/ribo-transcriber-ondevice/src/{index,rtf-verdict,config}.ts` — `prime()` and
  measured-capability patterns; the dtype claim #25 overturned.
- `docs/implementation/16-extraction-schema-scale.md` §5, `18-first-extraction-measurement.md`.
- Prompt API explainer, `https://github.com/webmachinelearning/prompt-api` — fetched 2026-08-17
  and 2026-08-25.
- Mozilla standards-positions #1213.

## 9. Review history

**2026-08-17, external review** (OpenCode / `kimi-k2p7-code`, read-only; Codex unavailable —
HTTP 402 `deactivated_workspace`). Findings verified against source before acceptance. Two
invalidated the first draft:

1. **Provenance never reached the outbox** — `toExtractStep` discards `usage` and the outbox has
   no engine column, so the engine was computed and thrown away. Fixed in §3.6.
2. **Serializing below the seam corrupted the retry budget** — one extractor at `concurrency: 4`
   with the client serializing internally had `deriveMaxRetries` sizing for 2 batches while
   reality ran 7. Fixed by two correctly-configured delegates and moving selection to the
   `Extractor` level.

Also adopted: `usage.engine` must be optional; `helixChat` must subscribe to connectivity; the
composite needs `invalidate()`; "type-only dependency" was wrong for a runtime function. Worker
and multi-tab risks were unnamed and are now recorded.

## 10. Measurement log — 2026-08-25

Chrome 151.0.7922.138, macOS 26.5.2, M-series laptop. Harness: a standalone page driving the
real API, results posted back to a local collector. **All numbers below are from real Gemini
Nano, not estimates.**

### 10.1 Baseline

- `contextWindow` **9,216** tokens. System prompt cost 25–31 tokens.
- Cold `create()` (with download): **323,028 ms** (~5.4 min). Warm `create()`: **8,040 ms**.
- Tokenization ≈ **0.26 tokens/byte** (637-byte transcript → 163 tokens).
- Download progress reports `loaded` 0..1 with `total` always 1 — no byte figure available.

### 10.2 Schema size and features

`measureContextUsage` returned **163 tokens for every schema size** from 1,593 to 26,393 bytes —
it ignores `responseConstraint`. But the 26,393-byte / 57-leaf schema **completed successfully**,
which a 9,216-token window could not have absorbed. Conclusion: the constraint is enforced at the
sampler and does not consume input context. Every schema feature the envelope transform emits was
accepted; no `NotSupportedError` at any size.

Latency by size (successful runs): 3 leaves 2.1s · 13 leaves 10.7s · 57 leaves 48.8s.

### 10.3 The loop, discovered

A 29-leaf schema failed after 114,814 ms with `QuotaExceededError: The response exceeded output
limits and was truncated`, while 57 leaves succeeded — so it was never a size threshold.
Streaming revealed the cause: output degenerating into unbounded whitespace
(`"\n  \n  \n  …"`). This also disproved the previous revision's claim that `QuotaExceededError`
fires only before generation.

### 10.4 Offline and gesture

With external fetch probes failing (`navigator.onLine` deliberately not trusted):
`availability()` → `available`; `create()` → OK in 8,040 ms; a constrained prompt generated until
it hit the cap. **Local execution confirmed.**

Separately, `create()` without a user gesture while `downloadable` throws
`NotAllowedError: Requires a user gesture when availability is "downloading" or "downloadable"` —
undocumented in the explainer.

### 10.5 Loop rate and mitigation

| arm                                 | loops                                               |
| ----------------------------------- | --------------------------------------------------- |
| default options                     | 4/8, and 3/8 in a later run                         |
| `omitResponseConstraintInput: true` | 2/8                                                 |
| `samplingMode: "most-predictable"`  | 5/8 (worse; `session.samplingMode` read back `n/a`) |

Per transcript (6 calls each): basement 360ch **0/6** · rambling 502ch **1/6** · gas 205ch
**4/6** · sparse 123ch **5/6**. Suggestive that sparse inputs derail more — the abstention story
of §6.8 — but the same transcript scored 0/6 here and 3/8 in another arm under identical
settings, so **run-to-run variance is large and n is small.**

**Mitigation validated.** Streaming with an 80-character whitespace-run abort, retrying up to
four times: **20/20 solved, 0 gave up**, histogram `{1:4, 2:10, 3:5, 4:1}` (mean 2.15 attempts),
**6,482 ms mean per group**, **~45s for seven groups** against a 900s step timeout. Loop-kill
latency 1.4s median versus 3.9s median for a successful call.

### 10.6 Reaching a real model from a test — the blocker is the gesture, not the browser

**Corrected 2026-08-26.** This section previously claimed Playwright's bundled Chromium has no
Gemini Nano, so any real-model test would have to use a Chrome-channel launch or a standalone
harness. **That was wrong**, and it was asserted three times over — by this spec, by the plan
built from it, and independently by both reviewers of that plan. Nobody measured it.

Measured under the repo's own browser project
(`packages/ribo-extractor-ondevice/src/prompt-api-availability.browser.test.ts`, HeadlessChrome
149):

| probe                  | result                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `LanguageModel` global | **present**                                                                                      |
| `availability()`       | **`downloadable`**                                                                               |
| `create()`             | `NotAllowedError — Requires a user gesture when availability is "downloading" or "downloadable"` |

**Corrected again, same day.** The paragraph above was the _second_ wrong answer. Pushing one step
further — clicking a real button and prompting the session it returns — produced this:

> `USABLE — session answered "On-device model is not available in Chromium, this API is just a stub"`

**Playwright's Chromium implements the Prompt API as a stub.** The surface exists, `availability()`
reports `downloadable`, a synthesised click _does_ satisfy user activation, `create()` resolves —
and `prompt()` returns canned text instead of running a model.

So the original conclusion was right and the reasoning behind it was wrong three times over:

| round | claim                                  | verdict                   |
| ----- | -------------------------------------- | ------------------------- |
| 1     | Chromium has no Prompt API             | wrong — it has one        |
| 2     | It has one; the gesture is the blocker | wrong — the gesture works |
| 3     | It is a stub that returns fixed text   | **measured**              |

**This shape is more dangerous than a missing API.** A real-model test under Playwright would not
skip: the global is present, availability looks promising, a gesture-driven `create()` succeeds.
It would run against a fixed string and report green — coverage that measures nothing. Any
real-model test must therefore assert on _behaviour_ it could not get from a stub, not merely on
the API being present.

**Conclusion, unchanged from the original but now actually established:** real-model acceptance
runs need real Chrome — a Chrome-channel launch with a pre-armed profile, or the standalone
harness §10 used. Automating them under the repo's browser project is not possible.

Both probes stay in the suite (`prompt-api-availability.browser.test.ts`,
`prompt-api-gesture.browser.test.ts`) rather than being written up and deleted. The second asserts
the stub marker, so if Chromium ever ships a working model that assertion fails — which is exactly
when this decision deserves revisiting.

### 10.7 What the measurements changed

Context window ceased to be the gate (§6.1). Latency ceased to be a concern (§6.3). The
whitespace loop became the central design problem, and its mitigation (§3.5) became
load-bearing. The timing model inverted from a 120s ceiling with zero retries to a ~15s ceiling
with 4–5 — which requires making `PER_CALL_CEILING_MS` configurable, the one shared-code edit
this design needs.

## 11. Second review round — 2026-08-25 (plan review, findings folded back)

Two independent reviewers read the implementation plan and this spec together, both read-only,
both told to verify claims against source rather than reason from the documents: **`kimi-k3`**
via dispatch (a different model family — the cross-family read) and **Fable** (same family as
the author, so a weaker independence check, weighted accordingly). They agreed on every critical
finding, which is the strongest signal available here.

Folded back into this spec:

1. **`ChatCapability` was declared in the wrong package.** §3.2 put it in the on-device package
   while §3.4 gave `helixChat` — in `ribo-extractor-openai` — a capability-reporting return
   type. Since the on-device package depends on `-openai`, that is a cycle. It survived the
   first review and two revisions. Fixed: the capability contract lives beside `ChatClient`.
2. **The per-call ceiling is arithmetic, not a deadline.** Nothing in `per-group.ts` times a
   call, the whitespace detector only catches _trailing_ runs, and `withTimeout` leaves a
   timed-out `extract()` running detached. §3.5 now requires `OnDeviceChat` to enforce its own
   `AbortSignal` deadline.
3. **The acceptance run-record fix was already shipped** in `1b2d003` (#10). §4 carried doc 18's
   stale "not done here" note into scope. Removed; the narrower remaining work is named instead.
4. **Reaching a real model from a test is unsolved** — Playwright's Chromium has no Nano, so
   any real-model acceptance run needs a Chrome-channel launch with a pre-armed profile, or a
   standalone harness. Recorded as §10.6.

Also confirmed sound by both, independently: §3.5's retry arithmetic is exact, and the
transient-classification chain (`completeOrClassify` → per-group retry → relay
`isTransientFailure` → `maxAttempts`) terminates without loop or swallow.

**A note on how three of these arose.** Each came from trusting a document over the tree — doc
18 for the run records, an earlier draft for the capability's home, and the author's own prior
message for the browser harness. The measurement round (§10) had already established the
Playwright limitation and the need for a hard deadline; neither reached the design. When this
spec and the tree disagree, the tree is right.
