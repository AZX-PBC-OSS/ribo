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
# Two build stages, not one, so a failure is attributable: a library build that
# cannot emit is a different diagnosis from an app that cannot bundle.
#
# `build:packages` produces every publishable `dist/` and runs publint (strict)
# + attw (level: error) in-build, so a broken `exports` block fails here rather
# than in a later job.
run_stage "build:packages" pnpm build:packages
# The user-facing sizing command, run by the built bin against the Snugg
# adapter's generated JSON Schema document — the same file a consumer installs
# — with the route's caps pinned on this line. Gates from the other side what
# the adapter's internal cap tests guard: the command's own exit codes, output
# discipline and report contract, so a T5 contract bump or schema drift reddens
# CI here instead of un-gating. Sits immediately after `build:packages` because
# both inputs (the bin, the artifact) are its products. The depth pin is 14, not
# the vendor's 12: the command measures the DERIVED extraction schema
# (`describeExtraction` derives before measuring) and reports 14 on today's
# artifact, while the vendor's error text (`nest <= 12 levels`) binds the plain
# split pieces — a different measure the adapter's per-group-cap.test.ts pins at
# exactly 12. The character pin is the vendor cap verbatim. A legitimate schema
# deepening re-pins 14 deliberately; the count is tied to the adapter's exported
# cap by packages/ribo-cli/src/snugg-schema-gate.test.ts so it cannot drift
# silently.
run_stage "snugg:inspect" node scripts/check-snugg-schema.mjs --max-depth 14 --max-piece-chars 32768
# Replaces the guard that building destroyed. Runs AFTER build:packages (for
# diagnostic clarity — a resolve failure reads better against a built tree) and
# BEFORE build:app because a resolution failure explains most bundling failures
# that would follow it. NOTE: `import.meta.resolve` does exports resolution
# without stat-ing the target, so this gate does NOT prove `dist/` exists — file
# existence is covered by publint in the build stage, not here.
run_stage "resolve" pnpm check:resolve
# The playground's production build is the only gate that exercises Vite's
# resolver, the `@azx/source` condition, the JSX transform, React dedup and
# real bundling. `tsc` cannot see any of that. Both run after the cheap static
# gates (so their output is not buried) and before `test`, because a module
# resolution failure explains most test failures that would follow.
run_stage "build:app" pnpm build:app
# The docs site build is the only gate that runs VitePress's dead-link check and
# TypeDoc's entry-point/{@link} validation. It builds the static site into
# `docs/.vitepress/dist`. Part of the everyday loop so broken docs fail here and
# in CI alike, not only in CI.
run_stage "docs:build" pnpm docs:build
# The three publishing gates publint and attw do not cover: no TypeScript source in
# any tarball, exactly one resolved React, and react/react-dom declared as peer
# deps (not regular deps) where used. Runs here rather than in CI alone so
# `./check.sh` stays the single "am I done?" signal.
run_stage "pkg:gates" pnpm check:pkg
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
# The scorer's own mutation tests. A standalone node script with its own harness and
# exit code — not a vitest file — which is exactly how 1,175 lines of build-perfect /
# mutate-one-leaf / assert-red assertions came to match no glob and run nowhere. They are
# the most rigorous tests in the repo and they were dead weight until this line existed.
# Vendor drift: are the field descriptions we send to the extraction model still the
# ones Snugg Pro publishes? Fetches the live spec and REPORTS a mismatch — it never
# regenerates, because a vendor rewording silently changing the model's prompt is
# exactly what a reviewable diff is for. Skips with a warning (exit 0) when the spec is
# unreachable: a build that fails on someone else's downtime teaches people to ignore it.
run_stage "snugg:drift" pnpm snugg:check

run_stage "skips:tracked" pnpm skips:check
run_stage "score:mutations" node docs/spikes/0001-extraction-snuggpro/score.test.mjs

run_stage "test" pnpm test

printf '\n----------------------------------------\n'

if [ -z "$failed" ]; then
  printf 'check.sh: PASS — typecheck, lint, format:check, build:packages, snugg:inspect, resolve, build:app, docs:build, pkg:gates, snugg:drift, skips:tracked, score:mutations, test\n'
  exit 0
fi

printf 'check.sh: FAIL — the following stage(s) failed:\n'
printf '%s' "$failed" | sed 's/^/  - /'
exit 1
