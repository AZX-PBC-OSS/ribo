---
"@azx/ribo-transcriber-managed-docs": patch
---

Add `@azx/ribo-transcriber-managed-docs` — managed document transcription behind the host's transport.

A new publishable package implementing `Transcriber<DocumentCapture>` with engine id `"managed-docs"`, reaching a hosted document understanding API over HTTP. The package has **no capacity to authenticate**: it takes an endpoint and an injected `fetch`, so the credential lives in the host's transport and never in the package — mirroring `ribo-transcriber-managed` exactly.

`capability()` is cheap (no network): missing endpoint or transport → `not-configured`; an injected connectivity predicate reporting down → `offline`. Both are situations, not permanent facts.

`transcribe()` POSTs the document bytes and flattates the response into text matching pdf.js conventions: `" | "` between table cells, newlines between rows, `\n===== PAGE n =====\n` per page. Three failure classes are kept distinct: 5xx/network/malformed-body → attempt failure (queue backoff owns it); 401/403 → `TranscriberUnavailableError` (capability); 415/413/encrypted-error/no-text → `UnsupportedItemError` (item unsuitability, routes the fallback ladder to pdf.js).

Composes with no core change: `fallbackTranscriber([managedDocs, pdfjs], unsupportedFallsThrough)` — managed when reachable, pdf.js when the uplink is down or the service refuses the item.
