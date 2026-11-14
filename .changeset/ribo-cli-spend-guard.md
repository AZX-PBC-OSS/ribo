---
"@azx/ribo-cli": minor
---

`ribo eval` — a pre-flight spend guard, and the secrets it reads.

Every run now prints an upper-bound cost estimate to stderr before the first model call, and
refuses the run — exit 2, the could-not-run code — when the estimate is above the ceiling. The
two new flags are `--max-spend <usd>` (the ceiling; USD 10.00 by default) and `--yes` (proceed
even when the estimate is above it). On a terminal the command asks instead of refusing outright;
with no terminal it refuses rather than hanging on a question nobody can answer.

The estimate's call model is inspect's own `describeCalls`, called once per run under the run's
own split caps, so a tight byte cap changes the bound the guard reads. Every rung of an arm's
ladder is counted (each rung can run and fail before the next starts), the consensus modifier
multiplies the whole ladder, and the retry budget multiplies the result by `1 + maxRetries`. A
bound the call model cannot state — a null `presenceNarrowedAtMost`, over a schema with no groups
or a split that cannot fit a piece — refuses the run rather than coercing the null to zero or
substituting another strategy's count, and no flag overrides that refusal. The tokens are measured
from the prompts the run really sends, and priced from a dated per-backend table in this package;
the two subscription CLI backends carry a stated token-equivalent assumption.

The credential comes from the environment, or from the working directory's gitignored `.env.local`;
the environment wins. A missing credential names the key and both places the CLI looked. No
credential-bearing flag exists, and none may.
