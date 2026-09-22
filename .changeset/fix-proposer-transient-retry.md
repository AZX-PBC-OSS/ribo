---
"@azx/ribo-extractor-openai": patch
---

Retry transient transport blips inside the shape-operation proposer's chat call; do not let them consume the repair budget.

`runAttempt` (`operations-proposer.ts:313-325`) was catching everything
`completeOrClassify` could throw — a model refusal, a 5xx, a 429, a
dropped connection — and folding them all into one `failure: "transport"`.
The repair loop then spent one of its attempts (default `maxRepairAttempts:
1`) on a transport blip. A 429 during the brief rate-limit window would
burn the only repair chance; on exhaustion the proposer returned `[]`,
unshaped, because the route was briefly busy.

The fix distinguishes two failure modes:

- **Model verdicts** (`refusal` / `unsupported` / `length` /
  `content_filter`) — the model's behaviour for THIS input is final. The
  proposer still routes them through the repair path (one shot) per ADR 0016.
- **Transient transport blips** (5xx, 429, dropped connection,
  malformed-response) — retried within the chat-call step via
  `retryAsync` (the same pattern `retryExtractor` and `validateExtractor`
  use). On exhaustion the proposer returns `[]` directly without
  burning a repair attempt.

The chat-call step and the repair loop now have separate retry budgets:

- `maxNetworkRetries` (default 2 — three attempts, matching
  `retryExtractor`'s default) is the chat-call retry budget. A 429
  retries silently with backoff; success returns the proposal without
  consulting the repair loop.
- `maxRepairAttempts` (default 1 — ADR 0016's argued default) is the
  model-verdict budget, unchanged.

Both budgets exhaust to `[]`. Either way, the newcomer-friendly
exhaustion default holds. ADR 0016 is amended with a single scoping
sentence to clarify what "transport verdict" means — model verdicts are
the repair-loop's case; transient blips are the chat-call retry's case.
