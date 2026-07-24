# Getting Started

Ribo is a pnpm workspace. It requires **Node >= 24** and **pnpm 10.34.5** (pinned via `packageManager`;
`corepack enable` honors it).

```bash
pnpm install                  # bootstrap the workspace
./check.sh                    # the one "am I done?" signal: typecheck, lint, format, build, test
pnpm --filter playground dev  # dev server on http://localhost:5173
```

The `playground/` app composes all three libraries from TypeScript source, so editing a package's
`src/index.ts` hot-updates the page with no build step.

::: info Content coming
The full walkthrough lands in the docs content pass. The commands above are accurate against the
current tree.
:::
