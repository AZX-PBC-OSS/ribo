# R2 — Headless Hook Layer — Implementation Plan

> **For anyone implementing this, human or agent:** work task-by-task, in order. Each task is
> independently testable and ends in a commit. Steps use checkbox (`- [ ]`) syntax for tracking. Do
> not batch tasks — a task's tests must pass before the next one starts. If a task's premise turns
> out to be wrong, stop and say so rather than improvising around it.

**Goal:** Make review a real gate in the outbox state machine, then populate `@azx/ribo-ui-react`
with six hooks and a provider over the core engine, and migrate the playground onto them.

**Architecture:** Phase A changes `@azx/ribo-core` — extracted items park in a new `awaiting-review`
status held out of `ACTIVE_OUTBOX_STATUSES`, so the relay drains past them instead of blocking on a
human; a review outcome is persisted; the write step consumes reviewed values and refuses an item
without them; `Recorder` gains pause/resume. Phase B builds hooks that subscribe to host-constructed
instances carried by a context provider. Phase C migrates the playground and its e2e suite.

**Tech Stack:** TypeScript 6.0.3, zod, RxDB (Dexie storage), React 19 (peer `^18.3 || ^19`), Vitest 4
with real-Chromium browser mode via Playwright, tsdown, pnpm 10.34.5 catalog.

**Design:** [`../design/r2-headless-hook-layer-design.md`](../design/r2-headless-hook-layer-design.md).
Section references below (§2.3, §3.6, …) point into it. Read §1–§2 before Task 1.

## Global Constraints

- **Node >= 24, pnpm 10.34.5.** Every command runs from the repo root.
- **`./check.sh` is the definition of done** (AGENTS.md §7): typecheck → lint → format:check →
  build:packages → resolve → build:app → pkg:gates → test. Paste its summary line; never assert
  success without it.
- **ESM-only**, `"type": "module"`, no CJS build.
- **zod at trust boundaries**, plain types inside. Persisted shapes are parsed, never cast.
- **`ribo-core` and `ribo-adapter-snuggpro` are headless**: no `react`, no `react-dom`, no `document`,
  no `window` — enforced by `eslint.config.mjs`. Browser APIs (`MediaRecorder`, IndexedDB, `fetch`,
  `Blob`, `AudioContext`, `Worker`) are fine. Use bare `fetch(...)`, not `window.fetch(...)`.
- **`import type` for type-only imports** (`verbatimModuleSyntax` + an ESLint rule enforce it).
- **Public entry points only across packages**: `@azx/ribo-core`, never `@azx/ribo-core/src/...`.
- **Small, focused files.** One responsibility each; prefer a new file over growing one.
- **Never hand-format.** Run `pnpm format`. Prettier: semicolons, double quotes, trailing commas, 100
  columns.
- **Catalog versions are exact, no carets** (AGENTS.md §5.4). Resolve at install time and pin what you
  actually got. **Do not invent version numbers.** Do not bump `typescript` (held at 6.0.3) or
  `@types/node` (held at 24.13.3).
- **`status` in `outboxRxSchema` is `maxLength: 16`.** `"awaiting-review"` is 15 characters and
  `"discarded"` is 9, so both fit. Any longer status name in future needs the bound raised, which is
  another schema version.
- **Test tiers:** `*.test.ts` → `unit` project (node, no DOM). `*.browser.test.{ts,tsx}` → `browser`
  project (real Chromium, fake media device). `playground/e2e/*.e2e.test.ts` → `e2e` project
  (production build + preview server). A test that crosses a package boundary by package name **must**
  resolve in **both** tiers today: the `unit` project via the project-local `ssr.resolve.conditions`
  block (`vitest.config.ts:25-58`, guarded by `adapter-snuggpro/src/workspace-resolution.test.ts`) and
  the `browser` project via plain `resolve.conditions`. **AGENTS.md §5.1's caveat calling this
  unproven is stale** — Task 18 corrects it. Choose a tier by what the test needs from the
  environment, not by resolution.
- **Individual packages have no `test` script.** Select tests with a path argument:
  `pnpm vitest run packages/ribo-core`.

---

# Phase A — the review gate in core

## Task 1: Statuses, the persisted review outcome, and the migration

**Files:**

- Modify: `packages/ribo-core/src/review.ts` (add `reviewOutcomeSchema`)
- Modify: `packages/ribo-core/src/queue/schema.ts` (statuses, `reviewOutcome`, `version: 1`)
- Modify: `packages/ribo-core/src/queue/database.ts` (`migrationStrategies`)
- Modify: `packages/ribo-core/src/index.ts` (export `reviewOutcomeSchema`)
- Test: `packages/ribo-core/src/queue/schema.test.ts`, `packages/ribo-core/src/review.test.ts`

**Interfaces:**

- Produces: `reviewOutcomeSchema` (zod, loose mirror of `ReviewOutcome`);
  `OUTBOX_STATUSES` including `"awaiting-review"` and `"discarded"`;
  `FINISHED_OUTBOX_STATUSES` including `"discarded"`;
  `OutboxDocument.reviewOutcome?: z.infer<typeof reviewOutcomeSchema>`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test for `reviewOutcomeSchema`**

Append to `packages/ribo-core/src/review.test.ts`:

```ts
test("reviewOutcomeSchema accepts what resolveReview produces, for all three branches", () => {
  const accepted = { status: "accepted", fields: { atticRValue: 19 } };
  expect(reviewOutcomeSchema.parse(accepted)).toEqual(accepted);

  const edited = {
    status: "edited",
    fields: { atticRValue: 30 },
    editedFields: ["atticRValue"],
    rejectedFields: ["blowerDoorCfm50"],
  };
  expect(reviewOutcomeSchema.parse(edited)).toEqual(edited);

  const discarded = { status: "discarded", reason: "misspoke" };
  expect(reviewOutcomeSchema.parse(discarded)).toEqual(discarded);
  expect(reviewOutcomeSchema.parse({ status: "discarded" })).toEqual({ status: "discarded" });
});

test("reviewOutcomeSchema rejects an edited outcome missing its touched-field lists", () => {
  // `editedFields`/`rejectedFields` are what name the human's work. An `edited`
  // outcome without them is indistinguishable from `accepted` and must not parse.
  expect(() => reviewOutcomeSchema.parse({ status: "edited", fields: {} })).toThrow();
});
```

Add `reviewOutcomeSchema` to the existing import from `./review.js` at the top of the file.

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm vitest run packages/ribo-core/src/review.test.ts
```

Expected: FAIL — `reviewOutcomeSchema` is not exported.

- [ ] **Step 3: Add `reviewOutcomeSchema` to `review.ts`**

`review.ts` currently imports no zod. Add `import { z } from "zod";` at the top, then append:

```ts
/**
 * The **persisted** mirror of {@link ReviewOutcome} — loose, because the outbox
 * document schema cannot be generic in `F`.
 *
 * Same reasoning as `extracted` in `queue/schema.ts`: one document schema
 * describes every host tool's field set, so the typed `ReviewOutcome<F>` lives at
 * the hook boundary and erases to this on the way to disk. `queue/schema.ts`
 * imports it from here rather than redeclaring it, so the concept has one owner.
 *
 * Strict objects on each branch: an `edited` outcome that lost `editedFields` is
 * indistinguishable from `accepted`, and silently under-reporting review effort is
 * exactly the failure `resolveReview`'s doc comment refuses.
 */
export const reviewOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("accepted"),
    fields: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    status: z.literal("edited"),
    fields: z.record(z.string(), z.unknown()),
    editedFields: z.array(z.string()),
    rejectedFields: z.array(z.string()),
  }),
  z.strictObject({
    status: z.literal("discarded"),
    reason: z.string().optional(),
  }),
]);

/** The persisted, field-set-agnostic outcome. `ReviewOutcome<F>` is the typed form. */
export type PersistedReviewOutcome = z.infer<typeof reviewOutcomeSchema>;
```

- [ ] **Step 4: Export it and confirm the test passes**

Add to `packages/ribo-core/src/index.ts`, in the existing "Human review" block:

```ts
export { buildReviewRequest, resolveReview, reviewOutcomeSchema } from "./review.js";
```

and add `PersistedReviewOutcome` to the adjacent `export type { … } from "./review.js";` list.

```bash
pnpm vitest run packages/ribo-core/src/review.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing schema tests**

In `packages/ribo-core/src/queue/schema.test.ts`, add:

```ts
test("awaiting-review is a status but is deliberately not active", () => {
  // The gate. `nextPending()` selects on ACTIVE_OUTBOX_STATUSES, so keeping
  // awaiting-review out of it is the only thing that stops the relay writing an
  // un-reviewed item — see the design §2.3 and §3.3.
  expect(OUTBOX_STATUSES).toContain("awaiting-review");
  expect(ACTIVE_OUTBOX_STATUSES as readonly string[]).not.toContain("awaiting-review");
  expect(FINISHED_OUTBOX_STATUSES as readonly string[]).not.toContain("awaiting-review");
});

test("discarded is terminal and distinct from dead", () => {
  expect(FINISHED_OUTBOX_STATUSES as readonly string[]).toContain("discarded");
  expect(ACTIVE_OUTBOX_STATUSES as readonly string[]).not.toContain("discarded");
});

test("every status fits the indexed maxLength the RxDB schema declares", () => {
  // `status` is stored with maxLength 16. A longer status name silently breaks
  // RxDB's fixed-width index encoding, so this is pinned rather than assumed.
  const bound = outboxRxSchema.properties.status.maxLength;
  for (const status of OUTBOX_STATUSES) expect(status.length).toBeLessThanOrEqual(bound);
});

test("a document carries an optional review outcome", () => {
  const base = {
    id: "a",
    seq: 0,
    status: "awaiting-review",
    idempotencyKey: "k",
    attempts: 0,
    nextAttemptAt: new Date(0).toISOString(),
    enqueuedAt: new Date(0).toISOString(),
    recording: {
      id: "r",
      capturedAt: new Date(0).toISOString(),
      durationMs: 1,
      mimeType: "audio/webm",
      ctx: {},
    },
  };
  expect(outboxDocumentSchema.parse(base).reviewOutcome).toBeUndefined();

  const reviewed = outboxDocumentSchema.parse({
    ...base,
    reviewOutcome: { status: "accepted", fields: { atticRValue: 19 } },
  });
  expect(reviewed.reviewOutcome).toEqual({ status: "accepted", fields: { atticRValue: 19 } });
});

test("the RxDB schema is at version 1", () => {
  expect(outboxRxSchema.version).toBe(1);
});
```

Import whatever of `ACTIVE_OUTBOX_STATUSES`, `FINISHED_OUTBOX_STATUSES`, `outboxRxSchema`,
`outboxDocumentSchema` the file does not already import.

- [ ] **Step 6: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-core/src/queue/schema.test.ts
```

Expected: FAIL. The existing drift guards (document ↔ Rx ↔ item) will also fail once Step 7 lands
partially — that is them working. Both must be green by Step 8.

- [ ] **Step 7: Change `queue/schema.ts`**

Import the outcome schema:

```ts
import { reviewOutcomeSchema } from "../review.js";
```

Add both statuses:

```ts
export const OUTBOX_STATUSES = [
  "queued",
  "transcribing",
  "extracting",
  "awaiting-review",
  "writing",
  "done",
  "failed",
  "dead",
  "discarded",
] as const;
```

Leave `ACTIVE_OUTBOX_STATUSES` **unchanged**, and add this comment directly above it:

```ts
/**
 * Statuses the relay will still act on. Everything else is finished — or, in the
 * case of `awaiting-review`, waiting on a human.
 *
 * **`awaiting-review` is missing from this list on purpose, and that omission is
 * the review gate.** `nextPending()` selects `list({ status: ACTIVE_OUTBOX_STATUSES })`,
 * so a parked item is never handed to the relay, and the next capture drains past
 * it. Add `awaiting-review` here and the relay will pick a parked item up,
 * `nextStep()` will see `extracted` present and return `"write"`, and un-reviewed
 * model output goes to the host tool. `schema.test.ts` pins this, and
 * `relay.browser.test.ts` proves the behaviour end to end.
 */
```

Add `"discarded"` to `FINISHED_OUTBOX_STATUSES`.

Add the document field, after `writeResult`:

```ts
  /**
   * What the human decided. Present once review has been submitted; absent means
   * this item has not been reviewed, which `relay.ts` treats as a hard error at
   * write time rather than a default-accept.
   */
  reviewOutcome: reviewOutcomeSchema.optional(),
```

In `outboxRxSchema`: bump `version: 0` to `version: 1` and add `reviewOutcome: { type: "object" }` to
`properties`, alongside `writeResult`. Do **not** add it to `required`.

- [ ] **Step 8: Fix the three existing tests the version bump and status additions break**

These fail as a direct consequence of Step 7 and are **not** the drift guards. Each is a real
assertion that needs a considered change, not a deletion.

1. **`queue/schema.test.ts:123` — "the active and finished status sets partition the state machine"**
   asserts `[...ACTIVE, ...FINISHED].sort()` equals `[...OUTBOX_STATUSES].sort()`. `awaiting-review`
   is in neither set, deliberately, so the partition no longer holds. Rewrite it to say what is now
   true, and to keep asserting that nothing is _accidentally_ unclassified:

   ```ts
   test("every status is active, finished, or explicitly parked for a human", () => {
     // `awaiting-review` is in neither set on purpose — that omission is the review
     // gate. It is named here rather than left as a hole, so a future status added
     // to neither set fails this test instead of silently joining it.
     const PARKED: readonly OutboxStatus[] = ["awaiting-review"];
     expect([...ACTIVE_OUTBOX_STATUSES, ...FINISHED_OUTBOX_STATUSES, ...PARKED].sort()).toEqual(
       [...OUTBOX_STATUSES].sort(),
     );
   });
   ```

2. **`src/index.test.ts:11`** pins the barrel's exact export list. Add `reviewOutcomeSchema` (and note
   `ReviewPresenter` leaves that list in Task 5, not here).

3. **`queue/outbox.browser.test.ts:69`** — `idbDatabaseName` builds
   `` `rxdb-dexie-${outboxName}--0--outbox` ``. **That `--0--` is the schema version**, so after the
   bump the raw-IndexedDB durability test opens a database that does not exist and fails in a way that
   looks like lost data. Parameterise it:

   ```ts
   function idbDatabaseName(outboxName: string, schemaVersion = outboxRxSchema.version): string {
     // The `--N--` segment is RxDB's schema version. Read it from the schema rather
     // than hardcoding it, so a version bump does not send this test looking in a
     // database that was never created.
     return `rxdb-dexie-${outboxName}--${String(schemaVersion)}--outbox`;
   }
   ```

   The file header already acknowledges this coupling to an RxDB implementation detail as "the price
   of an assertion that cannot be satisfied by anything in our own code" — keep that reasoning, just
   stop hardcoding the number.

- [ ] **Step 9: Register the migration plugin, then add the strategy in `database.ts`**

**The strategy alone is not enough and the failure is at open time, not at migration time.**
`database.ts:39` registers only `RxDBAttachmentsPlugin`. RxDB's schema-migration code lives in a
separate plugin, and with `version: 1` and RxDB's default `autoMigrate: true`, `addCollections` calls
into it during collection creation — so without the plugin the **outbox does not open at all**. Add it
to `registerPlugins`:

```ts
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";

function registerPlugins(): void {
  if (pluginsRegistered) return;
  addRxPlugin(RxDBAttachmentsPlugin);
  // Required from schema version 1 onward. RxDB calls into the migration plugin
  // during `addCollections` whenever a collection's schema version is above 0
  // (`autoMigrate` defaults to true), so without this the outbox fails to OPEN —
  // the error arrives at open time and says nothing about migrations.
  addRxPlugin(RxDBMigrationSchemaPlugin);
  pluginsRegistered = true;
}
```

Verify the subpath is exactly what this RxDB version ships:

```bash
node -e "console.log(Object.keys(require('rxdb/plugins/migration-schema')))" 2>/dev/null \
  || ls node_modules/rxdb/plugins/ | grep -i migration
```

Use whatever that reports rather than trusting the import above.

- [ ] **Step 10: Add the migration strategy in `database.ts`**

```ts
await database.addCollections({
  [OUTBOX_COLLECTION_NAME]: {
    schema: outboxRxSchema,
    // v0 → v1 added the optional `reviewOutcome` field (the review gate). An
    // absent optional field needs no transformation, so the strategy is
    // identity — but it is declared and exercised rather than skipped, so the
    // migration path exists before a non-trivial one needs it. Nothing is
    // published and there are no users, so no deployed data is at risk here.
    migrationStrategies: { 1: (doc: OutboxDocument) => doc },
  },
});
```

- [ ] **Step 11: Prove the migration path against a real v0 database**

**A reopen does not test this.** Both opens see `version: 1`, so nothing migrates and the test passes
whether or not the plugin and strategy exist — the exact "passes while production is broken" shape
`vitest.config.ts` warns about. A genuine v0→v1 upgrade needs a database whose **stored** version is
0, and RxDB encodes that version in the physical IndexedDB name (`rxdb-dexie-<name>--0--outbox`, per
the helper fixed in Step 8).

So seed one directly, in the browser tier, using the file's existing raw-IndexedDB helpers:

```ts
test("an outbox stored at schema version 0 opens and migrates to version 1", async () => {
  // Seeded through raw IndexedDB at the v0 physical name, because openOutbox() can
  // only ever create a v1 store — and a v1-to-v1 reopen would pass with no
  // migration plugin registered at all, which is precisely the failure this test
  // exists to catch.
  const name = `migration-${crypto.randomUUID()}`;
  await seedVersionZeroOutbox(name, v0Document());

  const outbox = await openOutbox({ name });
  const items = await outbox.list({});

  expect(items).toHaveLength(1);
  expect(items[0]?.reviewOutcome).toBeUndefined();
  expect(items[0]?.status).toBe("queued");

  await outbox.close();
  await removeOutboxDatabase(name);
});
```

`seedVersionZeroOutbox` writes one document into `idbDatabaseName(name, 0)` through the same raw
`indexedDB` path the durability test already uses — model it on that helper rather than inventing a
second style, and put the v0 document shape (no `reviewOutcome`) in `v0Document()`.

**If seeding a v0 store faithfully proves impractical** — RxDB's internal store layout is an
implementation detail and the durability test's header already calls that coupling "the price of an
assertion that cannot be satisfied by anything in our own code" — then do **not** ship a reopen test
dressed up as a migration test. Say so, and fall back to two honest assertions instead:

```ts
test("the migration plugin is registered, so a versioned collection can open", async () => {
  // Not a migration test. It pins the thing whose absence breaks OPEN: with
  // version 1 and autoMigrate on, addCollections calls into the migration plugin.
  const outbox = await openOutbox({ name: `plugin-${crypto.randomUUID()}` });
  expect(outbox.closed).toBe(false);
  await outbox.close();
});

test("the v1 migration strategy passes a document through unchanged", () => {
  const doc = { id: "a", seq: 0, status: "queued" };
  expect(OUTBOX_MIGRATION_STRATEGIES[1](doc)).toBe(doc);
});
```

The second requires exporting the strategies from `database.ts` as a named
`OUTBOX_MIGRATION_STRATEGIES` const rather than inlining them in `addCollections`. **State in the
commit message which route you took and why** — a migration test that does not migrate is worse than
an honest pair of narrower ones.

- [ ] **Step 12: Run the full core suite**

```bash
pnpm vitest run packages/ribo-core && pnpm --filter @azx/ribo-core typecheck
```

Expected: PASS. If a drift guard still fails, the three schemas disagree — fix the schema, not the
guard.

- [ ] **Step 11: Format, lint, commit**

```bash
pnpm format && pnpm lint
git add packages/ribo-core/src
git commit -m "Add awaiting-review and discarded statuses with a persisted review outcome

Bumps the outbox RxDB schema to version 1 with an identity migration.
awaiting-review is held out of ACTIVE_OUTBOX_STATUSES on purpose: that omission
is the review gate, since nextPending() selects on that list."
```

---

## Task 2: `summarizeWork` must not lose un-reviewed work

**Files:**

- Modify: `packages/ribo-core/src/work-safety.ts`
- Test: `packages/ribo-core/src/work-safety.test.ts`

**Interfaces:**

- Consumes: `OUTBOX_STATUSES` from Task 1.
- Produces: `WorkOnDevice` with an added `awaitingReview: number`.

**Why this task exists:** `summarizeWork` classifies on status with three branches — `dead`, `done`,
`in ACTIVE_OUTBOX_STATUSES` → `pending`. A status in none of them is counted as **nothing**, so after
Task 1 an outbox holding only `awaiting-review` items reports `pending: 0`, and `workSafety` then
answers `{ level: "safe", reason: "nothing-captured" }` while the auditor's dictation sits
un-reviewed on the device. See design §3.6.

- [ ] **Step 1: Write the failing tests**

Add to `packages/ribo-core/src/work-safety.test.ts`:

```ts
test("an awaiting-review item is pending work, not invisible", () => {
  const work = summarizeWork([{ status: "awaiting-review" }]);
  expect(work).toEqual({ pending: 1, dead: 0, synced: 0, awaitingReview: 1 });
});

test("un-reviewed work is never reported as safe", () => {
  // The regression this task exists for: a status outside summarizeWork's three
  // branches used to count as nothing, so the verdict read "safe / nothing-captured"
  // over a device holding an un-reviewed recording.
  const work = summarizeWork([{ status: "awaiting-review" }]);
  const verdict = workSafety(work, "granted", "online");
  expect(verdict.level).not.toBe("safe");
  expect(verdict).toEqual({
    level: "protected",
    reason: "awaiting-sync",
    pending: 1,
    connectivity: "online",
  });
});

test("un-reviewed work on unpersisted storage is at risk", () => {
  const work = summarizeWork([{ status: "awaiting-review" }]);
  expect(workSafety(work, "denied", "online")).toEqual({
    level: "at-risk",
    reason: "not-persisted",
    pending: 1,
    persistence: "denied",
  });
});

test("a discarded item is not work at all", () => {
  // Deliberately abandoned. Not pending (nothing to do), not synced (it never
  // left), not dead (it did not fail).
  const work = summarizeWork([{ status: "discarded" }]);
  expect(work).toEqual({ pending: 0, dead: 0, synced: 0, awaitingReview: 0 });
  expect(workSafety(work, "granted", "online")).toEqual({
    level: "safe",
    reason: "nothing-captured",
  });
});

test("awaitingReview counts only the parked items, while pending counts all unsynced work", () => {
  const work = summarizeWork([
    { status: "queued" },
    { status: "awaiting-review" },
    { status: "awaiting-review" },
    { status: "done" },
    { status: "discarded" },
  ]);
  expect(work).toEqual({ pending: 3, dead: 0, synced: 1, awaitingReview: 2 });
});

test("every status is accounted for by exactly one bucket, or deliberately none", () => {
  // A guard against the next status added without revisiting this function: the
  // failure mode is silent under-counting, so it is pinned rather than trusted.
  const unclassified = OUTBOX_STATUSES.filter((status) => {
    const work = summarizeWork([{ status }]);
    return work.pending + work.dead + work.synced === 0;
  });
  expect(unclassified).toEqual(["discarded"]);
});
```

Import `OUTBOX_STATUSES` if the file does not already.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-core/src/work-safety.test.ts
```

Expected: FAIL — `awaitingReview` is not in the returned object, and the safety verdict reads `safe`.

- [ ] **Step 3: Add `awaitingReview` to `WorkOnDevice`**

```ts
export interface WorkOnDevice {
  /** Unsynced work still on the device: active, recoverable, not yet gone. */
  readonly pending: number;
  /** Items that failed permanently and will not move without a human. */
  readonly dead: number;
  /** Items that have left the device — the only truly-safe state. */
  readonly synced: number;
  /**
   * Of `pending`, how many are parked waiting for a human to review them.
   *
   * A **subset of `pending`**, not a fourth bucket: an un-reviewed recording is
   * unsynced work on a device, and needing a human rather than a network does not
   * make it safe. Exposed separately only so a UI can say "3 recordings need
   * review" without re-querying the outbox, and it is deliberately not consulted
   * by {@link workSafety}.
   */
  readonly awaitingReview: number;
}
```

- [ ] **Step 4: Fix `summarizeWork`**

```ts
export const summarizeWork = (items: readonly Pick<OutboxItem, "status">[]): WorkOnDevice => {
  let pending = 0;
  let dead = 0;
  let synced = 0;
  let awaitingReview = 0;

  for (const { status } of items) {
    if (status === "dead") dead += 1;
    else if (status === "done") synced += 1;
    else if (status === "awaiting-review") {
      // Parked for a human. Counted as pending because it is unsynced work sitting
      // on a device — the review gate changes who unblocks it, not whether it is
      // at risk. Omitting it here is the bug this branch exists to prevent: it
      // would fall through every branch and be counted as nothing, making
      // workSafety answer "safe" over an un-reviewed recording.
      pending += 1;
      awaitingReview += 1;
    } else if ((ACTIVE_OUTBOX_STATUSES as readonly string[]).includes(status)) pending += 1;
    // `discarded` is counted nowhere, deliberately: work the human abandoned is
    // not outstanding, has not synced, and did not fail.
  }

  return { pending, dead, synced, awaitingReview };
};
```

Also update the `@link ACTIVE_OUTBOX_STATUSES` sentence in the doc comment above `summarizeWork` so it
no longer claims every non-`done`/`dead` status is classified by that list.

- [ ] **Step 5: Run and confirm pass**

```bash
pnpm vitest run packages/ribo-core/src/work-safety.test.ts && pnpm --filter @azx/ribo-core typecheck
```

Expected: PASS. Typecheck will flag any other construction of a `WorkOnDevice` literal — fix those to
include `awaitingReview`.

- [ ] **Step 6: Format, lint, commit**

```bash
pnpm format && pnpm lint
git add packages/ribo-core/src/work-safety.ts packages/ribo-core/src/work-safety.test.ts
git commit -m "Count awaiting-review items as pending work

summarizeWork classified on three status branches and counted anything outside
them as nothing, so an outbox holding only awaiting-review items reported
pending: 0 and workSafety answered 'safe' over un-reviewed work on the device.
Adds an informational awaitingReview subset count and a guard test that every
status lands in a bucket or is deliberately excluded."
```

---

## Task 3: The relay parks at `awaiting-review` and writes reviewed values

**Files:**

- Modify: `packages/ribo-core/src/queue/relay.ts`
- Test: `packages/ribo-core/src/queue/relay.browser.test.ts`

**Interfaces:**

- Consumes: statuses and `reviewOutcome` from Task 1.
- Produces: `WriteStepInput` with `reviewed: ExtractedFieldMap` **replacing** `extracted`. Task 12 and
  Task 17 update the two playground `write` stubs against this.

**Why the write change:** `nextStep` derives the step from which outputs are present, not from status
(`relay.ts:118`), and `#write` passes `item.extracted` — the model's raw envelope map. An auditor's
correction would be persisted to `reviewOutcome` and then ignored at write time. Design §2.9.

**This task revokes a documented guarantee, deliberately.** `queue/schema.ts:78` says `seq` means
"capture order is write order". Once a human gates the write, that stops being true: if recording 1 is
awaiting review and the auditor reviews recording 2 first, recording 2 writes first. The alternative —
refusing to write while any lower-`seq` item is non-terminal — reinstates exactly the stall the parked
design exists to avoid, with one un-reviewed recording blocking every write behind it. So the
guarantee is narrowed rather than defended, and it must be **rewritten where it is stated**, not
quietly falsified:

- `queue/schema.ts`'s `seq` comment becomes: capture order is the order items are _offered_ to the
  relay, and remains write order for everything the relay decides on its own — review is the one step
  a human orders, so writes follow review order.
- Add a test pinning the new truth, so nobody "fixes" it later:

  ```ts
  test("writes follow review order, not capture order", async () => {
    // The ordering guarantee `seq` used to carry, narrowed on purpose: a human
    // reviewing the second recording first means it writes first. Enforcing capture
    // order here would let one un-reviewed item block every write behind it.
    const { outbox, relay, writes } = await harness();
    await enqueueRecording(outbox);
    await enqueueRecording(outbox);
    await relay.drain();
    const [first, second] = await outbox.list({});

    await outbox.submitReview(second.id, { status: "accepted", fields: { atticRValue: 30 } });
    await relay.drain();

    expect(writes).toHaveLength(1);
    expect(writes[0].item.id).toBe(second.id);
    expect((await outbox.get(first.id))?.status).toBe("awaiting-review");
  });
  ```

**Budget for a substantial test rewrite, not an assertion swap.** Most of `relay.browser.test.ts` from
around `:195` drives a fresh `queued` item straight through to a write, then asserts on write retry,
idempotency-key reuse, ordering, connectivity edges and terminal-write failure. Every one of those
items now parks before writing, so replacing `done` with `awaiting-review` does not fix them — it
deletes what they were testing. Add three helpers and rebuild on them rather than patching assertions
one by one:

```ts
/** Drain until the item parks for review. */
const drainToReview = async (relay: Relay) => await relay.drain();
/** Accept every field, so the item is eligible to write. */
const acceptReview = async (outbox: Outbox, id: string, fields: ExtractedFieldMap = {}) =>
  await outbox.submitReview(id, { status: "accepted", fields });
/** Seed a row that is already reviewed and eligible, for write-only tests. */
const seedReviewedWriting = async (outbox: Outbox, fields: ExtractedFieldMap = {}) => { … };
```

The write-retry, idempotency and terminal-failure tests should use `seedReviewedWriting` so they test
the write in isolation; keep **at least one** end-to-end test that goes capture → transcribe → extract
→ review → write → `done`, because that is the path the product actually takes and nothing else covers
it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/ribo-core/src/queue/relay.browser.test.ts`, following the existing helpers in that
file for building an outbox and a relay:

```ts
test("a successful extraction parks the item for review instead of writing it", async () => {
  const { outbox, relay, writes } = await harness();
  await enqueueRecording(outbox);

  await relay.drain();

  const [item] = await outbox.list({});
  expect(item.status).toBe("awaiting-review");
  expect(item.extracted).toBeDefined();
  expect(writes).toHaveLength(0);
});

test("a parked item does not block the recordings behind it", async () => {
  // The point of parking rather than awaiting a presenter: a human reviewing the
  // first recording must not stop the second from transcribing and extracting.
  const { outbox, relay } = await harness();
  await enqueueRecording(outbox);
  await enqueueRecording(outbox);

  await relay.drain();

  const items = await outbox.list({});
  expect(items.map((item) => item.status)).toEqual(["awaiting-review", "awaiting-review"]);
});

test("the write step receives the human's reviewed values, not the model's", async () => {
  const { outbox, relay, writes } = await harness();
  await enqueueRecording(outbox);
  await relay.drain();
  const [parked] = await outbox.list({});

  await outbox.submitReview(parked.id, {
    status: "edited",
    fields: { atticRValue: 30 },
    editedFields: ["atticRValue"],
    rejectedFields: [],
  });
  await relay.drain();

  expect(writes).toHaveLength(1);
  expect(writes[0].reviewed).toEqual({ atticRValue: 30 });
  // The model's raw envelopes are still reachable for provenance.
  expect(writes[0].item.extracted).toBeDefined();
});

test("an item that reaches writing with no review outcome fails terminally", async () => {
  // Defence in depth for the one invariant whose violation is invisible: reaching
  // a write unreviewed is a state-machine bug, so it must not silently write.
  const { outbox, relay, writes } = await harness();
  await enqueueRecording(outbox);
  await relay.drain();
  const [parked] = await outbox.list({});

  await outbox.patch(parked.id, { status: "writing" });
  await relay.drain();

  expect(writes).toHaveLength(0);
  const [item] = await outbox.list({});
  expect(item.status).toBe("dead");
  expect(item.lastError).toMatch(/review/i);
});
```

The `harness()` helper must record `WriteStepInput` objects into `writes`. If the existing file has an
equivalent helper under another name, use it and drop `harness`; do not add a second one.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-core/src/queue/relay.browser.test.ts
```

Expected: FAIL — items reach `done` instead of parking.

**Write only the tests that do not call `submitReview` in this task**: the two parking tests and the
ordering test above depend on it, and it does not exist until Task 4. Specifically, write
"parks the item for review", "does not block the recordings behind it", and the un-reviewed-write
guard (which uses `outbox.patch`, not `submitReview`). Leave the two reviewed-values tests and the
review-order test to Task 4, which adds them fresh.

Do **not** write them now and comment them out. Commented-out tests are indistinguishable from
abandoned ones a week later, and a reviewer is right to flag them.

- [ ] **Step 3: Change `WriteStepInput`**

```ts
export interface WriteStepInput {
  item: OutboxItem;
  /**
   * The values review settled on — flat, already unwrapped from their provenance
   * envelopes by `resolveReview`, which is the shape `ToolAdapter.write(fields, ctx)`
   * wants.
   *
   * **This replaced an `extracted` field carrying the model's raw envelope map,
   * and the rename is the point.** Two similarly-named fields here would make
   * "wrote the un-reviewed values" a one-word typo with a silent symptom and a
   * customer's audit as the blast radius. The raw envelopes are still available as
   * `item.extracted` for provenance and diagnostics.
   */
  reviewed: ExtractedFieldMap;
  /**
   * Send this as `Idempotency-Key`. It is stable across every retry of this item,
   * which is the only thing standing between an ambiguous success and a
   * double-write.
   */
  idempotencyKey: string;
}
```

- [ ] **Step 4: Park at `awaiting-review` and guard the write**

```ts
  async #extract(item: OutboxItem): Promise<void> {
    const extracted = await this.#options.extract({ item, transcript: item.transcript! });
    // Parks for a human rather than advancing to `writing`. `awaiting-review` is
    // not in ACTIVE_OUTBOX_STATUSES, so `nextPending()` stops selecting this item
    // and the drain moves on to the next capture. `Outbox.submitReview` is the
    // only thing that moves it forward.
    await this.#patch(item.id, { extracted, status: "awaiting-review", attempts: 0 });
  }

  async #write(item: OutboxItem): Promise<void> {
    const outcome = item.reviewOutcome;
    if (outcome === undefined || outcome.status === "discarded") {
      // Unreachable through the state machine: `awaiting-review` is not active, so
      // only `submitReview` moves an item to `writing`, and a discard moves it to
      // `discarded` instead. Reaching here means the invariant broke, and writing
      // un-reviewed data to a customer's tool is not an acceptable way to find out.
      throw new TerminalQueueError(
        `outbox item ${item.id} reached the write step with no review outcome. Nothing is written that a human has not reviewed; move items forward with Outbox.submitReview.`,
      );
    }

    const writeResult = await this.#options.write({
      item,
      reviewed: outcome.fields,
      idempotencyKey: item.idempotencyKey,
    });
    await this.#patch(item.id, {
      status: "done",
      attempts: 0,
      // …keep whatever the existing implementation does with writeResult here.
    });
  }
```

`TerminalQueueError` is already exported from `./backoff.js`; import it if `relay.ts` does not already.
It is what makes the failure `dead` rather than retried, which the fourth test asserts.

- [ ] **Step 5: Run and confirm the first two tests pass**

```bash
pnpm vitest run packages/ribo-core/src/queue/relay.browser.test.ts
```

Expected: PASS for the two parking tests. Existing tests in this file that assert an item reaches
`done` after one drain must be updated — they now legitimately stop at `awaiting-review`. Update the
assertion, do not weaken it: assert `awaiting-review`.

- [ ] **Step 6: Format, lint, commit**

```bash
pnpm format && pnpm lint && pnpm --filter @azx/ribo-core typecheck
git add packages/ribo-core/src/queue/relay.ts packages/ribo-core/src/queue/relay.browser.test.ts
git commit -m "Park extracted items for review and write reviewed values

Extraction now patches status to awaiting-review, so the relay drains past the
item instead of writing it. WriteStepInput.extracted is replaced by reviewed --
the flat values resolveReview produces, which is what ToolAdapter.write wants --
because passing the model's raw envelopes would have made a reviewer's
corrections invisible at write time. A write with no review outcome fails
terminally rather than writing.

Two tests are commented out pending Outbox.submitReview in the next task."
```

---

## Task 4: `Outbox.submitReview`

**Files:**

- Modify: `packages/ribo-core/src/queue/outbox.ts`
- Test: `packages/ribo-core/src/queue/outbox.browser.test.ts`
- Modify: `packages/ribo-core/src/queue/relay.browser.test.ts` (add the three tests Task 3 deferred)

**Interfaces:**

- Consumes: `reviewOutcomeSchema` / `PersistedReviewOutcome` (Task 1), the statuses (Task 1).
- Produces: `Outbox.submitReview(id: string, outcome: PersistedReviewOutcome): Promise<OutboxItem>`.
  Task 14's `useReview` calls exactly this.

- [ ] **Step 1: Write the failing tests**

Add to `packages/ribo-core/src/queue/outbox.browser.test.ts`, using the file's existing setup helpers:

```ts
test("an accepted review moves the item to writing and persists the outcome", async () => {
  const outbox = await openTestOutbox();
  const item = await enqueueTestRecording(outbox);
  await outbox.patch(item.id, { status: "awaiting-review", extracted: { atticRValue: {} } });

  const outcome = { status: "accepted", fields: { atticRValue: 19 } } as const;
  const updated = await outbox.submitReview(item.id, outcome);

  expect(updated.status).toBe("writing");
  expect(updated.reviewOutcome).toEqual(outcome);
  expect(updated.attempts).toBe(0);
});

test("an edited review moves the item to writing with the touched fields named", async () => {
  const outbox = await openTestOutbox();
  const item = await enqueueTestRecording(outbox);
  await outbox.patch(item.id, { status: "awaiting-review" });

  const updated = await outbox.submitReview(item.id, {
    status: "edited",
    fields: { atticRValue: 30 },
    editedFields: ["atticRValue"],
    rejectedFields: ["blowerDoorCfm50"],
  });

  expect(updated.status).toBe("writing");
  expect(updated.reviewOutcome).toMatchObject({ editedFields: ["atticRValue"] });
});

test("a discarded review is terminal and drops the audio", async () => {
  const outbox = await openTestOutbox();
  const item = await enqueueTestRecording(outbox);
  expect(await outbox.getAudio(item.id)).toBeDefined();
  await outbox.patch(item.id, { status: "awaiting-review" });

  const updated = await outbox.submitReview(item.id, {
    status: "discarded",
    reason: "misspoke",
  });

  expect(updated.status).toBe("discarded");
  expect(updated.hasAudio).toBe(false);
  expect(await outbox.getAudio(item.id)).toBeUndefined();
  expect(updated.reviewOutcome).toEqual({ status: "discarded", reason: "misspoke" });
});

test("an edited review that rejected every field still goes to writing", async () => {
  // resolveReview's rule: rejecting every field is a statement about the
  // extraction, not the recording. Whether an empty field set is writable is the
  // adapter's schema.parse to decide, not the outbox's.
  const outbox = await openTestOutbox();
  const item = await enqueueTestRecording(outbox);
  await outbox.patch(item.id, { status: "awaiting-review" });

  const updated = await outbox.submitReview(item.id, {
    status: "edited",
    fields: {},
    editedFields: [],
    rejectedFields: ["atticRValue"],
  });

  expect(updated.status).toBe("writing");
});

test("submitting a review for an unknown id rejects", async () => {
  const outbox = await openTestOutbox();
  await expect(outbox.submitReview("nope", { status: "accepted", fields: {} })).rejects.toThrow(
    /nope/,
  );
});
```

Use whatever the file's existing open/enqueue helpers are actually called rather than
`openTestOutbox`/`enqueueTestRecording` if they differ.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-core/src/queue/outbox.browser.test.ts
```

Expected: FAIL — `submitReview` is not a function.

- [ ] **Step 3: Implement `submitReview`**

Add to the `Outbox` class, next to `patch`:

```ts
  /**
   * Record what a human decided about a parked item, and move it forward.
   *
   * The only way out of `awaiting-review`, and it **only** works from
   * `awaiting-review`. That guard is not defensive tidiness: `multiInstance: true`
   * means a second tab holds its own `Outbox` over the same IndexedDB database, so
   * without it a stale tab could submit a review for an item that has since reached
   * `done` — patching a completed row back to `writing` and causing a second write —
   * or discard one while a write is in flight.
   *
   * Applied through `incrementalModify`, which RxDB re-runs against the **current**
   * revision on write conflict, so the status check and the mutation cannot be
   * split by another writer. `patch()` is not usable here: it reads with `findOne`,
   * validates, then writes, and (contrary to what one might assume from `enqueue`)
   * it does **not** go through this class's `#serialized` chain — that chain guards
   * only the sequence-number allocation in `enqueue`.
   *
   * - `accepted` / `edited` → `writing`, with `attempts` reset so the write gets a
   *   clean backoff budget. The relay picks the item up on its next drain and
   *   passes `outcome.fields` to the write step.
   * - `discarded` → `discarded`, and the audio is dropped. An auditor abandoning a
   *   dictation should not leave a recording of someone's home on the device; the
   *   row is kept because "captured and deliberately discarded" is worth seeing.
   *
   * Takes the persisted (loose) outcome. The typed `ReviewOutcome<F>` erases to it
   * at the hook boundary — one document schema serves every host tool's field set.
   *
   * @throws if the item does not exist, or is not `awaiting-review`. A duplicate
   * submission — two clicks, or two tabs — therefore fails loudly on the second
   * rather than silently rewriting a row that has moved on.
   */
  async submitReview(id: string, outcome: PersistedReviewOutcome): Promise<OutboxItem> {
    const parsed = reviewOutcomeSchema.parse(outcome);
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item with id "${id}"`);

    const patch: OutboxPatch =
      parsed.status === "discarded"
        ? { reviewOutcome: parsed, status: "discarded" }
        : { reviewOutcome: parsed, status: "writing", attempts: 0 };

    const updated = await doc.incrementalModify((current) => {
      if (current.status !== "awaiting-review") {
        throw new Error(
          `outbox: item ${id} is "${current.status}", not "awaiting-review", so a review cannot be submitted for it. Another tab or an earlier submission has already moved it on.`,
        );
      }
      const merged = { ...current, ...patch };
      // Validated inside the modifier, against the revision actually being written.
      outboxDocumentSchema.parse(merged);
      return merged;
    });

    // After the status is committed, so a crash between the two leaves a
    // `discarded` row that still has its audio — recoverable — rather than an
    // `awaiting-review` row whose audio has silently vanished.
    if (parsed.status === "discarded") await this.dropAudio(id);

    return this.#toItem(updated);
  }
```

Import `reviewOutcomeSchema` and `type PersistedReviewOutcome` from `../review.js`, and
`outboxDocumentSchema` / `type OutboxPatch` from `./schema.js` if not already imported.

Two notes. First, **verify `incrementalModify` is the right RxDB API for this version** — check
`node_modules/rxdb` for the current name and conflict semantics before relying on the retry behaviour;
if the modifier is not re-run against the current revision on conflict, this guard is not atomic and
the plan's premise needs revisiting rather than papering over.

Second, note the **drop-audio ordering is the reverse** of what an earlier draft of this plan
specified. Dropping first would mean a crash between the two steps leaves an `awaiting-review` row
whose audio is gone — the item looks reviewable, the recording is unrecoverable, and nothing indicates
why. Committing the status first makes the worst case a `discarded` row that still holds audio, which
is merely untidy.

- [ ] **Step 3b: Add the concurrency test**

```ts
test("a second submission for the same item fails rather than rewriting it", async () => {
  // Two tabs, or two clicks. The second must not patch a row that has moved on —
  // most importantly it must not take a `done` item back to `writing`, which would
  // cause a second write to the host tool.
  const outbox = await openTestOutbox();
  const item = await enqueueTestRecording(outbox);
  await outbox.patch(item.id, { status: "awaiting-review" });

  await outbox.submitReview(item.id, { status: "accepted", fields: { atticRValue: 19 } });
  await expect(
    outbox.submitReview(item.id, { status: "discarded", reason: "changed my mind" }),
  ).rejects.toThrow(/awaiting-review/);

  const settled = await outbox.get(item.id);
  expect(settled?.status).toBe("writing");
  expect(settled?.hasAudio).toBe(true);
});

test("a review cannot be submitted for an item that was never parked", async () => {
  const outbox = await openTestOutbox();
  const item = await enqueueTestRecording(outbox);
  await expect(outbox.submitReview(item.id, { status: "accepted", fields: {} })).rejects.toThrow(
    /queued/,
  );
});
```

- [ ] **Step 4: Run and confirm pass**

```bash
pnpm vitest run packages/ribo-core/src/queue/outbox.browser.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the three relay tests Task 3 deferred, and run the whole queue suite**

`submitReview` now exists, so write the three tests Task 3 could not: "the write step receives the
human's reviewed values, not the model's", "an item that reaches writing with no review outcome fails
terminally" (if Task 3 did not already cover it via `patch`), and "writes follow review order, not
capture order". Their code is in Task 3's step 1 and its ordering section — copy it from there.

```bash
pnpm vitest run packages/ribo-core && pnpm --filter @azx/ribo-core typecheck
```

Expected: PASS, all four of Task 3's tests included.

- [ ] **Step 6: Format, lint, commit**

```bash
pnpm format && pnpm lint
git add packages/ribo-core/src
git commit -m "Add Outbox.submitReview as the only way out of awaiting-review

Accepted and edited outcomes move the item to writing with attempts reset;
a discard is terminal and drops the audio. Re-enables the relay tests that
assert the reviewed values reach the write step."
```

---

## Task 5: Delete `ReviewPresenter` and correct `review.ts`

**Files:**

- Modify: `packages/ribo-core/src/review.ts` (delete the interface, rewrite the header)
- Modify: `packages/ribo-core/src/index.ts` (drop the export)
- Modify: `packages/ribo-core/src/review.test.ts` (drop presenter tests)
- Check: `packages/ribo-core/src/contracts.test.ts` (composes the whole vocabulary — will need edits)

**Interfaces:**

- Produces: a `@azx/ribo-core` public surface with no `ReviewPresenter`.

**Why:** it has no implementations and no callers, and its `present(request) => Promise<ReviewSubmission>`
shape is the design that was rejected — a relay blocked on a human stalls every recording behind it
(design §2.3, §2.4). An exported interface that misdescribes the architecture invites someone to build
against it.

- [ ] **Step 1: Find every reference**

```bash
grep -rn "ReviewPresenter" packages playground docs --include="*.ts" --include="*.tsx" --include="*.md" | grep -v node_modules
```

Note each one. Source and test references get deleted in this task. Markdown references in
`docs/implementation/` are R5's, **except** any statement this task makes false — see Step 5.

- [ ] **Step 2: Delete the interface**

Remove the `ReviewPresenter` interface from `review.ts`, including its doc comment about function
properties and bivariance. If `review.test.ts` has a `@ts-expect-error` test pinning that variance,
delete that test too — it pins a type that no longer exists.

- [ ] **Step 3: Rewrite the `review.ts` file header**

Two claims in it are now false: that the contract is a presenter the caller invokes, and that
"`ribo-ui-react` implements `ReviewPresenter` in Phase 5". Replace the "Presentation-agnostic" section
and the three-part contract framing with:

```
 * ## Review is a queue state, not a callback
 *
 * The gate is a status, not a presenter. `queue/relay.ts` parks an extracted item
 * at `awaiting-review` — a status deliberately absent from
 * `ACTIVE_OUTBOX_STATUSES` — and stops seeing it; the relay drains the next
 * capture instead of blocking. A UI finds parked items with an ordinary query
 * (`outbox.watch({ status: "awaiting-review" })`), and `Outbox.submitReview`
 * records the outcome and moves the item to `writing`.
 *
 * An earlier design had the relay `await` a `ReviewPresenter.present(request)`
 * promise the UI resolved. It was removed rather than kept unused: the relay
 * processes strictly ascending `seq`, so a step blocked on a human stalls every
 * recording behind it, and a reload mid-await drops the promise with nothing left
 * to resolve. Persisting the decision is what makes review survive the tab dying,
 * which on iOS it does often.
 *
 * So what remains here is the *vocabulary*, not an invocation protocol:
 * {@link buildReviewRequest} prepares a draft, {@link resolveReview} classifies
 * what the human did, and {@link reviewOutcomeSchema} is how the answer is stored.
 * Nothing here knows about React, the DOM, or rendering.
```

Keep the "Why this is not `present(draft: T): Promise<T | null>`" section — it explains why decisions
are per-field, which is still true and still load-bearing. Adjust its numbered list so it describes
`ReviewRequest` → `ReviewSubmission` → `ReviewOutcome` without referring to "the presenter".

- [ ] **Step 4: Drop the export and fix `contracts.test.ts`**

Remove `ReviewPresenter` from the `export type { … } from "./review.js";` block in
`packages/ribo-core/src/index.ts`.

`contracts.test.ts` "composes the whole vocabulary through this entry point, so it doubles as
executable documentation of the pipeline". If it builds a presenter, replace that with the real flow:
`buildReviewRequest` → construct `FieldDecisions` → `resolveReview` → assert the `ReviewOutcome`. This
test is documentation; make it show the shape the system actually has.

- [ ] **Step 5: Correct the one AGENTS.md statement this falsifies**

AGENTS.md §1 lists "the review contract (`buildReviewRequest`, `resolveReview`, `ReviewPresenter`)".
Drop `ReviewPresenter` from that list. Leave everything else in AGENTS.md for Task 18.

- [ ] **Step 6: Verify and commit**

```bash
pnpm vitest run packages/ribo-core && pnpm --filter @azx/ribo-core typecheck && pnpm lint
grep -rn "ReviewPresenter" packages playground --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: tests pass, and the grep returns nothing.

```bash
pnpm format
git add packages/ribo-core/src AGENTS.md
git commit -m "Remove ReviewPresenter and describe review as a queue state

The interface had no implementations and no callers, and its promise shape
described the rejected design: a relay awaiting a human stalls the serial queue
and loses the promise on reload. The vocabulary it sat beside -- buildReviewRequest,
resolveReview, reviewOutcomeSchema -- is what review actually runs on."
```

---

## Task 6: `Recorder` pause and resume

**Files:**

- Modify: `packages/ribo-core/src/recorder.ts`
- Test: `packages/ribo-core/src/recorder.browser.test.ts`

**Interfaces:**

- Produces: `RecorderPhase` including `"paused"`; `Recorder.pause(): void`; `Recorder.resume(): void`.
  Task 12's `useRecorder` surfaces both.

**The invariant this must not break:** `elapsedMs` is `performance.now() - session.startedAt`, which
keeps counting through a pause — so a 30-second dictation paused for two minutes would report 2:30,
and `stop()` writes that number to `Recording.durationMs`. Design §2.6.

- [ ] **Step 1: Write the failing tests**

Add to `packages/ribo-core/src/recorder.browser.test.ts`:

```ts
test("pausing and resuming keeps the phase honest", async () => {
  const recorder = new Recorder();
  const phases: RecorderPhase[] = [];
  const stop = recorder.subscribe((state) => phases.push(state.phase));

  await recorder.start();
  recorder.pause();
  expect(recorder.phase).toBe("paused");
  recorder.resume();
  expect(recorder.phase).toBe("recording");
  await recorder.stop();

  stop();
  expect(phases).toContain("paused");
  expect(recorder.phase).toBe("idle");
});

test("elapsed time excludes the paused span", async () => {
  const recorder = new Recorder();
  await recorder.start();
  await delay(150);
  recorder.pause();
  const atPause = recorder.elapsedMs;

  await delay(300);
  // The whole point: a paused recorder is not accruing duration.
  expect(recorder.elapsedMs).toBe(atPause);

  recorder.resume();
  await delay(150);
  const { recording } = await recorder.stop();

  // ~300ms of real recording across a 300ms pause. Generous bounds: this asserts
  // the pause is excluded, not the precision of a timer under a headless browser.
  expect(recording.durationMs).toBeGreaterThanOrEqual(250);
  expect(recording.durationMs).toBeLessThan(560);
});

test("level reads zero while paused", async () => {
  const recorder = new Recorder();
  await recorder.start();
  await delay(150);
  recorder.pause();
  expect(recorder.level).toBe(0);
  await recorder.stop();
});

test("stop works from paused, and releases the microphone", async () => {
  const recorder = new Recorder();
  await recorder.start();
  recorder.pause();
  const { recording, audio } = await recorder.stop();
  expect(recording.durationMs).toBeGreaterThanOrEqual(0);
  expect(audio.size).toBeGreaterThan(0);
  expect(recorder.phase).toBe("idle");
});

test("pause and resume refuse the phases they cannot serve", async () => {
  const recorder = new Recorder();
  expect(() => recorder.pause()).toThrow(
    expect.objectContaining({ name: "RecorderError", code: "not-recording" }),
  );
  expect(() => recorder.resume()).toThrow(
    expect.objectContaining({ name: "RecorderError", code: "not-recording" }),
  );

  await recorder.start();
  expect(() => recorder.resume()).toThrow(
    expect.objectContaining({ name: "RecorderError", code: "already-recording" }),
  );
  recorder.pause();
  expect(() => recorder.pause()).toThrow(
    expect.objectContaining({ name: "RecorderError", code: "not-recording" }),
  );
  await recorder.stop();
});

test("a paused recorder cannot be started again", async () => {
  const recorder = new Recorder();
  await recorder.start();
  recorder.pause();
  await expect(recorder.start()).rejects.toThrow(
    expect.objectContaining({ code: "already-recording" }),
  );
  await recorder.stop();
});
```

If the file has no `delay` helper, add `const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));`
at the top. Import `type RecorderPhase` alongside the existing imports.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-core/src/recorder.browser.test.ts
```

Expected: FAIL — `recorder.pause` is not a function.

- [ ] **Step 3: Add the phase**

```ts
/**
 * Idle → recording ⇄ paused → stopping → idle.
 *
 * `paused` keeps the microphone **open**: `MediaRecorder.resume()` requires the
 * same stream, so pause cannot stop the tracks, and the browser's recording
 * indicator stays lit. That is consumer-visible and documented rather than
 * discovered — see the note on {@link Recorder.pause}.
 */
export type RecorderPhase = "idle" | "recording" | "paused" | "stopping";
```

- [ ] **Step 4: Replace `startedAt` with accumulating fields**

Remove `startedAt` from the `Session` interface. Add two class fields beside `#level`:

```ts
  /** Recorded duration banked by previous run-segments, excluding pauses. */
  #accumulatedMs = 0;
  /** `performance.now()` when the current run-segment began (start, or resume). */
  #resumedAt = 0;
```

Rewrite the getter:

```ts
  /**
   * Milliseconds of **recorded** audio; zero when idle.
   *
   * Sums banked segments with the live one, so a paused span is not counted. A
   * naive `now - startedAt` would keep running through a pause and hand a wrong
   * `durationMs` to every `Recording` that was ever paused.
   */
  get elapsedMs(): number {
    if (this.#session === undefined) return 0;
    if (this.#phase === "paused") return Math.round(this.#accumulatedMs);
    return Math.round(this.#accumulatedMs + (performance.now() - this.#resumedAt));
  }
```

In `#beginSession`, drop `startedAt` from the returned session and set the two fields instead — set
`#accumulatedMs = 0` and `#resumedAt = performance.now()` in `start()` immediately before
`this.#phase = "recording"`. In `#teardown`, reset both to `0` alongside `#level`.

- [ ] **Step 5: Add `pause` and `resume`**

```ts
  /**
   * Suspends recording without ending it.
   *
   * **The microphone stays open.** `MediaRecorder.resume()` must be handed the
   * same stream, so the tracks cannot be stopped here — which means the browser's
   * recording indicator stays lit while paused. In a field tool that is worth
   * saying out loud: a user who pauses may reasonably believe the mic is off. Call
   * {@link stop} to actually release it.
   *
   * `level` reads zero while paused, and `elapsedMs` stops advancing.
   *
   * @throws {RecorderError} `not-recording` if nothing is capturing.
   */
  pause(): void {
    const session = this.#session;
    if (session === undefined || this.#phase !== "recording") {
      throw new RecorderError(
        "not-recording",
        "This Recorder is not capturing, so there is nothing to pause. Call start() first.",
      );
    }
    session.recorder.pause();
    this.#accumulatedMs += performance.now() - this.#resumedAt;
    // A paused analyser still reads the live stream, so a meter driven by it would
    // bounce while nothing is being recorded — which reads as broken.
    this.#level = 0;
    this.#phase = "paused";
    this.#emit();
  }

  /**
   * Resumes a paused capture on the same stream and the same `Recording`.
   *
   * @throws {RecorderError} `already-recording` if capture is already running,
   * `not-recording` if there is nothing paused.
   */
  resume(): void {
    if (this.#phase === "recording") {
      throw new RecorderError(
        "already-recording",
        "This Recorder is already capturing. resume() is only for a paused capture.",
      );
    }
    const session = this.#session;
    if (session === undefined || this.#phase !== "paused") {
      throw new RecorderError(
        "not-recording",
        "This Recorder has nothing paused to resume. Call start() first.",
      );
    }
    session.recorder.resume();
    this.#resumedAt = performance.now();
    this.#phase = "recording";
    this.#emit();
  }
```

- [ ] **Step 6: Make `#tick` and `stop` pause-aware**

In `#tick`, return early while paused so the level stays at zero:

```ts
  #tick(): void {
    if (this.#phase === "paused") return;
    const session = this.#session;
    …
  }
```

In `stop()`, widen the guard:

```ts
const session = this.#session;
if (session === undefined || (this.#phase !== "recording" && this.#phase !== "paused")) {
  throw new RecorderError(
    "not-recording",
    "This Recorder is not capturing. Call start() before stop().",
  );
}
```

`start()` needs no change: its `phase !== "idle"` guard already rejects starting while paused, which
the last test asserts.

- [ ] **Step 7: Document the mic-stays-open behaviour where `level` lives**

Add to `RecorderState.level`'s doc comment: `Zero whenever idle or paused.` And extend the `@file`
header's point 2 ("The stream is released on stop") to note that `pause()` deliberately does not
release it, and why.

- [ ] **Step 8: Run and commit**

```bash
pnpm vitest run packages/ribo-core && pnpm --filter @azx/ribo-core typecheck && pnpm lint
pnpm format
git add packages/ribo-core/src/recorder.ts packages/ribo-core/src/recorder.browser.test.ts
git commit -m "Add pause and resume to Recorder

Duration now accumulates across run-segments rather than being now - startedAt,
so a paused span is excluded from Recording.durationMs. Level reads zero while
paused, and stop() works from paused. Pause keeps the microphone open because
MediaRecorder.resume() requires the same stream -- documented, since the
recording indicator stays lit."
```

---

## Task 7: Phase A gate

**Files:** none — this is the checkpoint.

**`./check.sh` cannot be green at this point, and pretending otherwise is the problem.** Phase A
changes the pipeline's observable behaviour, and the e2e suite asserts the old behaviour — correctly,
which is why it fails. Two specs poll for an item reaching `done`
(`extraction-ui.e2e.test.ts:98` and `network-transition.e2e.test.ts`), and the gate makes `done`
unreachable without a human. So this checkpoint is **not** "green"; it is "green except a named,
understood set", and the named set has to be exactly right.

- [ ] **Step 1: Run everything except e2e, and require it green**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build:packages && pnpm check:resolve \
  && pnpm build:app && pnpm check:pkg && pnpm vitest run --project unit --project browser
```

Expected: PASS on every one. Paste the vitest summary line, which must show both `unit` and
`browser (chromium)` ran. Anything red here is a Phase A defect — fix it now.

If `build:app` or the playground typecheck fails on `WriteStepInput`, fix the two stubs:
`playground/src/QueuePanel.tsx:219` and `playground/src/TranscribePanel.tsx:257`. Both are
parameter-less (`write: () => Promise.resolve({ … })`), so they should need no change — but confirm
rather than assume.

- [ ] **Step 2: Run e2e and record exactly which specs fail and why**

```bash
pnpm vitest run --project e2e
```

Expected: failures **only** in specs that assert an item reaches `done`. Write the list into the task
report with a one-line reason each. Then check the list against expectations: `extraction-ui` and
`network-transition` are the two known ones. **A failure anywhere else means Phase A broke something
this plan did not predict — stop and investigate rather than deferring it to Task 18.**

Do not fix any of them here, and specifically do not weaken an assertion to make it pass. Task 18
teaches them the new flow, which is one step longer because a human is now in it.

- [ ] **Step 3: Add a changeset**

`.changeset/kind-squids-throw.md` is an empty stub (`---` / `---`). Replace it with a real one for the
core change:

```markdown
---
"@azx/ribo-core": minor
---

Review is now a gate in the outbox state machine. Extracted items park at a new
`awaiting-review` status until `Outbox.submitReview` records what a human decided;
the relay drains past parked items rather than blocking on a person. Adds a
`discarded` terminal status, persists the review outcome, and passes reviewed
values to the write step instead of the model's raw extraction. `Recorder` gains
`pause()` and `resume()`. `ReviewPresenter` is removed.
```

```bash
git add .changeset
git commit -m "Add a changeset for the core review gate"
```

---

# Phase B — the hook layer

## Task 8: Test infrastructure for React in the browser tier

**Files:**

- Modify: `pnpm-workspace.yaml` (catalog entry)
- Modify: `packages/ribo-ui-react/package.json` (devDependency)
- Create: `packages/ribo-ui-react/src/workspace-resolution.browser.test.tsx`

**Interfaces:**

- Produces: a proven `render` path for hooks. Every later Phase B task depends on this working.

**Why it is its own task:** nothing in this repo renders React in a test. There are zero `.tsx` test
files and no rendering library installed. Proving the tier works — including the cross-package import
that nothing in this repo has done — before writing six hooks against it is
the difference between one debugging session and six.

- [ ] **Step 1: Add `vitest-browser-react` to the catalog**

In `pnpm-workspace.yaml`, beside the `@vitest/browser` entries, add an exact-pinned entry with a
comment in the style of its neighbours:

```yaml
# The Vitest-4-native React renderer for browser mode: `render` returns
# locators and cleanup is automatic, so hook tests need no per-file teardown.
# @testing-library/react also works in browser mode but wants explicit cleanup
# wiring and an act() model that fits Vitest 4 browser tests less well.
# R2 is the first task in this repo to render React in a test.
vitest-browser-react: "<resolve at install time>"
```

Resolve the actual latest version and pin what you get — **do not invent a version number**
(AGENTS.md §5.4). Then add `"vitest-browser-react": "catalog:"` to
`packages/ribo-ui-react/package.json` `devDependencies`, and `"@vitest/browser": "catalog:"` if that
package does not already have it.

```bash
pnpm install
```

- [ ] **Step 2: Write the infrastructure test**

Create `packages/ribo-ui-react/src/workspace-resolution.browser.test.tsx`:

```tsx
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
// Imported by *package name*, not a relative path — that is the point. This is the
// browser project's counterpart to
// packages/ribo-adapter-snuggpro/src/workspace-resolution.test.ts, which guards the
// same property for the node tier. The two projects need OPPOSITE spellings
// (`resolve.conditions` here, `ssr.resolve.conditions` there) and neither guard
// covers the other. If this file fails to resolve, the browser project has lost its
// block — do not "fix" it by switching to a relative import.
import { Recorder } from "@azx/ribo-core";

test("resolves @azx/ribo-core by package name from a ui-react browser test", () => {
  expect(new Recorder().phase).toBe("idle");
});

test("renders a React component in a real browser", () => {
  const screen = render(<p>ribo</p>);
  expect(screen.getByText("ribo")).toBeInTheDocument();
});

test("runs in a real browser with the capture APIs the recorder hook depends on", () => {
  expect(typeof MediaRecorder).toBe("function");
  expect(typeof indexedDB).toBe("object");
});
```

- [ ] **Step 3: Run it**

```bash
pnpm vitest run packages/ribo-ui-react
```

Expected: PASS, and the output must show the `browser (chromium)` project ran it.

If `toBeInTheDocument` is unavailable, the matcher package is not wired — use
`expect(screen.getByText("ribo").element()).toBeTruthy()` instead rather than adding
`@testing-library/jest-dom` to the tree for one assertion.

- [ ] **Step 4: Confirm the tier assignment is real**

```bash
pnpm vitest run packages/ribo-ui-react --project unit
```

Expected: **no tests found** — the `unit` project excludes `*.browser.test.{ts,tsx}`. This confirms
the file landed in the intended tier rather than passing by accident in the wrong one.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add pnpm-workspace.yaml pnpm-lock.yaml packages/ribo-ui-react
git commit -m "Add the React browser-test tier for ribo-ui-react

Pins vitest-browser-react in the catalog and proves the two things every hook
test needs: React renders in real Chromium, and @azx/ribo-core resolves by
package name -- which per AGENTS.md 5.1 only works in the browser project."
```

---

## Task 9: The context, the provider, and the instance resolver

**Files:**

- Create: `packages/ribo-ui-react/src/context.ts`
- Create: `packages/ribo-ui-react/src/RiboProvider.tsx`
- Create: `packages/ribo-ui-react/src/use-ribo-instance.ts`
- Create: `packages/ribo-ui-react/src/context.browser.test.tsx`
- Modify: `packages/ribo-ui-react/src/index.ts`
- Delete: `packages/ribo-ui-react/src/index.test.ts` (it asserts the `PACKAGE_NAME` stub)

**Interfaces:**

- Produces:

  ```ts
  export interface RiboInstances {
    readonly recorder?: AnyRecorder;
    readonly outbox?: Outbox;
    readonly connectivity?: Connectivity;
  }
  /** A `Recorder` whose host context type the provider cannot know. */
  export type AnyRecorder = Recorder<Record<string, unknown>>;
  export function RiboProvider(props: { value: RiboInstances; children: ReactNode }): ReactElement;
  export function useRiboInstance<K extends keyof RiboInstances>(
    key: K,
    override?: RiboInstances[K],
  ): NonNullable<RiboInstances[K]>;
  ```

  Every hook in Tasks 11–15 resolves its dependency through `useRiboInstance`.

- [ ] **Step 1: Write the failing test**

Create `packages/ribo-ui-react/src/context.browser.test.tsx`:

```tsx
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { Recorder } from "@azx/ribo-core";

import { RiboProvider } from "./RiboProvider.js";
import { useRiboInstance } from "./use-ribo-instance.js";

function ShowsPhase() {
  const recorder = useRiboInstance("recorder");
  return <p>{recorder.phase}</p>;
}

test("a hook resolves its instance from the provider", () => {
  const recorder = new Recorder();
  const screen = render(
    <RiboProvider value={{ recorder }}>
      <ShowsPhase />
    </RiboProvider>,
  );
  expect(screen.getByText("idle")).toBeInTheDocument();
});

test("an override wins over the provider, which is how tests inject", () => {
  const provided = new Recorder();
  const override = new Recorder();
  let seen: unknown;
  function Probe() {
    seen = useRiboInstance("recorder", override);
    return null;
  }
  render(
    <RiboProvider value={{ recorder: provided }}>
      <Probe />
    </RiboProvider>,
  );
  expect(seen).toBe(override);
});

test("a missing instance throws a message naming what to supply", () => {
  // The failure mode this replaces is an `undefined` read three frames later, in
  // a component that did not cause it.
  expect(() => render(<ShowsPhase />)).toThrow(/recorder/i);
  expect(() => render(<ShowsPhase />)).toThrow(/RiboProvider/);
});

test("an instance absent from a provider that has others still throws", () => {
  function NeedsOutbox() {
    useRiboInstance("outbox");
    return null;
  }
  expect(() =>
    render(
      <RiboProvider value={{ recorder: new Recorder() }}>
        <NeedsOutbox />
      </RiboProvider>,
    ),
  ).toThrow(/outbox/i);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-ui-react
```

Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write `context.ts`**

```ts
import type { Connectivity, Outbox, Recorder } from "@azx/ribo-core";
import { createContext } from "react";

/**
 * @file The one context this package defines.
 *
 * **The provider carries instances; it never constructs them.** Lifetime lives
 * above React, with the host, and this is not a style preference — it is the
 * playground's scar tissue. StrictMode's double mount opens a second RxDB
 * database over the same IndexedDB name and a second `Recorder` holding a second
 * microphone stream; Vite HMR replaces a module without reloading the page. The
 * fix is a module singleton with `import.meta.hot.data` carry-over
 * (`playground/src/outbox-handle.ts`), which is a **host** discipline. A provider
 * that called `openOutbox()` itself would pull an async open into the render tree
 * and ship that hazard inside the SDK, where a consumer cannot fix it.
 */

/**
 * A `Recorder` whose host context type (`C`) the provider cannot know.
 *
 * `Recorder<C>` uses `C` only in output position (`stop(): Promise<Capture<C>>`),
 * so a narrower recorder is assignable here covariantly. The cost is that
 * `stop()` resolved through context loses the host's `ctx` type; a host that needs
 * it passes its recorder to the hook explicitly. See the plan's open questions.
 */
export type AnyRecorder = Recorder<Record<string, unknown>>;

/**
 * The engine instances a host makes available to the hooks.
 *
 * Every field optional: a host using only capture must not be forced to open a
 * database. Each hook resolves the one it needs and throws if it is absent.
 */
export interface RiboInstances {
  readonly recorder?: AnyRecorder;
  readonly outbox?: Outbox;
  readonly connectivity?: Connectivity;
}

/** Empty rather than `undefined`, so "no provider" and "empty provider" fail identically. */
export const RiboContext = createContext<RiboInstances>({});
```

- [ ] **Step 4: Write `RiboProvider.tsx`**

````tsx
import type { ReactElement, ReactNode } from "react";

import { RiboContext, type RiboInstances } from "./context.js";

/**
 * Makes host-constructed engine instances available to the hooks.
 *
 * ```tsx
 * // the host owns lifetime, above React
 * const recorder = getRecorder();
 * const outbox = await getOutbox();
 *
 * <RiboProvider value={{ recorder, outbox }}>
 *   <App />
 * </RiboProvider>
 * ```
 *
 * `value` is passed through unchanged and is **not** memoized here — the host owns
 * the object's identity, and a provider that memoized it would silently keep a
 * stale instance after a host swapped one out. Hold it in a stable place (a module
 * singleton, or `useMemo` in the host) rather than building it inline in render.
 */
export function RiboProvider({
  value,
  children,
}: {
  readonly value: RiboInstances;
  readonly children: ReactNode;
}): ReactElement {
  return <RiboContext.Provider value={value}>{children}</RiboContext.Provider>;
}
````

- [ ] **Step 5: Write `use-ribo-instance.ts`**

```ts
import { useContext } from "react";

import { RiboContext, type RiboInstances } from "./context.js";

/** What a host has to do to supply each instance, quoted back to them in the error. */
const HOW_TO_SUPPLY: Record<keyof RiboInstances, string> = {
  recorder: "new Recorder() from @azx/ribo-core",
  outbox: "await openOutbox() from @azx/ribo-core",
  connectivity: "createConnectivity({ … }) from @azx/ribo-core",
};

/**
 * Resolves one engine instance: an explicit `override` if given, else the
 * provider's.
 *
 * Throws rather than returning `undefined`, and the message names the missing key
 * and how to make one. The alternative is a `TypeError` on a property of
 * `undefined`, several frames deep, in a component that did not cause the
 * problem — a host integrating this package for the first time should be told
 * what to add, not handed a stack trace.
 *
 * `override` is how tests inject an instance without a provider, and how a host
 * with two recorders points a subtree at the second one.
 */
export function useRiboInstance<K extends keyof RiboInstances>(
  key: K,
  override?: RiboInstances[K],
): NonNullable<RiboInstances[K]> {
  const instances = useContext(RiboContext);
  const resolved = override ?? instances[key];
  if (resolved === undefined) {
    throw new Error(
      `ribo: no "${key}" available. Construct one (${HOW_TO_SUPPLY[key]}) and pass it to <RiboProvider value={{ ${key} }}>, or hand it to this hook directly. The host owns instance lifetime — see @azx/ribo-ui-react's RiboProvider docs.`,
    );
  }
  return resolved as NonNullable<RiboInstances[K]>;
}
```

- [ ] **Step 6: Replace the package barrel**

Overwrite `packages/ribo-ui-react/src/index.ts`:

```ts
/**
 * @file The public surface of `@azx/ribo-ui-react`.
 *
 * Re-exports only, like `@azx/ribo-core`'s barrel. This package is a **headless
 * hook layer**: no components beyond `RiboProvider`, no markup, no stylesheet.
 * Rendering is the host's; these hooks only wire core's engine to React state.
 */

export { RiboProvider } from "./RiboProvider.js";
export type { AnyRecorder, RiboInstances } from "./context.js";
```

Delete `packages/ribo-ui-react/src/index.test.ts` — it asserts the `PACKAGE_NAME` stub, which is gone.
`useRiboInstance` is **not** exported: it is internal wiring, and exporting it would invite hosts to
resolve instances instead of using the hooks.

- [ ] **Step 6b: Unbreak the playground in the same commit**

`PACKAGE_NAME` is not unused — `playground/src/App.tsx:2` imports it and `:32` puts it in
`COMPOSED_NAMES = [UI, ADAPTER]`, which the footer renders. Deleting the export without this step
breaks `pnpm typecheck` and `pnpm build:app`, so this task's own verification would fail and the whole
of Phase B would proceed on a red gate.

Minimal fix now (the real migration is Task 17): drop the `PACKAGE_NAME as UI` import and name the
package directly, since the footer's job is to prove all three packages are composed into the build —
which the provider import now does for real:

```tsx
import { RiboProvider } from "@azx/ribo-ui-react";
// …
const COMPOSED_NAMES = ["@azx/ribo-ui-react", ADAPTER];
```

Also correct the `@file` header two lines above: it says `ribo-ui-react` "is still Phase 0 scaffolding
and exports only its `PACKAGE_NAME`". As of this task it is the hook layer.

Note this is why the import is a _value_ import rather than type-only: the footer proved composition
by importing a runtime constant, and `RiboProvider` preserves that property. A type-only import would
be erased and the composition check would quietly stop checking anything.

- [ ] **Step 7: Run, verify, commit**

```bash
pnpm vitest run packages/ribo-ui-react && pnpm --filter @azx/ribo-ui-react typecheck && pnpm lint
pnpm format
git add packages/ribo-ui-react
git commit -m "Add RiboProvider and the instance resolver

The provider carries host-constructed instances and never builds them: an async
openOutbox() inside the render tree is what playground/src/outbox-handle.ts
exists to avoid, and shipping that hazard in an SDK puts it where a consumer
cannot fix it. A missing instance throws a message naming what to supply."
```

---

## Task 10: The subscription helper

**Files:**

- Create: `packages/ribo-ui-react/src/use-subscribed.ts`
- Create: `packages/ribo-ui-react/src/use-subscribed.browser.test.tsx`

**Interfaces:**

- Produces:
  ```ts
  export function useSubscribed<T>(
    subscribe: (listener: (value: T) => void) => Unsubscribe,
    initial: () => T,
  ): T;
  ```
  Tasks 11, 12 and 13 all build on it.

**Why not `useSyncExternalStore`:** `useSyncExternalStore(recorder.subscribe, () => recorder.state)`
re-renders forever. `recorder.state` builds a fresh object per call and `elapsedMs` recomputes from
`performance.now()`, so the snapshot is never referentially stable. Design §2.7.

- [ ] **Step 1: Write the failing test**

Create `packages/ribo-ui-react/src/use-subscribed.browser.test.tsx`:

```tsx
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useCallback } from "react";

import { useSubscribed } from "./use-subscribed.js";

/** A minimal push source with the same contract as `Recorder.subscribe`. */
function makeSource(initial: number) {
  const listeners = new Set<(value: number) => void>();
  let current = initial;
  return {
    get current() {
      return current;
    },
    push(value: number) {
      current = value;
      for (const listener of listeners) listener(value);
    },
    subscribe(listener: (value: number) => void) {
      listeners.add(listener);
      listener(current); // immediately, like core's sources
      return () => listeners.delete(listener);
    },
    get size() {
      return listeners.size;
    },
  };
}

test("renders the pushed value and updates on push", async () => {
  const source = makeSource(1);
  function Probe() {
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    return <p>value {useSubscribed(subscribe, () => source.current)}</p>;
  }

  const screen = render(<Probe />);
  await expect.element(screen.getByText("value 1")).toBeInTheDocument();

  source.push(2);
  await expect.element(screen.getByText("value 2")).toBeInTheDocument();
});

test("an unstable getSnapshot does not loop — the whole reason this exists", () => {
  // The bug this helper avoids: a source whose snapshot is a fresh object every
  // call would spin useSyncExternalStore forever. Here the render count is bounded
  // because the value comes from state, not from a re-read.
  const source = makeSource(0);
  const renders = vi.fn();
  function Probe() {
    renders();
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    // A deliberately unstable initial: a new object identity on every call.
    const value = useSubscribed(subscribe, () => source.current);
    return <p>{JSON.stringify({ value })}</p>;
  }

  render(<Probe />);
  expect(renders.mock.calls.length).toBeLessThan(10);
});

test("unsubscribes on unmount", () => {
  const source = makeSource(0);
  function Probe() {
    const subscribe = useCallback(
      (listener: (value: number) => void) => source.subscribe(listener),
      [],
    );
    useSubscribed(subscribe, () => source.current);
    return null;
  }
  const screen = render(<Probe />);
  expect(source.size).toBeGreaterThan(0);
  screen.unmount();
  expect(source.size).toBe(0);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-ui-react/src/use-subscribed.browser.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

````ts
import type { Unsubscribe } from "@azx/ribo-core";
import { useEffect, useState } from "react";

/**
 * Holds the latest value pushed by one of core's subscription sources.
 *
 * ## Why this is not `useSyncExternalStore`
 *
 * The obvious wiring is broken:
 *
 * ```ts
 * useSyncExternalStore(recorder.subscribe, () => recorder.state); // infinite loop
 * ```
 *
 * `useSyncExternalStore` requires `getSnapshot` to be referentially stable across
 * calls that represent the same state. `Recorder.state` builds a fresh object
 * every call, and `elapsedMs` recomputes from `performance.now()`, so it never
 * stabilizes and React re-renders forever. The playground hit exactly this and
 * solved it by caching a snapshot in module scope — which a hook over a
 * host-owned instance cannot do.
 *
 * So the pushed value is held in state instead. Core's sources call their listener
 * **immediately** on subscribe (`Recorder.subscribe`, `Connectivity.subscribe`),
 * so the first paint is never blank and nothing polls.
 *
 * **The accepted tradeoff:** this gives up `useSyncExternalStore`'s tearing
 * protection under concurrent rendering. For a level meter pushed every 100 ms and
 * a connectivity badge, a torn frame is not observable. If a value ever needs the
 * guarantee, add a snapshot cache **here** rather than a second pattern in each
 * hook.
 *
 * `subscribe` must be referentially stable — wrap it in `useCallback` keyed on the
 * instance. An inline arrow re-subscribes on every render.
 */
export function useSubscribed<T>(
  subscribe: (listener: (value: T) => void) => Unsubscribe,
  initial: () => T,
): T {
  const [value, setValue] = useState<T>(initial);
  // `subscribe` returns its own unsubscribe handle, so it *is* the cleanup.
  useEffect(() => subscribe(setValue), [subscribe]);
  return value;
}
````

- [ ] **Step 4: Run, verify, commit**

```bash
pnpm vitest run packages/ribo-ui-react && pnpm --filter @azx/ribo-ui-react typecheck && pnpm lint
pnpm format
git add packages/ribo-ui-react/src/use-subscribed.ts packages/ribo-ui-react/src/use-subscribed.browser.test.tsx
git commit -m "Add the useSubscribed helper for core's push sources

Deliberately not useSyncExternalStore: Recorder.state builds a fresh object per
call and elapsedMs recomputes from performance.now(), so getSnapshot never
stabilizes and React loops. One helper, one documented tearing tradeoff, rather
than a snapshot cache in every hook."
```

---

## Task 11: `useConnectivity` and `useStoragePersistence`

**Files:**

- Create: `packages/ribo-ui-react/src/use-connectivity.ts`
- Create: `packages/ribo-ui-react/src/use-storage-persistence.ts`
- Create: `packages/ribo-ui-react/src/use-connectivity.browser.test.tsx`
- Create: `packages/ribo-ui-react/src/use-storage-persistence.browser.test.tsx`
- Modify: `packages/ribo-ui-react/src/index.ts`

**Interfaces:**

- Consumes: `useRiboInstance` (Task 9), `useSubscribed` (Task 10).
- Produces:
  ```ts
  export function useConnectivity(connectivity?: Connectivity): ConnectivityState;
  export interface UseStoragePersistenceResult {
    readonly persistence: StoragePersistence;
    readonly estimate: StorageEstimate | undefined;
    readonly request: () => Promise<StoragePersistence>;
    readonly refresh: () => void;
  }
  export function useStoragePersistence(): UseStoragePersistenceResult;
  ```
  Task 15's `useWorkSafety` consumes both.

They ship together because each is a few lines and neither is worth a task of its own.

- [ ] **Step 1: Write the failing tests**

`use-connectivity.browser.test.tsx`:

```tsx
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { createConnectivity } from "@azx/ribo-core";

import { useConnectivity } from "./use-connectivity.js";

/** A connectivity model over injected seams — no real network, no real events. */
function fakeConnectivity(online: boolean) {
  return createConnectivity({
    bindEvents: () => () => undefined,
    isOnline: () => online,
    probe: async () => online,
  });
}

test("renders the current connectivity state without a provider when given an instance", async () => {
  const connectivity = fakeConnectivity(false);
  function Probe() {
    return <p>status {useConnectivity(connectivity).status}</p>;
  }
  const screen = render(<Probe />);
  await expect.element(screen.getByText(/^status /)).toBeInTheDocument();
});

test("resolves connectivity from the provider", async () => {
  const connectivity = fakeConnectivity(false);
  function Probe() {
    return <p>status {useConnectivity().status}</p>;
  }
  const screen = render(
    <RiboProvider value={{ connectivity }}>
      <Probe />
    </RiboProvider>,
  );
  await expect.element(screen.getByText("status offline")).toBeInTheDocument();
});
```

Import `RiboProvider` from `./RiboProvider.js`. Check `ConnectivityOptions` in
`packages/ribo-core/src/connectivity.ts` for the exact seam names and fix `fakeConnectivity` to match
— the names above are the shape, not verified spellings. `connectivity.start()` may be required
before the state leaves its initial value; if so, call it in the test.

`use-storage-persistence.browser.test.tsx`:

```tsx
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { useStoragePersistence } from "./use-storage-persistence.js";

test("reports a persistence grant from the real Storage API", async () => {
  function Probe() {
    return <p>persistence {useStoragePersistence().persistence}</p>;
  }
  const screen = render(<Probe />);
  // Real Chromium: `persisted()` resolves, so the value must settle to one of the
  // four honest states and must not stay "unknown" forever.
  await expect
    .element(screen.getByText(/persistence (granted|denied|unsupported)/))
    .toBeInTheDocument();
});

test("exposes a storage estimate", async () => {
  let seen: StorageEstimate | undefined;
  function Probe() {
    seen = useStoragePersistence().estimate;
    return null;
  }
  render(<Probe />);
  await vi.waitFor(() => expect(seen?.quota).toBeGreaterThan(0));
});
```

Import `vi` from vitest.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-ui-react
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `use-connectivity.ts`**

```ts
import type { Connectivity, ConnectivityState } from "@azx/ribo-core";
import { useCallback } from "react";

import { useRiboInstance } from "./use-ribo-instance.js";
import { useSubscribed } from "./use-subscribed.js";

/**
 * The current {@link ConnectivityState} — the three-state `offline`/`probing`/`online`
 * model, not `navigator.onLine`.
 *
 * State only. `Connectivity.start()` and `stop()` bind and unbind an event source,
 * which is lifecycle and stays the host's — the same reason `RiboProvider` does not
 * construct instances. A host that has not called `start()` will see the model's
 * initial state and no transitions, which is the honest result rather than a hook
 * quietly starting something it does not own.
 */
export function useConnectivity(connectivity?: Connectivity): ConnectivityState {
  const instance = useRiboInstance("connectivity", connectivity);
  const subscribe = useCallback(
    (listener: (state: ConnectivityState) => void) => instance.subscribe(listener),
    [instance],
  );
  return useSubscribed(subscribe, () => instance.state);
}
```

- [ ] **Step 4: Implement `use-storage-persistence.ts`**

```ts
import type { StoragePersistence } from "@azx/ribo-core";
import { useCallback, useEffect, useState } from "react";

/**
 * The storage-persistence grant and quota estimate, as `workSafety` wants them.
 *
 * The one hook here with no core counterpart: it wraps `navigator.storage`
 * directly and returns core's {@link StoragePersistence} vocabulary. Scoped thin
 * on purpose — `playground/src/storage-store.ts` is 172 lines including eviction
 * detection, and that logic stays in the app. If it should be shared, the right
 * home is a headless core model beside `createConnectivity`, not logic buried in a
 * hook. See the plan's open questions.
 *
 * `unsupported` and `unknown` are different answers and both are needed:
 * `unsupported` means this browser has no Storage API to ask, `unknown` means we
 * have not finished asking. Collapsing them would let a UI claim a device is
 * unprotected while the question is still in flight.
 */
export interface UseStoragePersistenceResult {
  readonly persistence: StoragePersistence;
  readonly estimate: StorageEstimate | undefined;
  /** Asks the browser for a persistence grant. Resolves to the resulting state. */
  readonly request: () => Promise<StoragePersistence>;
  /** Re-reads the grant and the estimate. */
  readonly refresh: () => void;
}

const readPersistence = async (): Promise<StoragePersistence> => {
  if (typeof navigator === "undefined" || navigator.storage?.persisted === undefined) {
    return "unsupported";
  }
  return (await navigator.storage.persisted()) ? "granted" : "denied";
};

export function useStoragePersistence(): UseStoragePersistenceResult {
  const [persistence, setPersistence] = useState<StoragePersistence>("unknown");
  const [estimate, setEstimate] = useState<StorageEstimate | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const grant = await readPersistence();
      if (live) setPersistence(grant);
      const measured = await navigator.storage?.estimate?.();
      if (live) setEstimate(measured);
    })();
    return () => {
      live = false;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const request = useCallback(async (): Promise<StoragePersistence> => {
    if (navigator.storage?.persist === undefined) {
      setPersistence("unsupported");
      return "unsupported";
    }
    const granted = (await navigator.storage.persist()) ? "granted" : "denied";
    setPersistence(granted);
    return granted;
  }, []);

  return { persistence, estimate, request, refresh };
}
```

- [ ] **Step 5: Export both**

Add to `packages/ribo-ui-react/src/index.ts`:

```ts
export { useConnectivity } from "./use-connectivity.js";
export { useStoragePersistence } from "./use-storage-persistence.js";
export type { UseStoragePersistenceResult } from "./use-storage-persistence.js";
```

- [ ] **Step 6: Run, verify, commit**

```bash
pnpm vitest run packages/ribo-ui-react && pnpm --filter @azx/ribo-ui-react typecheck && pnpm lint
pnpm format
git add packages/ribo-ui-react
git commit -m "Add useConnectivity and useStoragePersistence

useConnectivity exposes state only -- start/stop bind an event source and stay
the host's lifecycle. useStoragePersistence is scoped to the grant and the
estimate; the playground's eviction detection stays in the playground."
```

---

## Task 12: `useRecorder`

**Files:**

- Create: `packages/ribo-ui-react/src/use-recorder.ts`
- Create: `packages/ribo-ui-react/src/use-recorder.browser.test.tsx`
- Modify: `packages/ribo-ui-react/src/index.ts`

**Interfaces:**

- Consumes: `useRiboInstance`, `useSubscribed`, and `Recorder.pause`/`resume` from Task 6.
- Produces:

  ```ts
  export interface UseRecorderOptions {
    readonly recorder?: AnyRecorder;
    readonly outbox?: Outbox;
    /** Enqueue the capture on stop. Defaults to `true`. */
    readonly enqueue?: boolean;
  }
  export interface StopResult {
    readonly capture: Capture<Record<string, unknown>>;
    readonly item: OutboxItem | undefined;
  }
  export interface UseRecorderResult {
    readonly phase: RecorderPhase;
    readonly elapsedMs: number;
    readonly level: number;
    readonly scaledLevel: number;
    readonly busy: boolean;
    readonly error: RecorderError | undefined;
    readonly start: () => Promise<void>;
    readonly stop: () => Promise<StopResult>;
    readonly pause: () => void;
    readonly resume: () => void;
    readonly toggle: () => Promise<void>;
  }
  export function useRecorder(options?: UseRecorderOptions): UseRecorderResult;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/ribo-ui-react/src/use-recorder.browser.test.tsx`:

```tsx
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { openOutbox, Recorder, RecorderError } from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { useRecorder } from "./use-recorder.js";

test("scaledLevel spreads the raw level, which is why the hook owns the curve", () => {
  // Raw RMS for speech sits low enough that a bar at `level * 100%` barely leaves
  // the left edge. Every consumer would otherwise rediscover this and pick its own
  // curve — doc 04 assigns the mapping to the meter, and a headless package has no
  // meter, so the hook owns it.
  let seen: { level: number; scaledLevel: number } | undefined;
  const recorder = new Recorder();
  function Probe() {
    const { level, scaledLevel } = useRecorder({ recorder, enqueue: false });
    seen = { level, scaledLevel };
    return null;
  }
  render(<Probe />);
  expect(seen).toEqual({ level: 0, scaledLevel: 0 });
});

test("records, and enqueues the capture on stop by default", async () => {
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  const recorder = new Recorder();
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, outbox });
    return <p>phase {api.phase}</p>;
  }
  const screen = render(<Probe />);

  await api!.start();
  await expect.element(screen.getByText("phase recording")).toBeInTheDocument();
  const { item } = await api!.stop();

  // The durability promise: bytes reach disk without the host wiring it up.
  expect(item).toBeDefined();
  expect(await outbox.get(item!.id)).toBeDefined();
  await outbox.close();
});

test("enqueue: false returns the capture and writes nothing", async () => {
  const recorder = new Recorder();
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return null;
  }
  render(<Probe />);

  await api!.start();
  const { capture, item } = await api!.stop();
  expect(item).toBeUndefined();
  expect(capture.audio.size).toBeGreaterThan(0);
});

test("surfaces pause and resume, and the phase they produce", async () => {
  const recorder = new Recorder();
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return <p>phase {api.phase}</p>;
  }
  const screen = render(<Probe />);

  await api!.start();
  api!.pause();
  await expect.element(screen.getByText("phase paused")).toBeInTheDocument();
  api!.resume();
  await expect.element(screen.getByText("phase recording")).toBeInTheDocument();
  await api!.stop();
});

test("a denied microphone surfaces as a RecorderError with a branchable code", async () => {
  // A string message would force every host to pattern-match prose. `.code` is
  // what distinguishes "ask the user to allow the mic" from "there is no mic".
  const recorder = new Recorder({
    getUserMedia: () => Promise.reject(new DOMException("no", "NotAllowedError")),
  });
  let api: ReturnType<typeof useRecorder> | undefined;
  function Probe() {
    api = useRecorder({ recorder, enqueue: false });
    return null;
  }
  render(<Probe />);

  await api!.start();
  await vi.waitFor(() => {
    expect(api!.error).toBeInstanceOf(RecorderError);
    expect(api!.error?.code).toBe("permission-denied");
  });
});

test("enqueue defaults on, so a missing outbox fails loudly rather than dropping audio", () => {
  const recorder = new Recorder();
  function Probe() {
    useRecorder({ recorder });
    return null;
  }
  expect(() => render(<Probe />)).toThrow(/outbox/i);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-ui-react/src/use-recorder.browser.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

````ts
import type { Capture, Outbox, OutboxItem, RecorderPhase, RecorderState } from "@azx/ribo-core";
import { RecorderError } from "@azx/ribo-core";
import { useCallback, useState } from "react";

// `AnyRecorder` is this package's own alias for a recorder whose host context type
// the provider cannot know — it is defined in ./context.js, NOT in @azx/ribo-core.
import type { AnyRecorder } from "./context.js";
import { useOptionalRiboInstance, useRiboInstance } from "./use-ribo-instance.js";
import { useSubscribed } from "./use-subscribed.js";

export interface UseRecorderOptions {
  readonly recorder?: AnyRecorder;
  readonly outbox?: Outbox;
  /**
   * Hand the capture to the outbox on stop. Defaults to **`true`**.
   *
   * A recording that stops without reaching disk is lost, so the durable path is
   * the default rather than an opt-in. With `enqueue: false` no outbox is needed
   * and `stop()` resolves `item: undefined`.
   */
  readonly enqueue?: boolean;
}

export interface StopResult {
  readonly capture: Capture<Record<string, unknown>>;
  /** The queued row, or `undefined` when `enqueue` was `false`. */
  readonly item: OutboxItem | undefined;
}

export interface UseRecorderResult {
  readonly phase: RecorderPhase;
  readonly elapsedMs: number;
  /** Raw RMS in `[0, 1]` — the honest value. */
  readonly level: number;
  /** {@link level} under a perceptual curve, for drawing a meter. */
  readonly scaledLevel: number;
  /** An async `start`/`stop` is in flight. */
  readonly busy: boolean;
  readonly error: RecorderError | undefined;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<StopResult>;
  readonly pause: () => void;
  readonly resume: () => void;
  /** Start when idle, stop when recording or paused. */
  readonly toggle: () => Promise<void>;
}

/**
 * Capture, as React state.
 *
 * ```tsx
 * const { phase, scaledLevel, toggle } = useRecorder();
 * <button onClick={toggle}>{phase === "recording" ? "Stop" : "Record"}</button>
 * <Meter value={scaledLevel} />
 * ```
 *
 * Errors are captured into {@link UseRecorderResult.error} rather than thrown out
 * of an event handler, where React cannot route them anywhere useful. The one
 * exception is a misconfiguration — `enqueue` on with no outbox — which throws at
 * render, because it is a wiring bug the developer must fix rather than a runtime
 * condition the UI should display.
 */
export function useRecorder(options: UseRecorderOptions = {}): UseRecorderResult {
  const { enqueue = true } = options;
  const recorder = useRiboInstance("recorder", options.recorder);
  // Resolved unconditionally — a conditional hook call breaks the rules of hooks,
  // and `eslint-plugin-react-hooks` is configured for this package and will reject
  // it. The *check* is conditional instead, and it throws at first render rather
  // than at the end of the first recording, by which point the audio is in memory
  // with nowhere to go.
  const maybeOutbox = useOptionalRiboInstance("outbox", options.outbox);
  if (enqueue && maybeOutbox === undefined) {
    throw new Error(
      "ribo: useRecorder({ enqueue: true }) needs an outbox, so a stopped recording reaches disk. Pass one to <RiboProvider value={{ outbox }}>, or set enqueue: false to handle the capture yourself.",
    );
  }
  const outbox = enqueue ? maybeOutbox : undefined;

  const subscribe = useCallback(
    (listener: (state: RecorderState) => void) => recorder.subscribe(listener),
    [recorder],
  );
  const state = useSubscribed(subscribe, () => recorder.state);
  const [error, setError] = useState<RecorderError | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    setError(undefined);
    setBusy(true);
    try {
      await recorder.start();
    } catch (cause) {
      setError(asRecorderError(cause));
    } finally {
      setBusy(false);
    }
  }, [recorder]);

  const stop = useCallback(async (): Promise<StopResult> => {
    setError(undefined);
    setBusy(true);
    try {
      const capture = await recorder.stop();
      const item = outbox === undefined ? undefined : await outbox.enqueue(capture);
      return { capture, item };
    } catch (cause) {
      const failure = asRecorderError(cause);
      setError(failure);
      throw failure;
    } finally {
      setBusy(false);
    }
  }, [outbox, recorder]);

  const pause = useCallback(() => {
    try {
      recorder.pause();
    } catch (cause) {
      setError(asRecorderError(cause));
    }
  }, [recorder]);

  const resume = useCallback(() => {
    try {
      recorder.resume();
    } catch (cause) {
      setError(asRecorderError(cause));
    }
  }, [recorder]);

  const toggle = useCallback(async () => {
    if (recorder.phase === "idle") return await start();
    await stop();
  }, [recorder, start, stop]);

  return {
    phase: state.phase,
    elapsedMs: state.elapsedMs,
    level: state.level,
    scaledLevel: scaleLevel(state.level),
    busy,
    error,
    start,
    stop,
    pause,
    resume,
    toggle,
  };
}

/**
 * Maps raw RMS onto something a bar can show.
 *
 * `RecorderState.level` is honest RMS, and for ordinary speech it sits low enough
 * that a bar at `level * 100%` barely leaves the left edge — it reads as a broken
 * meter, not a quiet room. Doc 04 assigns this mapping to the meter component; a
 * headless package has no meter, so the hook owns it, and every consumer gets the
 * same curve instead of guessing at its own.
 *
 * `sqrt` rather than a dB mapping: it is monotonic, needs no floor, and is what
 * the playground arrived at against a real microphone.
 */
const scaleLevel = (level: number): number => Math.sqrt(level);

/** Keeps `error` typed as `RecorderError` without lying about an unknown cause. */
const asRecorderError = (cause: unknown): RecorderError =>
  cause instanceof RecorderError
    ? cause
    : new RecorderError("capture-failed", "The capture failed.", { cause });
````

**This needs a non-throwing resolver that Task 9 did not create.** Add it to
`packages/ribo-ui-react/src/use-ribo-instance.ts`:

```ts
/**
 * Like {@link useRiboInstance} but yields `undefined` instead of throwing.
 *
 * For the caller whose need is conditional — `useRecorder({ enqueue: false })` has
 * no use for an outbox. A conditional `useRiboInstance` call would break the rules
 * of hooks, so the resolution stays unconditional and the *requirement* becomes a
 * plain check at the call site.
 */
export function useOptionalRiboInstance<K extends keyof RiboInstances>(
  key: K,
  override?: RiboInstances[K],
): RiboInstances[K] {
  const instances = useContext(RiboContext);
  return override ?? instances[key];
}
```

Also note `toggle()` reads `recorder.phase` directly rather than the subscribed `state.phase`. That is
deliberate: `state` can be one render behind a phase change, and a toggle that acts on stale phase
double-starts or double-stops. The instance is the authority.

- [ ] **Step 4: Export and run**

```ts
export { useRecorder } from "./use-recorder.js";
export type { StopResult, UseRecorderOptions, UseRecorderResult } from "./use-recorder.js";
```

```bash
pnpm vitest run packages/ribo-ui-react && pnpm --filter @azx/ribo-ui-react typecheck && pnpm lint
```

Expected: PASS, with no react-hooks lint errors.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ribo-ui-react
git commit -m "Add useRecorder

Exposes raw level and a scaled level: doc 04 gives the meter the perceptual
curve, and a headless package has no meter, so the hook owns it rather than
letting every consumer rediscover that honest RMS draws a broken-looking bar.
Enqueue-on-stop defaults on, because a recording that stops without reaching
disk is lost."
```

---

## Task 13: `useOutboxItems`

**Files:**

- Create: `packages/ribo-ui-react/src/use-outbox-items.ts`
- Create: `packages/ribo-ui-react/src/use-outbox-items.browser.test.tsx`
- Modify: `packages/ribo-ui-react/src/index.ts`

**Interfaces:**

- Consumes: `useRiboInstance` (Task 9).
- Produces:

  ```ts
  export interface UseOutboxItemsResult {
    readonly items: readonly OutboxItem[];
    readonly loading: boolean;
    readonly error: Error | undefined;
  }
  export function useOutboxItems(query?: OutboxQuery, outbox?: Outbox): UseOutboxItemsResult;
  ```

  Tasks 14 and 15 both consume it.

- [ ] **Step 1: Write the failing tests**

```tsx
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { openOutbox, type Outbox } from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { useOutboxItems } from "./use-outbox-items.js";

const freshOutbox = () =>
  openOutbox({ name: `t-${crypto.randomUUID()}`, storage: getRxStorageMemory() });

const aRecording = () => ({
  recording: {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    durationMs: 10,
    mimeType: "audio/webm",
    ctx: {},
  },
  audio: new Blob(["x"], { type: "audio/webm" }),
});

test("loading is a real state, distinct from empty", async () => {
  // A UI must be able to say "reading the outbox…" rather than flashing "nothing
  // here" before the first emission — the playground's ReviewPanel already draws
  // this distinction and it matters.
  const outbox = await freshOutbox();
  const seen: { loading: boolean; count: number }[] = [];
  function Probe() {
    const { items, loading } = useOutboxItems({}, outbox);
    seen.push({ loading, count: items.length });
    return null;
  }
  render(<Probe />);
  expect(seen[0]).toEqual({ loading: true, count: 0 });
  await vi.waitFor(() => expect(seen.at(-1)).toEqual({ loading: false, count: 0 }));
  await outbox.close();
});

test("updates live when an item is enqueued", async () => {
  const outbox = await freshOutbox();
  function Probe() {
    return <p>count {useOutboxItems({}, outbox).items.length}</p>;
  }
  const screen = render(<Probe />);
  await expect.element(screen.getByText("count 0")).toBeInTheDocument();

  await outbox.enqueue(aRecording());
  await expect.element(screen.getByText("count 1")).toBeInTheDocument();
  await outbox.close();
});

test("honours a status filter", async () => {
  const outbox = await freshOutbox();
  const item = await outbox.enqueue(aRecording());
  await outbox.patch(item.id, { status: "awaiting-review" });
  await outbox.enqueue(aRecording());

  function Probe() {
    return <p>parked {useOutboxItems({ status: "awaiting-review" }, outbox).items.length}</p>;
  }
  const screen = render(<Probe />);
  await expect.element(screen.getByText("parked 1")).toBeInTheDocument();
  await outbox.close();
});

test("an inline query object does not re-subscribe every render", async () => {
  // The trap: `{ status: "queued" }` is a new object identity per render, so a
  // naive effect dependency tears the subscription down and rebuilds it forever.
  const outbox = await freshOutbox();
  const watch = vi.spyOn(outbox, "watch");
  function Probe() {
    const { items } = useOutboxItems({ status: "queued" }, outbox);
    return <p>count {items.length}</p>;
  }
  const screen = render(<Probe />);
  await expect.element(screen.getByText("count 0")).toBeInTheDocument();
  await outbox.enqueue(aRecording());
  await expect.element(screen.getByText("count 1")).toBeInTheDocument();

  expect(watch.mock.calls.length).toBeLessThanOrEqual(2);
  await outbox.close();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-ui-react/src/use-outbox-items.browser.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

````ts
import type { Outbox, OutboxItem, OutboxQuery } from "@azx/ribo-core";
import { useEffect, useMemo, useState } from "react";

import { useRiboInstance } from "./use-ribo-instance.js";

export interface UseOutboxItemsResult {
  readonly items: readonly OutboxItem[];
  /** No emission has arrived yet. Distinct from an empty queue. */
  readonly loading: boolean;
  readonly error: Error | undefined;
}

/**
 * The outbox as live React state.
 *
 * ```tsx
 * const { items: parked, loading } = useOutboxItems({ status: "awaiting-review" });
 * ```
 *
 * `loading` is load-bearing, not cosmetic: "reading the outbox…" and "nothing in
 * the queue" are different sentences, and conflating them flashes the empty state
 * on every mount.
 *
 * The query is compared **by value**, not by identity. A caller writing
 * `useOutboxItems({ status: "queued" })` builds a new object every render, and an
 * effect keyed on that object would tear down the RxDB subscription and rebuild it
 * on every single render — a trap a consumer hits immediately and diagnoses slowly.
 */
export function useOutboxItems(query: OutboxQuery = {}, outbox?: Outbox): UseOutboxItemsResult {
  const instance = useRiboInstance("outbox", outbox);
  // Serialized rather than deep-compared: the query has two scalar-ish fields, so
  // a string key is cheaper and more obvious than a comparison helper. Key order
  // is stable because the object is built from a fixed set of fields.
  const key = JSON.stringify({ status: query.status, limit: query.limit });

  const stableQuery = useMemo<OutboxQuery>(() => JSON.parse(key) as OutboxQuery, [key]);

  const [items, setItems] = useState<readonly OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    setLoading(true);
    const subscription = instance.watch(stableQuery).subscribe({
      next: (next) => {
        setItems(next);
        setLoading(false);
      },
      error: (cause: unknown) => {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setLoading(false);
      },
    });
    return () => subscription.unsubscribe();
  }, [instance, stableQuery]);

  return { items, loading, error };
}
````

Note: `JSON.parse(key)` drops `undefined` fields, which is exactly right — `{ status: undefined }` and
`{}` mean the same thing to `watch`.

- [ ] **Step 4: Export, run, commit**

```ts
export { useOutboxItems } from "./use-outbox-items.js";
export type { UseOutboxItemsResult } from "./use-outbox-items.js";
```

```bash
pnpm vitest run packages/ribo-ui-react && pnpm --filter @azx/ribo-ui-react typecheck && pnpm lint
pnpm format
git add packages/ribo-ui-react
git commit -m "Add useOutboxItems

Compares the query by value, so an inline { status } literal does not tear down
and rebuild the RxDB subscription on every render. Keeps loading distinct from
empty: a UI must be able to say 'reading the outbox' rather than flashing
'nothing here' before the first emission."
```

---

## Task 14: `useReview`

**Files:**

- Create: `packages/ribo-ui-react/src/use-review.ts`
- Create: `packages/ribo-ui-react/src/use-review.browser.test.tsx`
- Modify: `packages/ribo-ui-react/src/index.ts`

**Interfaces:**

- Consumes: `Outbox.submitReview` (Task 4), `buildReviewRequest` / `resolveReview` /
  `reviewOutcomeSchema` (core), `useRiboInstance`.
- Produces:

  ```ts
  export interface UseReviewResult<F extends Record<string, unknown>> {
    readonly ready: boolean;
    readonly fields: ReviewFields<F> | undefined;
    readonly transcript: Transcript | undefined;
    readonly decisionOf: <K extends keyof F>(key: K) => FieldDecision<F[K]> | undefined;
    readonly accept: (key: keyof F) => void;
    readonly edit: <K extends keyof F>(key: K, value: F[K] | null) => void;
    readonly reject: (key: keyof F) => void;
    readonly untouched: readonly (keyof F)[];
    readonly submit: () => Promise<ReviewOutcome<F>>;
    readonly discard: (reason?: string) => Promise<ReviewOutcome<F>>;
    readonly submitting: boolean;
    readonly error: Error | undefined;
  }
  export function useReview<F extends Record<string, unknown>>(
    item: OutboxItem | undefined,
    options?: { readonly outbox?: Outbox },
  ): UseReviewResult<F>;
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { openOutbox, type OutboxItem } from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { useReview } from "./use-review.js";

interface Fields extends Record<string, unknown> {
  atticRValue: number;
  heatingFuel: string;
}

const TRANSCRIPT = { text: "The attic is R-19 and the boiler runs on oil.", segments: [] };

/** A parked item with two extracted fields: one grounded, one invented. */
async function parkedItem() {
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  const item = await outbox.enqueue({
    recording: {
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      durationMs: 10,
      mimeType: "audio/webm",
      ctx: {},
    },
    audio: new Blob(["x"], { type: "audio/webm" }),
  });
  const parked = await outbox.patch(item.id, {
    status: "awaiting-review",
    transcript: TRANSCRIPT,
    extracted: {
      atticRValue: { value: 19, confidence: 1, sourceSpan: "R-19" },
      heatingFuel: { value: "propane", confidence: 1, sourceSpan: "runs on propane" },
    },
  });
  return { outbox, item: parked };
}

test("is not ready until the item has both a transcript and an extraction", async () => {
  const { outbox, item } = await parkedItem();
  let api: ReturnType<typeof useReview<Fields>> | undefined;
  function Probe({ subject }: { subject: OutboxItem | undefined }) {
    api = useReview<Fields>(subject, { outbox });
    return null;
  }

  render(<Probe subject={undefined} />);
  expect(api!.ready).toBe(false);
  expect(api!.fields).toBeUndefined();

  render(<Probe subject={item} />);
  expect(api!.ready).toBe(true);
  await outbox.close();
});

test("grounding comes from core, so every UI flags the same thing", async () => {
  const { outbox, item } = await parkedItem();
  let api: ReturnType<typeof useReview<Fields>> | undefined;
  function Probe() {
    api = useReview<Fields>(item, { outbox });
    return null;
  }
  render(<Probe />);

  expect(api!.fields?.atticRValue.isGrounded).toBe(true);
  // "runs on propane" was never said — the model invented the quote.
  expect(api!.fields?.heatingFuel.isGrounded).toBe(false);
  await outbox.close();
});

test("every field starts accepted, and untouched names what nobody looked at", async () => {
  // FieldDecisions is deliberately not Partial: a missing decision is
  // indistinguishable from a field nobody saw. So decisions start complete, and
  // `untouched` is what lets a host refuse to submit while an ungrounded field has
  // not been visited.
  const { outbox, item } = await parkedItem();
  let api: ReturnType<typeof useReview<Fields>> | undefined;
  function Probe() {
    api = useReview<Fields>(item, { outbox });
    return null;
  }
  render(<Probe />);

  expect(api!.decisionOf("atticRValue")).toEqual({ status: "accepted" });
  expect([...api!.untouched].sort()).toEqual(["atticRValue", "heatingFuel"]);
  await outbox.close();
});

test("submitting untouched fields yields an accepted outcome and moves the item to writing", async () => {
  const { outbox, item } = await parkedItem();
  let api: ReturnType<typeof useReview<Fields>> | undefined;
  function Probe() {
    api = useReview<Fields>(item, { outbox });
    return null;
  }
  render(<Probe />);

  const outcome = await api!.submit();
  expect(outcome.status).toBe("accepted");

  const persisted = await outbox.get(item.id);
  expect(persisted?.status).toBe("writing");
  expect(persisted?.reviewOutcome).toMatchObject({ status: "accepted" });
  await outbox.close();
});

test("an edit is reported as edited even when the value is unchanged", async () => {
  // resolveReview's rule: the signal is what the human touched, not whether the
  // bytes changed. Comparing values would under-report review effort for exactly
  // the fields someone stopped to check.
  const { outbox, item } = await parkedItem();
  let api: ReturnType<typeof useReview<Fields>> | undefined;
  function Probe() {
    api = useReview<Fields>(item, { outbox });
    return null;
  }
  render(<Probe />);

  api!.edit("atticRValue", 19);
  await vi.waitFor(() =>
    expect(api!.decisionOf("atticRValue")).toEqual({ status: "edited", value: 19 }),
  );
  const outcome = await api!.submit();

  expect(outcome).toMatchObject({ status: "edited", editedFields: ["atticRValue"] });
  await outbox.close();
});

test("rejecting a field drops it from the written values", async () => {
  const { outbox, item } = await parkedItem();
  let api: ReturnType<typeof useReview<Fields>> | undefined;
  function Probe() {
    api = useReview<Fields>(item, { outbox });
    return null;
  }
  render(<Probe />);

  api!.reject("heatingFuel");
  await vi.waitFor(() => expect(api!.decisionOf("heatingFuel")).toEqual({ status: "rejected" }));
  const outcome = await api!.submit();

  expect(outcome).toMatchObject({ status: "edited", rejectedFields: ["heatingFuel"] });
  expect("heatingFuel" in (outcome as { fields: object }).fields).toBe(false);
  await outbox.close();
});

test("editing to null is a positive assertion, not a rejection", async () => {
  const { outbox, item } = await parkedItem();
  let api: ReturnType<typeof useReview<Fields>> | undefined;
  function Probe() {
    api = useReview<Fields>(item, { outbox });
    return null;
  }
  render(<Probe />);

  api!.edit("heatingFuel", null);
  await vi.waitFor(() =>
    expect(api!.decisionOf("heatingFuel")).toEqual({ status: "edited", value: null }),
  );
  const outcome = await api!.submit();

  // Present and null — "there is nothing to record here" — not absent.
  expect((outcome as { fields: Record<string, unknown> }).fields.heatingFuel).toBeNull();
  await outbox.close();
});

test("discarding is terminal and drops the audio", async () => {
  const { outbox, item } = await parkedItem();
  let api: ReturnType<typeof useReview<Fields>> | undefined;
  function Probe() {
    api = useReview<Fields>(item, { outbox });
    return null;
  }
  render(<Probe />);

  const outcome = await api!.discard("misspoke");
  expect(outcome).toEqual({ status: "discarded", reason: "misspoke" });

  const persisted = await outbox.get(item.id);
  expect(persisted?.status).toBe("discarded");
  expect(persisted?.hasAudio).toBe(false);
  await outbox.close();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-ui-react/src/use-review.browser.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

````ts
import type {
  ExtractedFields,
  FieldDecision,
  FieldDecisions,
  Outbox,
  OutboxItem,
  ReviewFields,
  ReviewOutcome,
  ReviewRequest,
  Transcript,
} from "@azx/ribo-core";
import { buildReviewRequest, resolveReview } from "@azx/ribo-core";
import { useCallback, useMemo, useState } from "react";

import { useRiboInstance } from "./use-ribo-instance.js";

export interface UseReviewResult<F extends Record<string, unknown>> {
  /** The item has both a transcript and an extraction, so review can proceed. */
  readonly ready: boolean;
  readonly fields: ReviewFields<F> | undefined;
  readonly transcript: Transcript | undefined;
  readonly decisionOf: <K extends keyof F>(key: K) => FieldDecision<F[K]> | undefined;
  readonly accept: (key: keyof F) => void;
  readonly edit: <K extends keyof F>(key: K, value: F[K] | null) => void;
  readonly reject: (key: keyof F) => void;
  /** Fields the human has not acted on. Every field starts here. */
  readonly untouched: readonly (keyof F)[];
  readonly submit: () => Promise<ReviewOutcome<F>>;
  readonly discard: (reason?: string) => Promise<ReviewOutcome<F>>;
  readonly submitting: boolean;
  readonly error: Error | undefined;
}

/**
 * Field-by-field review of one parked item.
 *
 * ```tsx
 * const { fields, decisionOf, edit, reject, untouched, submit } = useReview<SnuggFields>(item);
 * ```
 *
 * ## Decisions start complete, and `untouched` is why that is safe
 *
 * `FieldDecisions` is deliberately not `Partial`: core's contract says a field
 * with no decision is indistinguishable from a field the reviewer never saw, and
 * "I did not look at it" must not silently mean "accepted". So every field starts
 * `{ status: "accepted" }` — which is the sensible default for a UI — and
 * {@link UseReviewResult.untouched} reports what nobody acted on. A host can
 * require every `isGrounded: false` field to be visited before enabling submit,
 * which honours the warning without inventing a fourth decision status.
 *
 * ## The generic boundary
 *
 * `item.extracted` is persisted loose (`Record<string, unknown>`), so `F` is the
 * caller's claim about what the adapter extracts and this hook asserts it on the
 * way in. On the way out, `ReviewOutcome<F>` erases back to the loose shape
 * `Outbox.submitReview` persists. Both crossings happen here, in one place, rather
 * than scattered through a UI — and neither is validation. The adapter's
 * `schema.parse` at write time is the actual trust boundary.
 */
export function useReview<F extends Record<string, unknown>>(
  item: OutboxItem | undefined,
  options: { readonly outbox?: Outbox } = {},
): UseReviewResult<F> {
  const outbox = useRiboInstance("outbox", options.outbox);
  const [decisions, setDecisions] = useState<Partial<FieldDecisions<F>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const request = useMemo<ReviewRequest<F> | undefined>(() => {
    if (item?.extracted === undefined || item.transcript === undefined) return undefined;
    return buildReviewRequest(item.extracted as ExtractedFields<F>, item.transcript);
  }, [item?.extracted, item?.transcript]);

  const keys = useMemo(
    () => (request === undefined ? [] : (Object.keys(request.fields) as (keyof F)[])),
    [request],
  );

  const decisionOf = useCallback(
    <K extends keyof F>(key: K): FieldDecision<F[K]> | undefined =>
      request === undefined
        ? undefined
        : ((decisions[key] ?? { status: "accepted" }) as FieldDecision<F[K]>),
    [decisions, request],
  );

  const accept = useCallback((key: keyof F) => {
    setDecisions((prior) => ({ ...prior, [key]: { status: "accepted" } }));
  }, []);

  const edit = useCallback(<K extends keyof F>(key: K, value: F[K] | null) => {
    setDecisions((prior) => ({ ...prior, [key]: { status: "edited", value } }));
  }, []);

  const reject = useCallback((key: keyof F) => {
    setDecisions((prior) => ({ ...prior, [key]: { status: "rejected" } }));
  }, []);

  const untouched = useMemo(
    () => keys.filter((key) => decisions[key] === undefined),
    [decisions, keys],
  );

  const settle = useCallback(
    async (outcome: ReviewOutcome<F>): Promise<ReviewOutcome<F>> => {
      if (item === undefined) throw new Error("ribo: cannot submit a review with no item.");
      setSubmitting(true);
      setError(undefined);
      try {
        // The typed outcome erases to the persisted loose shape here. `submitReview`
        // re-parses it, so a malformed outcome fails at the argument.
        await outbox.submitReview(item.id, outcome as Parameters<Outbox["submitReview"]>[1]);
        return outcome;
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        setError(failure);
        throw failure;
      } finally {
        setSubmitting(false);
      }
    },
    [item, outbox],
  );

  const submit = useCallback(async (): Promise<ReviewOutcome<F>> => {
    if (request === undefined) throw new Error("ribo: this item is not ready for review.");
    // Every key gets a decision, defaulting to accepted — the complete-by-
    // construction shape core's FieldDecisions requires.
    const complete = Object.fromEntries(
      keys.map((key) => [key, decisions[key] ?? { status: "accepted" }]),
    ) as FieldDecisions<F>;
    return await settle(resolveReview(request, { status: "submitted", decisions: complete }));
  }, [decisions, keys, request, settle]);

  const discard = useCallback(
    async (reason?: string): Promise<ReviewOutcome<F>> =>
      await settle(
        reason === undefined ? { status: "discarded" } : { status: "discarded", reason },
      ),
    [settle],
  );

  return {
    ready: request !== undefined,
    fields: request?.fields,
    transcript: request?.transcript,
    decisionOf,
    accept,
    edit,
    reject,
    untouched,
    submit,
    discard,
    submitting,
    error,
  };
}
````

- [ ] **Step 4: Export, run, commit**

```ts
export { useReview } from "./use-review.js";
export type { UseReviewResult } from "./use-review.js";
```

```bash
pnpm vitest run packages/ribo-ui-react && pnpm --filter @azx/ribo-ui-react typecheck && pnpm lint
pnpm format
git add packages/ribo-ui-react
git commit -m "Add useReview

Decisions start complete because core's FieldDecisions is deliberately not
Partial, and `untouched` is what lets a host refuse to submit while an
ungrounded field has never been looked at -- honouring the 'I did not look at
it must not mean accepted' rule without a fourth decision status."
```

---

## Task 15: `useWorkSafety`

**Files:**

- Create: `packages/ribo-ui-react/src/use-work-safety.ts`
- Create: `packages/ribo-ui-react/src/use-work-safety.browser.test.tsx`
- Modify: `packages/ribo-ui-react/src/index.ts`

**Interfaces:**

- Consumes: `useOutboxItems` (Task 13), `useConnectivity` + `useStoragePersistence` (Task 11),
  `summarizeWork` / `workSafety` with `awaitingReview` (Task 2).
- Produces:

  ```ts
  export interface UseWorkSafetyResult {
    readonly safety: WorkSafety;
    readonly work: WorkOnDevice;
    readonly loading: boolean;
  }
  export function useWorkSafety(): UseWorkSafetyResult;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { createConnectivity, openOutbox } from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

import { RiboProvider } from "./RiboProvider.js";
import { useWorkSafety } from "./use-work-safety.js";

test("un-reviewed work is never reported as safe", async () => {
  // The hook-level assertion of the same regression work-safety.test.ts covers:
  // an item parked for review is unsynced work on the device, and a UI built on
  // this hook must not tell the auditor their work is safe.
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  const item = await outbox.enqueue({
    recording: {
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      durationMs: 10,
      mimeType: "audio/webm",
      ctx: {},
    },
    audio: new Blob(["x"], { type: "audio/webm" }),
  });
  await outbox.patch(item.id, { status: "awaiting-review" });

  const connectivity = createConnectivity({
    bindEvents: () => () => undefined,
    isOnline: () => true,
    probe: async () => true,
  });

  function Probe() {
    const { safety, work, loading } = useWorkSafety();
    if (loading) return <p>loading</p>;
    return (
      <p>
        {safety.level} pending {work.pending} review {work.awaitingReview}
      </p>
    );
  }

  const screen = render(
    <RiboProvider value={{ outbox, connectivity }}>
      <Probe />
    </RiboProvider>,
  );

  await expect.element(screen.getByText(/pending 1 review 1/)).toBeInTheDocument();
  await expect.element(screen.getByText(/^safe/)).not.toBeInTheDocument();
  await outbox.close();
});
```

Match `createConnectivity`'s real option names, as in Task 11.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm vitest run packages/ribo-ui-react/src/use-work-safety.browser.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

```ts
import type { WorkOnDevice, WorkSafety } from "@azx/ribo-core";
import { summarizeWork, workSafety } from "@azx/ribo-core";
import { useMemo } from "react";

import { useConnectivity } from "./use-connectivity.js";
import { useOutboxItems } from "./use-outbox-items.js";
import { useStoragePersistence } from "./use-storage-persistence.js";

export interface UseWorkSafetyResult {
  readonly safety: WorkSafety;
  readonly work: WorkOnDevice;
  /** The outbox has not emitted yet, so the verdict is provisional. */
  readonly loading: boolean;
}

/**
 * The one honest answer to "is my work safe?", composed for React.
 *
 * Reads the outbox, the storage-persistence grant and connectivity, and runs
 * core's `summarizeWork` → `workSafety`. Composed **here**, once, because the
 * whole reason that logic lives in core is so "every presenter classifies
 * identically" — a host assembling the three inputs itself is exactly the
 * divergence core centralised to prevent.
 *
 * While `loading`, the verdict is computed over an empty outbox, so it will read
 * `safe` / `nothing-captured`. Show a pending state rather than that verdict: a UI
 * that renders it unconditionally tells the auditor their work is safe before it
 * has looked.
 */
export function useWorkSafety(): UseWorkSafetyResult {
  const { items, loading } = useOutboxItems();
  const { persistence } = useStoragePersistence();
  const connectivity = useConnectivity();

  const work = useMemo(() => summarizeWork(items), [items]);
  const safety = useMemo(
    () => workSafety(work, persistence, connectivity.status),
    [connectivity.status, persistence, work],
  );

  return { safety, work, loading };
}
```

- [ ] **Step 4: Export, run, commit**

```ts
export { useWorkSafety } from "./use-work-safety.js";
export type { UseWorkSafetyResult } from "./use-work-safety.js";
```

```bash
pnpm vitest run packages/ribo-ui-react && pnpm --filter @azx/ribo-ui-react typecheck && pnpm lint
pnpm format
git add packages/ribo-ui-react
git commit -m "Add useWorkSafety

Composes the outbox, the persistence grant and connectivity through core's
summarizeWork and workSafety in one place -- a host assembling those three
inputs itself is the divergence core centralised that logic to prevent."
```

---

## Task 16: Phase B gate

- [ ] **Step 1: Everything except e2e, green**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build:packages && pnpm check:resolve \
  && pnpm build:app && pnpm check:pkg && pnpm vitest run --project unit --project browser
```

Expected: PASS on all of it. `build:app` and the playground typecheck are only green because Task 9
Step 6b removed the `PACKAGE_NAME` import — if they fail here, that step was skipped.

`e2e` is still red, with the same two specs Task 7 recorded and no others. Re-run
`pnpm vitest run --project e2e` and confirm the failing list is **unchanged** from Task 7's report: a
new e2e failure means something in Phase B broke the app, which is worth knowing now rather than
inside Task 18.

- [ ] **Step 2: Verify the built artifact is real**

```bash
pnpm build:packages && pnpm check:resolve && pnpm check:pkg
node -e "import('@azx/ribo-ui-react').then((m) => console.log(Object.keys(m).sort().join(', ')))"
```

Expected: the barrel exports `RiboProvider`, `useConnectivity`, `useOutboxItems`, `useRecorder`,
`useReview`, `useStoragePersistence`, `useWorkSafety` — and nothing else. `PACKAGE_NAME` must be gone.

- [ ] **Step 3: Add a changeset**

```markdown
---
"@azx/ribo-ui-react": minor
---

Replace the package stub with the headless hook layer: `RiboProvider` plus
`useRecorder`, `useOutboxItems`, `useReview`, `useWorkSafety`, `useConnectivity`
and `useStoragePersistence`. The provider carries host-constructed engine
instances and never builds them, so instance lifetime stays where StrictMode and
HMR require it — above React.
```

```bash
git add .changeset && git commit -m "Add a changeset for the ribo-ui-react hook layer"
```

---

# Phase C — the playground migration

## Task 17: Migrate the panels and add the review UI

**Files:**

- Modify: `playground/src/App.tsx` (wrap in `RiboProvider`)
- Modify: `playground/src/RecordPanel.tsx`, `ConnectivityPanel.tsx`, `QueuePanel.tsx`,
  `WorkSafetyPanel.tsx`, `StoragePanel.tsx`
- Rewrite: `playground/src/ReviewPanel.tsx`
- Delete: `playground/src/connectivity-store.ts` (if nothing else imports it)
- Modify: `playground/package.json` (add `@azx/ribo-ui-react` as `workspace:*`)

**Interfaces:**

- Consumes: every hook from Phase B.

**Keep:** `recorder-handle.ts` and `outbox-handle.ts` exactly as they are. They are the host lifetime
discipline the provider expects, and their StrictMode/HMR comments are the best documentation of why
the provider constructs nothing.

- [ ] **Step 1: Wrap the tree**

`@azx/ribo-ui-react` is **already** a playground dependency (`playground/package.json:18`) — it has to
be, because `App.tsx` imports `PACKAGE_NAME` from it today. No dependency change is needed.

In `App.tsx`, wrap the panels:

```tsx
<RiboProvider value={{ recorder: getRecorder(), outbox, connectivity: getConnectivity() }}>
```

`outbox` is whatever `App.tsx` already resolves from `getOutbox()`. Read `connectivity-store.ts` for
how the app builds its `Connectivity` instance and expose it the same way; if the store constructs it
lazily, add a `getConnectivity()` in the handle style of `recorder-handle.ts` rather than constructing
it in render.

- [ ] **Step 2: Migrate `RecordPanel`, and add pause/resume**

Replace the `useState`/`useEffect`/`subscribe`/`busy`/`error` block with:

```tsx
const { phase, elapsedMs, scaledLevel, level, busy, error, toggle, pause, resume } = useRecorder();
```

The panel no longer needs the `outbox` prop for enqueueing — `useRecorder` does it. Delete the local
`Math.sqrt(level)` in `LevelMeter` and pass `scaledLevel`; keep showing raw `level` in the numeric
readout, because that line is documenting the honest value. Add a pause/resume button, enabled only
while `phase` is `recording` or `paused`.

- [ ] **Step 3: Migrate the other four panels**

- `ConnectivityPanel`: `const { status } = useConnectivity();` — drop the `useSyncExternalStore` call.
- `QueuePanel`: `const { items, loading } = useOutboxItems();` and `useConnectivity()`. Its `write`
  stub becomes `write: () => Promise.resolve({ writtenBy: "playground stub" })` — already
  parameter-less, so only its type changes, but confirm it compiles against `reviewed`.
- `WorkSafetyPanel`: `const { safety, work, loading } = useWorkSafety();` — delete its local
  composition. Add the `work.awaitingReview` count to the readout: "3 need review" is now a real state
  the panel can show.
- `StoragePanel`: `const { persistence, estimate, request } = useStoragePersistence();` for the grant;
  keep its eviction logic on the existing store.

Then:

```bash
grep -rn "connectivity-store" playground/src
```

If nothing imports it, delete `playground/src/connectivity-store.ts`.

- [ ] **Step 4: Rewrite `ReviewPanel` as the interactive surface**

Keep, verbatim: `ExtractorBanner`, `MeasurementCaveat`, `flatten`, `humanize`, and the `Envelope`
handling. They are hard-won and still true — a grounded span proves the model quoted the transcript,
never that the audio was heard right.

Change the data source and add the controls:

```tsx
const { items: parked, loading } = useOutboxItems({ status: "awaiting-review" });
```

and per item, a `ReviewCard` built on `useReview`, with per-field accept / edit / reject controls, an
"accept all and queue" submit, and a discard. Gate submit while
`untouched.some((key) => fields?.[key].isGrounded === false)` — the ungrounded fields are precisely the
ones a human must look at, and `untouched` exists to make that enforceable.

The panel's copy must change too: it currently says "Drain the queue above (_sync now_, or
_Transcribe_) and the fields appear here." That is still true, but the fields now _wait_ for review
rather than flowing through, and the panel is where they move forward.

- [ ] **Step 5: Verify the app builds and runs**

```bash
pnpm --filter playground typecheck && pnpm build:app
pnpm --filter playground dev
```

Then **manually** open http://localhost:5173, record something, drain the queue, and confirm the item
appears in the review panel and moves to `writing` on submit. `curl` on `/` proves nothing — the HTML
is an empty shell that React fills in the browser (AGENTS.md §7). This manual step is the only way to
observe the app actually running.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint
git add playground packages/ribo-ui-react
git commit -m "Migrate the playground onto the hooks and add interactive review

Panels consume the hooks instead of hand-rolled stores; recorder-handle and
outbox-handle stay, since they are the host lifetime discipline the provider
expects. ReviewPanel becomes the first real review surface: parked items, a
decision per field, submit and discard."
```

---

## Task 18: The e2e suite, `TryItPanel`, and the docs

**Files:**

- Modify: `playground/e2e/extraction-ui.e2e.test.ts`
- Audit: `playground/e2e/try-it-ui.e2e.test.ts`, `playground/e2e/transcribe-ui.e2e.test.ts`
- Modify: `playground/src/TryItPanel.tsx`
- Modify: `AGENTS.md`, `docs/roadmap/index.md`

- [ ] **Step 1: Fix `extraction-ui.e2e.test.ts`**

It polls for the item reaching `done` (`:98`). Under the gate it parks at `awaiting-review`. Teach it
the new flow: drain → assert `awaiting-review` → submit the review through the UI → assert `done`. Do
**not** weaken the assertion to "any status" — the point of the test is that a recording drains all
the way through, and the path is now longer by one human step.

- [ ] **Step 2: Audit the other two e2e specs**

```bash
pnpm vitest run --project e2e
```

Read every failure. `transcribe-ui` and `try-it-ui` assert statuses too; update each to the real new
flow rather than deleting the assertion. If a spec's premise is genuinely gone, say so in the commit
message rather than silently dropping coverage.

- [ ] **Step 3: Fix `network-transition.e2e.test.ts`**

It asserts an item reaches `done` and was missed in the original file list for this task. Same
treatment as `extraction-ui`: the flow is one human step longer now.

**There is no `TryItPanel` work.** An earlier draft of this plan said its "drain the queue" affordance
needed new copy. It has no such affordance — `TryItPanel` is a standalone `/api/extract` editor
(`TryItPanel.tsx:96`) with no queue, no statuses and no relay. Skip it, and do not go looking for the
copy to change.

- [ ] **Step 4: Correct AGENTS.md**

Four things are now false or incomplete:

- **§1** — `ribo-ui-react` is no longer a `PACKAGE_NAME` stub. Describe it as the headless hook layer
  and name the six hooks. Add the review gate to the pipeline summary
  (`queued → transcribing → extracting → awaiting-review → writing → done`).
- **§6.2** — it justifies ui-react's `peerDependencies` on core by saying its hooks "will hold core's
  `Controller` / `ReviewPresenter` instances". Neither type exists. The conclusion is unchanged; the
  real reason is that `RiboProvider` carries `Recorder`, `Outbox` and `Connectivity` instances across
  the package boundary, so object identity must be shared.
- **§5.1** — its closing "Verified caveat (probed 2026-07-23)" block is **stale and actively
  misleading**. It says cross-package resolution is unproven, that "nothing fails today only because
  every test imports its own module by relative path", and to "expect to fix this the moment a test
  crosses a package boundary". All three are false now: `vitest.config.ts:25-58` carries the
  project-local `ssr.resolve.conditions` fix for the `unit` tier, and
  `adapter-snuggpro/src/workspace-resolution.test.ts` already crosses a package boundary by name in
  that tier. Replace the caveat with what is true: **both** tiers resolve workspace packages by name,
  via deliberately different spellings (`ssr.resolve.conditions` for `unit`, plain
  `resolve.conditions` for `browser`), each pinned by its own guard —
  `adapter-snuggpro/src/workspace-resolution.test.ts` and, as of R2,
  `ribo-ui-react/src/workspace-resolution.browser.test.tsx`. Note that neither guard covers the
  other's spelling, which is why both exist.

  This one matters beyond tidiness: a stale caveat telling contributors a working mechanism is broken
  costs someone a day of re-verifying it, which is exactly what it cost while writing this plan.

- **§3** — the architecture table's `ribo-ui-react` row still says "still a stub".

- [ ] **Step 5: Update the roadmap**

In `docs/roadmap/index.md`, move R2 from "What is next" into "What has shipped" with a link to both
the design and this plan, and renumber the remaining R3/R4/R5/F1 list.

- [ ] **Step 6: Final gate**

```bash
./check.sh
```

Expected: **every** stage green, e2e included. Paste the summary line. This is the first point in the
plan where a red e2e tier is not acceptable.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add .
git commit -m "Update the e2e suite and docs for the review gate

extraction-ui polled for done, which the gate makes unreachable without a human;
it now drives the review UI. Corrects the AGENTS.md statements R2 falsified:
ribo-ui-react is no longer a stub, there is no Controller or ReviewPresenter to
justify the peer dependency, and cross-package test resolution is now proven in
the browser project."
```

---

## Open questions carried out of implementation

1. **`useRecorder` does not thread the recorder's context type `C`.** `RiboInstances.recorder` is
   `Recorder<Record<string, unknown>>`, so a capture resolved through the provider loses the host's
   `ctx` type. Fine for the playground (`new Recorder()` with `{}`), but F1's field app will attach a
   job id. Options when it matters: make `RiboProvider` generic in `C`, or have hosts pass their
   recorder to `useRecorder` explicitly. Not solved now because a generic provider infects every hook
   signature to serve one call site that does not exist yet.
2. **`useStoragePersistence` has no core counterpart** (design §8.1). If the playground's eviction
   detection should be shared, the right home is a headless core model beside `createConnectivity`.
3. **Whether `awaitingReview` deserves its own `WorkSafety` level** (design §8.2). Counted as
   `pending` for now.
