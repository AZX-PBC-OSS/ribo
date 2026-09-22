// Throwaway spike helper: .env.local lives at the repo root and is not exported to the shell.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../.env.local", import.meta.url));

export function loadEnv() {
  const out = {};
  for (const line of readFileSync(root, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export const API = "https://api.typesafe.ai/v1/systemone";

export function apiKey() {
  const key = loadEnv().TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY missing from .env.local");
  return key;
}

export async function ask(body) {
  const t0 = Date.now();
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", ...body }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return { ...(await res.json()), ms };
}
