import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, "..", "extraction-snuggpro");
const TRANSCRIPTS = join(CORPUS, "transcripts");
const GROUND_TRUTH = join(CORPUS, "ground-truth");
const OUT_DIR = join(CORPUS, "results", "ondevice");

/**
 * The corpus goes out and the results come back, both over the dev server.
 *
 * The extraction has to run in **real Chrome** — Playwright's Chromium answers the
 * Prompt API with a stub, so an automated run would grade canned text (spec §10.6).
 * But `score.mjs` reads files from disk. This plugin bridges those: the page fetches
 * transcripts, runs them through the real model, and posts each result back to be
 * written where the scorer expects it.
 *
 * Only the slugs with ground truth are offered, so the runner cannot silently score
 * a transcript nobody annotated.
 */
function corpusBridge(): Plugin {
  return {
    name: "ondevice-acceptance-corpus",
    configureServer(server) {
      server.middlewares.use("/api/corpus", (_req, res) => {
        const slugs = readdirSync(GROUND_TRUTH)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.replace(/\.json$/, ""))
          .sort();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ slugs }));
      });

      server.middlewares.use("/api/transcript", (req, res) => {
        const slug = new URL(req.url ?? "", "http://x").searchParams.get("slug") ?? "";
        if (!/^[\w.-]+$/.test(slug)) {
          res.statusCode = 400;
          res.end("bad slug");
          return;
        }
        res.setHeader("content-type", "text/plain");
        res.end(readFileSync(join(TRANSCRIPTS, `${slug}.txt`), "utf8"));
      });

      server.middlewares.use("/api/result", (req, res) => {
        const slug = new URL(req.url ?? "", "http://x").searchParams.get("slug") ?? "";
        if (!/^[\w.-]+$/.test(slug)) {
          res.statusCode = 400;
          res.end("bad slug");
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          mkdirSync(OUT_DIR, { recursive: true });
          writeFileSync(join(OUT_DIR, `${slug}.json`), body);
          res.statusCode = 204;
          res.end();
        });
      });

      server.middlewares.use("/api/log", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          mkdirSync(OUT_DIR, { recursive: true });
          writeFileSync(join(OUT_DIR, "run-log.txt"), body);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

const PACKAGES = resolve(HERE, "..", "..", "packages");
const src = (pkg: string): string => join(PACKAGES, pkg, "src", "index.ts");

export default defineConfig({
  root: HERE,
  server: { port: 8975, strictPort: true },
  plugins: [corpusBridge()],
  resolve: {
    // Aliased to source rather than resolved through node_modules, because this
    // spike is deliberately NOT a pnpm workspace member — adding one would put it
    // in front of the repo's publishable-package census gates, which exist to
    // notice new packages. Aliasing also guarantees the run exercises the working
    // tree rather than a stale build, which is the same reason the playground
    // resolves through the `@azx/source` condition.
    alias: {
      "@azx/ribo-core": src("ribo-core"),
      "@azx/ribo-extractor-openai": src("ribo-extractor-openai"),
      "@azx/ribo-extractor-ondevice": src("ribo-extractor-ondevice"),
      "@azx/ribo-adapter-snuggpro": src("ribo-adapter-snuggpro"),
    },
    conditions: ["@azx/source"],
  },
});
