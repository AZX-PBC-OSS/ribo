---
"@azx/ribo-adapter-snuggpro": patch
---

The acceptance tree's CLI-backed transport now lives in `@azx/ribo-cli`, which publishes it; this package's acceptance code imports it from there. The `ajv` devDependency leaves with the file — nothing in this package's tree imports `ajv` by value any more. No runtime change: the package ships only `dist`.
