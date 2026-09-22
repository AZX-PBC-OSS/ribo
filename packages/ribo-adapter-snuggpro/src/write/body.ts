import type { SnuggEndpointOperation } from "../endpoints.generated.js";
import { SNUGG_ENDPOINTS } from "../endpoints.generated.js";
import { resolveDuctInsulationVendorLiteral } from "../normalization.js";

/**
 * The pure patch→wire-body turn for Snugg Pro write-back: a reviewed patch's
 * values for one group become the JSON body one of the vendor's write
 * operations accepts. No HTTP here — the egress layer sends what this returns,
 * and is tested against bodies rather than against a network.
 *
 * The operation is named, not passed as an object, so `params`, the create-only
 * list and the create/update split all come from the one source of truth
 * (`SNUGG_ENDPOINTS`) and a hand-rolled operation object can never desync them.
 */
export type SnuggWriteOperationName = "create" | "update" | "upsert";

/**
 * Leaves that name an id but are captured as spoken free text — the schema
 * says so explicitly ("never a UUID", "never an invented id"). Resolution
 * against the real id lists is a human, review-time step
 * (`runtime-reference-resolution-design.md`); sending the spoken string is a
 * 400 the write layer classifies as terminal, stranding the session. The
 * builder refuses, and never looks up, guesses or fuzzy-matches.
 *
 * `job.programId` is named for completeness; `JobFields` does not capture that
 * leaf yet, so a schema-valid patch cannot carry it.
 */
const UNRESOLVED_REFERENCE_LEAVES: ReadonlySet<string> = new Set([
  "fromTemplateUuid",
  "accountId",
  "programId",
]);

/**
 * Refuse a reference leaf that would actually be SENT, rather than one merely
 * present in the patch.
 *
 * The distinction is load-bearing for a create-only reference on a non-create
 * operation. `incentive.fromTemplateUuid` is create-only, so it is absent from
 * `incentive.update.params` and the body loop can never emit it — refusing on
 * its mere presence in `values` would strand an incentive UPDATE over a field
 * that was never going anywhere. Called from inside the loop, after the
 * accepted-parameter and create-only filters have already decided the leaf is
 * bound for the wire.
 */
const refuseUnresolvedReference = (group: string, name: string): void => {
  if (!UNRESOLVED_REFERENCE_LEAVES.has(name)) return;
  throw new Error(
    `write/body: \`${group}.${name}\` is captured as spoken free text, never an id — ` +
      `resolve it against the real id list with a human at review before writing. ` +
      `Refusing to send an unresolved reference.`,
  );
};

/**
 * Per-leaf wire transform. The absence distinction is decided by the caller
 * loop (an undefined value is skipped, never transformed): an explicit `null`
 * passes through untouched — the vendor clears a `null` field and leaves an
 * absent one alone — and a number stringifies only where the spec types the
 * parameter `string`, never by field-name list.
 *
 * **Both transforms key on the VALUE, never on the leaf's name.** An earlier
 * version matched `name === "hvacDuctInsulation"`, which put a copy of a schema
 * identifier here as a bare string: renaming the leaf would move `schema.ts` and
 * leave this comparison quietly never matching again, so the alias would reach
 * the vendor unmapped and be rejected — a silent break with no failing test,
 * because nothing ties the literal to the schema. `resolveDuctInsulationVendorLiteral`
 * returns its input unchanged on a miss, so asking it about every string costs a
 * `Map.get` and removes the coupling. It also means a second leaf carrying the
 * same enum is handled for free rather than silently missed.
 */
const transformLeaf = (value: unknown, specType: string): unknown => {
  if (value === null) return null;
  if (typeof value === "number" && specType === "string") return String(value);
  if (typeof value === "string") return resolveDuctInsulationVendorLiteral(value);
  return value;
};

/**
 * Turn one group's plain reviewed values into the JSON body the named write
 * operation accepts. Pure: filters to the operation's declared `params`, drops
 * the group's create-only keys on every non-create operation, stringifies
 * numerics the spec types `string`, maps duct-insulation aliases to the
 * vendor's literals, and refuses an unresolved reference leaf rather than
 * sending spoken text.
 *
 * @throws Error on an unknown group, an operation the group does not have
 * (`job` has no create), or an unresolved reference leaf present in `values`.
 */
export const buildWriteBody = (
  group: string,
  operationName: SnuggWriteOperationName,
  values: Record<string, unknown>,
): Record<string, unknown> => {
  const endpoints = SNUGG_ENDPOINTS[group];
  if (!endpoints) {
    throw new Error(`write/body: no Snugg Pro endpoint table entry for group "${group}".`);
  }
  const operation: SnuggEndpointOperation | undefined = endpoints[operationName];
  if (!operation) {
    throw new Error(`write/body: the "${group}" group has no "${operationName}" operation.`);
  }
  const body: Record<string, unknown> = {};
  for (const [name, specType] of Object.entries(operation.params)) {
    if (!Object.hasOwn(values, name)) continue;
    const value = values[name];
    // An undefined value is absence, not a null — it never reaches the wire.
    if (value === undefined) continue;
    if (operationName !== "create" && endpoints.createOnly.includes(name)) continue;
    // Last, so it fires only for a leaf the filters above have already decided
    // is bound for the wire. See the refusal's own note.
    refuseUnresolvedReference(group, name);
    body[name] = transformLeaf(value, specType);
  }
  return body;
};
