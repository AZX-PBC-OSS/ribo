# Ribo — Roadmap

Ribo is a browser-side, offline-first pipeline for turning an unstructured capture — a dictation, a
PDF, later a photo — into structured, checkable data in a system of record, with a human in the
loop: transcribe the capture, extract structured fields from the transcript, let a human review and
accept them, then write the result back into a host tool through a thin per-tool adapter. Snugg Pro
is the reference adapter — home-energy audits — not the subject. The library lives in this repo; the
consuming field app lives in a separate repo and is not built here.

This directory is the project's roadmap — the design specs and per-phase plans, committed as records
of what was planned and why. It is excluded from the published docs site (via `srcExclude` in
`docs/.vitepress/config.ts`), but tracked in the repo for anyone working on the code.

## What has shipped

**Phases 0–4** built a working capture → transcribe → extract → review pipeline, in this order:

- **Phase 0** — pnpm workspace, three package skeletons, playground, lint/typecheck/test, `AGENTS.md`.
  → [plan](phases/phase-0-foundation.md)
- **Phase 1** — core contracts in `@azx/ribo-core`: the provenance envelope (`extractedSchema`,
  `isSpanGrounded`), `Recording`/`Transcript`, the `Transcriber` contract, `ToolAdapter<F, C>`, and the
  review contract. → [plan](phases/phase-1-contracts.md)
- **Phase 2** — real audio capture (`MediaRecorder`) and the durable RxDB-backed outbox with its
  per-item state machine. → [plan](phases/phase-2-capture-and-queue.md)
- **Phase 2.5** — offline app load: a service worker precaching the shell, storage persistence, and
  eviction handling. → [plan](phases/phase-2.5-offline-app-load.md)
- **Phase 3** — on-device transcription: Whisper via `@huggingface/transformers` in a Web Worker, in a
  new `@azx/ribo-transcriber-ondevice` package. → [plan](phases/phase-3-ondevice-transcription.md)
- **Phase 4** — extraction and review: the pluggable `Extractor<F>` seam, the single-shot managed-LLM
  extractor (`@azx/ribo-extractor-openai`), field-level review, and the write-back scaffold (gated on
  Helix egress signing). → [plan](phases/phase-4-extraction-writeback.md)

**R1 — package build configs** gave all five publishable packages real tsdown builds producing
`dist/`, plus gates that prove the artifact is valid for a consumer: publint and attw in-build, a
source-condition resolver assertion, and tarball/duplicate-React checks. All five build, gated by
`./check.sh`. → [design](design/r1-package-build-configs-design.md) ·
[plan](phases/r1-package-build-configs.md)

**R1.5 — field-shape contracts** split `ToolAdapter<F, C>`'s one type
parameter, which was doing two incompatible jobs, into a declared writable patch (`V`) and an
extraction schema **derived** from it (`Enveloped<V>`, via `enveloped()`), so the extractor's
provenance-envelope needs and `write`'s plain-value needs stop fighting over one shape. Review now
addresses flat dotted leaf paths, not top-level keys — so a nested group of tests like Snugg Pro's
`health` no longer collapses to one envelope and one verdict for every test in it — with each leaf's
own zod schema carried on `ReviewField` for rendering and submit-time validation, and submission
completeness enforced at runtime. `toWriteStep(adapter)` installs the `schema.parse` trust boundary
that write-back had documented but never actually wired to anything, resolving `ctx` per item from
`item.recording.ctx`. A frozen JSON Schema fixture proves the model is asked for byte-identically
what it was asked for before. → [design](design/r1.5-field-shape-contracts-design.md) ·
[plan](phases/r1.5-field-shape-contracts.md)

The original design spec (D1–D10 decisions, architecture, data flow, risks) is at
[design/ribo-design.md](design/ribo-design.md). The docs-site plan is at
[phases/docs-site.md](phases/docs-site.md).

**R2 — the headless hook layer** populated `@azx/ribo-ui-react`, which had been a one-line
`PACKAGE_NAME` stub since R1 gave it a real build with nothing in it. Phase A closed the gap R2
surfaced while planning the hooks: core carried a complete, tested review vocabulary
(`buildReviewRequest`, `resolveReview`) that nothing called, because the relay went straight from
`extracting` to `writing`. Review is now a real gate — an item parks at `awaiting-review` (deliberately
absent from `ACTIVE_OUTBOX_STATUSES`, so the relay drains past it rather than stalling), a persisted
`ReviewOutcome` records the human's decision, and `Outbox.submitReview` is the only way out, to
`writing`. The pipeline is now
`queued → transcribing → extracting → awaiting-review → writing → done`. Phase B built `RiboProvider`
and six hooks over the core engine — `useRecorder`, `useOutboxItems`, `useReview`, `useConnectivity`,
`useWorkSafety`, `useStoragePersistence` — respecified against R1.5's leaf-path review contract
(no generic `F`; the adapter's values schema is passed at the call site instead). Phase C migrated the
playground onto the hooks, built the interactive review card (`ReviewPanel`, gated on every ungrounded
leaf being actioned), restored the two e2e specs the gate had made temporarily unreachable, and
corrected the AGENTS.md statements R2 itself falsified. → [design](design/r2-headless-hook-layer-design.md) ·
[plan](phases/r2-headless-hook-layer.md)

**R3 — the pack-and-consume test tier** closed the one gap every other gate in this repo shares:
the playground resolves every workspace package through the `@azx/source` condition and never
touches `dist/`, so a worker that cannot spawn, a `default` export pointing at a path that does not
exist, or a `dependencies` entry that got dropped were all invisible to `./check.sh`. R3
(`pnpm test:pack-and-consume`, `scripts/pack-and-consume/`) packs all five publishable packages with
`pnpm pack`, installs the tarballs as `file:` dependencies into a fresh app built from scratch in a
temp directory **outside this repository** (so nothing can silently fall back to a workspace link),
runs that app's own production Vite build, and drives a real headless Chromium against it —
asserting that `@azx/ribo-transcriber-ondevice`'s published `./worker` entry spawns and primes a
tiny real ONNX Whisper fixture (`Xenova/tiny-random-WhisperForConditionalGeneration`, proving the
ONNX Runtime WASM backend genuinely initializes), and that the other four packages resolve, bundle
and run correctly from their tarballs too — including one that composes two of them
(`@azx/ribo-extractor-openai` built against `@azx/ribo-adapter-snuggpro`'s schema) across the tarball
boundary. Deliberately its own CI step rather than a `./check.sh` stage (AGENTS.md §7): it is slow
and writes outside the repo, but unlike the acceptance gate it needs no secret, so it still runs on
every push rather than becoming a gate nobody runs.

**Group provenance granularity** let a group declare the unit its citations are attached to, and
derived the extraction schema from that declaration rather than from a second hand-written schema.
`enveloped()` wrapped every leaf in `{ value, confidence, sourceSpan }`, which is right for a field
a human verifies one at a time and wrong for a wide table: a Manual J `componentLoads` table of
67 rows x 9 leaves cost 603 verbatim citations no reviewer will click, and partitioned across two
calls to deliver them. A group may now declare `"row"` (plain leaves, one span per row) or `"none"`;
`"leaf"` remains the default and is byte-for-byte unchanged, which the frozen Snugg fixture proves.
The measured payoff is one call instead of two on a 15-leaf room set, with 14/14 verbatim row spans
where per-cell citations were 37% fabricated. `splitExtractionSchema` now partitions on nullable
unions rather than leaf count — the two units coincide exactly while every leaf is enveloped, so no
existing partition boundary moved — because a leaf count would split a 15-leaf row group for no
gain. → [design](design/group-provenance-granularity-design.md)

**Phased extraction** made a multi-pass strategy a value instead of a bespoke loop: a phase is
`plan`/`run`/`merge` over a shared draft, and the `phasedExtractor` engine owns the scheduling,
per-item retry, cancellation, deadline, unit stream and closing parse that every one of them had
hand-rolled — the on-device monolith carried four retry loops, `instance-fill.ts` a fifth, and the
copies had drifted. All three multi-pass strategies (`gapFillExtractor`, `scopedInstanceExtractor`,
`threePhaseExtractor`) are now presets over the engine, their option names held; `retryExtractor`
and `timeoutExtractor` landed alongside as wrappers over any `Extractor`. The program's one
outstanding item is the manual acceptance-gate run. →
[design](design/phased-extraction-design.md) · [acceptance gate](design/phased-extraction-acceptance.md)

## What is next

The post-Phase-4 work is organized as tasks **R1–R5** and **F1**, defined in a Voice-to-Text MVP
design that is not in this repo. R1.5 was inserted between R1 and R2, surfaced while planning R2's
review hook. R1, R1.5 and R2 are all done; the rest proceed in dependency order:

1. **R1.6 — Snugg Pro API alignment. _Largely done (2026-08-06)._** The adapter's field set was
   reverse-engineered from Snugg Pro's public **printed field sheet**; the machine-readable spec later
   showed that model to be wrong in several places, and `schema.ts` has now been rebuilt from the spec
   directly. What that closed: the wire property names are the schema's keys, the enum members are the
   spec's literal strings, the shape nests by write endpoint, the health matrix is **13** tests,
   `hvacSystemEquipmentType` is one field for heating and cooling both, `hvacUpgradeAction` is
   extracted rather than hard-coded, attic R-value is a real write target (so the
   `atticInsulationSpokenRValue` holding pen is gone), and `combustionVentType` is dropped for having
   no write target. [Doc 17](../implementation/17-snuggpro-field-reconciliation.md) has the
   field-by-field mapping and verbatim enum lists behind it (the spec turned out to be public, not
   vendor-private — see doc 15's amended redaction note).
   **What remains under R1.6:** choosing the next field tranche (51 leaves of a 163-field capture
   surface — see the fill-rate open question below), instance/cardinality modelling, and re-annotating
   the spike corpus so extraction quality is measured against this vocabulary rather than the old one.
   → see also R1.7, which mechanises the parts of this that should not be hand-maintained.
2. **R1.7 — generate the base types (`pnpm snugg:refresh`).** A script that regenerates wire field names
   and leaf types from the spec into a committed `*.generated.ts`, following the `pnpm target:refresh`
   precedent exactly: thin script, real logic in a typechecked and unit-tested module, deliberately not
   run by CI so a vendor change lands in a reviewable diff. **Enum vocabularies are deliberately out of
   the first cut** — see "Open questions" below. The frozen JSON Schema fixture already means a
   regeneration cannot silently change what is sent to the model: it goes red and a human looks.
3. **R4 — publishing.** Versioning is live: the Release workflow opens a version PR from pending
   changesets, and merging it tags each bumped package and creates a GitHub release (first release
   0.1.0, 2026-11). **What remains is the registry:** choose one and confirm the scope is ours (the
   `@azx` npm scope is unverified; the Helix CLI publishes as `@azx-pbc`), add the `.npmrc`, settle
   `publishConfig.access`, and swap the workflow's `publish-script` to `pnpm changeset:publish`.
   **Blocker to clear before the first publish: the nine package READMEs link to the docs with
   repo-relative paths** (`../../docs/guide/*.md`). Those resolve on the forge and are correct
   there today — a deliberate choice, since no deployed docs origin exists to point at yet — but
   a published README is rendered from the tarball root, where `../../docs` does not exist, so
   every one of those links 404s on npm. Decide at publish time: rewrite them to absolute
   `github.com/AZX-PBC-OSS/ribo/blob/main/docs/...` URLs (works everywhere, no dependency on a
   docs deploy), or to the docs site's own URLs if one is live by then. Roughly 20 links across
   nine files; `pnpm docs:build` does **not** check them, so whichever is chosen needs a manual
   pass. Surfaced by the docs repositioning pass (see
   [design](design/docs-repositioning-design.md)).
4. **R5 — correct the docs the newer decisions falsify.** Doc 10 §3.1's Vite-library-mode mandate and
   doc 04's styled-components design are superseded by the tsdown-for-all and headless-hook-layer
   decisions; R5 rewrites them (and finishes what R1.5 left it: doc 04's `ReviewCard` example and the
   rest of its now-superseded `run<F>`/`ReviewPresenter` shape). Also covers any AGENTS.md statements
   R1–R4 have made false — including, per R3, AGENTS.md §3 / §7's now-stale "the app is compiled,
   never executed, there is no runtime smoke test" claim, which predates the `e2e` Vitest project
   `./check.sh` already runs and reads as though R3's tier were the first to execute anything.
5. **F1 — the field app** (separate repo). The deployed Helix app that composes the published packages.
   Not built here; the `playground/` app is this repo's stand-in for a consumer.

## Open questions and findings pending action

Discovered while building R1.5 and investigating the Snugg Pro API. Recorded here so they are decided
rather than rediscovered.

- **Vocabulary: "contract" replaces "seam", and "plasmid" goes away. Decided 2026-09-11; the code
  has not caught up.** A prose pass over the published docs cut both terms from the package
  READMEs — "plasmid" is internal shorthand a newcomer cannot decode, and "seam" is vaguer than
  "contract" for what `Transcriber`, `Extractor` and `ToolAdapter` actually are. The maintainer
  confirmed the library should follow, but not urgently. What still uses the old words:
  `AGENTS.md` (§6.1 defines the `ribo-<category>-<variant>` scheme in terms of plasmids, and
  "seam" recurs throughout), doc comments across `packages/*/src`, and the design docs in this
  directory. None of it is user-facing, which is why it can wait — but a split vocabulary between
  the published docs and the repo's own notes is exactly the kind of drift this project keeps
  having to correct, so it should not wait indefinitely. No identifier changes are implied: this
  is prose only.

- **Correction (2026-09-10): extraction, review and write moved off the recording.** Earlier entries
  in "What has shipped" above (R2 in particular) describe one state machine and name
  `Outbox.submitReview` / `Outbox.reopenForReview` — accurate when written, and left as-is; they are
  historical records, not current API. The session-ownership work since then split the pipeline into
  two persisted state machines: a recording (`OUTBOX_STATUSES`, capture and transcription only) and a
  session (`SESSION_STATUSES`, extraction through write-back). The current methods are
  `Outbox.submitSessionReview` and `Outbox.reopenSessionForReview`; see
  `packages/ribo-core/src/queue/schema.ts` and `session-schema.ts` for the two status lists.
- **~~Do we ask the model for Snugg's literal enum strings, or keep readable tokens and map?~~
  Answered: literal strings (2026-08-06).** The schema now asks the model for `"6% - Well sealed"` and
  `"Not Tested"` directly, which deletes the per-enum translation layer rather than planning it, and
  fixes the membership divergences a string map could never have covered. **What this cost, stated
  plainly:** the decision was made on design grounds, not measured ones. The ≈0.5%-hallucination and
  75/75-enum figures were produced against the old snake_case vocabulary and no longer describe this
  adapter — see the corpus item below. The bet is that a model reproducing a listed literal string is
  no harder than a model reproducing a listed token; that bet is untested, and the corpus is how it
  gets settled.
- **~~Which model family, and which extraction strategy, for the managed path?~~ Answered:
  OpenAI-family, `perGroupExtractor` (2026-09-08).** A spike ported the on-device three-phase
  strategy onto the managed transport to see whether it should replace `perGroupExtractor` as the
  vehicle for scaling past today's 51-leaf schema. It is NO-GO on quality and cost at current
  scale, but it surfaced the real constraint: on this route, Anthropic-family models reject any
  response schema with more than 16 nullable unions (8 enveloped leaves per call) — `hvac` (12
  leaves) and `health` (14 leaves) are already over that today, invisible only because the managed
  path has always run an OpenAI model in practice. Decision: pin managed extraction to
  OpenAI-family models (matches what's deployed); partition `hvac`/`health` to ≤8 leaves anyway, as
  groundwork for a possible Anthropic-compatible path later rather than in response to a live
  break. → [doc 21](../implementation/21-managed-three-phase-extraction.md).
- **Job collections beyond `basedata` are now curated.** 837 distinct writable wire fields exist
  across the whole API; 293 are `basedata`'s, 544 are not. Under a broad dictation-plausible stance,
  378 of those 544 are candidates, organized into 18 build tranches. Findings that change the
  `basedata` playbook: the `*Improved`-field exclusion rule doesn't transfer (some `Improved`-side
  fields carry primary information, not retrofit echoes), most repeating resources have no instance
  label at all (worse than a matching problem), and `recDefinitionId` has no listing endpoint —
  recommendations cannot be created via the API regardless of extraction quality.
  → [doc 20](../implementation/20-job-collections-field-reconciliation.md).
- **The spike corpus no longer grades this adapter, and the acceptance gate is blocked.**
  `docs/spikes/0001-extraction-snuggpro/ground-truth/*.json` is hand-annotated in the old flat, snake_cased field
  set. `packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts` runs the current adapter against it,
  so every field would score as a miss; a guard now fails that run with an explanation rather than
  emitting meaningless numbers. Unblocking means re-annotating 14 transcripts in the API vocabulary —
  manual, and the reason those baselines are trustworthy. Until then there is **no current measurement
  of extraction quality**.
- **Entity identity is the sharpest unresolved risk.** Our field set is singular — "the attic", "the
  heating system" — while the API models components as per-instance resources and real houses have
  several of each. Extraction can be perfectly typed and still write the upstairs furnace's value onto
  the basement boiler. Doc 15 §1 has the resource model and the realistic write sequence; nothing
  implements it. This lands at write-back time, which is the most expensive moment to discover it.
- **Custom fields exist and cannot be enumerated at build time.** The API attaches per-account custom
  fields with their own type/bounds/options metadata. The likely shape is a generated static base schema
  plus a runtime-discovered overlay, cached and available offline — not a wholly dynamic adapter.
  → [doc 17 §4](../implementation/17-snuggpro-field-reconciliation.md#4-custom-fields--confirmed-present-and-they-matter).
- **Whole-spec extraction is closed, on hard limits rather than quality.** The combined job-data schema
  is ~1,326 leaves, which after provenance-enveloping is ~5,360 properties against OpenAI's documented
  5,000 cap, and ~1,490 enum values against the 1,000 cap. The `basedata` subset does fit (~1,201
  properties) but is ~9× the current pilot. Recorded so it is not re-proposed.
  → [doc 16](../implementation/16-extraction-schema-scale.md).
- **Choose the next field tranche from real fill-rate data, not judgement.** The pilot's bounded field
  set is now justified rather than assumed — `basedata` is 294 fields, but 122 are `*Improved` retrofit
  proposals an auditor does not dictate during a walkthrough and 9 are auto-calculated by Snugg Pro
  itself, leaving a **163-field capture surface** (doc 17 §Scoping). What is still unknown is which of
  those 163 anyone actually fills in. Two cheap sources answer it: the 14-transcript corpus says what
  auditors _say_, and the API says what real jobs _contain_. Do that before picking the next tranche.
- **~~`Outbox.reopenForReview(id)`. Two places now point a reader at a raw `patch` back to
  `awaiting-review`, which the relay's own tests describe as "exactly the shape a bug in it would take".
  The only documented recovery path is the one we tell people never to take.~~
  Answered: added (2026-08-07).** `Outbox.reopenForReview(id)` is the supported replacement; both raw-
  `patch` advisory sites (`write-step.ts`, `relay.ts`) now name it instead. It accepts only `dead` as a
  source status, requires both `extracted` and a `transcript` (a review needs both — `buildReviewRequest`
  takes both, and `isSpanGrounded` checks spans against the transcript), and clears the stale
  `reviewOutcome` so a later `submitReview` cannot merge a decision nobody just made. **What this did not
  close:** the new method gives the state machine a cycle (`dead → awaiting-review → writing → dead → …`),
  which exposes both its own guard and `submitReview`'s to a narrow ABA race under a suspended-then-resumed
  caller. Documented in `outbox.ts`'s own doc comment — with the concrete sequence required and why it is
  judged unlikely on this project's actual browser targets today — rather than closed with a persisted
  generation token; that field's schema cost is not the reason, the API-shape cost landing on every future
  caller is.
- **Cross-tab relay leader election.** Pre-existing, not introduced by R2: `multiInstance: true` with no
  leader means two tabs can process the same item, and `database.ts` explicitly defers it.
- **The API host is wrong in four docs.** `ribo-design.md`, `06-field-app-helix.md`, `09-offline-first.md`
  and `05-adapter-snuggpro.md` name `https://api.snugg.pro`; the spec's `basePath` is
  `https://api.snuggpro.com/`, which doc 12 and the adapter's own tests already have right. Doc 06
  specifies the Helix egress `fetch.origins` allowlist from the wrong one — a domain we do not control.
- **`minimum`/`maximum` may no longer be forbidden.** `provenance.ts` asserts strict structured-output
  mode rejects them, which is why `confidence` is a bare `z.number()`. Current OpenAI documentation
  lists them as supported for non-fine-tuned models. If that is stale, our schema is more constrained
  than it needs to be — worth one engineer's re-check. → [doc 16 §1](../implementation/16-extraction-schema-scale.md#a-discrepancy-worth-an-engineers-re-check-not-treated-as-settled-here).

## Deferred until write-back unblocks — the MVP cut (2026-08-06)

**The MVP was R2 Phase B + C: the hooks and the review card — now shipped.** Capture, the durable
outbox and relay, on-device transcription, real extraction, the review gate and card, and the write
trust boundary all ship and gate green, e2e included. The loop runs end to end up to the write itself,
which stays stubbed behind the Helix egress ask below — the human can review and submit; only the
actual write to Snugg Pro is gated off.

**Every remaining Snugg Pro item is downstream of a dependency we do not control.** Write-back is gated
on the Helix egress HMAC ask (A1, `docs/implementation/13-helix-platform-asks.md`), so work that makes
a write _correct_ cannot be exercised, demoed, or validated. Deferred until that unblocks:

- **~~R1.6 — the doc 15 delta list.~~ Done ahead of the cut (2026-08-06).** The schema-shape half was
  cheap enough to take now and it removes a whole translation layer from the write that lands later;
  see item 2 above for what it closed. What is still deferred is everything that needs a real write or
  real data to settle: the next field tranche, instance modelling, corpus re-annotation.
- **R1.7 — `pnpm snugg:refresh`.** Tooling with no user-facing value until the field set grows.
- **Instance modeling.** Correctness of a write that cannot happen yet.
- **Re-annotating the spike corpus.** Needed to measure extraction against the new vocabulary; manual,
  and not on the MVP path. See the open question above.
- **The schema-generation spike.** Its _design_ is committed (`docs/spikes/0004-schema-generation/`) and
  deliberately not run — the question is preserved without spending on it.

**What makes deferring safe: the review card is schema-driven.** It renders and validates from
`ReviewField.schema`, so when R1.6 later corrects an enum or adds a field, the UI adapts with no
rework. Schema churn does not invalidate UI work — which is exactly why the UI goes first.

**The known-wrong parts are all invisible to the MVP loop.** The pilot ships 51 hand-written leaves
that now use the API's own names and vocabulary, so the translation problem that used to sit at the
write boundary is gone. What remains wrong is coverage (51 of ~163 capture fields) and cardinality
(one instance per component where the API models many) — both of which only bite at the moment of
writing, which is stubbed.

**What we gave up to get there, and it is not nothing.** The extraction-quality numbers
(≈0.5% hard hallucination, 75/75 enums correct) were measured against the previous vocabulary and do
not describe the current adapter; the acceptance gate that produced them is blocked until the corpus is
re-annotated. The MVP loop does not depend on that number — the review card is where a bad extraction
gets caught, and it is exactly what is being built — but "extraction is measured" is a claim this
repo cannot currently make.

## What is deliberately out of scope

So nobody re-litigates it:

- **Snugg Pro write-back and the request-signing it depends on.** Write-back is scaffolded behind the
  `WriteStep`/`ToolAdapter.write` seam but gated OFF pending Helix egress HMAC-SHA256 signing (A1 in
  `docs/implementation/13-helix-platform-asks.md`). Do not fake the signing to green a demo.
- **~~The managed STT fallback.~~ Built (2026-08-17.)** Azure AI Speech Fast Transcription behind the
  `Transcriber` seam, plus the measured real-time-factor gate that makes it reachable — before it,
  `capability()` judged readiness on cached weights alone, so a slow device always reported `ready`
  and the fallback could never be selected at any threshold. See
  [Managed Transcription — Design](design/managed-transcription-design.md). What is **not** built:
  the Helix `azure-stt` connection itself (development runs against a same-origin dev endpoint that
  holds the key server-side), and live preview on the managed path, which no gateway WebSocket makes
  possible.
- **iOS on-device transcription.** Phase 3 targets evergreen Chromium with WebGPU. iOS/Safari support,
  engine sniffing, and the WASM single-threaded path are deferred.

## Design documents

- [Ribo — Design](design/ribo-design.md) — the original design spec: D1–D10 decisions, architecture,
  data flow, Helix integration, offline-first, risks.
- [R1 — Package Build Configs — Design](design/r1-package-build-configs-design.md) — the R1 design:
  one build tool (tsdown) for all five packages, the generated Baseline syntax floor, and the package-
  contract gates.
- [R1.5 — Field-Shape Contracts — Design](design/r1.5-field-shape-contracts-design.md) — the R1.5
  design: one declared values schema, a derived extraction schema, and leaf-path review.
- [Group Provenance Granularity — Design](design/group-provenance-granularity-design.md) — R1.5's
  derivation, extended so a group can choose the unit its citations attach to: `"leaf"` (unchanged,
  and the default), `"row"` (plain leaves, one span per row) or `"none"`. Records why the per-call
  cap had to start counting nullable unions rather than leaves, why the group/envelope test moved to
  `isExtractedSchema`, why a row's citation is shared by its fields in review rather than getting a
  node kind of its own, and the one open question — whether review should derive the granularity
  instead of being handed it (§9).
- [R2 — Headless Hook Layer — Design](design/r2-headless-hook-layer-design.md) — the R2 design: the
  review gate in the outbox state machine, pause/resume, and the six hooks plus provider that make
  `@azx/ribo-ui-react` real.
- [Durable Capture — Design](design/durable-capture-design.md) — making audio durable _during_ capture
  so a crash partway through a recording stops losing all of it: chunk attachments named from an
  immutable `capture.sourceId`, Web Locks for cross-tab exclusion, and a rotating `capture.owner` token
  for write authorisation. Revision 8. Its [plan](design/durable-capture-plan.md) is 12 tasks, of which
  2 and 3 have landed; **Task 1, the bfcache spike that decides whether the write fence defends a real
  path, has not run.**
- [Live Transcription — Design](design/live-transcription-design.md) — utterance-level preview while the
  auditor is still dictating, delivered through the existing reactive outbox rather than a new API.
  **Blocked on durable capture**, and carrying two unresolved problems of its own (worker contention,
  and what must survive a VAD feed boundary).
- [Managed Transcription — Design](design/managed-transcription-design.md) — the transcription path for
  devices that cannot run the model, or cannot run it fast enough: a measured real-time-factor gate in
  `prime()`, a managed Azure AI Speech engine behind the fetch-proxy, and an opt-in `hedged` combinator
  that races the two on a latency budget. Nothing external blocks it — unlike write-back, the
  `azure-stt` secret is a plain header injection. Container support, latency and the phrase list are
  **measured against the real endpoint**, not assumed (§6, §7). Its
  [plan](design/managed-transcription-plan.md) is 8 tasks, none started.
- [Photo Capture and Image Transcription — Design](design/photo-capture-design.md) — capturing a
  photo of a nameplate or meter face and transcribing it to text on-device, flowing through the
  existing `extract → review → write` pipeline unchanged. Two candidate engines — Chrome's Prompt
  API with multimodal image input, and transformers.js with a small vision model over WebGPU —
  compose via `firstCapable` / `fallbackTranscriber`. **Pre-measurement**: the design recommends
  measuring image-input availability, download size, latency, and nameplate accuracy before
  building, and does not state any of those as facts.
- [Docs Repositioning — Plan](design/docs-repositioning-plan.md) — the sixteen-task execution plan
  for the design below, in four shippable tranches. Also the record of four pieces of stale prose
  found while planning it, the substantive one being that the pipeline is now **two** state
  machines (recording and session), not the single one AGENTS.md §1 still describes.
- [Docs Repositioning — Design](design/docs-repositioning-design.md) — retiring "voice-capture SDK"
  for what the library actually became: a structured-extraction pipeline for any capture. Records
  the answer to "why not Docling or Mistral directly" (a category error — they plug into the
  `Transcriber` seam), a TanStack-shaped information architecture with a Comparison page that marks
  Ribo down where it loses, the honesty rails for the three things that are not finished (npm
  publication, extraction measurement, write-back), and why `Transcriber` keeps its name.

## Phase records

- [Phase 0 — Foundation](phases/phase-0-foundation.md)
- [Phase 1 — Contracts](phases/phase-1-contracts.md)
- [Phase 2 — Recorder + Queue](phases/phase-2-capture-and-queue.md)
- [Phase 2.5 — Offline App Load](phases/phase-2.5-offline-app-load.md)
- [Phase 3 — On-Device Transcription](phases/phase-3-ondevice-transcription.md)
- [Phase 4 — Extraction + Write-back](phases/phase-4-extraction-writeback.md)
- [R1 — Package Build Configs](phases/r1-package-build-configs.md)
- [R1.5 — Field-Shape Contracts](phases/r1.5-field-shape-contracts.md)
- [R2 — Headless Hook Layer](phases/r2-headless-hook-layer.md)
- [Docs Site + OSS Front Door](phases/docs-site.md)
