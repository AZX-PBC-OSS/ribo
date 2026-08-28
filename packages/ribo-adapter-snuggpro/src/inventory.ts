/**
 * The inventory-pass roster for Snugg Pro instance extraction — the schema and
 * natural-language instructions that drive one house-wide call before any per-
 * instance fill.
 *
 * The roster is **scaffolding for prompt assembly**, not part of the write patch
 * or the extraction contract (design §5.3). It lists, per collection group, the
 * candidate instances the auditor introduced, with the verbatim spans that ground
 * existence, separation and exclusion. It is not persisted and does not reach
 * review.
 *
 * The three span requirements are one mechanism used three times (design §3):
 * existence, separation and exclusion each require a verbatim quote, making the
 * unsafe direction cost evidence. A model cannot invent a system, split one into
 * two, or drop a live one without quoting the auditor doing it.
 *
 * `discriminator` is a prompting artifact only — a short auditor-language handle
 * with no write target — so there is no schema leaf for it beyond this roster.
 */

import { z } from "zod";

import { TRANSCRIPT_SECTION } from "./instructions.js";

/** Eligibility verdict for a candidate instance. */
export const RosterEligibility = z.enum([
  "current",
  "decommissioned",
  "proposed",
  "off-property",
  "outside-scope",
]);

/** A single candidate instance in the inventory roster. */
export const rosterCandidateSchema = z.union([
  // A current (recordable) candidate: no exclusion span needed.
  z.strictObject({
    mentionSpan: z.string(),
    discriminator: z.string(),
    distinguishedBy: z.string().nullable(),
    eligibility: z.literal("current"),
    eligibilitySpan: z.null(),
  }),
  // An excluded candidate: the span where the auditor excluded it is required.
  z.strictObject({
    mentionSpan: z.string(),
    discriminator: z.string(),
    distinguishedBy: z.string().nullable(),
    eligibility: RosterEligibility.exclude(["current"]),
    eligibilitySpan: z.string(),
  }),
]);

export type RosterCandidate = z.infer<typeof rosterCandidateSchema>;

/**
 * One group of candidates, ordered by first mention. The first candidate may
 * carry `distinguishedBy: null`; every later candidate must carry a non-null
 * span that separates it from the ones before it.
 */
const rosterGroupSchema = z
  .array(rosterCandidateSchema)
  .refine(
    (candidates) =>
      candidates.every((candidate, index) => index === 0 || candidate.distinguishedBy !== null),
    {
      message: "every candidate after the first must have a non-null distinguishedBy span",
    },
  );

/** The house-wide inventory roster, one ordered list per collection group. */
export const rosterSchema = z.strictObject({
  hvac: rosterGroupSchema,
  attic: rosterGroupSchema,
  wall: rosterGroupSchema,
  window: rosterGroupSchema,
  dhw: rosterGroupSchema,
});

export type Roster = z.infer<typeof rosterSchema>;

// --- Instructions ------------------------------------------------------------

const INVENTORY_PREAMBLE = `## System

You are doing an inventory pass over a home energy auditor's dictated transcript. Your job is to
list every recordable instance of the following component types: \`hvac\`, \`attic\`, \`wall\`,
\`window\`, and \`dhw\`. Do not fill any leaf fields yet — only decide which instances exist, which
are excluded, and how to refer to them.

For each candidate instance emit exactly these five fields:

- \`mentionSpan\` — the verbatim substring that introduces the component. This grounds its
  existence.
- \`discriminator\` — a short auditor-language handle, e.g. "the propane Carrier in the closet".
  This is only to help later passes identify the instance; it has no write target.
- \`distinguishedBy\` — the verbatim substring that separates this candidate from earlier ones in
  the same group. \`null\` for the first candidate in a group; required for every later one.
  This grounds the split.
- \`eligibility\` — \`current\` if the component should be recorded, otherwise one of the named
  exclusion reasons: \`decommissioned\`, \`proposed\`, \`off-property\`, \`outside-scope\`.
- \`eligibilitySpan\` — the verbatim quote for any non-\`current\` verdict. \`null\` for
  \`current\`. This grounds the exclusion.

### The rules

**1. Only mention what the auditor actually introduced.**

Every candidate needs a \`mentionSpan\` that is a character-for-character substring of the transcript.
If you cannot paste a span into find-in-page and match it, you do not have grounds for the
candidate. Emit \`null\` instead.

**2. Merge by default.**

Every mention of a component refers either to a candidate already in the roster or to a new one, and
the default is **already in the roster**. Splitting requires explicit evidence: contrastive language
like "separate from", "its own", "standalone", "the other one", "a second"; stated coexistence of
two systems; attributes that cannot hold of one thing concurrently; or an explicit count.

A bare re-mention, a pronoun or definite description continuing the same topic, a part-whole mention
(Rule 4), or a correction marker like "no wait" / "actually" / "I mean" signals merging or
sequential revision — not a new instance.

**3. A second candidate must be distinguished.**

For every group, the first candidate may carry \`distinguishedBy: null\`. Every later candidate must
carry a non-null \`distinguishedBy\` span. Without that span, the two candidates collapse into one.

**4. Exclusion needs a span.**

If \`eligibility\` is not \`current\`, \`eligibilitySpan\` must be a verbatim substring where the auditor
excluded the component. A mentioned-but-excluded component is different from one never mentioned.

**5. Granularity — one record per group as the vendor counts it.**

- \`hvac\`: equipment sharing a distribution system is one record, even when it is several physical
  boxes. An air handler, a condenser and a plenum are parts of a system, not systems. Equipment with
  its own distribution is another record.
- \`attic\`: one record per thermally distinct attic space.
- \`wall\`: one record per distinct wall construction assembly.
- \`window\`: one record per distinct window type or area.
- \`dhw\`: one record per water heating system.

**6. Self-correction at the instance level.**

Rule 5 of the leaf-level instructions says the last assertion wins for values. A retraction that
changes the **count** of instances resolves to the post-correction enumeration. "There's an air
handler, no wait, the furnace is in the closet and the AC air handler is the separate thing" yields
the corrected count, not the first one.

### Output

Return a **single JSON object** conforming exactly to the roster schema.

- The object has exactly five top-level keys — \`hvac\`, \`attic\`, \`wall\`, \`window\`, \`dhw\` — each
  an array of candidate instances in **first-mention order**.
- A group the transcript never mentions is an **empty array**, not an invented candidate.
- No prose, no explanation, no markdown fence, no commentary before or after. The response is the
  JSON object and nothing else.`;

/**
 * The full inventory-pass instructions for Snugg Pro: the system prompt, rules,
 * output section and the transcript injection boundary. The transcript stays
 * last so everything after the boundary line is data, never instructions.
 */
export const snuggInventoryInstructions = INVENTORY_PREAMBLE + TRANSCRIPT_SECTION;
