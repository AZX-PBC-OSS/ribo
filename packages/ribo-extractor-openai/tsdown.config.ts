import { defineConfig } from "tsdown";

import { sharedTsdown } from "@azx/build-config";

// `sharedTsdown.deps.neverBundle` is a fixed two-regex array (React, by name) as of this
// writing, never `true` ("externalize everything") for any package that uses it. Asserted
// rather than defensively spread so a future change to that shape fails loudly here instead of
// silently dropping the React externalization this config extends below.
const sharedNeverBundle = sharedTsdown.deps?.neverBundle;
if (!Array.isArray(sharedNeverBundle)) {
  throw new Error("@azx/build-config's sharedTsdown.deps.neverBundle is no longer an array");
}

export default defineConfig({
  ...sharedTsdown,
  // The object form is REQUIRED, not merely preferred: the `./cli-chat` export points at
  // `./dist/cli-chat.js`, so the output filename is part of the published contract — same
  // reasoning as `@azx/ribo-transcriber-ondevice`'s `./worker` entry. `cli-chat.ts` is a SEPARATE
  // entry (not re-exported from `index.ts`) because it imports Node built-ins
  // (`node:child_process`/`node:fs`/`node:os`) that must never enter the browser bundle
  // `index.ts` feeds (`playground/src/extractor-store.ts` imports `index.ts` by value) — see
  // `cli-chat.ts`'s file header.
  entry: { index: "src/index.ts", "cli-chat": "src/cli-chat.ts" },
  // `cli-chat.ts` imports Node builtins (`node:child_process`, `node:fs`, `node:os`,
  // `node:path`). `sharedTsdown` forces `platform: "browser"` for every entry (correct for
  // `index.ts`), so rolldown does not know these are intentional Node builtins and would
  // otherwise warn `UNRESOLVED_IMPORT ... treating it as an external dependency` on every one —
  // harmless (the import is left exactly as written, which is what a Node-only entry needs at
  // runtime) but noisy. Declaring them external explicitly makes that deliberate. Extends
  // (rather than replaces) `sharedTsdown.deps.neverBundle`, which already externalizes React by
  // regex the same way — plain `external` cannot be combined with `deps.neverBundle`.
  deps: { neverBundle: [...sharedNeverBundle, /^node:/] },
});
