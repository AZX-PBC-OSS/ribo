# Phase 1 — Contracts Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the real types and zod schemas in `@azx/ribo-core` — the vocabulary every later phase is written against. No I/O, no browser APIs called, no behavior beyond validation and small pure helpers.

**Architecture:** contracts first, in one package, with tests as the executable specification. Everything here is consumed by Phases 2–6, so getting the shapes right is worth more than getting them fast. Four independent reviews changed three of these interfaces before a line was written — see Review Findings below.

**Tech Stack:** TypeScript, zod, Vitest. `@azx/ribo-core` only.

## Global Constraints

Everything in [`AGENTS.md`](../../../AGENTS.md) applies, plus:

- **TDD.** Red → green → commit, per task. Phase 0 was scaffolding so tests came last; here behavior exists, so tests come first.
- **zod is the source of truth.** Types are `z.infer`red from schemas, never hand-declared alongside them.
- **`ribo-core` is headless** — no React, no `document`/`window` (ESLint-enforced). Browser _types_ are available; do not _call_ browser APIs in this phase.
- **Small files.** One concept per file. `src/index.ts` re-exports; it does not define.
- **No `any`.** Prefer `unknown` + a parse.

## Review Findings folded into this phase

Four reviewers (codex, opencode, a cold-read agent, an extraction spike) changed these contracts:

1. **`ctx: unknown` was an untyped hole** hiding host↔adapter coupling from the type system → `ToolAdapter<F, C>`.
2. **`ReviewPresenter.present(draft): Promise<T | null>` was too thin** — all-or-nothing, but the product UX needs per-field accept/edit/reject.
3. **Confidence carries no signal.** In the extraction spike the model returned ~1.0 on all 168 slots (mean 0.998 correct, 1.000 on correct nulls). Keep the field — one run is not grounds for removing it — but **never flag on it.** Ship a checkable span-validity signal instead.

---

### Task 1: Provenance envelope + span validity

**Files:** create `src/provenance.ts`, `src/provenance.test.ts`

**Produces:** `Extracted<T>`, `extractedSchema()`, `isSpanGrounded()`

- [ ] **Step 1: failing tests** covering — a valid envelope parses; `value: null` is valid (absence is a legitimate answer, not an error); a _missing_ `value` key is rejected (nullable + **required**, the anti-hallucination rule at schema level); `sourceSpan: null` is valid; `isSpanGrounded` returns true for a verbatim substring, false for a fabricated span, false for a null span, and **true when trailing whitespace differs but the text matches** (spans arrive trimmed).
- [ ] **Step 2:** run, confirm they fail.
- [ ] **Step 3: implement.** `extractedSchema(inner)` wraps any zod type as `{ value: inner.nullable(), confidence: z.number(), sourceSpan: z.string().nullable() }` — every key required, none `.optional()` (strict structured-output compatible). `isSpanGrounded(span, transcript)` is a pure predicate.
- [ ] **Step 4:** tests pass. **Step 5:** commit.

> Document at the definition site _why_ `confidence` exists but is not used for flagging, with the spike numbers. Someone will otherwise wire a threshold to it.

### Task 2: `Recording` and `Transcript`

**Files:** create `src/recording.ts`, `src/transcript.ts` + colocated tests

**Produces:** `Recording`, `Transcript`, and their schemas.

- [ ] **Step 1: failing tests** — a well-formed record parses; a missing required field is rejected; an unknown extra key is rejected (be strict at the boundary); ids are non-empty.
- [ ] **Step 2:** confirm red. **Step 3:** implement. `Recording`: `id`, `capturedAt`, `durationMs`, `mimeType`, plus a typed opaque `ctx` slot. `Transcript`: `recordingId`, `text`, optional `confidence`. **Audio bytes are NOT in `Recording`** — the blob is held by the queue, and this type is the metadata record; note that where someone would look for it. **Step 4:** green. **Step 5:** commit.

### Task 3: `Transcriber`

**Files:** create `src/transcriber.ts` + test

- [ ] TDD a `Transcriber` interface (`transcribe(recording, audio): Promise<Transcript>`) and a `FakeTranscriber` test double returning canned text. The double is a real deliverable — Phases 4–6 need to run the pipeline without a model.

### Task 4: `ToolAdapter<F, C>`

**Files:** create `src/adapter.ts` + test

- [ ] TDD the adapter contract: `name`, `schema: z.ZodType<F>`, `instructions: string`, `examples?`, `write(fields: F, ctx: C): Promise<void>`.
- [ ] **`C` is a real type parameter** — no `unknown`. A host's context (e.g. `{ jobId: string }`) must be visible to the type system; this was a review finding.
- [ ] Include a type-level test that a mismatched `ctx` fails to compile (`@ts-expect-error`), so the guarantee is enforced rather than asserted.

### Task 5: `ReviewPresenter` — redesigned for field-level review

**Files:** create `src/review.ts` + test

This interface was **rejected in review** as too thin. Do not reproduce `present(draft): Promise<T | null>`.

- [ ] TDD a contract supporting **per-field** accept / edit / reject, carrying provenance and the span-grounded flag through to the presenter, and returning a result that distinguishes _accepted with edits_ from _accepted as-is_ from _discarded_.
- [ ] Keep it presentation-agnostic — no React, no DOM. `ribo-ui` implements it in Phase 5.
- [ ] Model the outcome explicitly (a discriminated union beats `T | null`).

### Task 6: barrel + integration test

**Files:** modify `src/index.ts`; create `src/contracts.test.ts`

- [ ] `index.ts` re-exports the public surface only — it defines nothing.
- [ ] One test composing the pieces: a `FakeTranscriber` → a fake extraction result built from `extractedSchema` → a fake `ToolAdapter` write, asserting the types line up end to end. This is the first proof the vocabulary is coherent.
- [ ] Remove the Phase 0 `PACKAGE_NAME` placeholder from `ribo-core` **and** update the playground and any test importing it, so `./check.sh` stays green.

---

## Definition of done

- `./check.sh` green.
- Every contract has tests that fail without its implementation.
- No `any`; no hand-written type that duplicates a zod schema.
- `ctx` is typed; `ReviewPresenter` supports field-level review; `confidence` is documented as non-load-bearing.

## Deliberately NOT in Phase 1

Real transcription, real extraction, RxDB, the queue state machine, any React, any network call. Phase 1 is vocabulary only — if a task starts needing I/O, it belongs in a later phase.
