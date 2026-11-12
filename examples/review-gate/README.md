# example-review-gate — the review gate before write-back

One idea: **nothing is written until a human resolves the review, stated
positively.** `docs/api/examples/relay.run.ts` demonstrates the gate only
incidentally — it asserts one write after `submitReview` but never zero writes
before it, and its write is a bare stub rather than an adapter.
`docs/api/examples/review.run.ts` covers `buildReviewRequest`/`resolveReview`
as pure functions with no storage behind them. This example composes the three:

- **The relay gets its chance to write.** After the session reaches
  `awaiting-review`, `relay.syncNow()` runs again — and the adapter double's
  write count is asserted to be `0`. A zero assertion made before the relay
  ever ran would prove nothing.
- **The write step is the host's real shape.** A tool-neutral `ToolAdapter`
  double behind `toWriteStep` — no Snugg Pro names, no bypass path — so the
  write that eventually happens is the one a host actually wires.
- **Exactly one write, carrying the reviewed values.** After
  `storage.sessions.submitReview`, one more `syncNow` produces exactly one
  write whose fields hold the reviewer's edited value, not the raw extraction.

It does not re-teach the pure review contract (`review.run.ts` owns that) or
the relay's drain mechanics (`relay.run.ts` owns those). Runs credential-free
against in-memory storage, an injected clock and a granting lock manager. Its
code is pulled into `docs/guide/review.md` (the review-contract and gate
regions) and `docs/guide/write-back.md` (the relay-wiring region) by VitePress
snippet includes, and the runner (`examples/run-examples.test.ts`) executes
its export in the `unit` project on every `./check.sh` run.
