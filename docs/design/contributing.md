# Contributing

Setup is **Node >= 24** and **pnpm 10.34.5**. The one "am I done?" signal is `./check.sh` — it runs
typecheck, lint, format, build, and test, and CI runs the same script. The conventions that bite:
the headless boundary, exact catalog pinning, the export-surface tests, and the `@azx/source` condition.

The authoritative contributor guide lives in [`CONTRIBUTING.md`](https://github.com/azx-pbc/ribo/blob/main/CONTRIBUTING.md)
at the repo root, alongside [`AGENTS.md`](https://github.com/azx-pbc/ribo/blob/main/AGENTS.md).

::: info Content coming
A fuller contributor narrative lands in the content pass.
:::
