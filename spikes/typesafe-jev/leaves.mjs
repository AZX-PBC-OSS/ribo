// Enum leaves of the five groups the annotated corpus covers, read from the BUILT adapter
// schema via the existing spike's schema-leaves.mjs — never a hand-copied member list.
import { LEAVES } from "../extraction-snuggpro/schema-leaves.mjs";

export const COVERED_GROUPS = ["attic", "hvac", "wall", "window", "dhw"];
export const NOT_STATED = "Not stated";

export const ENUM_LEAVES = LEAVES.filter(
  (l) => l.kind === "enum" && COVERED_GROUPS.includes(l.path.split(".")[0]),
);

/** Question ids must survive a JSON round trip; the dotted path is fine but noisy in output. */
export const qid = (path) => path.replace(".", "__");
export const unqid = (id) => id.replace("__", ".");
