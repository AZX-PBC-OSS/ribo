# @azx/ribo-ui-react

The React layer over the Ribo engine — recorder and review components that render `@azx/ribo-core`'s
headless state, shipping their own CSS. This is where React, hooks, and DOM rendering live; the engine
and adapter packages stay headless. It is the `react` variant of the `ribo-ui-*` category (AGENTS §6.1);
a differently-styled implementation of the same components could land later as a sibling variant.

## Status: stub

**This package has no components yet.** Its public surface is currently a single placeholder constant:

```ts
export const PACKAGE_NAME = "@azx/ribo-ui-react" as const;
```

There is no real API to document, and `@azx/ribo-ui-react/styles.css` has no source stylesheet behind it
yet. The package's manifest, `exports`, `peerDependencies` (React as a peer, `@azx/ribo-core` shared as a
peer) and tsconfig are wired for a React library, so components can land without further scaffolding.

## Installation

```bash
pnpm add @azx/ribo-ui-react @azx/ribo-core react react-dom
```

> Not yet published to a public registry, and not yet functional — see the status note above.

This README will grow a real API-at-a-glance and usage example once the recorder and review components
exist. Until then, drive the pipeline directly through [`@azx/ribo-core`](../ribo-core/README.md).
