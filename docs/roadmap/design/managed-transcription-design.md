# Managed transcription — Design

**Date:** 2026-08-17
**Status:** Draft — shape agreed and validated against the real endpoint; three decisions open (§9)
**Task:** [Investigate online transcription via Azure Speech](https://app.asana.com/1/1208495702765136/project/1216763563065333/task/1217509060037650) — rescoped from a spike to an implementation
**Depends on:** nothing blocking. The `azure-stt` connection secret is a constant-header recipe and is
untouched by ask A1, which gates only the Snugg Pro write
**Related:** `docs/implementation/02-server-stt.md` — the original managed-STT design, corrected here in §7

---

## 1. Goal

Give devices that cannot transcribe on-device — or cannot do it fast enough — a working transcription
path, and let a host optionally race the two engines.

Three pieces, in dependency order:

1. **The RTF gate.** `OnDeviceTranscriber.capability()` learns to report `too-slow`, measured rather
   than assumed.
2. **The managed transcriber.** A new package implementing `Transcriber` against Azure AI Speech,
   proxied through Helix.
3. **The hedge combinator.** A new `ribo-core` export that races a preferred engine against a
   fallback on a latency budget.

## 2. Why now

**The MVP needs a transcription path that does not depend on the device.** This was scoped as a spike
ending in "a recommendation with numbers behind it, not an implementation". That framing is
superseded: the pilot needs the path itself, and accuracy is measured alongside rather than as a gate
on shipping.

**The fallback is currently unreachable, which is the more urgent half.** `firstCapable` selects the
first engine reporting `ready`, and `OnDeviceTranscriber.capability()` decides `ready` purely by
asking whether the model weights are cached. Its own comment says so
(`packages/ribo-transcriber-ondevice/src/index.ts:148`):

> Task-2 honest: this reflects cache state, not a measured throughput verdict. The `too-slow`
> real-time-factor gate and the WebGPU probe are Task 3/4.

So a device that has downloaded the weights always reports `ready`, however slowly it runs. Adding a
managed engine to the roster without the gate would change nothing for the devices that most need it:
they would still select on-device and still be slow. **The gate is what makes the fallback real**, not
the new engine.

**Nothing external blocks it.** Unlike write-back, which waits on egress HMAC signing (ask A1), the
`azure-stt` connection is a constant-header injection — `Ocp-Apim-Subscription-Key`, per
`docs/implementation/06-field-app-helix.md:22` — which is exactly what the fetch-proxy already does.

## 3. What is already built

More than `02` assumes, and this design is mostly about filling one gap rather than building a
mechanism.

| Already there                                                                                                                                      | Where                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| The seam, with the managed engine named in its file header as an expected implementation                                                           | `ribo-core/src/transcriber.ts`                |
| `unavailable` reasons `offline` and `not-configured`, written for this path — "the managed path becomes `unavailable` the moment the uplink drops" | `transcriber.ts`                              |
| `too-slow` present in both the reason list and the _permanent_ subset                                                                              | `transcriber.ts:24`, `:49`                    |
| Roster selection, capability caching with TTL, demotion on `TranscriberUnavailableError`, `onFallback` telemetry                                   | `ribo-core/src/first-capable.ts`              |
| `Recording.durationMs`, needed to predict transcription time                                                                                       | `ribo-core/src/recording.ts`                  |
| Vocabulary biasing on the on-device path — "every chunk gets the same jargon prefix"                                                               | `ribo-transcriber-ondevice/src/worker.ts:524` |

The single gap is that no implementation ever _produces_ `too-slow`. The only occurrence outside the
type definitions is a test fixture (`first-capable.test.ts:313`, `detail: "RTF 4.2"`) — the vocabulary
was designed, and the measurement was deferred.

`firstCapable` is also strictly sequential: `first-capable.ts:182` is a `for…of` with an `await`
inside, so exactly one engine runs per recording and two results cannot occur today. That is
deliberate, and rule 5 of its contract explains why — falling through on an ordinary error "would let
one OOMed clip permanently demote a device to the cloud". **This design does not change
`firstCapable`.** Racing is added beside it.

## 4. What this is not

- **Not live transcription on the managed path.** Helix has no gateway WebSocket
  (`13-helix-platform-asks.md:247`, an accepted constraint), so there is no streaming managed
  equivalent. A device on the managed path records without preview and sees the transcript after
  `stop()`. The UI should say so rather than appear broken.
- **Not confidence-based arbitration.** The literature's usual tie-break is a confidence score, and
  our on-device stack is unlikely to expose one. Tie-breaking is positional instead (§5.3).
- **Not cancellation of a losing hedge.** `Transcriber.transcribe` takes no `AbortSignal`, so a fired
  hedge is paid for even when the primary wins. Accepted for this tranche; revisited when telemetry
  shows the real firing rate.
- **Not composition safety.** `hedged` can be composed into configurations that race an engine against
  itself. Deliberately deferred to
  [its own ticket](https://app.asana.com/1/1208495702765136/project/1216763563065333/task/1217558466172554) —
  the composition this repo ships is the safe one, and a point fix would paper over a general gap.
- **Not a custom STT service.** `02` makes this conditional on needs we do not have; the managed
  endpoint is a direct proxy.

## 5. Design

### 5.1 The RTF gate

`capability()` is contractually cheap and called on every queue drain, so it cannot run inference. The
measurement therefore happens elsewhere and `capability()` reports a stored verdict.

**It happens in `prime()`.** That is already the expensive, explicitly user-initiated step with a
progress UI, and it leaves the pipeline warm, so the marginal cost is one short inference on top of a
165 MB download. Structurally it is also the cheapest place: `prime()` is **not part of the
`Transcriber` interface** — it exists only on `OnDeviceTranscriber` — so the gate needs **no change to
the core contract**. `capability()` simply begins returning a `too-slow` it was always typed to return.

The verdict is **persisted**, not held in memory: `too-slow` is in the permanent subset, so it must
survive a reload. It is keyed by model id, so changing models re-measures.

Two consequences are accepted rather than solved:

- **The download is paid before the verdict is known.** On the device most likely to fail, 165 MB is
  spent to discover the result cannot be used. The cheap WebGPU probe (Task 4) belongs in front of
  this as a pre-filter, which is presumably why Tasks 3 and 4 were scoped together.
- **A device that never primes never gets a verdict.** That is correct: it reports `needs-download`,
  `firstCapable` skips it, and the managed engine runs.

The alternative — measuring RTF from the first real transcription instead of a calibration clip — was
rejected. It is cheaper and self-tuning, but the verdict would only arrive after a slow first
recording, and the fallback it selects needs network. **The verdict must be settled while the device
is still on wifi, because the field is where the uplink is not.** Lazy measurement composes on top
later as a refinement.

### 5.2 The managed transcriber

A new package, `@azx/ribo-transcriber-managed`, mirroring the on-device one: implements `Transcriber`,
engine id `managed-azure-speech`.

**The package does not know how its call is routed.** It takes the Azure transcribe endpoint and an
injected `fetch`, builds the multipart request, and calls it. Whether that fetch goes straight to
Azure with a key attached, or is rewritten onto `<gateway>/_api/fetch/<url>` so egress injects the
stored `azure-stt` secret, is the host's business and never the package's.

This is a deliberate strengthening of "no secret is bundled". Rather than the package holding a
credential and being trusted not to leak it, the package has **no capacity to authenticate at all** —
the credential lives in the transport the host supplies. It also makes the eventual migration from
development credentials to the Helix connection a change at the composition site, with no package
release.

The development transport — key attached, straight to Azure — is viable only because a localhost dev
server has no Content-Security-Policy. A deployed Helix app cannot reach a third-party origin
directly (`connect-src 'self'`), so production is necessarily proxied. Dev-direct is therefore
bounded by the platform, not merely by our own discipline.

Capability reporting maps onto reasons that already exist: `not-configured` when no transport or
endpoint is supplied, `offline` when connectivity is down, `ready` otherwise. Neither is permanent, so both are
re-probed — correct, since both are situations rather than facts about the hardware.

Failure classification follows the contract's existing split, and getting it wrong is the bug the
contract exists to prevent: a 503, a timeout or a malformed response is an **attempt** failure and is
thrown plainly for the queue's backoff to own; only "this engine cannot run here at all" throws
`TranscriberUnavailableError`.

### 5.3 The hedge combinator

A new `ribo-core` export beside `firstCapable`, not a flag inside it, so rule 5 stays intact and a
deployment that will not let audio leave the device simply never calls it. The default composition
stays privacy-preserving.

It is **asymmetric rather than roster-shaped**, because hedging has roles that a flat list cannot
express: there is a primary you prefer and a hedge you fire late. It takes a primary, a hedge, a delay
policy, an optional `onHedge` callback mirroring `onFallback`, and an injectable timer for tests. It
returns a `CompositeTranscriber`, so it is drop-in interchangeable with `firstCapable` and
`capabilities()` / `invalidate()` keep working.

**The delay is a function, not a constant** — the host owns the policy, and we have no hardware
numbers to justify shipping a magic value. A helper computes the common case, and its clamp is the
substantive part of this design:

> `delayMs = clamp(predictedMs × factor, floorMs, budgetMs)`

The clamp is not defensive tidiness. The obvious formula — fire after the primary's own predicted
duration — is **wrong**, because it scales the deadline by the device's slowness. On a three-minute
dictation an RTF of 0.5 predicts 90 s and hedges at 135 s, but an RTF of 2.5 predicts 450 s and would
hedge at 675 s: the slower the device, the later the help. `budgetMs` expresses how long the auditor
will actually wait; the prediction only pulls the hedge _earlier_ on fast devices.

This also delimits what hedging is for. It serves the **middle band** — devices that pass the RTF gate
but are sluggish. Below it the primary finishes inside the budget and the hedge never fires; above it
the gate has already routed to managed and there is nothing to race.

RTF is read through a host-supplied accessor on `OnDeviceTranscriber`, so knowledge of what an RTF is
stays in the package that measured it and `ribo-core` never learns the concept.

Resolution, which is where the tests belong:

| Situation                                         | Result                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Primary resolves before the timer                 | Primary. Hedge never fires; no audio leaves the device                                      |
| Timer fired, primary still resolves first         | Primary; hedge result discarded                                                             |
| Timer fired, hedge resolves first                 | Hedge                                                                                       |
| Both already resolved                             | **Primary** — privacy is the tie-break, absent a confidence signal. Rare in practice (§7.1) |
| Primary throws `TranscriberUnavailableError`      | Hedge takes over, primary demoted — same semantics as `firstCapable`                        |
| Primary throws an ordinary error, hedge succeeded | Hedge's transcript                                                                          |
| Both throw                                        | Primary's error propagates; it is the more actionable one                                   |
| Primary not `ready`                               | No race; straight delegation to the hedge                                                   |

Every discarded promise must have a rejection handler attached, or a losing failure surfaces as an
unhandled rejection.

### 5.4 Composition

`firstCapable` returns a `CompositeTranscriber`, so it nests inside `hedged`. The intended shape when
several on-device engines exist is a `firstCapable` roster as the primary with the managed engine as
the hedge. The host's choice between sequential and racing is a one-line change at the composition
site; nothing downstream of the `Transcriber` seam is aware of which was chosen.

## 6. Why Azure AI Speech Fast Transcription

`02` left the vendor open between Azure AI Speech Fast Transcription and Azure OpenAI transcription.
This closes it in favour of **Fast Transcription**, on two grounds.

**Phrase lists.** Fast Transcription accepts a phrase list to bias recognition toward supplied terms;
Azure OpenAI transcription does not. This matters more than it appears, because the on-device path
already biases vocabulary through a jargon prefix (`worker.ts:524`). A phrase list is the same intent
by a different mechanism, so both engines can share one vocabulary source instead of drifting apart on
exactly the domain terms extraction depends on.

The 2026-08-17 probe supplied unsolicited evidence for this. The test sentence contained "R nineteen",
a standard insulation R-value, and the service returned **"our 19"** — from both the WAV and the WebM,
so it is a vocabulary failure and not a container artefact. That is precisely the class of term the
extractor depends on, mis-heard on the first sentence anyone tried.

Re-running the same audio with a phrase list of eight domain terms returned **"R-19"**. One variable
changed, and the term came back correct — so this is measured, not argued. The parameter is
`definition.phraseList.phrases`, and it exists only from api-version **2025-10-15** onward, which is
the version this design targets. A phrase list is not a refinement here; it is load-bearing.

**Headroom.** Fast Transcription accepts files up to 500 MB and five hours; Azure OpenAI transcription
caps at 25 MB. Neither is the binding constraint (§7), but the larger limit removes a second ceiling
to reason about.

## 7. Audio, container and latency — measured

`02` treats client-side chunking as a given, because of Helix's 10 MB/hop fetch-proxy cap. Both halves
of that premise were tested against the real endpoint on 2026-08-17.

**The container is accepted, so there is no transcode.** A genuine `MediaRecorder` blob — recorded
through real Chromium against a fake capture device, negotiated as `audio/webm;codecs=opus`, the exact
path `Recorder` takes — transcribed at the first attempt. The transcript matched a WAV baseline of the
same audio and carried correct word-level timings. Azure also reported the right
`durationMilliseconds` despite the streaming-style container, which was the specific risk worth
testing: `MediaRecorder` cannot know a recording's length while writing it, so its WebM is not the
ordinary seekable variant decoders are usually exercised against.

**The size figure is worse than estimated, and the cause is our own default.** Measured output was
145,196 bytes for 9 s — about 16 KB/s, or **0.97 MB per minute**. A 10 MB hop is therefore roughly
**ten minutes** of dictation, not the 40+ that typical speech-Opus bitrates would suggest.
`recorder.ts` sets no `audioBitsPerSecond`, so Chromium's ~128 kbps default applies: four to five
times what speech needs.

Chunking therefore stays out of this tranche — ten minutes comfortably exceeds a field dictation. But
the margin is thinner than `02` implies, and it is worth recording which way it can be widened:
setting `audioBitsPerSecond` to roughly 32 kbps would restore the 40-minute figure, shrink queued
blobs in IndexedDB, and cut upload time on the managed path. That is a change to the recorder rather
than to this tranche, noted here so it is not rediscovered.

### 7.1 Latency

Three runs per clip, same endpoint, same day. "Effective RTF" is wall-clock over audio duration, the
same units the on-device gate uses, so the two paths can be compared directly.

| Audio             | Bytes   | Wall clock | Effective RTF |
| ----------------- | ------- | ---------- | ------------- |
| 9.0 s (WebM/Opus) | 145 KB  | 1.08 s     | 0.12          |
| 9.3 s (WAV)       | 304 KB  | 1.16 s     | 0.13          |
| 2 m 09 s (WAV)    | 4.1 MB  | 5.6 s      | 0.043         |
| 6 m 28 s (WAV)    | 12.4 MB | 9.5 s      | 0.024         |

Connection setup is a steady ~0.27 s; everything else is upload plus service. Longer audio is
_relatively_ cheaper because that overhead amortises. A realistic three-minute dictation lands around
six to seven seconds.

**This changes what hedging means.** At RTF 0.02–0.12 the managed path is roughly one to two orders of
magnitude faster than a sluggish on-device device (RTF 1–3, the band the gate admits). So a hedge that
fires **wins essentially always**, and the positional tie-break in §5.3 is close to unreachable in
practice. Hedging is therefore not a latency optimisation with a privacy side effect; it is a decision
to route audio off-device, and `budgetMs` is the control that governs it.

**These numbers are a floor, not a field figure.** They were taken on an office uplink, and upload sits
inside that wall clock. At the current ~0.97 MB/min a three-minute recording is ~2.9 MB — roughly 5 s
on a 5 Mbps uplink but ~23 s on 1 Mbps, against ~5 s of service time. In the field this is plausibly
**upload-bound at 10–30 s**. Measuring that on a real uplink is deliberately deferred (§9), but it is
the reason the recorder bitrate matters: a 4× smaller upload saves time exactly where it is scarce.

## 8. What changes where

| Package                                | Change                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@azx/ribo-transcriber-ondevice`       | `prime()` measures and persists RTF; `capability()` reports `too-slow` above threshold; an accessor exposes the measured value                                                    |
| `@azx/ribo-transcriber-managed`        | New package: the Azure transcriber, its Helix transport, and chunking if §7 requires it                                                                                           |
| `@azx/ribo-core`                       | New `hedged` combinator and its delay helper. **No change to `Transcriber`, `TranscriberCapability`, `firstCapable`, or the outbox schema**                                       |
| `playground`                           | Compose the real roster. Batch transcription there still runs a `FakeTranscriber` (`QueuePanel.tsx:243`), so this is also where the on-device engine first reaches the batch path |
| `docs/roadmap/index.md`                | Managed STT moves out of "deliberately out of scope"                                                                                                                              |
| `docs/implementation/02-server-stt.md` | Record the vendor decision (§6) and the chunking correction (§7)                                                                                                                  |

## 9. Open questions

**Answered 2026-08-17 — does Fast Transcription accept WebM-Opus?** Yes, measured against the real
endpoint: no transcode, chunking out of this tranche. See §7 for the numbers, and note the bitrate
finding it turned up. The Speech capability is live on the existing AI Foundry resource, so no
provisioning or platform approval gates this work.

1. **What is the calibration clip?** A bundled short speech fixture is deterministic and gives a
   known-duration input; synthesized audio is free but may not produce a representative RTF. A real
   asset in the package is the likely answer.
2. **What are the default `budgetMs` and the RTF gate threshold?** The managed side is now measured
   (§7.1); what is missing is the two numbers that bracket it — on-device RTF on a real Surface Go 3,
   and upload time on a real field uplink. **Both are deliberately deferred rather than blocking.**
   Ship documented provisional defaults with knobs, and let `onHedge` telemetry supply the field data
   rather than a measurement campaign up front. RTF < 1 is the usual hard floor for interactive ASR,
   but the gate is not the same question as interactivity and should sit higher.
3. **Does transformers.js expose per-segment logprobs?** If it does, confidence-based arbitration
   becomes available and the positional tie-break in §5.3 could be revisited. Assume not until
   checked — the stack is already known to withhold timestamps on Moonshine.

## 10. How we will know it worked

- A device whose measured RTF is above threshold reports `too-slow`, and `firstCapable` selects the
  managed engine instead. This is the behaviour that does not exist today at any threshold.
- The managed engine transcribes a real recording end to end through `/_api/fetch/`, with the key
  never present in the browser.
- With hedging composed, a primary that beats the budget produces **no outbound request** — the
  privacy-relevant assertion, and the one worth a test that fails loudly.
- A hedge that fires produces exactly one transcript, and `onHedge` reports which engine won.
- `./check.sh` passes, and the accuracy comparison against the corpus runs as a separate exercise
  rather than a gate on any of the above.
