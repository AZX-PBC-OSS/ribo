# Docs Repositioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire "reusable voice-capture SDK" across every front door and replace the mostly-stub
docs site with real content describing what Ribo became — a browser-side, offline-first pipeline
that takes any capture through extraction, verifiable provenance, human review and write-back.

**Architecture:** Four tranches, twenty tasks, each independently shippable and each leaving the
site coherent and `pnpm docs:build` green. Tranche 1 lands the argument (home, overview,
motivation, comparison, README, AGENTS). Tranche 2 lands the on-ramp. Tranche 3 publishes the moat
evidence, writes the eleven concept guides moat-pages-first, and hardens the Comparison page
against it. Tranche 4 cleans up: package READMEs, deep dives, the design section, the generated
Reference's doc comments, and the removal of `capabilities/` behind a link audit.

**Revision, after external review.** Task 1 is complete (commit `44e7e0f`). A cross-family review
then found nine factual errors — all verified true — and two structural gaps. Four tasks were added
in response and are marked **"Added after review"**: **1A** (accuracy disclosure and the
`capabilities` nav removal, pulled forward out of Tranche 4), **5A** (deep dives for the moat
evidence, which previously had nowhere to live), **7A** (widening the Comparison set and adding the
rows Ribo loses), and **15A** (auditing the doc comments the generated Reference is built from).
The must-fail grep in Global Constraints was also unsatisfiable as first written; see the note
there.

**Tech Stack:** VitePress 1.6.4, TypeDoc (`pnpm docs:api`), a generated accuracy page
(`scripts/generate-accuracy-page.mjs`), Prettier at 100 columns, pnpm workspace.

**Spec:** `docs/roadmap/design/docs-repositioning-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **No page ships a `::: info Content coming` block.** If a page cannot be written honestly, it does
  not land and does not appear in the nav. This is spec §5.
- **VitePress fails the build on dead links.** `docs/.vitepress/config.ts` does not set
  `ignoreDeadLinks`, so the default applies. A page may only link to pages that exist when its task
  lands. Forward references wait for the task that creates the target.
- **`pnpm docs:build` must be green at the end of every task**, not only at the end of the plan. It
  is a separate CI step that `./check.sh` does not cover (AGENTS.md §7).
- **`./check.sh` must be green at the end of every task.** Prettier formats markdown at 100 columns
  and `format:check` is a stage, so run `pnpm format` (or `npx prettier --write` on the touched
  files) before committing.
- **Two must-fail greps define done for the whole plan**, both of which fail today. **Both exclude
  all of `docs/roadmap/` and `docs/implementation/`**, which are internal records that stay as
  written — including this plan and its design, which quote the retired phrase in order to retire
  it:

  ```bash
  grep -rl "Content coming" docs --include='*.md' \
    --exclude-dir=roadmap --exclude-dir=implementation
  grep -rn "voice-capture SDK" . --include='*.md' \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.superpowers \
    --exclude-dir=roadmap --exclude-dir=implementation
  ```

  Both must print nothing. Two things this form gets right that earlier drafts did not, each
  verified on this machine:

  - **It excludes all of `docs/roadmap/`, not just `docs/roadmap/phases/`.** The retired phrase
    also lives in `docs-repositioning-design.md`, in this file, and in `docs/roadmap/index.md`'s
    entry for the design doc — and no task edits any of them, so the narrower exclusion made the
    grep unsatisfiable forever.
  - **It uses `--exclude-dir` rather than piping through `grep -v '^\./…'`.** BSD grep on macOS
    does not prefix matches with `./` the way GNU grep does, so a path-anchored filter silently
    matches nothing and the roadmap hits come back anyway. `--exclude-dir` behaves the same on
    both.
  - **It excludes `.superpowers/`.** That directory holds this plan's execution scratch — briefs,
    reports, ledger — which quote the retired phrase in order to hunt it. It is gitignored, so
    the hits are untracked, but the literal command still printed them until this exclusion was
    added.

  As of this revision the first prints 17 files and the second prints exactly two — `README.md:7`
  and `AGENTS.md:8` — which are Task 2's and Task 3's targets. If you see a roadmap or
  implementation path, you are running an older form of the grep, not looking at a real failure.

- **Snugg Pro is an example, never the subject.** Any page whose only illustration is a home-energy
  audit needs a second one. The standing second example is the heat-pump quote reviewer: an invoice
  PDF plus an ACCA Manual J report plus the reviewer's dictation, joined into one session.
- **The superseded extraction-quality figures are never quoted** — not the ≈0.5% hard-hallucination
  number, not 75-of-75 enums, not even with a caveat. Spec §5.
- **Every code example imports from the published package name** (`@azx/ribo-core`, not a relative
  or `src/` path), even though nothing is published yet. Spec §5.
- **Verify every API name against the source barrel before writing it into prose.** The barrels are
  `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/queue/index.ts` and each other
  package's `src/index.ts`. AGENTS.md has already been caught carrying a name the code does not
  export; do not trust prose as a source for an identifier.
- **The pipeline is TWO state machines. Every page that touches it must say so.** Existing prose in
  `AGENTS.md`, `README.md` and the roadmap describes one machine
  (`queued → transcribing → extracting → awaiting-review → writing → done`) and is wrong. Verified
  against `packages/ribo-core/src/queue/schema.ts` and `session-schema.ts` on 2026-09-10:
  - **Recording** — `OUTBOX_STATUSES` is `recording, queued, transcribing, transcribed, failed,
dead, discarded`. `ACTIVE_OUTBOX_STATUSES` is `queued, transcribing, failed`. `transcribed` is
    deliberately **not** active: the relay is finished with a recording once it is text.
    `discarded` means the contractor threw the recording away, and `session-extract.ts` excludes
    discarded recordings from the joined transcript.
  - **Session** — `SESSION_STATUSES` is `open, extracting, awaiting-review, writing, done, failed,
dead`. `ACTIVE_SESSION_STATUSES` is `extracting, writing, failed`. `open` and `awaiting-review`
    are deliberately **not** active.
  - `dead` is terminal; `failed` is a _resting_ state the relay picks back up after
    `nextAttemptAt`. Both `done` and `dead` have a human-driven way out.
  - Methods are `openSession`, `closeSession`, `watchSessions`, `submitSessionReview`,
    `reopenSessionForReview`. **`submitReview` and `reopenForReview` do not exist.**

  This split is not an implementation detail to gloss: it is the repositioning stated structurally,
  and the Sessions guide (Task 8) exists to make that point.

- **Directory decision, applied throughout:** there is exactly one `/guide/` directory. The sidebar
  splits it into two groups, "Getting Started" and "Guides". Do **not** create a sibling `guides/`
  directory — `guide/` and `guides/` as neighbours is a permanent source of wrong links.

---

## Tranche 1 — Positioning

### Task 1: The argument — home, overview, motivation, comparison

The marquee task. Everything else in the plan is downstream of getting this right, and it is the
one worth reviewing hardest.

**Files:**

- Modify: `docs/index.md` (hero, tagline, four feature cards)
- Modify: `docs/guide/index.md` (currently an 11-line stub; becomes Overview)
- Create: `docs/guide/motivation.md`
- Create: `docs/guide/comparison.md`
- Modify: `docs/.vitepress/config.ts` (site `description`; the `/guide/` sidebar gains a "Getting
  Started" group containing Overview, Motivation, Comparison alongside the existing pages)

**Interfaces:**

- Consumes: nothing. First task.
- Produces: the vocabulary every later page reuses — "capture", "citable text", "target schema",
  "provenance envelope", "span-grounded", "review gate", "write-back", "plasmid". Later tasks must
  use these words and not invent synonyms. Also produces the link targets `/guide/`,
  `/guide/motivation` and `/guide/comparison`.

- [ ] **Step 1: Establish the must-fail baseline**

Run `grep -c "voice-capture SDK" docs/index.md README.md AGENTS.md docs/roadmap/index.md` and record
the counts. Run `pnpm docs:build` and confirm it is green _before_ any edit, so a later failure is
attributable to this task.

- [ ] **Step 2: Rewrite `docs/index.md`**

Hero name stays "Ribo". The `text` and `tagline` state spec §2's framing: a pipeline that turns any
capture — dictation, PDF, photo — into reviewed structured data written back to a system of record.
Three hero actions: "Get Started" → `/guide/getting-started` (exists today; Task 4 replaces it),
"Why Ribo" → `/guide/motivation`, "Comparison" → `/guide/comparison`.

Replace all four feature cards. They must map to the four strongest differentiators from spec §3,
one card each: schema-scaled extraction, checkable provenance, human review as a contract, and
offline-first durability. Do **not** keep the existing "Capture → transcribe → extract → review"
card as-is — it is the old framing in miniature.

- [ ] **Step 3: Write `docs/guide/index.md` as Overview**

What Ribo is, in the spec §2 framing, for a reader who arrived from a search result. It must state
within the first screen: the pipeline stages, that the capture source is pluggable and audio is only
one kind, and that the library is browser-side and offline-first. It must **not** open with Snugg
Pro. Close with a "where to go next" pointing at Motivation, Comparison and Getting Started.

- [ ] **Step 4: Write `docs/guide/motivation.md`**

The problem statement, written as TanStack Query's "Motivation" is: describe the pain before naming
the solution. The pain is that getting structured data out of documents and dictation is easy to
demo and hard to ship — the schema does not fit in one call, the model cites things that are not
there, somebody has to check the output, the network is not always available, and the result has to
land in a system of record. Name each, then say which part of Ribo answers it. No feature list
before the problem.

- [ ] **Step 5: Write `docs/guide/comparison.md`**

Per spec §3, in this order:

1. **The reframe, first and unmissable:** Docling and Mistral Document AI are not alternatives —
   they are things you plug into the `Transcriber` seam, and `@azx/ribo-transcriber-managed-docs`
   already is one. A parser hands you a document; Ribo is the pipeline above the parser.
2. **The matrix.** Four columns: Ribo, Docling, Mistral Document AI, LLM structured outputs used
   directly. Rows: parses scanned/rotated/handwritten pages; ingests audio dictation; one session
   across mixed sources; target schema past a few hundred leaves; provenance verified against the
   source; human review as a contract; works with no network; writes back to a system of record;
   data can stay on-device; parser is swappable. Use a legend of ✅ / 🟡 / 🚫 and define it above
   the table.
3. **Ribo loses the parsing row outright** — 🚫, with the reason inline: it delegates parsing, and
   `@azx/ribo-transcriber-pdfjs` carries a `no-text-layer` guard precisely because it cannot OCR.
   This is not optional. A matrix in which Ribo wins every row is not evidence.
4. **The seven differentiators** as short subsections, each carrying its in-repo evidence. Verify
   each number against its source before writing it: the ~1,326-leaf / ~5,360-property / ~1,490-enum
   figures and the 5,000 and 1,000 caps are in `docs/implementation/16-extraction-schema-scale.md`;
   the 16-nullable-union limit is in `docs/implementation/21-managed-three-phase-extraction.md`; the
   37%-fabricated-per-cell-citation and 14/14-verbatim-row-span results are in
   `docs/roadmap/design/group-provenance-granularity-design.md` §1.
5. **The three deployment properties** — no compute plane, no credential reaches the client, data
   need never leave the device — with the second and third written as capabilities, not apologies.
6. **A closing "use something else when…" block:** server-side batch extraction over a pile of PDFs,
   a schema small enough for one call with no human in the loop, best-in-class parsing of degraded
   scans, or a Python stack.

Evidence density per spec §11: one line of evidence inline per matrix row, with the full working
linked to its deep dive where one exists.

- [ ] **Step 6: Update the VitePress config**

Change the site `description` off "voice-capture SDK". Restructure the `/guide/` sidebar into two
groups: "Getting Started" (Overview, Motivation, Comparison, Getting Started) and "Guides" (The Core
Loop, The Offline Outbox — the two existing pages, kept until Tasks 4 and 11 replace them). Add a
"Comparison" entry to the top `nav` beside "Guide".

- [ ] **Step 7: Verify**

Run `npx prettier --write` on every touched file, then `npx prettier --check` on them. Run
`pnpm docs:build` — expect green, and expect **zero dead-link errors**, which is the check that
catches a hero action or a "next" link pointing at a page that does not exist yet. Run `./check.sh`
and paste its summary line.

- [ ] **Step 8: Commit**

`git add docs/index.md docs/guide/index.md docs/guide/motivation.md docs/guide/comparison.md docs/.vitepress/config.ts`
then commit as `docs: reposition the site around structured extraction`.

---

### Task 1A: Close the two interim inconsistencies Task 1 opens

Added after review. Task 1 ships a Comparison page that refuses to quote any extraction-accuracy
figure, and a nav that still advertises a `Capabilities` section of stubs. Both are defensible at
the end of the plan and indefensible for the fifteen tasks in between, so they move here.

**Files:**

- Modify: `scripts/generate-accuracy-page.mjs`
- Modify: `docs/.vitepress/config.ts` (remove the `Capabilities` **nav** entry only)

**Interfaces:**

- Consumes: Task 1's honesty framing.
- Produces: nothing. This task only removes contradictions.

- [ ] **Step 1: Add the accuracy disclosure to the generator**

Read `scripts/generate-accuracy-page.mjs` and see what it currently emits — it writes
`docs/deep-dives/accuracy.md` (gitignored, regenerated by `pnpm docs:accuracy`) and already carries
a staleness banner. Per spec §5 the page must say plainly that extraction quality is **not
currently measured** and why: the corpus is annotated in the superseded vocabulary and the
acceptance gate deliberately refuses to emit meaningless numbers. It must not quote the superseded
figures. Put this in the **generator**, not in its output, or the next regeneration drops it.

Until this lands, the site ships measured-looking extraction numbers on one page while the
Comparison page declines to quote any — an internally inconsistent site.

- [ ] **Step 2: Remove the `Capabilities` nav entry, keep the files**

Delete `{ text: "Capabilities", link: "/capabilities/" }` from `nav` and drop the
`"/capabilities/"` sidebar block. **Leave the four files in place** — Tasks 6–12 still absorb their
content and Task 16 deletes them. Orphaned pages build fine; a nav entry reading "Capabilities →
Extraction: Content coming" next to "Guides → Extraction: a real page" does not.

Deleting the sidebar block means the four pages lose their sidebar when visited directly. That is
correct for a section being retired, and they are unreachable from the nav from this point on.

- [ ] **Step 3: Verify and commit**

`pnpm docs:accuracy` and read the regenerated page. Then `pnpm docs:build` — this is the step that
proves removing the nav entry broke no link — and `./check.sh`. Commit as
`docs: disclose the extraction-measurement gap and retire the capabilities nav`.

---

### Task 2: `README.md`

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: Task 1's vocabulary and the comparison argument. The README is the compressed version of
  the same case; it must not contradict it or introduce a different one-liner.
- Produces: the package table that Task 15's nine package READMEs each link back to.

- [ ] **Step 1: Rewrite the opening**

Replace the "reusable voice-capture SDK for field data collection" paragraph with spec §2's framing.
Snugg Pro moves from "First target:" at the top to a mention inside the packages table as the
reference adapter.

- [ ] **Step 2: Rewrite "What works today"**

The current pipeline line is `capture → on-device transcribe → extract → review → write-back`, which
presumes audio. Restate it source-neutrally, and split it at the seam the code splits at: capture
and transcription belong to the recording; extraction, review and write-back belong to the session.
Correct the bullets against the current tree: capture covers audio and documents; transcription
covers four engines, not one; extraction covers both the managed and on-device extractors and names
the per-group strategy; review is a real gate the session parks at. Keep the honest statements that
are already there — the write-back gate and the `~6×` real-time / 8.0% WER transcription figures —
and add spec §5's disclosure that extraction quality is not currently measured.

- [ ] **Step 3: Rewrite the architecture table**

It currently lists five packages. There are nine publishable ones —
`ribo-core`, `ribo-ui-react`, `ribo-adapter-snuggpro`, `ribo-extractor-openai`,
`ribo-extractor-ondevice`, `ribo-transcriber-ondevice`, `ribo-transcriber-managed`,
`ribo-transcriber-managed-docs`, `ribo-transcriber-pdfjs` — plus two private ones
(`@azx/build-config`, `@azx/tsconfig`) that the table should not list as products. Verify by reading
each `packages/*/package.json` for a `private` flag rather than trusting this list.

Also correct the "three interfaces" sentence: the extension points are now `Transcriber`,
`Extractor`, `ToolAdapter` **and** the injectable outbox `RxStorage` (AGENTS.md §5.5).

- [ ] **Step 4: Add a "not yet published" line**

Per spec §5: a short factual note that the packages are not on npm yet, naming R4 as the tracking
item, placed with the Quick start rather than in the opening pitch.

- [ ] **Step 5: Verify and commit**

`npx prettier --write README.md && npx prettier --check README.md`, then `./check.sh`. Commit as
`docs: reframe the README around structured extraction`.

---

### Task 3: `AGENTS.md` §1, the roadmap preamble, and one stale identifier

Internal, unpublished, and the highest-leverage twenty lines in the plan: these are what every
future contributor and coding agent reads first, so leaving them stale guarantees the old framing
gets reproduced.

**Files:**

- Modify: `AGENTS.md` (§1 "What this repo is"; §3's tier table intro if it repeats the framing)
- Modify: `docs/roadmap/index.md` (the preamble paragraph only — the historical phase records below
  it stay exactly as written)

**Interfaces:**

- Consumes: Task 1's framing.
- Produces: nothing other pages depend on.

- [ ] **Step 1: Confirm both stale identifiers before fixing them**

`AGENTS.md` §1 describes "the `Extractor<F>` seam (`toExtractStep`, `FakeExtractor`)". Run
`grep -n "toExtractStep\|toSessionExtractStep" packages/ribo-core/src/index.ts` — the barrel exports
`toSessionExtractStep`, not `toExtractStep`. Then run
`grep -n "OUTBOX_STATUSES\|SESSION_STATUSES" -A 12 packages/ribo-core/src/queue/schema.ts packages/ribo-core/src/queue/session-schema.ts`
and confirm the two-machine reality in the Global Constraints. If either has changed again, use
what the source says.

- [ ] **Step 2: Rewrite `AGENTS.md` §1's first paragraph**

Lead with what the library is per spec §2. Keep the paragraph's existing virtue — it is a dense,
accurate inventory of what each package does — and keep the status sentence. Change only the framing
sentence and any place the inventory implies audio is the only capture kind.

- [ ] **Step 3: Correct `AGENTS.md` §1's state machine — the substantive fix in this task**

Line 25 currently reads `(queued → transcribing → extracting → awaiting-review → writing → done)`
as one machine. Replace it with the two machines from the Global Constraints, and say which relay
acts on which statuses. This is a correctness fix, not a reframing: a contributor reading the
current sentence will look for an `extracting` status on the recording outbox and not find one.

- [ ] **Step 4: Fix `toExtractStep` → `toSessionExtractStep`**

- [ ] **Step 4b: Sweep the rest of AGENTS.md's drift — do not stop at the known instances**

An external review found four more stale claims beyond the two this task was originally scoped to,
which is the point of the "assume there are more" rule. Verify each against source and fix:

- **"six hooks over core's engine"** (§1) — the barrel exports **seven**; `useSessions` is missing
  from the list, and Task 12 of this plan already names all seven.
- **"`pnpm typecheck` prints `Scope: 9 of 10 workspace projects`"** (§2) — there are **12**
  workspace members now. Re-run `pnpm typecheck` and quote what it actually prints, including the
  count of members that define a `typecheck` script, since that paragraph's whole point is that a
  package without one is silently absent from the gate.
- **"All six packages build"** (§5.1) — there are **nine** publishable packages.
- **"as of Task 1 its `src/worker.ts` is a stub"** (§5.2) — Phase 3 shipped; check whether the
  worker is still a stub and correct or drop the clause.

Grep for other counts while you are in there: any bare numeral describing packages, hooks or
workspace members is a candidate. Prefer naming the source of truth over restating a count that
will go stale again.

- [ ] **Step 5: Rewrite the `docs/roadmap/index.md` preamble**

The first paragraph only. Everything from "This directory is the project's roadmap" onward is
unchanged, and every "What has shipped" entry is a historical record that must not be retro-edited
— including R2's, which described the single state machine accurately at the time it was written.
Where the roadmap names `Outbox.submitReview` or `Outbox.reopenForReview` in a _historical_ entry,
leave it; add one dated correction note under "Open questions and findings pending action" saying
that extraction, review and write have since moved to the session and naming the current methods.

- [ ] **Step 6: Verify and commit**

Run the Global Constraints form of the `voice-capture SDK` grep. After this task and Task 2 it must
print nothing at all. Then `npx prettier --write`, `./check.sh`. Commit as
`docs: retire the voice-capture framing from AGENTS and the roadmap preamble`.

---

## Tranche 2 — The on-ramp

### Task 4: Installation and Quick Start

**Files:**

- Create: `docs/guide/installation.md`
- Create: `docs/guide/quick-start.md`
- Delete: `docs/guide/getting-started.md` (its accurate content — the Node/pnpm floors and the three
  workspace commands — moves into Installation)
- Modify: `docs/.vitepress/config.ts` ("Getting Started" group becomes Overview, Motivation,
  Comparison, Installation, Quick Start)
- Modify: `docs/index.md` (the "Get Started" hero action retargets to `/guide/installation`)

**Interfaces:**

- Consumes: Task 1's link targets.
- Produces: `/guide/installation` and `/guide/quick-start`. Retires `/guide/getting-started`, so any
  page linking there must be updated in this task — run
  `grep -rn "getting-started" docs README.md` first and fix every hit.

- [ ] **Step 1: Find every inbound link to the page being deleted**

`grep -rn "getting-started" docs README.md packages` — at minimum `docs/index.md` and the sidebar.
Deleting the file without fixing these fails `docs:build` on dead links.

- [ ] **Step 2: Write `docs/guide/installation.md`**

Two audiences in two sections. **As a consumer:** the package-manager install line written against
the published names, preceded by spec §5's short factual note that they are not on npm yet with R4
named as the tracking item — stated once, plainly, no badge. Name the peer-dependency reality a
consumer will hit: React is a peer on `@azx/ribo-ui-react` (`^18.3 || ^19`), and packages that share
runtime object identity with core declare core as a peer too (AGENTS.md §6.2) — verify the current
peer ranges by reading the `package.json` files rather than copying them from here. **From source:**
the Node ≥ 24 and pnpm 10.34.5 floors, `pnpm install`, `./check.sh`, and
`pnpm --filter playground dev`, with the note that the playground consumes every library from
TypeScript source.

- [ ] **Step 3: Write `docs/guide/quick-start.md`**

One runnable path from nothing to a first extracted, span-checked field. It must be honest about
requiring no model: build it on `FakeTranscriber` and `FakeExtractor`, both exported from
`@azx/ribo-core`, so a reader can run it with no credentials. Then show the one-line swap to a real
engine.

Derive the example from `playground/src/` rather than inventing an API shape — read it first. The
page must show: declaring a small values schema, deriving the extraction schema with `enveloped()`,
running an extractor, and checking a field with `isSpanGrounded`. Keep the schema tiny — four or
five leaves. Do not use the Snugg Pro schema here; a reader's first example must be one they can
read in ten seconds.

Verify every identifier used against `packages/ribo-core/src/index.ts` before writing it.

- [ ] **Step 4: Delete `getting-started.md`, update the sidebar and the hero action**

- [ ] **Step 5: Verify and commit**

`pnpm docs:build` — the dead-link check is the real gate here, because a file was deleted. Then
`./check.sh`. Commit as `docs: split getting started into installation and a runnable quick start`.

---

### Task 5: Important Defaults and Typesafety

**Files:**

- Create: `docs/guide/important-defaults.md`
- Create: `docs/guide/typesafety.md`
- Modify: `docs/.vitepress/config.ts`

**Interfaces:**

- Consumes: Task 4's Quick Start vocabulary.
- Produces: the defaults table that later guide pages reference instead of restating.

- [ ] **Step 1: Establish each default from source, not from memory**

For every default the page will state, find and cite the constant or the code path. At minimum:
`"leaf"` as `enveloped()`'s default provenance granularity (`packages/ribo-core/src/enveloped.ts`);
Dexie as `openOutbox`'s default storage (AGENTS.md §5.5, `packages/ribo-core/src/queue/outbox.ts`);
`firstCapable`'s sequential preference order and `DEFAULT_CAPABILITY_TTL_MS`; the relay's backoff
defaults (`packages/ribo-core/src/queue/backoff.ts`); `DEFAULT_HEDGE_BUDGET_MS`,
`DEFAULT_HEDGE_FACTOR` and `DEFAULT_HEDGE_FLOOR_MS`; `MAX_NULLABLE_UNIONS_PER_CALL`
(`@azx/ribo-extractor-openai`); and `DEFAULT_PROBE_TIMEOUT_MS` / `DEFAULT_STABILITY_WINDOW_MS`.

**The arbiter defaults come in two pairs, one per seam — do not mix them.** Extraction defaults are
`terminalFallsThrough` (conservative) and `acceptAnySuccess` (degraded-experience). Transcription's
default is `unsupportedFallsThrough`. Both sets are in `packages/ribo-core/src/index.ts` with
explanatory comments; read them rather than pairing one from each seam.

Do **not** hardcode a numeric value in prose where naming the exported constant will do — per the
repo's standing preference, baked-in numbers go stale silently. Name the constant, state what it
governs, and let the reference carry the value.

- [ ] **Step 2: Write `docs/guide/important-defaults.md`**

Modeled on TanStack Query's page of the same name. Each entry: the default, why it is the default,
and the symptom a reader will see if it is the wrong one for them.

The two most important entries are both about the relay declining to act, because a reader who does
not know them concludes it is broken:

- **The review gate.** A session parks at `awaiting-review`, which is deliberately absent from
  `ACTIVE_SESSION_STATUSES` so the relay drains past it rather than stalling, and
  `submitSessionReview` is the only way out. (`reopenSessionForReview` is the way back in from
  `done` or `dead`.)
- **`open` and `transcribed` are also inactive, on purpose.** The relay does not touch an `open`
  session until the host closes it, and it is finished with a recording once that recording is
  `transcribed` — from there the session owns the work.

Also state that `failed` is a _resting_ state, not a failure state: it is in
`ACTIVE_OUTBOX_STATUSES` and `ACTIVE_SESSION_STATUSES` precisely because the relay picks it back up
once `nextAttemptAt` passes. `dead` is the terminal one.

- [ ] **Step 3: Write `docs/guide/typesafety.md`**

The derived-schema story, which is the genuinely interesting part of the design: one declared
writable values schema (`V`), an extraction envelope **derived** from it via `enveloped()`, and
review addressing flat dotted leaf paths where each `ReviewField` carries its own leaf schema — so a
review UI renders and validates off the schema and imports nothing from any adapter. Explain why
`ToolAdapter`'s single field-shape parameter had to be split (R1.5), because that is the part a
reader will otherwise get wrong in their own adapter.

- [ ] **Step 4: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: add important defaults and typesafety guides`.

---

## Tranche 3 — The concept guides

Moat pages first. Spec §4: Schema at Scale and Provenance carry the repositioning.

### Task 5A: Give the moat evidence somewhere to live

Added after review, and it closes the plan's largest structural hole. Spec §4 names Schema at Scale
and Provenance as the two pages that carry the repositioning, and spec §11 resolves that each
Comparison row carries one line of evidence inline "with the full working linked". **There is
nowhere to link.** Every number those pages depend on lives in
`docs/implementation/16-extraction-schema-scale.md`, `docs/implementation/21-managed-three-phase-extraction.md`
and `docs/roadmap/design/group-provenance-granularity-design.md` — all excluded from the site by
`srcExclude` — and the Deep Dives section has no page for either subject. This task creates the
targets **before** Tasks 6, 7 and 7A need them.

**Files:**

- Create: `docs/deep-dives/schema-scale.md`
- Create: `docs/deep-dives/provenance-measurement.md`
- Modify: `docs/.vitepress/config.ts` (two new Deep Dives sidebar entries)

**Interfaces:**

- Consumes: nothing.
- Produces: `/deep-dives/schema-scale` and `/deep-dives/provenance-measurement` — the link targets
  Tasks 6, 7 and 7A all rely on. Nothing in Tranche 3 can cite its evidence until this lands.

- [ ] **Step 1: Write `docs/deep-dives/schema-scale.md`**

Repackage `docs/implementation/16-extraction-schema-scale.md` and the relevant part of doc 21 as
published prose: the method, the numbers, and what they do and do not support. Must carry the
property and enum ceilings, the measured schema sizes, and the nullable-union limit.

Two accuracy requirements the source documents impose and the guide must respect:

- **The `~1,326` leaf figure is stale.** `docs/implementation/20-job-collections-field-reconciliation.md`
  records that the spec drifted after doc 16 measured it, that the figure was not re-derived, and
  that `allJobData` spans the read-only surface too — "a different and smaller set". Present it as
  measured against a named snapshot, or lead with the current **837 writable fields** instead. Do
  not present it as a current count.
- **The 16-nullable-union limit is scoped.** Doc 21 says outright that "whether the 16 is the
  vendor's own limit or this route's translation of it is not established". Attribute it as our own
  measurement (16 accepted, 18 rejected) on a named route, not as published vendor documentation.

- [ ] **Step 2: Write `docs/deep-dives/provenance-measurement.md`**

Repackage `docs/roadmap/design/group-provenance-granularity-design.md` §1: the 67×9 table, 603
citations across two partitions, the 37%-fabricated per-cell result against 14/14 verbatim row
spans, and the single-call outcome after switching granularity. This is the site's strongest
evidence and currently its least reachable.

Be precise about scope: this measures **citation fidelity and call economics**, not field accuracy.
It is not a substitute for the extraction-accuracy number the project does not have, and the page
must say so rather than let a reader borrow it as one.

- [ ] **Step 3: Add both to the Deep Dives sidebar**

- [ ] **Step 4: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: publish the schema-scale and provenance deep dives`.

---

### Task 6: The Provenance guide

**Files:**

- Create: `docs/guide/provenance.md`
- Modify: `docs/.vitepress/config.ts` ("Guides" group)

**Interfaces:**

- Consumes: Task 5's Typesafety vocabulary (`enveloped()`, derived schema, leaf paths).
- Produces: the terms "span-grounded", "granularity", "envelope" as later pages use them. Task 7
  (Schema at Scale) depends on granularity being explained here, because partitioning counts
  nullable unions and enveloping is what creates them.

- [ ] **Step 1: Write the page**

Four movements. **What the envelope is:** every leaf arrives as value + confidence + source span,
derived not hand-written. **Why a span beats a confidence score:** `isSpanGrounded` checks the quote
against the source text, so an invented citation is detectable; a confidence score is the model
grading its own work. Include `spanGroundedness` and its near-miss tier. **Why granularity is a
knob:** `"leaf"` (default), `"row"`, `"none"`, with the measured reason from
`group-provenance-granularity-design.md` — a 67×9 table costs 603 citations nobody clicks and forced
the group to partition across two calls, while row spans got it into one call, and per-cell
citations were 37% fabricated where row spans were 14/14 verbatim. **What it buys downstream:**
review refuses to accept a submission while an ungrounded leaf is unactioned.

- [ ] **Step 2: Verify the numbers against the design doc before publishing them**

Re-read `docs/roadmap/design/group-provenance-granularity-design.md` §1 and confirm each figure.
This page is the site's primary evidence; a wrong number here discredits the rest.

- [ ] **Step 3: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: add the provenance guide`.

---

### Task 7: The Schema at Scale guide

The deepest differentiator and the one no competitor has a page for.

**Files:**

- Create: `docs/guide/schema-at-scale.md`
- Modify: `docs/.vitepress/config.ts`

**Interfaces:**

- Consumes: Task 6's envelope and granularity vocabulary.
- Produces: the names `splitExtractionSchema`, `perGroupExtractor`, `instanceLadder`,
  `extractInventory`, gap-fill — which Task 9's Extraction guide links to rather than re-explaining.

- [ ] **Step 1: Establish the constraint with numbers**

Open with the wall, not the solution: a real system of record's schema does not fit in one model
call. Cite from `docs/implementation/16-extraction-schema-scale.md` — ~1,326 leaves, ~5,360
enveloped properties against a documented 5,000 cap, ~1,490 enum values against a 1,000 cap — and
from `docs/implementation/21-managed-three-phase-extraction.md` the 16-nullable-union ceiling on one
model family, which two existing groups already exceed. Note that enveloping **multiplies** the
count, so provenance and scale are the same problem.

- [ ] **Step 2: Describe the machinery**

`splitExtractionSchema` and `MAX_NULLABLE_UNIONS_PER_CALL`; why partitioning counts nullable unions
rather than leaves (a leaf count would split a 15-leaf row group for no gain); `perGroupExtractor`;
the gap-fill pass and what an abstained leaf is; `extractInventory` and `instanceLadder` for
repeating resources. Verify every name against
`packages/ribo-extractor-openai/src/index.ts` before writing it.

- [ ] **Step 3: State what is closed and why**

Whole-spec extraction is closed on hard limits rather than quality — record it here so a reader does
not propose it, the way the roadmap records it so contributors do not.

- [ ] **Step 4: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: add the schema-at-scale guide`.

---

### Task 7A: Harden the Comparison page

Added after review. Task 1 shipped the Comparison page and an external review found its argument
sound but its evidence set self-serving: **every column included is a layer Ribo sits above, and
every layer Ribo actually competes at was omitted.** A knowledgeable evaluator notices. This task
fixes that and wires the page to the evidence Task 5A published.

**Files:**

- Modify: `docs/guide/comparison.md`

**Interfaces:**

- Consumes: `/deep-dives/schema-scale` and `/deep-dives/provenance-measurement` from Task 5A.
- Produces: the final positioning argument. Nothing later depends on it.

- [ ] **Step 1: Widen the comparison set**

The page currently compares Ribo against Docling, Mistral Document AI, and structured outputs used
directly. Add the two categories that contest Ribo's actual claims:

- **Document-AI platforms that already sell "documents → your schema, with citations and review"** —
  Reducto, LandingAI ADE, Extend, Unstructured, LlamaParse, and the cloud trio (Azure Document
  Intelligence, Google Document AI, AWS Textract). These contest differentiators 2, 3 and 5
  head-on. Azure Document Intelligence is worth naming explicitly: this repo already sits beside
  Azure for speech, so omitting it looks like avoidance.
- **DIY orchestration** — Instructor, LangChain/LlamaIndex extraction. This is what "structured
  outputs used directly" actually looks like on the competent team the page imagines, and comparing
  against a naive `fetch` loop instead is a straw man.

A twelve-column matrix is unreadable. Keep the matrix at four columns but **group** it: compare
against representative categories rather than every product, and name the products inside each
category in prose beneath. The category labels matter more than the individual rows.

- [ ] **Step 2: Add the losing rows the page is currently missing**

The page concedes only the parsing row — which the category reframe had already defined as not
Ribo's job, so the concession costs nothing. Add rows Ribo genuinely loses:

- **Measured extraction accuracy.** Ribo: 🚫 — there is no current number. Several competitors
  publish benchmarks. This is the row an evaluator most wants and the one the page currently omits
  while disclosing the same fact in a footer.
- **Installable today.** Ribo: 🚫 — not on npm. An evaluator's first filter, currently confined to
  the Installation page.
- **Managed batch throughput** and **zero-ops hosting.** Ribo requires the host to supply a
  credentialed transport; "no capacity to authenticate" cuts both ways and should appear as a cost,
  not only as a virtue.

- [ ] **Step 3: Tighten the "works with no network" row**

It currently reads as though the whole pipeline runs offline. Precisely: **capture, the durable
queue and review survive with no network unconditionally**; transcription and extraction offline
require the on-device engines, and on-device extraction quality is unmeasured. Split the row or
qualify it. (The review that raised this attributed offline-first's weakness to a dependency on
on-device extraction, which is wrong — the outbox is durable regardless — but the row as written
does overclaim, so fix the row and not the rationale.)

- [ ] **Step 4: Date the competitor claims**

Every non-✅ cell in a competitor column is an assertion about someone else's product, on a page
whose whole argument is verifiability. Add an "evaluated as of `<date>`" line and, where a claim is
load-bearing, name the version or link the vendor's documentation. A comparison page that fails its
own standard is worse than no comparison page.

- [ ] **Step 5: Replace the vague evidence links**

The page currently links "Full working" to `/deep-dives/` because nothing specific existed. Point
the schema-scale claims at `/deep-dives/schema-scale` and the citation-fidelity claims at
`/deep-dives/provenance-measurement`.

- [ ] **Step 6: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: widen the comparison set and add the rows Ribo loses`.

---

### Task 8: Captures & Sources, and Sessions

**Files:**

- Create: `docs/guide/captures-and-sources.md`
- Create: `docs/guide/sessions.md`
- Modify: `docs/.vitepress/config.ts`

**Interfaces:**

- Consumes: Task 1's vocabulary.
- Produces: the `Transcriber` reframe paragraph that spec §6 says the docs spend exactly once, and
  which every later page relies on having been said.

- [ ] **Step 1: Write the `Transcriber` reframe paragraph**

Per spec §6, early in `captures-and-sources.md` and once only: a `Transcriber` turns any capture into
citable text; audio was merely the first kind. Then never apologise for the name again. Do not
introduce "source" or "reader" as a competing noun for the interface — spec §6 rejected that.

- [ ] **Step 2: Write `docs/guide/captures-and-sources.md`**

`CaptureItem` as the union of `Recording` and `DocumentCapture`, and why a PDF is not modelled as a
recording with `durationMs: 0`. The four transcriber packages and what each is for. The capability
model — `capability()`, the unavailable reasons, and `UnsupportedItemError` as the third failure
class that is terminal for the queue but not for the item. `restrictToKind` for lifting a narrow
transcriber into a slot that sees any `CaptureItem`.

- [ ] **Step 3: Write `docs/guide/sessions.md`**

The page that proves the repositioning, and the reason Task 8 is not a minor one.

`joinSessionTranscript()` returns `{ text, recordingIds }` and does not know whether audio was
involved, which is why one session can hold an invoice PDF, a Manual J report and a dictation and
extract across all three at once. Cover per-capture attribution markers in the joined transcript,
and that `discarded` recordings are excluded from it.

Then make the structural argument explicitly, because it is the strongest evidence the docs have:
extraction, review and write-back live on the **session**, not the recording. A recording's machine
ends at `transcribed`; the session's begins at `open`. The source-aware half of the pipeline and
the source-agnostic half are separated in the type system and in the persistence layer, not merely
by convention — which is why adding PDF support required no change to `Extractor`,
`isSpanGrounded`, arbitration or the review contract.

Cover the session lifecycle API: `Outbox.openSession`, `closeSession` (the relay does not act on an
open session until the host closes it), `watchSessions`, and `submitSessionReview` **named but not
linked** — the Review guide does not exist until Task 10, and a forward link here fails
`docs:build` on a dead link. Task 10 adds the link back. Use the heat-pump quote reviewer as the
worked example.

- [ ] **Step 4: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: add the captures, sources and sessions guides`.

---

### Task 9: Extraction, and Arbitration & Fallback

**Files:**

- Create: `docs/guide/extraction.md`
- Create: `docs/guide/arbitration.md`
- Modify: `docs/.vitepress/config.ts`

**Interfaces:**

- Consumes: Task 7's strategy names, Task 6's envelope.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write `docs/guide/extraction.md`**

The `Extractor<F>` seam, `ExtractionTarget`, `toSessionExtractStep` (verify the name against the
barrel — it is **not** `toExtractStep`), and `FakeExtractor` for driving the pipeline with no model.
The two real extractors: `@azx/ribo-extractor-openai` and `@azx/ribo-extractor-ondevice`'s
`threePhaseExtractor` over the platform's on-device language model.

**Get the two transports right — they are not the same kind of thing.** `openAiChat` is the
OpenAI-compatible transport; `helixChat` is a second `ChatClient` for the Helix platform's
provider-neutral `/_api/llm/chat` route and its barrel comment says **"(not OpenAI-compatible)"**
in as many words (`packages/ribo-extractor-openai/src/index.ts`). Do not describe them as one
OpenAI-compatible transport with two endpoints. Link to Schema at Scale for strategy selection rather than
restating it. Include spec §5's disclosure that extraction quality is not currently measured, with
the reason, and link to the Extraction: Measured deep dive.

- [ ] **Step 2: Write `docs/guide/arbitration.md`**

Why composition needed a decision vocabulary rather than a retry flag. `fallbackExtractor`,
`raceExtractor`, `compositeExtractor`; the `ExtractionArbiter` contract and the two defaults
(`terminalFallsThrough`, `acceptAnySuccess`); `SchemaParseError` as the error that stays retryable
while being recognisable to an arbiter. Then the transcriber siblings — `firstCapable`,
`fallbackTranscriber`, `hedged`, `unsupportedFallsThrough` — and the point AGENTS.md makes about
them: `fallbackTranscriber` is **not** "firstCapable with retries", and a reader who thinks it is
will wire it wrongly. Say that explicitly.

- [ ] **Step 3: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: add the extraction and arbitration guides`.

---

### Task 10: Review and Write-back

**Files:**

- Create: `docs/guide/review.md`
- Create: `docs/guide/write-back.md`
- Modify: `docs/.vitepress/config.ts`

**Interfaces:**

- Consumes: Tasks 5–7.
- Produces: the review vocabulary Task 12's React Hooks guide builds on.

- [ ] **Step 1: Write `docs/guide/review.md`**

`buildReviewRequest` / `resolveReview` as a contract, not a UI. Flat dotted leaf paths and why
top-level keys were wrong (a multi-test health matrix collapsing to one verdict — the concrete
failure R1.5 fixed). **Do not put a number on that matrix without checking which era you mean:**
the R1.5 design and doc 16 both describe an **11**-test matrix, which is the schema as it stood
when the top-level-key problem existed; today's schema has more. Either say "eleven" and attribute
it to R1.5, or say "a matrix of independent tests" and skip the count. `ReviewField.schema` carrying the declared leaf schema, and
`stripOptionalNullable` as the one primitive a UI needs to render an editor from it. The gate: a
**session** parks at `awaiting-review`, ungrounded leaves must be actioned,
`Outbox.submitSessionReview` is the only exit, and `Outbox.reopenSessionForReview` is the supported
way back in from `done` or `dead` — explicitly not a raw `patch`. Use the session method names; the
`submitReview` / `reopenForReview` spellings that appear in the roadmap do not exist.
Instance-identity review (`ExistingRecord`, `InstanceLinkDecision`, `RankedCandidate`) gets a
subsection.

- [ ] **Step 2: Write `docs/guide/write-back.md`**

`ToolAdapter<F, C>` as the only tool-specific surface; what belongs in an adapter and what must never
leak out of one. `toWriteStep` as the single place `schema.parse` runs before a write, and
`toInstanceWriteStep` with `deriveInstanceIdempotencyKey` for per-instance writes that resume after
a partial failure. `@azx/ribo-adapter-snuggpro` as the reference implementation — described as a
worked example, not as the subject.

State the gate plainly per spec §5: the seam and the trust boundary are real; the live Snugg Pro
write is gated on the Helix egress HMAC signing ask. Link to
`docs/implementation/13-helix-platform-asks.md` — verify that path resolves from a published page,
since `implementation/**` is in `srcExclude`; if it does not, link to the repo file on the forge or
restate the substance inline rather than shipping a dead link.

- [ ] **Step 3: Add the backlinks Task 8 had to defer**

`docs/guide/sessions.md` names `submitSessionReview` without linking, because this page did not
exist yet. Add the link now. Check for any other page that names a review or write-back concept
without linking for the same reason.

- [ ] **Step 4: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: add the review and write-back guides`.

---

### Task 11: Offline & the Outbox, and the three offline-first pages

**Files:**

- Create: `docs/guide/offline-and-the-outbox.md`
- Delete: `docs/guide/outbox.md` and `docs/guide/core-loop.md` (both stubs; their content is
  absorbed here and in Task 8)
- Modify: `docs/offline-first/index.md` (stub → a real, short section overview)
- Modify: `docs/offline-first/service-worker.md`, `docs/offline-first/storage-eviction.md`,
  `docs/offline-first/ort-runtime-cache.md` (all three stubs → real content)
- Modify: `docs/.vitepress/config.ts`

**Interfaces:**

- Consumes: Task 10's review-gate vocabulary.
- Produces: `/guide/offline-and-the-outbox`. Retires `/guide/outbox` and `/guide/core-loop`, so
  every inbound link must be fixed in this task.

- [ ] **Step 1: Find inbound links to the two pages being deleted**

`grep -rn "core-loop\|guide/outbox" docs README.md`. Note that `docs/guide/core-loop.md` currently
links to `/capabilities/`, which Task 16 removes — deleting core-loop.md here removes one of the two
inbound links to that section ahead of time.

- [ ] **Step 2: Write `docs/guide/offline-and-the-outbox.md`**

The durable outbox and the foreground relay: **both** state machines exactly as the Global
Constraints give them, drawn as two diagrams rather than one — the recording machine ending at
`transcribed`, and the session machine running `open → extracting → awaiting-review → writing →
done`. Say why the split exists (a recording is finished once it is text; the session owns
everything downstream and does not know what produced the text) and link to the Sessions guide.
Cover which statuses each relay acts on and why `open`, `transcribed` and `awaiting-review` are
excluded; backoff and retry and the `failed`-is-resting distinction; `createRelay`; connectivity's
three states
and why the relay keys off the stably-online edge rather than `navigator.onLine`, and `workSafety` /
`summarizeWork` as the one honest "is my work safe?" answer. Cover the injectable storage seam
(`openOutbox({ storage })`, Dexie by default, memory storage for browser-free tests) and state its
deliberate Level-1 boundary per AGENTS.md §5.5. Include durable capture (`openCaptureSession`,
`recoverInterrupted`) — verify current status against
`docs/roadmap/design/durable-capture-plan.md` and describe only what has landed.

- [ ] **Step 3: Write the three offline-first pages**

Source material is `docs/implementation/09-offline-first.md` plus the code. These are the
browser-platform mechanics — service-worker precaching of the shell, storage persistence and
eviction handling, and the ORT runtime cache — as distinct from the outbox guide's model and API.
Repackage, do not paste: `implementation/**` is excluded from the site because it is a working
record, not published prose.

- [ ] **Step 4: Rewrite `docs/offline-first/index.md`**

A real short overview that says what the section covers and links to the outbox guide for the model.
Not a stub.

- [ ] **Step 5: Verify and commit**

`pnpm docs:build` — two deletions, so the dead-link check matters. `./check.sh`. Commit as
`docs: add the offline guide and write the offline-first pages`.

---

### Task 12: The React Hooks guide

**Files:**

- Create: `docs/guide/react.md`
- Modify: `docs/.vitepress/config.ts`

**Interfaces:**

- Consumes: Tasks 8, 10, 11.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the page**

`@azx/ribo-ui-react` as a headless hook layer — `RiboProvider` and nothing else that renders, no
markup, no stylesheet. The seven hooks, verified against
`packages/ribo-ui-react/src/index.ts`: `useRecorder`, `useOutboxItems`, `useReview`,
`useConnectivity`, `useWorkSafety`, `useStoragePersistence`, `useSessions`, plus
`createCaptureCoordinator`. Note the design property worth copying: the provider never constructs
core's instances, so lifetime stays with the host, and `useReview` takes the values schema as an
argument rather than reaching for a `ToolAdapter` — which is what keeps the hook layer genuinely
tool-agnostic. Note `useStoragePersistence` as the one hook with no core counterpart.

Frame this the way TanStack frames a framework adapter: the engine is framework-free and this is one
binding, so a Vue or Svelte binding is a new package and nothing else.

- [ ] **Step 2: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: add the react hooks guide`.

---

## Tranche 4 — Cleanup

### Task 13: The deep dives

**Files:**

- Modify: `docs/deep-dives/index.md`, `docs/deep-dives/feasibility.md`,
  `docs/deep-dives/transcription-measurement.md`, `docs/deep-dives/snuggpro-data-model.md` (four
  stubs)
- Modify: `scripts/generate-accuracy-page.mjs` (the generated Extraction: Measured page gains spec
  §5's disclosure)
- Leave alone: `docs/deep-dives/real-audio.md` (already real content)

**Interfaces:**

- Consumes: the guides, which link here for full workings.
- Produces: four written deep dives. **It does not produce any evidence target other pages depend
  on** — that is Task 5A's job, and 5A ran long before this. (An earlier draft claimed this task
  "must land before the link does"; it is struck as incoherent, since this task runs twelve tasks
  after Task 1 and the stubs it replaces already existed, so no link to them was ever dead.)

- [ ] **Step 1: Repackage, do not paste**

Source material: `docs/implementation/01-feasibility-spike.md`,
`docs/implementation/14-transcription-measurement.md`, `docs/implementation/12-snuggpro-data-model.md`.
These are working records excluded from the site by `srcExclude`; the deep dives are the published
retelling — method, numbers, and what the numbers do and do not support.

- [ ] **Step 2: Verify the accuracy disclosure — do not re-add it**

**Task 1A already added the disclosure** to `scripts/generate-accuracy-page.mjs`. This step is a
check, not a repeat: run `pnpm docs:accuracy`, read the regenerated page, and confirm it states
plainly that extraction quality is not currently measured and why, and that it quotes none of the
superseded figures. Adding a second disclosure block would leave the page contradicting itself.

If the disclosure is missing — 1A having been skipped or reverted — add it to the **generator**,
not to its output, and say so in your report.

- [ ] **Step 3: Verify and commit**

Run `pnpm docs:accuracy` and inspect the regenerated page before building. Then `pnpm docs:build`,
`./check.sh`. Commit as `docs: write the deep dives and disclose the extraction-measurement gap`.

---

### Task 14: The design section

**Files:**

- Modify: `docs/design/index.md` (stub → Design Decisions)
- Modify: `docs/design/contributing.md` (stub → real)
- Leave alone: `docs/design/releasing.md` (already real content)

**Interfaces:**

- Consumes: everything above.
- Produces: the recorded-decision home for spec §6's `Transcriber` naming call.

- [ ] **Step 1: Write `docs/design/index.md`**

The decisions a reader needs to understand the shape of the library, sourced from
`docs/roadmap/design/ribo-design.md` (D1–D10) and the later design docs. Include, per spec §6, the
`Transcriber` naming tension recorded as **considered and closed** — the name stays, the docs explain
it once — so it is not re-litigated. Also record the ESM-only decision and the reason (the
dual-package hazard is fatal for a library carrying React context), and the headless boundary as a
layering rule enforced by ESLint rather than by `lib`.

- [ ] **Step 2: Write `docs/design/contributing.md`**

Derive from `CONTRIBUTING.md` and AGENTS.md §7 rather than duplicating them. The essential content
is the definition of done: `./check.sh` is the everyday bar, and CI runs three further steps it does
not cover — `pnpm docs:build`, `pnpm changeset status`, `pnpm test:pack-and-consume` — with the note
that adding or renaming a publishable package is exactly the case where the other three matter.

- [ ] **Step 3: Verify and commit**

`pnpm docs:build`, `./check.sh`. Commit as `docs: write the design decisions and contributing pages`.

---

### Task 15: Nine package READMEs

**Files:**

- Modify: `packages/ribo-core/README.md`, `packages/ribo-ui-react/README.md`,
  `packages/ribo-adapter-snuggpro/README.md`, `packages/ribo-extractor-openai/README.md`,
  `packages/ribo-extractor-ondevice/README.md`, `packages/ribo-transcriber-ondevice/README.md`,
  `packages/ribo-transcriber-managed/README.md`, `packages/ribo-transcriber-pdfjs/README.md`
- Create: `packages/ribo-transcriber-managed-docs/README.md` (has none today)

**Interfaces:**

- Consumes: Task 2's README package table and the guide pages, which each README links into.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Read the existing eight before rewriting any**

They are the npm front door the day R4 publishes and may already be good. Change what carries the
old framing; keep what does not.

- [ ] **Step 2: Apply one template to all nine**

Four parts, in order: what this package is in one sentence; when you would reach for it (and when
you would not); one composition example showing it plugged into the seam it implements; links to its
guide page and to the repo root. Every example imports published package names.

- [ ] **Step 3: Write the missing one**

`@azx/ribo-transcriber-managed-docs`: a `Transcriber<DocumentCapture>` with engine id
`"managed-docs"`, a hosted document-understanding API behind the host's transport with no capacity
to authenticate, composing with pdf.js in a `fallbackTranscriber` ladder. Verify the engine id and
the options type against `packages/ribo-transcriber-managed-docs/src/index.ts` and `config.ts`.

- [ ] **Step 4: Verify and commit**

`./check.sh` (Prettier covers `packages/*/README.md`). Note that `pnpm docs:build` does not read
package READMEs, so it will not catch a broken link in one — check links by hand. Commit as
`docs: one README template across all nine publishable packages`.

---

### Task 15A: Audit the doc comments the Reference is generated from

Added after review, and it is the gap both must-fail greps miss by construction. `pnpm docs:api`
regenerates the entire Reference section from TypeScript doc comments, and those comments are
saturated with audio-first prose — "The recording state machine — capture and transcription only"
(`packages/ribo-core/src/queue/schema.ts`), "the contractor threw that recording away"
(`session-extract.ts`), and many more. **No task in this plan audits them, and neither grep reaches
them**, so a repositioned site would ship guides that say one thing and a generated Reference that
says another, on the same domain.

**Files:**

- Modify: doc comments across `packages/*/src/**`, wherever framing is wrong. Source only — no
  behaviour changes.

**Interfaces:**

- Consumes: the vocabulary Tasks 1 and 6–12 established.
- Produces: a Reference section consistent with the guides.

- [ ] **Step 1: Find the drift**

Grep the package sources for framing that presumes audio is the only capture kind: `dictation`,
`recording` used to mean "any capture", `auditor`, `contractor`, `voice`, `field app`. Read hits in
context. **Most will be correct and must be left alone** — `Recording` genuinely is the audio
branch of `CaptureItem`, and `recorder.ts` genuinely is about a microphone. The target is only
comments that describe a _general_ mechanism in audio-specific terms.

- [ ] **Step 2: Fix only what is wrong, and change no behaviour**

This is a comment-only pass. If a fix seems to require renaming a symbol, stop: renaming
`Transcriber` is explicitly out of scope (spec §6), and so is every other rename. Note it as a
finding instead.

Do not touch `packages/ribo-core/src/index.ts`'s barrel comments carelessly — they are unusually
load-bearing (they document _why_ each export is public) and are already accurate.

- [ ] **Step 3: Verify and commit**

`pnpm docs:api` and read the regenerated Reference for the packages you touched. Then
`pnpm docs:build` and `./check.sh` — the full gate, because this task edits package source rather
than markdown, so lint and typecheck are live for the first time since Task 1A. Commit as
`docs: align the generated reference's doc comments with the repositioning`.

---

### Task 16: Retire `capabilities/`, audit every link, run the full bar

The closing task. Nothing here is cosmetic: it is the task that makes the two must-fail greps pass.

**Files:**

- Delete: `docs/capabilities/index.md`, `docs/capabilities/extraction.md`,
  `docs/capabilities/transcription.md`, `docs/capabilities/adapters.md`
- Modify: `docs/.vitepress/config.ts` only if anything still references the section — Task 1A
  already removed the nav entry and the sidebar block, so this task deletes files, not config

**Interfaces:**

- Consumes: Tasks 6–12, which absorbed all four pages' content.
- Produces: the final IA.

- [ ] **Step 1: Confirm the content was actually absorbed**

Before deleting, read all four pages one last time and confirm each claim now appears in a guide.
`capabilities/adapters.md` in particular carries the "a second host tool is a new adapter package
and nothing else" line, which must survive into `write-back.md`.

- [ ] **Step 2: Find every inbound link**

`grep -rn "/capabilities" docs README.md packages --include='*.md' --include='*.ts'`, excluding
`docs/reference/` (generated) and any `dist/`. Expect zero content links by now: `core-loop.md`
carried the only one and Task 11 deleted it. Fix whatever remains.

- [ ] **Step 3: Delete the directory and update the config**

- [ ] **Step 4: Full link audit**

Every internal link in `docs/` and every repo-relative link in `README.md` and the nine package
READMEs must resolve. `pnpm docs:build`'s dead-link check covers the site; repo-relative links in
READMEs are **not** covered and must be checked separately — enumerate them and confirm each target
exists.

- [ ] **Step 5: Run the two must-fail greps**

Run them exactly as Global Constraints spells them out — both excluding all of `docs/roadmap/` and
`docs/implementation/`. Both fail today; both printing nothing is the observable signal that the
pass is complete rather than partially applied. If either still prints a roadmap or implementation
path, you are running the earlier, unsatisfiable form of the grep.

- [ ] **Step 6: Run the full bar and paste the output**

`./check.sh` and `pnpm docs:build`, and per AGENTS.md §7 paste the check summary line rather than
asserting success. No publishable package was added or renamed by this plan, so
`pnpm changeset status` and `pnpm test:pack-and-consume` pass by construction — but say so
deliberately rather than by omission.

- [ ] **Step 7: Commit**

`docs: retire the capabilities section and close the repositioning pass`.

---

## Notes for the executor

- **Run `pnpm install` first.** This plan was written in a fresh worktree with no `node_modules`,
  where `pnpm format:check`, `./check.sh` and `pnpm docs:build` all fail for that reason alone
  rather than for anything about the change. Install before Task 1 so the first red you see is a
  real one.
- **Tranche 1 is the review-heavy one.** Tasks 2–16 are downstream of the framing Task 1 sets. If
  Task 1's language is wrong, stopping to fix it is far cheaper than propagating it through fifteen
  tasks.
- **The site is publishable after every task**, which is the property to protect if the plan is
  interrupted. A half-finished tranche should never leave a dead link or a stub in the nav.
- **When a page, this plan, or AGENTS.md disagrees with the source code, the source code wins.**
  Four pieces of stale prose were already found this way while planning: `toExtractStep` (the
  export is `toSessionExtractStep`), a five-package architecture table that is now nine,
  `submitReview` / `reopenForReview` (the methods are `submitSessionReview` /
  `reopenSessionForReview`), and — the substantive one — a single-state-machine pipeline that is
  now two. Assume there are more. Fix them where found rather than reproducing them, and note each
  in the commit message so the corrections are reviewable as corrections rather than buried in a
  docs rewrite.
- **Two of those corrections are load-bearing for the argument, not just accuracy.** The
  recording/session split is the repositioning stated structurally; if a page describes one machine,
  it has also lost the best evidence the docs have.
