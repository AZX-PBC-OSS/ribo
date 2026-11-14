<!-- Ribo's standing rules: read once per azx run and binding on every prompt. -->

- No AI attribution anywhere: no Co-Authored-By trailers, no "Generated with" lines, in commits, PR bodies or files.
- No test or step spends on a real model or calls a paid endpoint: stub `ChatClient`s, local stub servers and stub binaries only; paid runs are an operator step.
- Never read, print or commit a credential; `.env.local` is gitignored and never echoed.
- Decisions go in ADRs (`docs/adr/NNNN-title.md`, one per file, never rewritten); implementation plans and ticket text are never committed.
- Comments are terse and say why; no hardcoded counts (fields, groups, calls, cases) in comments or docs prose, tests pin counts.
- Every published-package change carries a changeset; new public API is a minor bump.
- Exports of a TypeDoc entry point carry TypeDoc docs; TypeDoc warnings are errors.
- No browser-targeted package gains a `node:*` import.
- The CLI backends spawn the installed `claude`/`codex` binaries, never the vendor SDKs.
- Never weaken, skip or filter a gate or test to go green; skips are tracked.
