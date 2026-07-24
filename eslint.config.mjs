import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-preview/**", // manual local production preview (playground); gitignored, regenerable
      "playground/public/ort/**", // minified ONNX Runtime files copied from onnxruntime-web/dist by
      //                             vite.config.ts's serveOrtRuntime; gitignored, regenerable, not ours
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.d.ts",
      // Generated docs: VitePress build/cache and the TypeDoc-generated API Reference. Regenerable,
      // not ours to lint. The hand-written `docs/.vitepress/config.ts` is deliberately NOT ignored.
      "docs/.vitepress/cache/**",
      "docs/.vitepress/dist/**",
      "docs/reference/**",
    ],
  },

  js.configs.recommended,

  // Syntactic rules only for now. Type-aware linting (recommendedTypeChecked +
  // projectService) lands once packages have real source to point at — see the
  // Phase 1 plan. Adding it here would only lint an empty repo.
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Unused vars are errors, but allow the _-prefix escape hatch.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Enforce `import type` so verbatimModuleSyntax can erase types cleanly.
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },

  // Browser globals for UI and the playground.
  {
    files: ["packages/ribo-ui-react/**/*.{ts,tsx}", "playground/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },

  // The "headless" boundary for the engine packages.
  //
  // This is enforced here, not by omitting the DOM lib from tsconfig. `lib`
  // controls which *types* exist, and these packages are built on browser APIs
  // — MediaRecorder, IndexedDB, fetch, Blob, AudioContext, Worker — so they
  // need `lib: ["ES2023", "DOM", "DOM.Iterable"]` (see
  // @azx/tsconfig/browser-library.json). "Headless" means no React and no DOM
  // rendering, which is a layering rule, and layering rules belong in lint.
  {
    files: [
      "packages/ribo-core/**/*.{ts,tsx}",
      "packages/ribo-adapter-snuggpro/**/*.{ts,tsx}",
      "packages/ribo-extractor-openai/**/*.{ts,tsx}",
    ],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react/*", "react-dom/*"],
              message:
                "These packages are headless: no React, no DOM rendering. Browser APIs (MediaRecorder, IndexedDB, fetch, Blob, AudioContext, Worker) are fine here — React components, hooks and rendering belong in @azx/ribo-ui-react, which consumes this package's plain-TypeScript API.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "document",
          message:
            "These packages are headless: no DOM manipulation. Browser APIs (MediaRecorder, IndexedDB, fetch, Blob, AudioContext, Worker) are fine here, but reaching for `document` means you are rendering or querying the page — that belongs in @azx/ribo-ui-react. Accept the values you need as arguments instead.",
        },
        {
          name: "window",
          message:
            "These packages are headless: no DOM manipulation. Browser APIs (MediaRecorder, IndexedDB, fetch, Blob, AudioContext, Worker) are fine here and are available as bare globals — use `fetch(...)`, not `window.fetch(...)`. Anything genuinely window-scoped (resize, history, DOM events) belongs in @azx/ribo-ui-react.",
        },
      ],
    },
  },
);
