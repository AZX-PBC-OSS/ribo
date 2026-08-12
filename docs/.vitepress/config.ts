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
    "A reusable voice-capture SDK for field data collection: capture, on-device transcription, extraction, and human review with provenance.",
  cleanUrls: true,
  // The internal process docs live under docs/ but are not part of the public site. The roadmap
  // (design specs and per-phase plans) stays committed but unpublished; the implementation findings
  // are repackaged into Deep Dives (Task 2), not served raw.
  srcExclude: ["roadmap/**", "implementation/**", "open-questions.md"],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Capabilities", link: "/capabilities/" },
      { text: "Offline-first", link: "/offline-first/" },
      { text: "Deep Dives", link: "/deep-dives/" },
      { text: "Reference", link: "/reference/" },
      { text: "Design", link: "/design/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Introduction", link: "/guide/" },
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "The Core Loop", link: "/guide/core-loop" },
            { text: "The Offline Outbox", link: "/guide/outbox" },
          ],
        },
      ],
      "/capabilities/": [
        {
          text: "Capabilities",
          items: [
            { text: "Overview", link: "/capabilities/" },
            { text: "Transcription", link: "/capabilities/transcription" },
            { text: "Extraction", link: "/capabilities/extraction" },
            { text: "Adapters", link: "/capabilities/adapters" },
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
            { text: "The Snugg Pro Data Model", link: "/deep-dives/snuggpro-data-model" },
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
