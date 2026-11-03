// Why do the narrowed arms miss values the baseline gets? For every value the ground truth asserts
// and a narrowed arm left null, record what the shipped presence phase answered for that leaf —
// so a miss is attributed to presence (the leaf was never asked for) or to the fill (it was).
//
// Re-runs ONLY the presence phase, through the shipped `systemOnePresencePhase`, logging every
// question id and answer off the wire. Presence is near-deterministic (0008 probe 12), so this
// reproduces the decisions the end-to-end run made.
//
//   node diagnose.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { phasedExtractor } from "../../../packages/ribo-core/dist/index.js";
import { systemOnePresencePhase } from "../../../packages/ribo-extractor-systemone/dist/index.js";
import { systemOneClient } from "../../../packages/ribo-systemone-managed/dist/index.js";
import { snuggProAdapter } from "../../../packages/ribo-adapter-snuggpro/dist/index.js";
import { loadEnv } from "../0008-typesafe-jev/env.mjs";
import { corpus } from "../0008-typesafe-jev/corpus.mjs";

const env = loadEnv();
const THRESHOLD = 0.2;

const transports = {
  "md-1": {
    endpoint: `${new URL(env.AZURE_AI_FOUNDRY_OPENAI_BASE_URL).origin}/providers/microsoft`,
    model: "md-1",
    auth: (h) => {
      h.delete("authorization");
      h.set("api-key", env.AZURE_AI_FOUNDRY_API_KEY);
    },
  },
  jev: {
    endpoint: "https://api.typesafe.ai",
    model: "jev-latest",
    auth: (h) => h.set("authorization", `Bearer ${env.TYPESAFE_API_KEY}`),
  },
};

/** Every presence answer for one transcript, keyed by the phase's own question id. */
async function presenceAnswers(arm, transcript) {
  const t = transports[arm];
  const answers = {};
  let sample = null;
  const fetchImpl = async (input, init) => {
    const headers = new Headers(init?.headers);
    t.auth(headers);
    const res = await fetch(input, { ...init, headers });
    const body = await res.clone().json();
    const sent = JSON.parse(init.body);
    sample ??= Object.entries(sent.questions)[0];
    for (const [id, a] of Object.entries(body.answers ?? {})) answers[id] = a.noul;
    return res;
  };
  const client = systemOneClient({
    endpoint: t.endpoint,
    fetch: fetchImpl,
    model: t.model,
    batchSize: 100,
  });
  const presenceOnly = phasedExtractor({
    target: snuggProAdapter,
    phases: [
      systemOnePresencePhase({
        client,
        schema: snuggProAdapter.extractionSchema,
        threshold: THRESHOLD,
      }),
    ],
  });
  await presenceOnly.extract(
    { text: transcript, annotations: [] },
    { deadline: Date.now() + 5 * 60_000 },
  );
  return { answers, sample };
}

const readOut = (arm, name) =>
  JSON.parse(readFileSync(new URL(`./results/${arm}/${name}.json`, import.meta.url), "utf8"));

/** The envelope at group / instance / leaf, for an object group or a collection group alike. */
const cell = (fields, group, i, leaf) => {
  const g = fields[group];
  const inst = Array.isArray(g) ? g[i] : i === 0 ? g : undefined;
  return inst?.[leaf];
};

const rows = [];
for (const entry of corpus()) {
  const baseline = readOut("baseline", entry.name);
  const asserted = [];
  for (const [group, insts] of Object.entries(entry.gt.instances ?? {})) {
    insts.forEach((inst, i) => {
      for (const [leaf, truth] of Object.entries(inst.leaves ?? {})) {
        if (truth.status === "asserted") asserted.push({ group, i, leaf });
      }
    });
  }
  // Object groups (health, basedata, …) are annotated as top-level "group.leaf" paths.
  for (const [path, truth] of Object.entries(entry.gt.leaves ?? {})) {
    const [group, leaf] = path.split(".");
    if (truth.status === "asserted") asserted.push({ group, i: 0, leaf });
  }
  for (const arm of ["md-1", "jev"]) {
    const out = readOut(arm, entry.name);
    const { answers, sample } = await presenceAnswers(arm, entry.transcript);
    if (rows.length === 0)
      console.log("sample presence question:", JSON.stringify(sample).slice(0, 400));
    for (const a of asserted) {
      const got = cell(out, a.group, a.i, a.leaf)?.value ?? null;
      const base = cell(baseline, a.group, a.i, a.leaf)?.value ?? null;
      const id = Object.keys(answers).find(
        (k) =>
          k === `${a.group}.${a.leaf}` || (k.endsWith(`.${a.leaf}`) && k.startsWith(`${a.group}`)),
      );
      rows.push({
        name: entry.name,
        arm,
        path: `${a.group}[${a.i}].${a.leaf}`,
        instance: a.i,
        narrowed: got,
        baseline: base,
        presenceId: id ?? null,
        noul: id === undefined ? null : answers[id],
      });
    }
  }
  console.log(`${entry.name} done`);
}

writeFileSync(new URL("./results/diagnose.json", import.meta.url), JSON.stringify(rows, null, 2));

for (const arm of ["md-1", "jev"]) {
  const mine = rows.filter((r) => r.arm === arm);
  const missed = mine.filter((r) => r.narrowed === null && r.baseline !== null);
  const unmatched = mine.filter((r) => r.presenceId === null).length;
  const second = missed.filter((r) => r.instance > 0);
  const first = missed.filter((r) => r.instance === 0);
  const dropped = first.filter((r) => r.noul !== null && r.noul < THRESHOLD);
  const kept = first.filter((r) => r.noul !== null && r.noul >= THRESHOLD);
  console.log(
    `\n== ${arm}: ${mine.length} asserted values, ${missed.length} the baseline got and this arm left null`,
  );
  console.log(`  presence id unmatched for ${unmatched} asserted values (should be 0)`);
  console.log(`  beyond the first instance (singleton fill cannot hold them): ${second.length}`);
  console.log(
    `  presence answered < ${THRESHOLD} (leaf never asked for):        ${dropped.length}`,
  );
  console.log(`  presence answered >= ${THRESHOLD} (asked, fill still missed):   ${kept.length}`);
  for (const r of dropped.slice(0, 15))
    console.log(`    ${r.noul.toFixed(3)} ${r.name.slice(0, 2)} ${r.path}`);
}
