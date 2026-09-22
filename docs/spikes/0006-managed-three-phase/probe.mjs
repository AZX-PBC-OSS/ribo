/**
 * Probe the Helix dev gateway: find the slug and model this repo's dev token can reach.
 * Reads `.env.local` at the repo root (gitignored) directly — it is not exported to the shell.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export function loadEnvLocal() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(`${ROOT}.env.local`, "utf8");
  } catch {
    return env;
  }
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

async function probe(base, slug, token, model) {
  const url = `https://dev-api.azx.helix.azxlabs.io/${slug}/_api/llm/chat`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "say hi" }],
        stream: false,
        maxTokens: 16,
      }),
    });
    const text = await res.text();
    return `${res.status} ${text.slice(0, 300)}`;
  } catch (e) {
    return `THREW ${e.message}`;
  }
}

if (process.argv[1] && /[/\\]probe\.mjs$/.test(process.argv[1])) {
  const env = loadEnvLocal();
  const token = env.HELIX_DEV_TOKEN ?? env.VITE_HELIX_DEV_TOKEN;
  console.log("token present:", Boolean(token), "len", token?.length);
  const slugs = process.argv[2]
    ? process.argv[2].split(",")
    : ["ribo-docs", "ribo", "ribo-playground", "ribo-app", "ribo-field"];
  for (const slug of slugs) {
    for (const origin of ["http://localhost:5173"]) {
      console.log(
        `[${slug}] origin=${origin} ->`,
        await probe(origin, slug, token, "claude-haiku-4-5"),
      );
    }
  }
}
