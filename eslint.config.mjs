import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeAwareFiles = [
  "packages/*/src/**/*.{ts,tsx}",
  "playground/src/**/*.{ts,tsx}",
  // The e2e specs have their own project (playground/tsconfig.e2e.json, include:
  // ["e2e"]), so the project service finds them — they get the same type-aware
  // gate as every other test file.
  "playground/e2e/**/*.{ts,tsx}",
];

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

  // Syntactic TypeScript rules for every TS/TSX file (and the loose .mjs scripts
  // that are not part of a package tsconfig). Type-aware rules are layered on
  // top of this only for files inside package/playground source trees.
  ...tseslint.configs.recommended,

  // Type-aware linting. projectService discovers each package's tsconfig.json
  // automatically, so recommendedTypeChecked rules have real source to point at.
  // Scoped to source files only: package-root config files are intentionally
  // outside their tsconfig `include` and stay syntactic-only.
  ...tseslint.configs.recommendedTypeChecked.map((cfg) => ({
    // `files` must come AFTER the spread: the preset's middle entry
    // (`typescript-eslint/eslint-recommended`) carries its own all-TS `files`,
    // which would otherwise outscope this one — and drag the projectService
    // onto every .ts file on disk, including spikes in no tsconfig, which then
    // fail with "was not found by the project service".
    ...cfg,
    files: typeAwareFiles,
    languageOptions: {
      ...cfg.languageOptions,
      parserOptions: {
        ...(cfg.languageOptions?.parserOptions || {}),
        projectService: {
          allowDefaultProject: [
            "*.ts",
            "*.mjs",
            "scripts/*.mjs",
            "scripts/*/*.mjs",
            "packages/*/tsdown.config.ts",
            "packages/*/vitest.acceptance.config.ts",
            "packages/*/vitest.manual.config.ts",
            "packages/ribo-adapter-snuggpro/acceptance/*.manual.ts",
            "docs/.vitepress/config.ts",
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 100,
        },
      },
    },
    rules: {
      ...cfg.rules,
      // 191 hits, every one an implementation of a Promise-returning contract method —
      // `async write(...) { return x; }` — where `async` is how the return type is satisfied and
      // there is nothing to await. The alternative is `Promise.resolve` at every such site, which
      // is worse. NOT because interfaces are exempt: interfaces have no bodies and never fire it.
      "@typescript-eslint/require-await": "off",
    },
  })),

  {
    // Every package, not a subset: the rule exists so the contravariant declaration is the
    // default nobody has to remember, and a rule covering three of ten packages is not a default.
    files: ["packages/*/src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/method-signature-style": ["error", "property"],
    },
  },

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

  // Browser globals for the accuracy report's plain-JS inspector script. Served
  // as a static file from docs/public/, loaded by the generated accuracy page.
  {
    files: ["docs/public/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
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
      "packages/ribo-chat-helix/**/*.{ts,tsx}",
      "packages/ribo-chat-openai/**/*.{ts,tsx}",
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
