# Spend: the estimate and the ceiling

Every `ribo eval` run prints a cost estimate to stderr **before the first model call**, and refuses
to start when the estimate is over the ceiling. The estimate is an **upper bound, not a forecast** —
it says so on its face — because an estimate that undercounts refuses too late: the money is
already spent. Overcounting is the safe direction: the run refuses early, and you raise the
ceiling.

## How the bound is computed

The estimate reads the run's own settings and never restates a formula:

- **Calls** — the worst-case calls per case are read off the same call model `ribo schema
inspect` reports (`describeCalls`), computed **with the run's own split caps** — a tight
  `--max-serialized-chars-per-group` changes how the schema splits, and the estimate prices the
  split the run will actually make. A **planned** arm's count comes from core's dry run over the
  reviewed plan instead: the plan's pieces are packed into their actual calls under the run's own
  caps, and the packed-call count is what the multipliers below apply to. Every rung of an arm's
  ladder counts, because each rung can run and fail before the next starts; under `--consensus`,
  the arm's count is multiplied by the candidate count. A rung whose bound the call model cannot
  state — the presence-narrowed strategy over a schema with no groups, or a schema the split
  refuses — makes the estimate **underivable**, and the run is refused with the cause named: no
  flag coerces "no bound" into a number.
- **Retries** — a call's worst case is `1 + maxRetries` attempts, where the retry budget comes
  from `--max-retries` (default: 2). Setting `--max-retries 0` removes the multiplier: the retry
  factor becomes one. The multiplier applies to every rung of the ladder — including a
  `single-shot` rung, which passes no retry budget to its extractor and never retries — so a
  single-shot arm's estimate overcounts in the safe direction.
- **Tokens** — the prompt tokens are measured from the run's real prompts (document cases are
  transcribed first, so the estimate prices the text the run will send, not a schema-sized guess;
  a planned arm's prompts are measured from its real packed calls, plan descriptions included);
  the completion tokens are the run's `--response-cap`, or the default cap when none is set.
- **Price** — the tokens are priced from a dated table in the CLI package; discounts are ignored,
  which overcounts, the safe direction.

Every multiplier above applies to a planned arm over its whole ladder: the ladder rungs, the retry
attempts per call and the consensus candidates all count against the packed-call bound, so a
planned arm's ceiling is derived from the same worst case as any other arm's — never from the
plan's ideal call count. When no safe bound exists for a planned arm — a schema the split refuses
under the run's caps, so the packed calls cannot be constructed — the run is refused before any
backend work: no preflight, no transcription, no chat.

## The per-model rows, and the fallback

The price table is keyed by backend and, where a row exists, by model id. A model with its own
dated row — the table carries the models the help and these docs name (`gpt-4o` on
`openai-compatible`; `claude-sonnet-5-5` and `claude-haiku-5-5` on `claude-cli`) — is priced on
that row, and the estimate names it. **Any other model is priced on its backend's reference row,
and the estimate says it fell back and names the reference it used** — a model is never silently
priced at the wrong class's prices. A model whose list price cannot be stated from a public source
gets no row and takes the fallback; no price is invented.

Authoring has its own ceiling: `ribo schema init`, `ribo schema plan` and `ribo corpus propose`
print the same kind of upper-bound estimate and refuse above `--max-spend` before their first
call. The authoring-side behavior — what a plan costs to write and update — is
[Planning and authoring](/cli/planning); this page is the run-side bound.

`ribo corpus propose` prices one initial proposal call per case that has unanswered leaves, each
on that case's own measured prompt (document cases are transcribed first, so a PDF is priced at
the text it actually yields), and sums the per-case bounds into one invocation-wide estimate —
never one corpus-sized call, never every case at the largest prompt. Each per-case bound carries
the same multipliers as init: one semantic repair round, two transport retries and the authoring
CLI shape budget, with the completion side at `--response-cap` or the default cap. The repair
request quotes only the named problems, bounded in size, so the per-attempt growth term stays
small on long case texts and never scales with `--response-cap`. The ceiling is **per
invocation**: proposing a corpus in chunks — a `--only` scope at a time, or a few case ids per
run — spends up to the ceiling for each chunk, not across all chunks combined.

The `claude-cli` and `codex-cli` backends are subscriptions: their use is not metered per token.
Their rows price the run at the token-equivalent list price of the named class, and the estimate
prints that assumption on its own `assumption:` line — your actual marginal cost is the
subscription fee.

## The ceiling

`--max-spend <usd>` sets the ceiling on the estimated spend (default USD 10.00). Over it:

- on a terminal (stdin **and** stderr both TTYs), the command asks `continue? [y/N]` — anything
  but `y`/`yes`, including end of input, refuses;
- piped, or answered "no", the run is refused with exit 2 before any model call, naming the
  estimate, the ceiling, and the way through;
- `--yes` proceeds without asking.

## The CLI backends

`--backend claude-cli` and `--backend codex-cli` spawn the `claude` / `codex` binary **you already
have installed**, on your own subscription login — the CLI carries no credential for them and has
no capacity to hold one. Before the run starts, the binary is preflighted with `<binary>
--version`, so a missing or non-answering binary is reported up front, as itself — never as a
spend refusal or a corpus fault. `--model` is required on every backend: the openai-compatible
backend sends it in each request, and the CLI backends pass it to the binary they spawn
(`claude --model`, `codex -m`).

One caveat: a CLI cannot cap generated tokens, so `--response-cap` with a CLI backend is refused up
front; run against `--backend openai-compatible`, which honours the cap. The same asymmetry shapes
an over-ceiling refusal's cheaper fixes: on `openai-compatible` the refusal may recommend naming
fewer case ids, narrowing the asked leaves with `--only`, or lowering `--response-cap`; on
`claude-cli` or `codex-cli` it recommends only fewer case ids or a narrower `--only` — never a
flag that backend refuses.

`--timeout <seconds>` sets how long one CLI call may run before its case fails (default 600 — a
large-document prompt takes a CLI minutes to answer, and a timed-out call's failure names the
flag as the fix). On `openai-compatible` the flag is refused up front, the mirror of the
`--response-cap` refusal: the HTTP transport has no per-call timeout to set.
