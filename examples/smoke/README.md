# example-smoke — scaffolding smoke package

This package teaches no idea. It is the scaffolding smoke package for the docs
Examples section: it exists to prove the `examples/*` wiring end to end —
workspace membership, `typecheck` in the `pnpm -r` gate, the `unit`-project
runner, and by-name `@azx/ribo-core` resolution through the `@azx/source`
condition at both typecheck and test time. It also owns the Examples page's
"anatomy of a runnable example" include until the no-key-pipeline example
lands, at which point (and only then) it is deleted in the same change that
retargets that include.

Every real example package copies this skeleton: `"private": true`, its own
`typecheck` script, `@azx/ribo-core` and `@azx/tsconfig` as `workspace:*`
devDependencies, and its runnable code in a `*.run.ts` at the package root
whose exports are zero-argument functions ending in `node:assert/strict`
assertions. Example packages carry no `*.test.ts` files — the root runner
(`examples/run-examples.test.ts`) is the only one.
