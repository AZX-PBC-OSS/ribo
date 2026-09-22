#!/usr/bin/env node
/** Read-only: what shape do real jobs actually store in the setpoint fields? */
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
  try {
    return await res.json();
  } catch {
    return undefined;
  }
};

const FIELDS = [
  "heatingSetpointHigh",
  "heatingSetpointLow",
  "coolingSetpointHigh",
  "coolingSetpointLow",
  "yearBuilt",
  "conditionedArea",
  "numberOfBedrooms",
];

const jobs = (await get("/jobs?stageId=2")) ?? [];
console.log(`sampling ${String(Math.min(40, jobs.length))} of ${String(jobs.length)} jobs\n`);

const seen = new Map(FIELDS.map((f) => [f, new Map()]));
let sampled = 0;
for (const job of jobs.slice(0, 40)) {
  const bd = await get(`/jobs/${String(job.id)}/basedata`);
  if (!bd) continue;
  sampled += 1;
  for (const f of FIELDS) {
    const v = bd[f];
    if (v === null || v === "" || v === undefined) continue;
    const shape = /^\d+\s*-\s*\d+$/.test(String(v))
      ? "RANGE"
      : /^\d+(\.\d+)?$/.test(String(v))
        ? "number-like"
        : "other";
    const bucket = seen.get(f);
    bucket.set(shape, [...(bucket.get(shape) ?? []), v]);
  }
}

console.log(`read ${String(sampled)} basedata records\n`);
for (const [field, shapes] of seen) {
  if (shapes.size === 0) {
    console.log(`${field.padEnd(22)} (never populated in the sample)`);
    continue;
  }
  const parts = [...shapes].map(
    ([shape, vals]) => `${shape}×${String(vals.length)} e.g. ${JSON.stringify(vals[0])}`,
  );
  console.log(
    `${field.padEnd(22)} ${parts.join("  |  ")}\n${"".padEnd(22)} distinct: ${JSON.stringify([...new Set([...shapes.values()].flat())].sort())}`,
  );
}
