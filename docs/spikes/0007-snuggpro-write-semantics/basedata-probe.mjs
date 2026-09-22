#!/usr/bin/env node
/**
 * Does the `basedata` singleton upsert MERGE or REPLACE?
 *
 * The largest blast radius in the schema: 163 modelled leaves on one endpoint, and
 * unlike the health matrix this job already has data in it. Merge was measured on a
 * collection update and on the health singleton; this is the inference to basedata,
 * tested rather than assumed.
 *
 * Reversible: the full snapshot is written to disk BEFORE anything is mutated, so a
 * manual restore is possible even if this process dies mid-probe.
 */
import { readFileSync, writeFileSync } from "node:fs";

const HERE =
  "/private/tmp/claude-501/-Users-ekongiy-projects-azx-ribo/e3721097-dbc0-4312-8f79-aa0f1db74949/scratchpad/";
const ENVFILE = "/Users/ekongiy/projects/clients/franklin/franklin-field-app/.env.local";
const GATEWAY = "https://dev-api.franklin.helix.azxlabs.io/franklin-field-app";
const SNUGG = "https://api-staging.snuggpro.com";
const JOB = process.argv[2] ?? "588613";

const TOKEN = (/^HELIX_DEV_TOKEN=(.*)$/m.exec(readFileSync(ENVFILE, "utf8"))?.[1] ?? "")
  .trim()
  .replace(/^["']|["']$/g, "");
if (!TOKEN) {
  console.error("no HELIX_DEV_TOKEN");
  process.exit(2);
}

const call = async (method, path, body) => {
  const res = await fetch(`${GATEWAY}/_api/fetch/${SNUGG}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
      origin: "http://localhost:5173",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 300) };
};

const readBasedata = async () => (await call("GET", `/jobs/${JOB}/basedata`)).json ?? {};
const nonEmpty = (o) =>
  Object.entries(o).filter(
    ([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );

// --- 1. Snapshot, to disk, before touching anything -------------------------
const before = await readBasedata();
const snapshotPath = `${HERE}basedata-${JOB}-snapshot.json`;
writeFileSync(snapshotPath, JSON.stringify(before, null, 1));
const setBefore = nonEmpty(before);
console.log(`snapshot written: ${snapshotPath}`);
console.log(
  `basedata has ${String(setBefore.length)} non-empty of ${String(Object.keys(before).length)} fields`,
);
console.log(
  `  witnesses: ${setBefore
    .slice(0, 6)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ")}`,
);

// --- 2. Choose a probe field that is currently null -------------------------
const spec = JSON.parse(readFileSync(`${HERE}swagger.json`, "utf8"));
const writable = new Set(
  spec.paths["/jobs/{jobId}/basedata"].post.parameters
    .filter((p) => p.in !== "path" && p.type === "integer")
    .map((p) => p.name),
);
const probeField = Object.keys(before).find((k) => writable.has(k) && before[k] === null);
if (!probeField) {
  console.error("no null integer field to probe with");
  process.exit(1);
}
console.log(`\nprobe field: ${probeField} (currently ${JSON.stringify(before[probeField])})`);

let verdict = "UNKNOWN";
try {
  // --- 3. Write ONLY the probe field ---------------------------------------
  const wrote = await call("POST", `/jobs/${JOB}/basedata`, { [probeField]: 3 });
  console.log(`POST { ${probeField}: 3 } -> ${wrote.status}`);
  if (!wrote.ok) {
    console.log("  body:", wrote.text);
    throw new Error("probe write failed");
  }

  // --- 4. Did everything else survive? -------------------------------------
  const after = await readBasedata();
  console.log(`  ${probeField} is now ${JSON.stringify(after[probeField])}`);

  const lost = setBefore.filter(([k, v]) => JSON.stringify(after[k]) !== JSON.stringify(v));
  verdict = lost.length === 0 ? "MERGES" : "REPLACES";
  console.log(
    `\n  >>> basedata upsert ${verdict}` +
      (lost.length
        ? ` — ${String(lost.length)} of ${String(setBefore.length)} previously-set fields changed: ` +
          lost
            .slice(0, 8)
            .map(([k]) => k)
            .join(", ")
        : ` — all ${String(setBefore.length)} previously-set fields survived untouched`),
  );
} finally {
  // --- 5. Restore ----------------------------------------------------------
  console.log("\nrestore:");
  const restore =
    verdict === "REPLACES"
      ? { ...Object.fromEntries(setBefore), [probeField]: null }
      : { [probeField]: null };
  const res = await call("POST", `/jobs/${JOB}/basedata`, restore);
  console.log(`  POST restore (${String(Object.keys(restore).length)} field(s)) -> ${res.status}`);

  const end = await readBasedata();
  const stillWrong = Object.keys(before).filter(
    (k) => JSON.stringify(end[k]) !== JSON.stringify(before[k]),
  );
  console.log(
    stillWrong.length === 0
      ? "  clean — basedata is byte-identical to the snapshot"
      : `  !! RESIDUE in ${String(stillWrong.length)} field(s): ${stillWrong.join(", ")}\n     restore by hand from ${snapshotPath}`,
  );
}
