// Throwaway spike helper: .env.local lives at the repo root and is not exported to the shell.
//
// SYSTEMONE picks the model behind ask(): `jev` (or unset) for hosted Jev, `md-1` for the
// Microsoft-Decision-1 deployment on the Foundry resource in .env.local. A set target reads and
// writes its own results directory, so a chained probe (4 reads 3's hallucinations) never mixes
// models and a re-run never overwrites the recorded 2026-09 Jev results, which unset still reads.
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../.env.local", import.meta.url));

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

const SET = process.env.SYSTEMONE;
const TARGET = SET ?? "jev";

function target() {
  if (TARGET === "jev") {
    return { url: API, headers: { Authorization: `Bearer ${apiKey()}` }, model: "jev-latest" };
  }
  if (TARGET === "md-1") {
    const env = loadEnv();
    const key = env.AZURE_AI_FOUNDRY_API_KEY;
    if (!key) throw new Error("AZURE_AI_FOUNDRY_API_KEY missing from .env.local");
    // Foundry's model is the deployment name, not the underlying model.
    const origin = new URL(env.AZURE_AI_FOUNDRY_OPENAI_BASE_URL).origin;
    return {
      url: `${origin}/providers/microsoft/v1/systemone`,
      headers: { "api-key": key },
      model: "md-1",
    };
  }
  throw new Error(`unknown SYSTEMONE target: ${TARGET}`);
}

/** A results file for the current target — unset keeps the recorded results where they were. */
export function results(name) {
  const dir = SET === undefined ? "./results/" : `./results/${SET}/`;
  const url = new URL(dir, import.meta.url);
  mkdirSync(url, { recursive: true });
  return new URL(name, url);
}

export async function ask(body) {
  const { url, headers, model } = target();
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ model, ...body }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return { ...(await res.json()), ms };
}
