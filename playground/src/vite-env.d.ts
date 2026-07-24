/// <reference types="vite/client" />
// `vanillajs`, not `client`: `vite-plugin-pwa/client` re-exports the Vue,
// Svelte, Solid and Preact declaration files too, and those import from
// framework packages this workspace does not install — so referencing it fails
// typecheck with four "cannot find module 'vue'"-shaped errors that have
// nothing to do with us. `vanillajs.d.ts` declares exactly the one virtual
// module we import, `virtual:pwa-register`.
/// <reference types="vite-plugin-pwa/vanillajs" />

/**
 * The build-time extraction config the playground reads (see `extractor-store.ts`).
 *
 * All optional: with none set the playground runs the shipped `FakeExtractor`, so
 * the demo needs no secret. Typed here (rather than left to Vite's `[key: string]:
 * any` index signature) so `extractor-store.ts` reads `string | undefined`, not
 * `any` — the `??` defaults and the "is a key present?" check stay type-checked.
 *
 * ⚠ `VITE_OPENAI_API_KEY` is inlined into the CLIENT bundle at build time. It is a
 * dev-only convenience and a raw browser→`api.openai.com` call is CORS-blocked, so
 * the live path expects a CORS-OK endpoint (the Helix proxy in production, or a
 * local proxy) via `VITE_OPENAI_BASE_URL`. Never ship a real key this way.
 */
interface ImportMetaEnv {
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_OPENAI_BASE_URL?: string;
  readonly VITE_OPENAI_MODEL?: string;
}
