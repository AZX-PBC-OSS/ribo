import { readdirSync, readFileSync } from "node:fs";
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

/**
 * The Design sidebar, shared with `/adr/`. The ADR list is read from `docs/adr/` at config load,
 * so a new ADR appears without editing this file; each entry's text is the file's own `# NNNN.`
 * heading. Collapsed by default: the list is long and most readers come for one record.
 */
function adrItems(): DefaultTheme.SidebarItem[] {
  const dir = fileURLToPath(new URL("../adr/", import.meta.url));
  return readdirSync(dir)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort()
    .map((name) => {
      const heading = /^# (.+)$/m.exec(readFileSync(dir + name, "utf8"))?.[1] ?? name;
      return { text: heading, link: `/adr/${name.replace(/\.md$/, "")}` };
    });
}

const designSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "Design & Contributing",
    items: [
      { text: "Design Decisions", link: "/design/" },
      { text: "Contributing", link: "/design/contributing" },
      { text: "Releasing", link: "/design/releasing" },
    ],
  },
  {
    text: "Architecture Decisions",
    collapsed: true,
    items: [{ text: "Overview", link: "/adr/" }, ...adrItems()],
  },
];

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
      { text: "Examples", link: "/examples/" },
      { text: "API", link: "/api/" },
      { text: "Offline-first", link: "/offline-first/" },
      { text: "Deep Dives", link: "/deep-dives/" },
      { text: "Reference", link: "/reference/" },
      { text: "Design", link: "/design/" },
    ],
    sidebar: {
      // One `/guide/` directory, grouped in the sidebar. A sibling `guides/` directory was
      // considered and rejected: two paths one character apart are a permanent source of
      // wrong links. See docs/roadmap/design/docs-repositioning-design.md §4.
      // The /api/ groups reuse these group names, so a concept sits under the same heading
      // in both sidebars.
      "/guide/": [
        {
          text: "Getting Started",
          collapsed: false,
          items: [
            { text: "Overview", link: "/guide/" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Quick Start", link: "/guide/quick-start" },
            { text: "Important Defaults", link: "/guide/important-defaults" },
          ],
        },
        {
          text: "Capture",
          collapsed: false,
          items: [
            { text: "Captures & Sources", link: "/guide/captures-and-sources" },
            { text: "Sessions", link: "/guide/sessions" },
          ],
        },
        {
          text: "Extraction",
          collapsed: false,
          items: [
            { text: "Extraction", link: "/guide/extraction" },
            { text: "From a Schema", link: "/guide/from-a-schema" },
            { text: "Schema at Scale", link: "/guide/schema-at-scale" },
            { text: "Per-Group Composition", link: "/guide/per-group" },
            { text: "Arbitration & Fallback", link: "/guide/arbitration" },
          ],
        },
        {
          text: "Review & Write-back",
          collapsed: false,
          items: [
            { text: "Provenance", link: "/guide/provenance" },
            { text: "Review", link: "/guide/review" },
            { text: "Write-back", link: "/guide/write-back" },
          ],
        },
        {
          text: "Storage",
          collapsed: false,
          items: [
            { text: "Offline & Storage", link: "/guide/offline-and-storage" },
            { text: "Migrations", link: "/guide/migrations" },
            { text: "Plugin Storage", link: "/guide/plugin-storage" },
          ],
        },
        {
          text: "Integration",
          collapsed: false,
          items: [
            { text: "React Hooks", link: "/guide/react" },
            { text: "Typesafety", link: "/guide/typesafety" },
          ],
        },
        {
          text: "Background",
          collapsed: false,
          items: [
            { text: "Motivation", link: "/guide/motivation" },
            { text: "Comparison", link: "/guide/comparison" },
          ],
        },
      ],
      "/api/": [
        { text: "API", items: [{ text: "Overview", link: "/api/" }] },
        {
          text: "Capture",
          collapsed: false,
          items: [
            { text: "Recorder", link: "/api/recorder" },
            { text: "Transcriber", link: "/api/transcriber" },
            { text: "OnDeviceTranscriber", link: "/api/ondevice-transcriber" },
            { text: "ManagedTranscriber", link: "/api/managed-transcriber" },
            { text: "PdfjsTranscriber", link: "/api/pdfjs-transcriber" },
            { text: "ManagedDocsTranscriber", link: "/api/managed-docs-transcriber" },
            { text: "Composing transcribers", link: "/api/composing-transcribers" },
            { text: "Live transcription", link: "/api/live-transcription" },
            { text: "CaptureSession", link: "/api/capture-session" },
          ],
        },
        {
          text: "Extraction",
          collapsed: false,
          items: [
            { text: "Extractor", link: "/api/extractor" },
            { text: "singleShotExtractor", link: "/api/single-shot-extractor" },
            { text: "ChatClient and transports", link: "/api/chat-transports" },
            { text: "Test doubles", link: "/api/test-doubles" },
          ],
        },
        {
          text: "Large Schemas",
          collapsed: false,
          items: [
            { text: "Schema at scale", link: "/api/schema-at-scale" },
            { text: "Presence narrowing", link: "/api/presence-narrowing" },
            { text: "Phased extraction", link: "/api/phased-extraction" },
            { text: "groupedExtractor", link: "/api/grouped-extractor" },
          ],
        },
        {
          text: "Arbitration",
          collapsed: false,
          items: [
            { text: "fallbackExtractor and wrappers", link: "/api/fallback-extractor" },
            { text: "corroborateExtractor", link: "/api/corroborate-extractor" },
          ],
        },
        {
          text: "Review & Write-back",
          collapsed: false,
          items: [
            { text: "Provenance", link: "/api/provenance" },
            { text: "Review", link: "/api/review" },
            { text: "ToolAdapter and write steps", link: "/api/tool-adapter" },
            { text: "snuggProAdapter", link: "/api/snuggpro-adapter" },
          ],
        },
        {
          text: "Storage & Offline",
          collapsed: false,
          items: [
            { text: "createRelay", link: "/api/relay" },
            { text: "openStorage", link: "/api/open-storage" },
            { text: "The StorageBackend port", link: "/api/storage-port" },
            { text: "createConnectivity", link: "/api/connectivity" },
          ],
        },
        {
          text: "React",
          collapsed: false,
          items: [
            { text: "RiboProvider", link: "/api/ribo-provider" },
            { text: "useRecorder", link: "/api/use-recorder" },
            { text: "useCaptures", link: "/api/use-captures" },
            { text: "useSessions", link: "/api/use-sessions" },
            { text: "useReview", link: "/api/use-review" },
            { text: "useConnectivity", link: "/api/use-connectivity" },
            { text: "useStoragePersistence", link: "/api/use-storage-persistence" },
            { text: "useWorkSafety", link: "/api/use-work-safety" },
            { text: "createCaptureCoordinator", link: "/api/create-capture-coordinator" },
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
          ],
        },
        {
          text: "Measured",
          collapsed: false,
          items: [
            { text: "Transcription", link: "/deep-dives/transcription-measurement" },
            { text: "Extraction", link: "/deep-dives/accuracy" },
            { text: "Schema at Scale", link: "/deep-dives/schema-scale" },
            { text: "Native Extraction", link: "/deep-dives/native-extraction" },
            { text: "Provenance", link: "/deep-dives/provenance-measurement" },
          ],
        },
        {
          text: "Field Data",
          collapsed: false,
          items: [
            { text: "Real Field Audio", link: "/deep-dives/real-audio" },
            { text: "The Snugg Pro Data Model", link: "/deep-dives/snuggpro-data-model" },
          ],
        },
      ],
      // Design and the ADRs share one sidebar, so a reader moves between them.
      "/design/": designSidebar,
      "/adr/": designSidebar,
      ...referenceSidebar(),
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    socialLinks: [],
  },
});
