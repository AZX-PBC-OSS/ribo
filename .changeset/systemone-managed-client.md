---
"@azx/ribo-systemone-managed": minor
---

Add `@azx/ribo-systemone-managed` — a client for the System One HTTP API, which answers typed
yes/no questions about a text with calibrated probabilities (noul values).

One client serves all three deployments that speak the contract — hosted TypeSafe ("Jev"), a
self-hosted `kev` server and a fine-tune — which is why the package is named for the deployment
mode (`managed`) and not for a vendor.

The package has no capacity to authenticate: it takes an endpoint and an injected `fetch`, and the
host's transport attaches whatever credential the call needs. The hosted endpoint sends no CORS
headers for any origin, so a browser host points the client at its own proxy.

Failure classification is the package's job; retrying is the caller's. 401 and 422 reject with
`SystemOneError`, which extends core's `TerminalError` — the request itself is wrong, so an
arbitration ladder should fall through to the next rung. 429, 529 and network-level failures
reject as plain transient errors, so the ladder gives up rather than retrying the next rung
against the same dead transport. Questions beyond `batchSize` (default 30) are split across
sequential requests and merged — every id exactly once.
