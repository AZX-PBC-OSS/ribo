#!/usr/bin/env bash
# Verify a finished dispatch worktree, independently of whatever the delegate claimed.
#
# `bootstrap.sh` makes verification POSSIBLE (installs the workspace so tsc, eslint and
# vitest can run at all). This makes it VERIFIED: dispatch.sh runs this against the
# worktree after the delegate exits, and reports the outcome as a banner above the
# collected diff.
#
# The default is deliberately the fast, high-signal subset rather than `./check.sh`:
#
#   * `./check.sh` also runs build:packages, build:app and the browser + e2e Vitest
#     projects, which drive a real Chromium through a built playground. That is minutes
#     of work against a 900s gate ceiling, and a timeout here reads as a failure while
#     telling you nothing about the delegate's actual change.
#   * Every task in the extraction-observability plan is unit-testable with fakes — the
#     plan says so explicitly, and a task reaching for a browser has misread its scope.
#
# So the default gate is: does it compile, does it lint, is it formatted, do the node
# tests pass. `./check.sh` runs once, by Claude, after the diffs are integrated.
#
# Pass `--full` (via dispatch.sh's `--verify-args`) to run the whole check.sh instead,
# for a run where that is worth the wall clock.
#
# NOTHING HERE MAY WRITE A TRACKED FILE. dispatch captures base_sha before the run and
# attributes any non-gitignored change to the DELEGATE, which both corrupts the diff and
# leaves the worktree permanently dirty so `collect.py --cleanup` refuses it forever.
# `format:check` not `format`; `lint` not `lint:fix`. `dist/` and `node_modules/` are
# gitignored, so a build is safe — but the default below does not need one.
set -uo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--full" ]]; then
  exec ./check.sh
fi

failed=()
run_stage() {
  local name="$1"
  shift
  echo "==> ${name}"
  if "$@"; then
    echo "<== ${name}: ok"
  else
    echo "<== ${name}: FAIL"
    failed+=("${name}")
  fi
}

run_stage "typecheck" pnpm typecheck
run_stage "lint" pnpm lint
run_stage "format:check" pnpm format:check
# The `unit` project only. The `browser` and `e2e` projects need a built playground and a
# real Chromium; see the header for why they are not the gate here.
run_stage "test:unit" pnpm vitest run --project unit

echo
echo "----------------------------------------"
if ((${#failed[@]})); then
  echo "verify.sh: FAIL — ${failed[*]}"
  exit 1
fi
echo "verify.sh: PASS"
