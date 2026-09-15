import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeAwareFiles = ["packages/*/src/**/*.{ts,tsx}", "playground/src/**/*.{ts,tsx}"];

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
      // Spikes are exploratory scratch code, not shipped or part of the everyday
      // build/test surface. Linting them type-aware would pull in ad-hoc
      // tsconfigs that do not exist; keep them out of the gate.
      "spikes/**",
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
    files: typeAwareFiles,
    ...cfg,
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
      // Interface and abstract contract methods are async because implementations
      // await; the declaration site has no `await` expression by design.
      "@typescript-eslint/require-await": "off",
    },
  })),

  // Test files deliberately probe and stub external APIs, so unsafe `any` from
  // test doubles, zod internals and browser mocks is expected. Disable the
  // type-aware rules that fire on deliberate fixture code while keeping the
  // rest of the type-aware rules active.
  {
    files: ["**/*.test.{ts,tsx}", "**/*.browser.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

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
