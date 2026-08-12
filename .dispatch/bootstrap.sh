#!/usr/bin/env bash
# Prepare a freshly-created dispatch worktree so a delegated run can actually
# verify its own work.
#
# A git worktree carries no gitignored state, so it starts with no node_modules
# and cannot run vitest, tsc, eslint or ./check.sh — i.e. a delegate would be
# writing code it has no way to test. This installs the workspace.
#
# `--frozen-lockfile` is load-bearing, not a style choice: dispatch captures
# base_sha BEFORE this script runs and never commits its output, so anything
# this script writes outside a gitignored path gets attributed to the DELEGATE
# in the collected diff and leaves the worktree permanently dirty (which makes
# `collect.py --cleanup` refuse to remove it, forever). `--frozen-lockfile`
# guarantees the install touches only the gitignored node_modules/ and never
# rewrites pnpm-lock.yaml.
set -euo pipefail

corepack enable
pnpm install --frozen-lockfile
