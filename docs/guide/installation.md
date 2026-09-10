# Installation

## As a consumer

Ribo's packages are not published to npm yet — that is R4, tracked and not yet done. Until it
lands, install from source (below). The examples on this site are written the way a real
consumer will use them once R4 ships: importing the published package names directly.

```bash
pnpm add @azx/ribo-core
```

Add a UI or engine package as your app needs it, for example:

```bash
pnpm add @azx/ribo-ui-react @azx/ribo-extractor-openai
```

**Peer dependencies.** `@azx/ribo-ui-react` declares `react` and `react-dom` as peers
(`^18.3 || ^19`) — install a matching React yourself. It also declares `@azx/ribo-core` as a peer
rather than a plain dependency, because its provider hands your app's own `Recorder` and `Outbox`
instances across the package boundary: your app and `ribo-ui-react` must share one copy of core,
or those objects stop being `instanceof` what the library expects. Any future package with the
same requirement — holding your app's core objects rather than only their types — will declare
core as a peer for the same reason.

## From source

Ribo is a pnpm workspace. It requires **Node >= 24** and **pnpm 10.34.5** (pinned via
`packageManager`; `corepack enable` honors it).

```bash
pnpm install                  # bootstrap the workspace
./check.sh                    # the one "am I done?" signal: typecheck, lint, format, build, test
pnpm --filter playground dev  # dev server on http://localhost:5173
```

The `playground/` app composes every publishable package from TypeScript source, so editing a package's
`src/index.ts` hot-updates the page with no build step — useful for reading how the pieces
actually compose before you write against the published packages.

## Next

**[Quick Start](/guide/quick-start)** — extract and check your first field, with no credentials
and no model.
