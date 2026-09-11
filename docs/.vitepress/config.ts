import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import type { DefaultTheme } from "vitepress";

/**
 * The generated API Reference sidebar. TypeDoc (`pnpm docs:api`) writes this file next to the
 * Reference markdown before either `docs:dev` or `docs:build` runs VitePress. Loaded defensively
 * so a bare `vitepress` invocation (before `docs:api`) degrades to an empty Reference sidebar
 * rather than crashing the config.
 */
function referenceSidebar(): DefaultTheme.SidebarItem[] {
  try {
    const path = fileURLToPath(new URL("../reference/typedoc-sidebar.json", import.meta.url));
    return JSON.parse(readFileSync(path, "utf8")) as DefaultTheme.SidebarItem[];
  } catch {
    return [];
  }
}

// Configurable base path so a subpath deploy (e.g. Helix under `/ribo/`) works without a rebuild
// of anything but this value: `DOCS_BASE=/ribo/ pnpm docs:build`. Defaults to root.
const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
  base,
  lang: "en-US",
  title: "Ribo",
  description:
    "Structured extraction from any source: documents, dictation, or both at once — with provenance you can check, human review as a contract, and offline-first durability.",
  // Helix's static host matches request paths to files exactly and falls back to the site's
  // index.html for anything that doesn't match (see docs/AGENTS or the helix-app skill). Clean
  // URLs link to paths without a `.html` extension, which never match the on-disk file on a host
  // that doesn't do extension resolution -- a direct load of a nested page then silently renders
  // the home page's markup underneath the sidebar. Keeping the `.html` extension in generated
  // links keeps every direct load an exact match.
  cleanUrls: false,
  // The internal process docs live under docs/ but are not part of the public site. The roadmap
  // (design specs and per-phase plans) stays committed but unpublished; the implementation findings
  // are repackaged into Deep Dives (Task 2), not served raw.
  srcExclude: ["roadmap/**", "implementation/**", "open-questions.md"],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Comparison", link: "/guide/comparison" },
      { text: "Offline-first", link: "/offline-first/" },
      { text: "Deep Dives", link: "/deep-dives/" },
      { text: "Reference", link: "/reference/" },
      { text: "Design", link: "/design/" },
    ],
    sidebar: {
      // One `/guide/` directory, two sidebar groups. A sibling `guides/` directory was
      // considered and rejected: two paths one character apart are a permanent source of
      // wrong links. See docs/roadmap/design/docs-repositioning-design.md §4.
      "/guide/": [
        {
          text: "Getting Started",
          items: [
            { text: "Overview", link: "/guide/" },
            { text: "Motivation", link: "/guide/motivation" },
            { text: "Comparison", link: "/guide/comparison" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Quick Start", link: "/guide/quick-start" },
            { text: "Important Defaults", link: "/guide/important-defaults" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "Typesafety", link: "/guide/typesafety" },
            { text: "Provenance", link: "/guide/provenance" },
            { text: "Schema at Scale", link: "/guide/schema-at-scale" },
            { text: "Captures & Sources", link: "/guide/captures-and-sources" },
            { text: "Sessions", link: "/guide/sessions" },
            { text: "Extraction", link: "/guide/extraction" },
            { text: "Arbitration & Fallback", link: "/guide/arbitration" },
            { text: "Review", link: "/guide/review" },
            { text: "Write-back", link: "/guide/write-back" },
            { text: "Offline & the Outbox", link: "/guide/offline-and-the-outbox" },
          ],
        },
      ],
      "/offline-first/": [
        {
          text: "Offline-first",
          items: [
            { text: "Overview", link: "/offline-first/" },
            { text: "The Service Worker", link: "/offline-first/service-worker" },
            { text: "Storage & Eviction", link: "/offline-first/storage-eviction" },
            { text: "The ORT Runtime Cache", link: "/offline-first/ort-runtime-cache" },
          ],
        },
      ],
      "/deep-dives/": [
        {
          text: "Deep Dives",
          items: [
            { text: "Overview", link: "/deep-dives/" },
            { text: "Feasibility", link: "/deep-dives/feasibility" },
            {
              text: "Transcription: Measured",
              link: "/deep-dives/transcription-measurement",
            },
            { text: "Extraction: Measured", link: "/deep-dives/accuracy" },
            { text: "Real Field Audio", link: "/deep-dives/real-audio" },
            { text: "The Snugg Pro Data Model", link: "/deep-dives/snuggpro-data-model" },
            { text: "Schema at Scale", link: "/deep-dives/schema-scale" },
            {
              text: "Provenance: Measured",
              link: "/deep-dives/provenance-measurement",
            },
          ],
        },
      ],
      "/design/": [
        {
          text: "Design & Contributing",
          items: [
            { text: "Design Decisions", link: "/design/" },
            { text: "Contributing", link: "/design/contributing" },
            { text: "Releasing", link: "/design/releasing" },
          ],
        },
      ],
      "/reference/": [{ text: "API Reference", link: "/reference/", items: referenceSidebar() }],
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    socialLinks: [],
  },
});
