# Roster absence: a group can say "none of these," grounded in a quote

Status: Draft — for review, no implementation plan written yet.

Tracked in Asana: "Ribo: roster can't say a group was stated as empty (no
verbatim-grounded none-stated signal)" (task 1218261411732237).

## 1. The problem

An untouched roster group and a group the auditor explicitly said was empty both
collapse to the same `[]` today. `Roster` (`ribo-extractor-openai/src/instance-fill.ts:46-57`)
is `{ [groupKey]: RosterCandidate[] }` — there is no value that means "the transcript
states there are none of these," only the absence of any candidate. The gap is a named,
accepted-for-now loss in `r1.6-instance-extraction-design.md` §5.3: "An eligibility
decision leaves no trace. If the model wrongly excludes a live system, nothing anywhere
says so, and it is indistinguishable from a system never mentioned... It is accepted
here because surfacing it means a core contract change and a review-card affordance,
and both are additive later." §9's "out of scope" list names it directly: "Surfacing
eligibility to review... Additive later."

Downstream, `review.ts`'s `ReviewCollectionNode.state` (`"absent" | "empty" |
"populated"`, `review.ts:186`) has the identical gap one layer up: `"empty"` means "an
array node exists with zero elements" (`review.ts:497-504`) regardless of whether that
emptiness was ever asserted by anything in the transcript. `ReviewPanel.tsx:541`
renders every empty collection group with the same hardcoded `<p>none described</p>` —
never a quote, because no quote exists to render. This is the gap that blocks "None in
this house" copy with a grounding quote (`group.emptyQuote` in the ask that motivated
this design).

## 2. Design: one new grounded value, threaded minimally

The codebase already has a house pattern for grounding a claim about a roster group in
a verbatim quote — `r1.6-instance-extraction-design.md` §3 calls it "one mechanism
three times": existence (`mentionSpan`), separation (`distinguishedBy`), exclusion
(`eligibilitySpan`). This design is the fourth instance of that mechanism: **absence**.

### 2.1 Roster schema change

A roster group's value becomes a union instead of a bare array:

```
RosterGroupResult<T> = readonly T[] | { readonly stated: "none"; readonly span: string }
```

applied to both the generic TS interface
(`ribo-extractor-openai/src/instance-fill.ts:46-57`) and the vendor-specific zod
schema (`ribo-adapter-snuggpro/src/inventory.ts`'s `rosterGroupSchema`, currently
`z.array(rosterCandidateSchema)`). `span` follows the same verbatim-substring-or-null
discipline as the roster's existing three spans (`inventory.ts:107-111`: "If you
cannot paste a span into find-in-page and match it, you do not have grounds for the
candidate. Emit `null` instead.") — except here the span is required, not nullable,
since the `{ stated: "none" }` variant only exists when there's a quote to back it.

The roster stays internal-only in every other respect — `discriminator` and the rest
of the scaffolding are not touched, matching `r1.6-instance-extraction-design.md`
§5.3's deliberate "roster is internal" decision. Only this one new signal crosses the
boundary (§2.2).

### 2.2 One new `ExtractionResult` field, not the whole roster

`scopedInstanceExtractor` (`instance-fill.ts:400`) already computes
`const roster = await inventory(transcript)` and discards it after building
`FillScope` objects. This design adds one line: for any group whose roster value is
`{ stated: "none" }`, record `(group, span)` into a new field on the extractor's
return value:

```
statedEmptyGroups?: Readonly<Record<string /* group */, string /* verbatim span */>>
```

This is additive to `ExtractionResult` and requires **no sessions schema migration** —
`session-schema.ts:134,263` stores `extracted` as `z.record(z.string(), z.unknown())`
/ `{ type: "object" }`, opaque and unpinned at the nested level (confirmed: no test in
`session-schema.test.ts` constructs or asserts a shaped `extracted` payload). A new
`ExtractionResult` field is invisible to RxDB's schema validation.

### 2.3 A fourth `ReviewGroupState` value

`ReviewGroupState` (`review.ts:186`) gains a fourth value, `"statedEmpty"`.
`ReviewCollectionNode` (`review.ts:219-226`) gains a nullable field,
`emptyQuote: string | null`, populated only when `state === "statedEmpty"`.
`buildReviewRequest`'s collection-state computation (`review.ts:497-504`) changes from

```
state = arrayNode === undefined ? "absent" : elements.length === 0 ? "empty" : "populated"
```

to consult `extractionResult.statedEmptyGroups?.[group]` when `elements.length === 0`:
present → `"statedEmpty"` with `emptyQuote` set to the span; absent → `"empty"` as
today, `emptyQuote: null`. `"absent"` (no array node at all) is unaffected — "there are
none of these" and "never mentioned" stay different claims, per the existing doc
comment at `ReviewPanel.tsx:76-79`, and this design adds a third claim distinct from
both: "never mentioned, but *this specific absence* was affirmatively stated."

### 2.4 Canvas rendering

`ReviewPanel.tsx`'s `groupFields` (lines 148-180) passes `emptyQuote` through onto its
`ResourceGroup` shape alongside the existing `isEmpty` boolean. The render at line
533-550 branches: when `emptyQuote` is present, render it (the "None in this house"
copy plus the quote) instead of the current hardcoded `<p>none described</p>`; when
absent, today's fallback (which still applies to a genuinely untouched/never-decided
group) is unchanged.

## 3. What this does *not* do

- Does not persist or expose the roster's other internal fields
  (`discriminator`, `mentionSpan`, `distinguishedBy`) — only the one new
  `stated: "none"` / `span` signal crosses into `ExtractionResult`.
- Does not change how populated or genuinely-untouched groups render.
- Does not retroactively backfill `statedEmpty` for sessions already extracted before
  this ships — their `extracted` blob simply won't have `statedEmptyGroups`, and
  `buildReviewRequest` treats that exactly like today's `"empty"` case (no crash, no
  special-casing needed, since the field is optional and `?.[group]` on `undefined` is
  `undefined`).

## 4. Testing

- `ribo-adapter-snuggpro/inventory.test.ts` (or equivalent): the new
  `rosterGroupSchema` union accepts both a candidate array and a
  `{ stated: "none", span }` value, and rejects a `{ stated: "none" }` missing `span`
  or with an empty string.
- `instance-fill.test.ts`: `scopedInstanceExtractor` surfaces `statedEmptyGroups`
  correctly when the injected `inventory` callback returns a stated-none group, and
  omits the key when the roster group is a genuinely empty array (no assertion made).
- `review.test.ts`: `buildReviewRequest` produces `state: "statedEmpty"` with the
  correct `emptyQuote` when `extractionResult.statedEmptyGroups` has an entry for that
  group, and confirms `"absent"` and plain `"empty"` are unaffected.
- A `ReviewPanel` test (or Storybook story, matching whatever this component already
  uses) confirming the quote renders in place of "none described" when
  `emptyQuote` is present.
