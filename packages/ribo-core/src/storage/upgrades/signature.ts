/**
 * @file A readable description of a document's stored shape.
 *
 * Guard A ties a ladder to a version number. It does not — cannot — notice a
 * *shape* change, because nothing in a ladder looks at a schema. That gap is the
 * bug this repository has already shipped: a field was added to the session
 * document at an unchanged version, every test stayed green, and RxDB refused to
 * open on every device that had the collection, taking the captures with it.
 *
 * This is the other half. A signature is pinned per version, so changing a shape
 * makes the current signature disagree with the entry recorded for the current
 * version, and the only ways back to green are reverting or doing the whole job:
 * bump, add a rung, record a new entry.
 *
 * See `docs/roadmap/design/storage-migrations-design.md` §7.
 */

import type { ZodObject, ZodType } from "zod";

/**
 * The sorted `field` / `field?` list of a document schema, comma-joined.
 *
 * Deliberately a readable string rather than a hash: when this fails, the
 * assertion diff names the field that changed, which is the whole difference
 * between a guard that explains itself and one that just says no.
 *
 * **Top level only.** It does not see a change inside a field, and both of this
 * repository's interesting cases are interior — `recording` gained a `kind`
 * discriminator with no bump, and `transcript` gained an `annotations` field
 * with one. Neither would move this string. Interior changes still need the
 * judgement a rung's `reason` is there to record.
 */
export function shapeSignature(schema: ZodObject): string {
  // `ZodObject`'s shape is loosely typed without a type parameter, and naming one
  // here would mean naming every document's shape at the call site. A field is
  // optional exactly when `undefined` parses — the same test `schema.test.ts` uses.
  const shape = schema.shape as Record<string, ZodType>;
  return Object.entries(shape)
    .map(([key, field]) => (field.safeParse(undefined).success ? `${key}?` : key))
    .sort()
    .join(",");
}
