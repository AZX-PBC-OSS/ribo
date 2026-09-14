#!/usr/bin/env node
/**
 * Scoring pass for the mistral-native-vs-flattened spike.
 *
 * For each (doc, run) pair, compares the native and flattened extractions:
 *   - aligns rooms by normalised name (case/punctuation-insensitive)
 *   - per-leaf agreement, with numbers compared after thousands-separator
 *     stripping and ±0.5% tolerance (comma-formatting is not a disagreement)
 *   - spanGroundedness from @azx/ribo-core against the markdown THAT ARM SAW
 *     (native: results/native/{doc}-run{i}.md; flattened: results/ocr/...md)
 *   - null asymmetry (native-value/flat-null and vice versa) with the spans
 *     recorded for adjudication
 *
 * Writes results/comparison.json (contains document quotes -> gitignored) and
 * prints an aggregate table (safe to commit in FINDINGS).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS_DIR, loadRibo } from "./lib.mjs";

const { core } = await loadRibo();
const { spanGroundedness } = core;

const DOCS = ["wrightsoft", "coolcalc"];
const RUNS = 5;

const normName = (s) =>
  typeof s === "string"
    ? s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    : null;

const numEq = (a, b) => {
  if (a === null || b === null) return a === b;
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (a === b) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  return denom > 0 && Math.abs(a - b) / denom <= 0.005;
};

const valEq = (a, b) => {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" && typeof b === "number") return numEq(a, b);
  if (typeof a === "string" && typeof b === "string") {
    return normName(a)?.replace(/\s+/g, " ") === normName(b)?.replace(/\s+/g, " ");
  }
  return a === b;
};

const ROOM_LEAVES = ["name", "area", "heatingLoad", "coolingLoad", "heatingAvf", "coolingAvf"];
const HOUSE_LEAVES = [
  "totalHeatingLoad",
  "totalCoolingLoad",
  "totalArea",
  "heatingEquipmentManufacturer",
  "heatingEquipmentModel",
  "preparerName",
  "hvacSystemType",
];

const comparison = {};
const adjudicationQueue = [];

for (const doc of DOCS) {
  comparison[doc] = [];
  for (let run = 0; run < RUNS; run++) {
    const nativePath = join(RESULTS_DIR, "native", `${doc}-run${run}.json`);
    const flatPath = join(RESULTS_DIR, "flattened", `${doc}-run${run}.json`);
    const nativeMdPath = join(RESULTS_DIR, "native", `${doc}-run${run}.md`);
    const flatMdPath = join(RESULTS_DIR, "ocr", `${doc}-run${run}.md`);
    if (!existsSync(nativePath) || !existsSync(flatPath)) {
      comparison[doc].push({ run, status: "missing-arm" });
      continue;
    }
    const nativeFields = JSON.parse(readFileSync(nativePath, "utf8"));
    const flatFields = JSON.parse(readFileSync(flatPath, "utf8"));
    const nativeMd = readFileSync(nativeMdPath, "utf8");
    const flatMd = readFileSync(flatMdPath, "utf8");

    // Align rooms by name
    const nRooms = nativeFields.rooms ?? [];
    const fRooms = flatFields.rooms ?? [];
    const fByName = new Map();
    for (let i = 0; i < fRooms.length; i++) {
      const key = normName(fRooms[i]?.name?.value);
      if (key && !fByName.has(key)) fByName.set(key, { index: i, room: fRooms[i] });
    }
    const usedF = new Set();
    const roomPairs = [];
    for (let i = 0; i < nRooms.length; i++) {
      const key = normName(nRooms[i]?.name?.value);
      const hit = key ? fByName.get(key) : null;
      if (hit && !usedF.has(hit.index)) {
        usedF.add(hit.index);
        roomPairs.push({ nativeIdx: i, flatIdx: hit.index, name: key });
      } else {
        roomPairs.push({ nativeIdx: i, flatIdx: null, name: key ?? `(native room ${i})` });
      }
    }
    for (let i = 0; i < fRooms.length; i++) {
      if (!usedF.has(i)) {
        roomPairs.push({
          nativeIdx: null,
          flatIdx: i,
          name: normName(fRooms[i]?.name?.value) ?? `(flat room ${i})`,
        });
      }
    }

    // Build comparable leaf rows
    const rows = [];
    for (const pair of roomPairs) {
      const nRoom = pair.nativeIdx !== null ? nRooms[pair.nativeIdx] : null;
      const fRoom = pair.flatIdx !== null ? fRooms[pair.flatIdx] : null;
      const leafNames =
        pair.flatIdx === null || pair.nativeIdx === null ? ROOM_LEAVES : ROOM_LEAVES;
      for (const leaf of leafNames) {
        const nEnv = nRoom?.[leaf] ?? { value: null, confidence: 0, sourceSpan: null };
        const fEnv = fRoom?.[leaf] ?? { value: null, confidence: 0, sourceSpan: null };
        const path = `rooms[${pair.name}].${leaf}`;
        rows.push({
          path,
          native: { value: nEnv.value ?? null, span: nEnv.sourceSpan ?? null },
          flat: { value: fEnv.value ?? null, span: fEnv.sourceSpan ?? null },
          nativeGrounded: spanGroundedness(nEnv.sourceSpan ?? null, nativeMd),
          flatGrounded: spanGroundedness(fEnv.sourceSpan ?? null, flatMd),
          paired: pair.nativeIdx !== null && pair.flatIdx !== null,
          unpairedSide:
            pair.nativeIdx !== null && pair.flatIdx === null
              ? "native"
              : pair.flatIdx !== null && pair.nativeIdx === null
                ? "flat"
                : null,
        });
      }
    }
    for (const leaf of HOUSE_LEAVES) {
      const nEnv = nativeFields.house?.[leaf] ?? { value: null, sourceSpan: null };
      const fEnv = flatFields.house?.[leaf] ?? { value: null, sourceSpan: null };
      rows.push({
        path: `house.${leaf}`,
        native: { value: nEnv.value ?? null, span: nEnv.sourceSpan ?? null },
        flat: { value: fEnv.value ?? null, span: fEnv.sourceSpan ?? null },
        nativeGrounded: spanGroundedness(nEnv.sourceSpan ?? null, nativeMd),
        flatGrounded: spanGroundedness(fEnv.sourceSpan ?? null, flatMd),
        paired: true,
        unpairedSide: null,
      });
    }

    // Classify
    let agree = 0,
      disagree = 0;
    const nGround = { grounded: 0, "near-miss": 0, ungrounded: 0, none: 0 };
    const fGround = { grounded: 0, "near-miss": 0, ungrounded: 0, none: 0 };
    for (const row of rows) {
      if (valEq(row.native.value, row.flat.value)) agree++;
      else {
        disagree++;
        adjudicationQueue.push({
          doc,
          run,
          path: row.path,
          nativeValue: row.native.value,
          flatValue: row.flat.value,
          nativeSpan: row.native.span,
          flatSpan: row.flat.span,
          nativeGrounded: row.nativeGrounded,
          flatGrounded: row.flatGrounded,
          unpairedSide: row.unpairedSide,
        });
      }
      nGround[row.native.span === null ? "none" : row.nativeGrounded]++;
      fGround[row.flat.span === null ? "none" : row.flatGrounded]++;
    }

    // Null asymmetry
    let nativeOnly = 0,
      flatOnly = 0,
      bothNull = 0;
    for (const row of rows) {
      const nNull = row.native.value === null,
        fNull = row.flat.value === null;
      if (!nNull && fNull) nativeOnly++;
      if (nNull && !fNull) flatOnly++;
      if (nNull && fNull) bothNull++;
    }

    comparison[doc].push({
      run,
      status: "ok",
      nativeRoomCount: nRooms.length,
      flatRoomCount: fRooms.length,
      pairedRooms: roomPairs.filter((p) => p.nativeIdx !== null && p.flatIdx !== null).length,
      leafRows: rows.length,
      agree,
      disagree,
      agreementRate: rows.length ? agree / rows.length : null,
      nativeGroundedness: nGround,
      flatGroundedness: fGround,
      nullAsymmetry: { nativeOnly, flatOnly, bothNull },
    });
  }
}

writeFileSync(join(RESULTS_DIR, "comparison.json"), JSON.stringify(comparison, null, 2));
writeFileSync(
  join(RESULTS_DIR, "adjudication-queue.json"),
  JSON.stringify(adjudicationQueue, null, 2),
);

// Print aggregate (safe numbers only)
console.log(
  "doc         run  rooms(N/F/paired)  rows  agree  disagree  agree%   N-span g/nm/u        F-span g/nm/u        null N-only/F-only",
);
for (const doc of DOCS) {
  for (const c of comparison[doc]) {
    if (c.status !== "ok") {
      console.log(`${doc} ${c.run} ${c.status}`);
      continue;
    }
    const pct = c.agreementRate !== null ? (100 * c.agreementRate).toFixed(1) : "n/a";
    const n = c.nativeGroundedness,
      f = c.flatGroundedness;
    console.log(
      `${doc.padEnd(11)} ${c.run}    ${`${c.nativeRoomCount}/${c.flatRoomCount}/${c.pairedRooms}`.padEnd(16)}  ${String(c.leafRows).padEnd(4)}  ${String(c.agree).padEnd(5)}  ${String(c.disagree).padEnd(8)}  ${pct.padEnd(6)}  ${`${n.grounded}/${n["near-miss"]}/${n.ungrounded}`.padEnd(18)}  ${`${f.grounded}/${f["near-miss"]}/${f.ungrounded}`.padEnd(18)}  ${c.nullAsymmetry.nativeOnly}/${c.nullAsymmetry.flatOnly}`,
    );
  }
}

// Overall
let totA = 0,
  totD = 0;
const gTot = {
  n: { grounded: 0, "near-miss": 0, ungrounded: 0 },
  f: { grounded: 0, "near-miss": 0, ungrounded: 0 },
};
let nativeOnly = 0,
  flatOnly = 0;
for (const doc of DOCS)
  for (const c of comparison[doc]) {
    if (c.status !== "ok") continue;
    totA += c.agree;
    totD += c.disagree;
    for (const k of ["grounded", "near-miss", "ungrounded"]) {
      gTot.n[k] += c.nativeGroundedness[k];
      gTot.f[k] += c.flatGroundedness[k];
    }
    nativeOnly += c.nullAsymmetry.nativeOnly;
    flatOnly += c.nullAsymmetry.flatOnly;
  }
console.log(
  `\nOVERALL: agreement ${totA}/${totA + totD} (${((100 * totA) / (totA + totD)).toFixed(1)}%), disagreements to adjudicate: ${totD}`,
);
console.log(
  `native spans: ${gTot.n.grounded}g/${gTot.n["near-miss"]}nm/${gTot.n.ungrounded}u — verbatim ${((100 * gTot.n.grounded) / (gTot.n.grounded + gTot.n["near-miss"] + gTot.n.ungrounded)).toFixed(1)}%`,
);
console.log(
  `flat   spans: ${gTot.f.grounded}g/${gTot.f["near-miss"]}nm/${gTot.f.ungrounded}u — verbatim ${((100 * gTot.f.grounded) / (gTot.f.grounded + gTot.f["near-miss"] + gTot.f.ungrounded)).toFixed(1)}%`,
);
console.log(`null asymmetry: native-only values ${nativeOnly}, flat-only values ${flatOnly}`);
console.log(
  `\nadjudication queue: results/adjudication-queue.json (${adjudicationQueue.length} rows)`,
);
