// Reads the existing extraction-snuggpro corpus: transcripts + annotated ground truth.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../0001-extraction-snuggpro/", import.meta.url));

export function corpus() {
  const names = readdirSync(`${dir}ground-truth`)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();

  return names.map((name) => {
    const gt = JSON.parse(readFileSync(`${dir}ground-truth/${name}.json`, "utf8"));
    const transcript = readFileSync(`${dir}transcripts/${name}.txt`, "utf8").trim();

    // Per group: how many leaves the annotation records, and how many are positively asserted.
    // A group with zero leaves is one the transcript never touches — the routing target.
    const groups = {};
    for (const [g, insts] of Object.entries(gt.instances ?? {})) {
      let asserted = 0;
      let total = 0;
      for (const inst of insts) {
        for (const leaf of Object.values(inst.leaves ?? {})) {
          total += 1;
          if (leaf.status === "asserted") asserted += 1;
        }
      }
      groups[g] = { asserted, total };
    }
    return { name, transcript, gt, groups };
  });
}

/**
 * Every (instance, leaf) the annotation positively asserts, flattened.
 * Enum leaves carry `member`, free/numeric leaves carry `value`; `arguable` marks the ones the
 * annotators judged to have a defensible second answer, so a scorer can exclude them.
 */
export function assertedLeaves(entry) {
  const out = [];
  for (const [group, insts] of Object.entries(entry.gt.instances ?? {})) {
    for (const inst of insts) {
      for (const [leaf, v] of Object.entries(inst.leaves ?? {})) {
        if (v.status !== "asserted") continue;
        out.push({
          group,
          leaf,
          isEnum: "member" in v,
          value: "member" in v ? v.member : v.value,
          alternatives: v.arguable?.acceptableAlternatives ?? [],
          span: v.sourceSpan ?? null,
        });
      }
    }
  }
  return out;
}
