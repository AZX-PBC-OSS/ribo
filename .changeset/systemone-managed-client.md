---
"@azx/ribo-systemone-managed": minor
---

Add `@azx/ribo-systemone-managed` — a client for the System One API, which answers typed yes/no
(noul) and named-choice questions about a state text, with calibrated probabilities, confidences
and per-label probabilities for choice answers.

One client serves all three deployments that speak the contract — hosted TypeSafe ("Jev"), a
self-hosted `kev` server and a fine-tune — which is why the package is named for the deployment
mode (`managed`) and not for a vendor. The wire handling is the official `@typesafe-ai/sdk` (added
to the catalog at 0.6.0) rather than a hand-rolled HTTP client: the SDK shapes the request body and
parses the response, and this package maps the SDK's typed errors onto Ribo's terminal/transient
split and owns batching.

The package has no capacity to authenticate: it takes an endpoint and an injected `fetch`, and the
host's transport attaches whatever credential the call needs. The SDK requires an `apiKey` (and
would read `TYPESAFE_API_KEY` from the environment without one), so a documented placeholder string
is passed instead — the only credential-shaped thing on the wire is `Authorization: Bearer
<placeholder>`. The hosted endpoint sends no CORS headers for any origin, so a browser host points
the client at its own proxy.

The SDK's own retries are disabled (`maxRetries: 0`) — retry and backoff belong to Ribo's relay and
its arbitration ladders, and the SDK's default (2 retries with exponential backoff) would triple
the cost of every failing call and delay transient errors reaching the arbiter that acts on them.

Failure classification: 400, 401, 403, 404 and 422 reject with `SystemOneError`, which extends
core's `TerminalError` — the request itself is wrong, so an arbitration ladder should fall through
to the next rung. 429, 5xx, other statuses and network-level failures reject as plain transient
errors, so the ladder gives up rather than retrying the next rung against the same dead transport.
A caller abort rejects terminally. Questions beyond `batchSize` (default 30) are split across
sequential requests and merged — every id exactly once.

`ask` is widened to take a record of noul OR choice questions (built with the re-exported `noul`
and `choice` builders) and resolves to a record of the matching answer kinds, discriminated on a
`type` member the way the wire does — no overload preserves the noul-only shape, which served no
choice questions and could not.
