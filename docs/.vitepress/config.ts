import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import type { DefaultTheme } from "vitepress";

/**
 * The generated API Reference sidebar, reshaped per package. TypeDoc (`pnpm docs:api`) writes
 * `typedoc-sidebar.json` next to the Reference markdown before either `docs:dev` or `docs:build`
 * runs VitePress; loaded defensively so a bare `vitepress` invocation (before `docs:api`) degrades
 * to an empty Reference sidebar rather than crashing the config.
 *
 * The JSON as generated lists every symbol, and VitePress inlines the sidebar into every page —
 * serving all ~820 symbol entries on each of the ~780 reference pages is what made
 * `docs/.vitepress/dist` ~379 MB. So the sidebar is keyed per package directory instead, and each
 * key carries only the module entry and its @category labels; the symbols themselves live on the
 * module's index page. Subpath modules (`@azx/ribo-core/testing`, …) share their package's key.
 */
function referenceSidebar(): DefaultTheme.Sidebar {
  let entries: DefaultTheme.SidebarItem[];
  try {
    const path = fileURLToPath(new URL("../reference/typedoc-sidebar.json", import.meta.url));
    entries = JSON.parse(readFileSync(path, "utf8")) as DefaultTheme.SidebarItem[];
  } catch {
    return { "/reference/": [{ text: "API Reference", link: "/reference/" }] };
  }
  const byPackage = new Map<string, DefaultTheme.SidebarItem[]>();
  for (const entry of entries) {
    // Module links look like "/reference/@azx/ribo-core.md" or, for a subpath,
    // "/reference/@azx/ribo-core/testing.md" — the package key is the directory prefix shared by
    // a package's pages: everything up to and including the package name.
    if (!entry.link) continue;
    const segments = entry.link.replace(/\.md$/, "").split("/").filter(Boolean);
    const packageSegments = segments[1] === "@azx" ? segments.slice(0, 3) : segments.slice(0, 2);
    const key = "/" + packageSegments.join("/");
    const items = byPackage.get(key) ?? [];
    items.push({ text: entry.text, link: entry.link });
    for (const category of entry.items ?? []) {
      items.push({ text: category.text });
    }
    byPackage.set(key, items);
  }
  return {
    "/reference/": [{ text: "API Reference", link: "/reference/" }],
    ...Object.fromEntries(byPackage),
  };
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
  // Without this, VitePress inlines its page-hash map (~78 KB with one page per Reference symbol)
  // into every page's HTML: ~67 MB of duplication across the site. One shared chunk instead.
  metaChunk: true,
  // The internal process docs live under docs/ but are not part of the public site. The roadmap
  // (design specs and per-phase plans) stays committed but unpublished; the implementation findings
  // are repackaged into Deep Dives (Task 2), not served raw.
  // `spikes/**` joins these for the same reason: a working record with corpora and
  // result trees, not a published page. See `spikes/index.md` and ADR 0019.
  srcExclude: ["roadmap/**", "implementation/**", "spikes/**", "open-questions.md"],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "API", link: "/api/" },
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
            { text: "Captures & Sources", link: "/guide/captures-and-sources" },
            { text: "Sessions", link: "/guide/sessions" },
            { text: "Extraction", link: "/guide/extraction" },
            { text: "Schema at Scale", link: "/guide/schema-at-scale" },
            { text: "From a Schema", link: "/guide/from-a-schema" },
            { text: "Per-Group Composition", link: "/guide/per-group" },
            { text: "Provenance", link: "/guide/provenance" },
            { text: "Review", link: "/guide/review" },
            { text: "Write-back", link: "/guide/write-back" },
            { text: "Offline & Storage", link: "/guide/offline-and-storage" },
            { text: "Migrations", link: "/guide/migrations" },
            { text: "Arbitration & Fallback", link: "/guide/arbitration" },
            { text: "Plugin Storage", link: "/guide/plugin-storage" },
            { text: "React Hooks", link: "/guide/react" },
            { text: "Typesafety", link: "/guide/typesafety" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "Recorder", link: "/api/recorder" },
            { text: "Transcriber", link: "/api/transcriber" },
            { text: "OnDeviceTranscriber", link: "/api/ondevice-transcriber" },
            { text: "ManagedTranscriber", link: "/api/managed-transcriber" },
            { text: "PdfjsTranscriber", link: "/api/pdfjs-transcriber" },
            { text: "ManagedDocsTranscriber", link: "/api/managed-docs-transcriber" },
            {
              text: "Choosing and composing transcribers",
              link: "/api/composing-transcribers",
            },
            { text: "Live transcription", link: "/api/live-transcription" },
            { text: "Capture session", link: "/api/capture-session" },
            { text: "Extractor", link: "/api/extractor" },
            { text: "singleShotExtractor", link: "/api/single-shot-extractor" },
            { text: "ChatClient and chat transports", link: "/api/chat-transports" },
            { text: "Test doubles", link: "/api/test-doubles" },
            { text: "groupedExtractor", link: "/api/grouped-extractor" },
            { text: "Provenance", link: "/api/provenance" },
            { text: "ToolAdapter and write steps", link: "/api/tool-adapter" },
            { text: "snuggProAdapter", link: "/api/snuggpro-adapter" },
            { text: "createRelay", link: "/api/relay" },
            { text: "openStorage", link: "/api/open-storage" },
            { text: "The StorageBackend port", link: "/api/storage-port" },
            { text: "createConnectivity and work safety", link: "/api/connectivity" },
            {
              text: "fallbackExtractor and the arbitration wrappers",
              link: "/api/fallback-extractor",
            },
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
            { text: "Schema at Scale: Measured", link: "/deep-dives/schema-scale" },
            {
              text: "Native Extraction: Measured",
              link: "/deep-dives/native-extraction",
            },
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
      ...referenceSidebar(),
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    socialLinks: [],
  },
});
