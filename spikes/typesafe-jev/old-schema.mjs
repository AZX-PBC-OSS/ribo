// Enum vocabularies of the OLD spike schema, which is the schema
// ../extraction-snuggpro/results/ was produced against. Regex-parsed because that file is
// frozen and dead — importing it would mean a resolver this throwaway does not need.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../extraction-snuggpro/schema.ts", import.meta.url)),
  "utf8",
);

const enums = new Map();
for (const m of src.matchAll(/export const (\w+) = z\.enum\(\[([^\]]*)\]/g)) {
  // Quoted prose inside the interleaved doc comments matches too; real members carry no spaces.
  const members = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((s) => !/\s/.test(s));
  if (members.length) enums.set(m[1], members);
}

/** field name -> its enum members, for fields declared `name: Extracted(EnumName)`. */
export const FIELD_OPTIONS = new Map();
for (const m of src.matchAll(/(\w+):\s*Extracted\((\w+)\)/g)) {
  const members = enums.get(m[2]);
  if (members) FIELD_OPTIONS.set(m[1], members);
}
