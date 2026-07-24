# 07 — Testing & Accuracy

Two tracks: ordinary component tests, and the **accuracy harness** — the project's key quality gate, because "how much of what an auditor says is measure-relevant" is the central technical bet.

## Component tests

| Area                  | What to test                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Queue`               | Durability across reload/offline; retry + backoff; ordering.                                                                                                                                             |
| Chunking              | Segments stay under the 10 MB/hop cap; reassembly/ordering correct.                                                                                                                                      |
| Transcriber selection | Capability probe routes on-device vs managed STT correctly; graceful fallback on probe failure.                                                                                                          |
| `Extractor`           | zod validation; retry-on-parse-fail; malformed-LLM-output handling.                                                                                                                                      |
| Adapter               | schema/prompt/write round-trip; write hits the right proxied path.                                                                                                                                       |
| Managed STT path      | Proxy call to the Azure STT endpoint returns a usable transcript; key injected server-side; chunking under the 10 MB cap. (Only if a custom STT service is later built: its cold-start / scale-to-zero.) |

### Durability cannot be tested through the thing whose durability you are testing

The obvious durability test is **write → close the database → reopen → read it back**. That test **passes against a purely in-memory storage backend**, so on its own it proves nothing.

Verified, not assumed, while building the outbox ([09](09-offline-first.md)): swapping `getRxStorageDexie()` for `getRxStorageMemory()` left _every_ close/reopen assertion in `queue/outbox.browser.test.ts` green. RxDB's memory storage keeps a **module-global store keyed by database name**, and `close()` does not clear it — so "reopen" hands back the same heap objects and the round trip never touches a disk. The same trap is waiting behind `fake-indexeddb` in jsdom, and behind any storage layer with a process-lifetime cache.

**The rule it generalizes to: a persistence claim has to be checked by something that does not share the persistence layer's memory.** Here that means reopening the underlying IndexedDB database directly with `indexedDB.open`, reading the `docs` and `attachments` object stores with no library in the call stack, and comparing the attachment bytes to what was written. It is knowingly coupled to an RxDB storage-layout detail (`rxdb-dexie-<db>--<version>--<collection>`), and that coupling is the price of an assertion our own code cannot satisfy by accident — under memory storage the database does not exist and the read throws. It also requires real browser mode: this is exactly the assertion jsdom cannot tell the truth about.

## The playground is a testing tier, not a demo

[10 §7](10-build-and-packaging.md) lists three tiers: unit, browser, and pack-and-consume. There is a
fourth, and it is the `playground/` app: **consuming our own published surface the way a host app
would.** It is distinct from the others by what it exercises — not "does this function return the
right value" (unit), not "does this work against a real browser API" (browser), not "does the tarball
resolve" (pack-and-consume), but **is this API usable, and does it behave when driven by a UI**.

The evidence is direct. Within one session of existing, the playground found an API race that unit
tests, browser tests, `tsc` and **four independent design reviews** had all missed. Nothing was wrong
with those gates; they were simply all looking at the package from the inside, and this was the first
code to look at it from the outside.

**The mechanism generalizes, so it is worth stating plainly: tests construct an item and immediately
`await` it; a UI subscribes to a stream and renders whatever arrives first.** An awaiter cannot see an
ordering or visibility bug, because awaiting collapses the window in which the bug exists — by the
time the promise settles, the state is correct. A subscriber renders the intermediate frame. So:
**async-visibility bugs need a subscriber, not an awaiter**, and no amount of `await`-shaped test
coverage will substitute. If a behaviour is observed through a stream in production, at least one test
must observe it through a stream too.

**Playground findings are real defects.** The temptation, when the only thing that reproduces a bug is
the dev app, is to file it as a harness quirk and move on. That is backwards: the playground is closer
to how the SDK will actually be used than any of our tests are, so a bug that only it can see is a bug
that only **hosts** will see. Fix it in the library, and — where the mechanism allows — add the
subscriber-shaped test that should have caught it.

## Accuracy harness (the gate)

- **Corpus (PoC — synthetic, see below):** the intended corpus is real home-energy audit dictation clips, each paired with a hand-checked reference transcript **and** the expected field values. That is **not what we have**. For the PoC the corpus is the 14 synthetic transcripts in `spikes/extraction-snuggpro/` plus the proposed TTS-synthesized audio built from them ([01](01-feasibility-spike.md)).
- **Scores:** transcription WER (per transcriber/model), and — more important — **field-level extraction accuracy / measure-relevance** end to end. Because structured outputs guarantee _shape_, failures are now purely **semantic** (wrong value) rather than a mix of semantic and format noise — so the numbers mean something.
- **Tooling:** Helix's OpenAI-compatible route means off-the-shelf eval runners work against it — we can score extraction runs with existing tools instead of hand-rolling a harness runner.
- **Use:** tune the extraction prompt and the bounded field set against real speech; catch regressions; produce the numbers that back the benefit case.

## Hard line: no production code against assumptions — **consciously traded for the PoC (2026-07-23)**

The stated rule (design spec §10): **get the client recording real home-energy audits now, before build**, to seed this corpus. Design/scaffolding/tests can proceed; production behaviour is not validated against a toy dataset.

**We are overriding that rule for the PoC, deliberately.** The in-home recording-consent path (the client's policy — design spec §10) is **deferred, not resolved**, and it is not ours to unblock. Waiting on it would stall the build entirely, so we are trading the hard line for PoC velocity and building against a synthetic corpus.

This is written down rather than quietly dropped **because the team set that rule itself**. It should be visible to anyone reading later that the line was overridden on purpose, with a known cost, and not simply forgotten. The cost is real: every accuracy number the PoC produces describes behaviour on clean synthetic input.

What that buys, and what it does not:

- The extraction numbers in `spikes/extraction-snuggpro/` are **a floor, not a forecast.** They are scored on authored text, not on speech. Real audio arrives through Whisper at some WER, in HVAC jargon it was never fine-tuned on, next to a running furnace. Real accuracy will be lower.
- The proposed TTS-synthesized audio path ([01](01-feasibility-spike.md)) extends the reach of the synthetic corpus to a genuine **end-to-end** measurement — including the transcription→extraction interaction nothing has tested — but TTS audio is cleaner than field speech, so it too is a floor.
- Nothing synthetic tells us how the system behaves on disfluent delivery, cross-talk, mic handling or attic acoustics. Those are exactly the conditions the product ships into.

### The real-recording gate (before field use, not before build)

Real-recording validation is **not cancelled — it is moved.** It was a gate before build; it is now a **gate before field use**.

**Nothing goes in front of a real auditor on a real home visit until the accuracy harness has been run against real home-energy audit recordings, with real consent.** That is a blocking gate, it is owned (the client for the consent path; AZX + the client for the harness run), and it is recorded here and in [08](08-risks-and-sequencing.md) so it cannot be silently skipped once a synthetic-corpus PoC is demoing well. The most likely way this project ships something wrong is that the PoC looks good on clean data and this gate quietly never happens.

## Size & open items

- **Size:** **S** to scaffold the harness, then cross-cutting / ongoing.
- **Open:** the in-home **recording-consent path** (design spec §10, [open questions §8](../open-questions.md)) — **deferred**, owned by the client. Downstream of it: who collects the recordings and how many.
- **Open:** building the TTS-synthesized audio path ([01](01-feasibility-spike.md)) — proposed, not implemented.
