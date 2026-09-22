// Probe 5: does the export run under WebGPU in a real browser, and how fast?
//
// Probes 2-4 already say the 0.6B model is not accurate enough to build on, so this does not
// decide anything today. It is here because it is the fact a future re-measure would otherwise
// have to rediscover from scratch: ADR 0020 reserved `ribo-systemone-ondevice` for "the
// WebGPU/ONNX rung", and until something runs, that name describes a hope.
//
// Serve a page and collect its POST — the repo's pattern for measuring a browser-only API from a
// spike, since headless Chromium reports no GPU adapter and a spike is in no tsconfig, so the
// package `*.manual.ts` + vitest-browser route is unavailable here. Runs HEADED for that reason.
//
//   node docs/spikes/0010-kev-ondevice/run-5-webgpu.mjs
//
// Downloads ~335MB of q4f16 weights into the browser's own cache on the first run.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const page = readFileSync(new URL("./browser/index.html", import.meta.url));

let resolveResult;
const collected = new Promise((r) => {
  resolveResult = r;
});

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/collect") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(204).end();
      resolveResult(JSON.parse(Buffer.concat(chunks).toString()));
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" }).end(page);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
console.log(`serving ${url} — launching headed Chromium (headless has no GPU adapter)\n`);

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newPage();
ctx.on("console", (m) => console.log(`  [page] ${m.text()}`));
await ctx.goto(url);

const timeout = new Promise((_, rej) =>
  setTimeout(() => rej(new Error("timed out after 15m")), 900_000),
);
let result;
try {
  result = await Promise.race([collected, timeout]);
} finally {
  await browser.close();
  server.close();
}

writeFileSync(new URL("./results/webgpu.json", import.meta.url), JSON.stringify(result, null, 2));

console.log("\n---");
if (!result.ok) {
  console.log("FAILED\n" + result.error);
  process.exit(1);
}
if (result.uniform) {
  console.log(
    "FAILED: every question returned an identical probability — delimiters did not bind.",
  );
  process.exit(1);
}
const warm = result.warmPassMs;
console.log(`adapter      ${JSON.stringify(result.adapter)}`);
console.log(`load         ${(result.loadMs / 1000).toFixed(1)}s (q4f16, ~335MB cold)`);
console.log(`sequence     ${result.tokens} tokens, ${result.questions} questions in one pass`);
console.log(`first pass   ${result.firstPassMs}ms (includes shader compilation)`);
console.log(
  `warm passes  ${warm.join(", ")}ms  (mean ${Math.round(warm.reduce((a, b) => a + b, 0) / warm.length)}ms)`,
);
// run-2 measured 16.0s per transcript over four passes of ~3200 tokens on CPU. The page packs a
// sequence of the same length on purpose, so this is a like-for-like comparison.
console.log(`\nNode CPU reference: ~4000ms per ~3200-token pass (run-2, q4 on CPU).`);
