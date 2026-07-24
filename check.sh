#!/usr/bin/env bash
#
# The single "am I done?" signal for this repo — used by both agents and CI.
# Runs every gate in order and reports a PASS/FAIL summary. Non-zero exit if
# any stage fails.
#
# Usage: ./check.sh

set -euo pipefail

cd "$(dirname "$0")"

# Newline-separated list of failed stage names. A plain string rather than an
# array so this stays correct under `set -u` on bash 3.2 (macOS system bash).
failed=""

run_stage() {
  local name="$1"
  shift

  printf '\n==> %s\n' "$name"

  if "$@"; then
    printf '<== %s: PASS\n' "$name"
  else
    printf '<== %s: FAIL\n' "$name"
    failed="${failed}${name}"$'\n'
  fi
}

run_stage "typecheck" pnpm typecheck
run_stage "lint" pnpm lint
run_stage "format:check" pnpm format:check
# The playground's production build is the only gate that exercises Vite's
# resolver, the `@azx/source` condition, the JSX transform, React dedup and
# real bundling. `tsc` cannot see any of that. It runs after the cheap static
# gates (so their output is not buried) and before `test`, because a module
# resolution failure explains most test failures that would follow it.
run_stage "build" pnpm build
# Runs ALL THREE Vitest projects in one pass: `unit` (node), `browser`
# (Playwright/Chromium) and `e2e`. The reporter is configured in vitest.config.ts
# to tag every file with its project, so this stage's output shows which projects
# actually ran — "all green" and "the browser project silently matched no files"
# are otherwise indistinguishable.
#
# `e2e` is Phase 2.5's acceptance suite. Each file builds the playground and
# serves `dist/` through `vite preview`, then drives a real Chromium:
#
#   offline-boot.e2e.test.ts        records audio, cuts the network with
#                                   `context.setOffline(true)`, reloads, and
#                                   asserts the app boots with the queue intact.
#   eviction.e2e.test.ts            wipes IndexedDB and Cache Storage the way a
#                                   browser reclaiming space would, and asserts
#                                   the user is TOLD rather than shown an empty
#                                   list. Includes a negative control (a queue
#                                   the user cleared is not reported as loss)
#                                   and the documented blind spot (a full sweep
#                                   that also takes the marker is not detected).
#   storage-persistence.e2e.test.ts asserts the persistence panel repeats the
#                                   answer `navigator.storage.persist()`
#                                   actually gave, and that the iOS
#                                   Add-to-Home-Screen nudge appears only on iOS.
#
# All three run headlessly and are GATED here — none of this is a manual check.
# On its own:
#   pnpm vitest run --project e2e
#
# Requires the Chromium binary: `pnpm exec playwright install chromium`. The npm
# package alone is not enough, and the failure is a launch error, not a missing
# module.
run_stage "test" pnpm test

printf '\n----------------------------------------\n'

if [ -z "$failed" ]; then
  printf 'check.sh: PASS — typecheck, lint, format:check, build, test\n'
  exit 0
fi

printf 'check.sh: FAIL — the following stage(s) failed:\n'
printf '%s' "$failed" | sed 's/^/  - /'
exit 1
