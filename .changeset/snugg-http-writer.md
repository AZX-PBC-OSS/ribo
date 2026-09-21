---
"@azx/ribo-adapter-snuggpro": minor
---

Add the Snugg Pro HTTP writer: `createSnuggHttpWriter({ fetchImpl })` returns a
per-group write function for the egress layer. It builds the request body with
`buildWriteBody` (no transform re-implemented), interpolates the endpoint
table's `{jobId}`/`{uuid}` templates against the context's `apiBaseUrl` — there
is deliberately no base-URL option, since the context is the one source for it
— sends `Idempotency-Key` (which the vendor ignores; duplicate protection stays
with the receipt), and parses the response with zod.

A collection write resolves with the vendor record's `uuid`. A singleton — and
the `job` — resolve with a fabricated, self-describing receipt
(`singleton:{group}:{assessmentId}`, `job:{assessmentId}`): the vendor's
singleton response definitions carry no identifier, and a uuid-shaped
fabrication would be a lie.

Failures are classified for the relay: 408, 429, 5xx and network errors stay
retryable under the relay's backoff; a 401 is split by body shape — the Helix
`{"error":{"code":…}}` envelope means the platform session lapsed (reload; the
error stays retryable), any other body means the injected credential was
rejected (terminal — a configuration fault no retry or reload fixes); a 404 on
an update and every other 4xx are terminal, the 404 naming the stale link
target and `reopenForReview` as the recovery.
