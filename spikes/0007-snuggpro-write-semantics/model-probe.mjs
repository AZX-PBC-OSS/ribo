#!/usr/bin/env node
/** Read-only: does the vendor's own energy model produce sane output for a job whose
 * setpoints are RANGES, versus one whose setpoints are NUMBERS? */
import { readFileSync } from "node:fs";

const ENVFILE = "/Users/ekongiy/projects/clients/franklin/franklin-field-app/.env.local";
const GATEWAY = "https://dev-api.franklin.helix.azxlabs.io/franklin-field-app";
const SNUGG = "https://api-staging.snuggpro.com";
const TOKEN = (/^HELIX_DEV_TOKEN=(.*)$/m.exec(readFileSync(ENVFILE, "utf8"))?.[1] ?? "")
  .trim()
  .replace(/^["']|["']$/g, "");

const get = async (path) => {
  const res = await fetch(`${GATEWAY}/_api/fetch/${SNUGG}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
      origin: "http://localhost:5173",
    },
  });
  let json;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
};

const isRange = (v) => typeof v === "string" && /^\d+\s*-\s*\d+$/.test(v);

const jobs = (await get("/jobs?stageId=2")).json ?? [];
const ranged = [];
const numeric = [];

for (const job of jobs.slice(0, 30)) {
  const bd = (await get(`/jobs/${String(job.id)}/basedata`)).json;
  const v = bd?.heatingSetpointHigh;
  if (v === null || v === undefined || v === "") continue;
  (isRange(v) ? ranged : numeric).push({ id: job.id, setpoint: v });
  if (ranged.length >= 3 && numeric.length >= 1) break;
}

console.log(
  `range-setpoint jobs: ${ranged.map((j) => `${String(j.id)}(${j.setpoint})`).join(", ")}`,
);
console.log(
  `number-setpoint jobs: ${numeric.map((j) => `${String(j.id)}(${j.setpoint})`).join(", ")}`,
);

/** Pull a few load/consumption figures out of whatever shape the model returns. */
const summarise = (obj, depth = 0) => {
  if (!obj || typeof obj !== "object" || depth > 2) return [];
  const hits = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && /load|heat|cool|therm|kwh|mmbtu|energy|cost/i.test(k)) {
      hits.push(`${k}=${String(v)}`);
    } else if (typeof v === "object") {
      hits.push(...summarise(v, depth + 1));
    }
  }
  return hits;
};

for (const { id, setpoint } of [...ranged.slice(0, 2), ...numeric.slice(0, 1)]) {
  console.log(`\n--- job ${String(id)}  heatingSetpointHigh=${JSON.stringify(setpoint)}`);
  for (const route of ["model", "metrics-summary"]) {
    const r = await get(`/jobs/${String(id)}/${route}`);
    const hits = summarise(r.json);
    console.log(
      `  ${route.padEnd(16)} ${String(r.status)}  ${
        hits.length
          ? hits.slice(0, 6).join("  ")
          : `keys=${JSON.stringify(Object.keys(r.json ?? {}).slice(0, 8))}`
      }`,
    );
  }
}
