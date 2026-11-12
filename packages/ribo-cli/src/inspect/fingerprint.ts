import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys recursively sorted in code-unit order, then
 * `JSON.stringify` with no whitespace. The input is already `JSON.parse`
 * output — numbers, strings and duplicate keys are already normalized — so
 * sorting keys is the whole canonicalization. `JSON.stringify` returns
 * `undefined` for `undefined` itself; a document cannot carry it, but a
 * canonicalizer that emitted the string "undefined" would sort differently
 * from one that emitted null, so it is folded to `null`.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/**
 * The report's schema fingerprint (design §7): SHA-256 over the canonical
 * serialization of the parsed document, as 64 lowercase hex characters.
 * Canonical — reordering object keys at any depth or reformatting whitespace
 * leaves it unchanged; any real schema change alters it. Computed from the
 * parsed document (plain data, never a zod object) with `node:crypto`, which
 * is builtin on the CLI's Node platform — no new dependency, no bundle change.
 */
export function schemaFingerprint(document: unknown): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}
