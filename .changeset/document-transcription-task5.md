---
"@azx/ribo-transcriber-pdfjs": patch
---

Add `@azx/ribo-transcriber-pdfjs` package skeleton with `capability()`.

Creates the `@azx/ribo-transcriber-pdfjs` package — a `Transcriber<DocumentCapture>` with engine id `"pdfjs"` for PDF document transcription via pdf.js. Task 5 implements the package skeleton (package.json, tsconfig, tsdown, README, config) and the cheap half of the contract: `capability()` answers only from the environment without loading pdf.js — no `Worker` constructor → `unsupported-platform` (permanent), no configured worker URL → `not-configured` (not permanent), otherwise `ready`. The worker URL is injected by the consumer per AGENTS.md §5.2. Adds `pdfjs-dist` to the catalog, adds the package to the playground, bumps the gate counts, and fixes stale package counts across the repo.
