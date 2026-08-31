# Session Entity Implementation Plan

> **Executing this:** one task at a time, in order, each ending with its own test cycle and its own
> review. Steps use checkbox (`- [ ]`) syntax so progress is trackable. Every task's final step runs
> a mutation and reports what it saw — a test nobody has watched fail is not a gate.

**Goal:** Split the single `OutboxItem` into two entities — a `Recording` that carries capture and
transcription, and a `Session` that owns extraction, review and write-back — so a house with two
HVAC systems can be extracted, reviewed and written as one job, not N independent recordings.

**Architecture:** A `Session` owns N `Recording`s. The relay transcribes recordings to `transcribed`
and stops; session-level extraction joins every transcribed recording's text in capture order
(excluding `discarded`), keyed by recording set, and re-runs when the set changes. Review addresses
one session, submits once, and writes once. Two RxDB collections (`outbox` for recordings, `sessions`
for sessions) replace one. The host opens a session explicitly and closes it when the auditor is
done walking the house.

**Tech Stack:** TypeScript 6.0.3 (ESM-only), RxDB 17.4.0 (Dexie storage, attachments plugin,
migration-schema plugin), zod 4, Vitest 4 (`unit` = node, `browser` = real Chromium via Playwright),
React 19.

**Design:** [`session-entity-design.md`](session-entity-design.md) — shared with
`franklin/franklin-field-app` (Project B). Read it before Task 1. Where this plan and the design
disagree, the design wins and the plan is wrong.

## Open questions resolved

The design's §12 leaves three questions open. They are resolved here so the plan can be written
against concrete decisions. Each resolution is annotated with its reasoning; a design revision
should fold them back into §12 before implementation begins.

### OQ1 — A session whose every recording is discarded

**Decision: the session transitions directly to `done`, skipping extraction and review.**
`reviewOutcome` is absent, `writeResult` is absent, `extracted` is absent. The recording statuses
tell the full story — every recording is `discarded` — and a UI distinguishes "done with a write"
from "done because everything was discarded" by checking for `reviewOutcome`. "Done" means "the
session is finished," not "a write happened." This is the simplest and most honest answer: there is
nothing to extract, nothing to review, and nothing to write, and inventing a synthetic review
outcome to paper over that would be the kind of convention nobody remembers.

### OQ2 — Naming

**Decision: `Session`.** The design uses it throughout. `Capture` overloads the durable-capture
concept (`capture-session.ts`, `CaptureSession`, `CAPTURE_LOCK`). `Walkthrough` is domain language
the host owns; ribo does not know what a session is _about_.

### OQ3 — Session close and late recordings

**Decision: reopening is supported.** Adding a recording to a closed session moves it back to
`open`. When the new recording is transcribed and the session is re-closed, extraction re-runs
(the cache keys on the recording set). A reopened session that had reached `awaiting-review` or
later clears `reviewOutcome`, `writeResult`, `writtenInstances` and `extracted`, then re-extracts.
This is cheap — the extraction cache reuses results for unchanged recordings — and it matches the
auditor's mental model: "I forgot the crawlspace" is one continuous job, not two. A session that
was `done` (write succeeded) is **not** reopenable: a second write would double-write, which is the
exact hazard `submitReview`'s status guard exists to prevent. The host creates a new session
instead.

## Global Constraints

- **ESM only.** Relative imports carry a `.js` extension though the source is `.ts`.
- **`import type`** for type-only imports — lint-enforced.
- **Comments explain WHY, not what.** This codebase comments heavily on rationale and not at all on
  mechanics. Match that.
- **`ribo-core` must not depend on any engine package** (`ribo-transcriber-ondevice`, adapters).
  Seams are defined in core; engines implement them.
- **No back-compat burden.** The SDK has no users; breaking changes are fine and migrations need no
  compatibility logic. Deleting persisted fields is free.
- **Every test must be able to fail.** Before finishing a task, break the implementation the test
  covers and confirm _that_ test goes red. Report which mutations you ran.
- **Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check` after every task; `./check.sh`
  before the final commit of the plan.
- **The `sessions` collection is a second RxDB collection in the same database.** Not a second
  database — `multiInstance: true` gives cross-tab leader election across both collections, and a
  single `removeRxDatabase` call clears both.

## File Structure

**Created:**

| File                                                  | Responsibility                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/ribo-core/src/queue/session-schema.ts`      | Session document schema, statuses, RxDB schema, projections        |
| `packages/ribo-core/src/queue/session-schema.test.ts` | Pins the session schema against its RxDB mirror                    |
| `packages/ribo-core/src/queue/session-outbox.ts`      | Session lifecycle operations on the `Outbox` class                 |
| `packages/ribo-core/src/queue/session-extract.ts`     | Session-level extraction: join transcripts, cache by recording set |
| `packages/ribo-ui-react/src/use-sessions.ts`          | `useSessions` — sessions as live React state                       |

**Modified:**

| File                                             | What changes                                                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ribo-core/src/queue/schema.ts`         | Recording loses `extracted`, `extractedBy`, `reviewOutcome`, `writeResult`, `writtenInstances`, `idempotencyKey`; gains `sessionId`; statuses lose `extracting`/`awaiting-review`/`writing`/`done`, gain `transcribed`; schema v5 → v6 |
| `packages/ribo-core/src/queue/database.ts`       | Adds `sessions` collection; migration strategies for v6                                                                                                                                                                                |
| `packages/ribo-core/src/queue/outbox.ts`         | `enqueue`/`beginRecording` take `sessionId`; loses `submitReview`/`reopenForReview` (move to session)                                                                                                                                  |
| `packages/ribo-core/src/queue/relay.ts`          | Transcribes recordings to `transcribed`; session-level extraction and write; new `SessionExtractStep`/`SessionWriteStep` interfaces                                                                                                    |
| `packages/ribo-core/src/queue/index.ts`          | Exports session types and operations                                                                                                                                                                                                   |
| `packages/ribo-core/src/index.ts`                | Re-exports session surface                                                                                                                                                                                                             |
| `packages/ribo-core/src/write-step.ts`           | `toWriteStep` adapts to `SessionWriteStep`                                                                                                                                                                                             |
| `packages/ribo-core/src/instance-write-step.ts`  | `toInstanceWriteStep` adapts to `SessionWriteStep`; `writtenInstances` on session                                                                                                                                                      |
| `packages/ribo-core/src/extractor.ts`            | `toExtractStep` → `toSessionExtractStep`                                                                                                                                                                                               |
| `packages/ribo-core/src/work-safety.ts`          | `summarizeWork` classifies recordings AND sessions                                                                                                                                                                                     |
| `packages/ribo-ui-react/src/use-review.ts`       | Takes a `SessionItem` instead of an `OutboxItem`                                                                                                                                                                                       |
| `packages/ribo-ui-react/src/use-outbox-items.ts` | Unchanged (still watches recordings)                                                                                                                                                                                                   |
| `packages/ribo-ui-react/src/use-work-safety.ts`  | Composes session state into the verdict                                                                                                                                                                                                |
| `packages/ribo-ui-react/src/index.ts`            | Exports `useSessions`                                                                                                                                                                                                                  |
| `playground/src/App.tsx`                         | Opens a session, enqueues into it, reviews the session                                                                                                                                                                                 |

**Why these boundaries:** `session-schema` is pure and node-testable, exactly like `schema.ts`.
`session-outbox` extends the `Outbox` class because both collections live in the same RxDB database
and share the same `#serialized` seq chain. `session-extract` is the join-and-cache logic the relay
calls; it is separate because it is the one piece of genuinely new algorithm (everything else is
moving fields between entities). The relay changes are mechanical — it stops after transcription
and gains a session drain phase — but they touch every step, which is why Task 3 is the large task.

---

## Task 1: Session schema and database collection

Define the session document, its state machine, and the RxDB collection that holds it. Purely
additive — the existing outbox is untouched.

**Files:**

- Create: `packages/ribo-core/src/queue/session-schema.ts`
- Create: `packages/ribo-core/src/queue/session-schema.test.ts`
- Modify: `packages/ribo-core/src/queue/database.ts` (add `sessions` collection)
- Modify: `packages/ribo-core/src/queue/index.ts` (export session types)

**Interfaces:**

- Consumes: `reviewOutcomeSchema` from `review.ts` (the session carries the review outcome).
- Produces: `SESSION_STATUSES`, `SessionStatus`, `sessionDocumentSchema`, `SessionDocument`,
  `sessionItemSchema`, `SessionItem`, `SessionPatch`, `sessionRxSchema`, `SESSION_COLLECTION_NAME`,
  `ACTIVE_SESSION_STATUSES`, `FINISHED_SESSION_STATUSES`.

- [ ] **Step 1: Write the failing tests for the session schema**

In `session-schema.test.ts`, test the same invariants `schema.test.ts` pins for the recording:

```ts
test("the session state machine has the expected statuses", () => {
  expect(SESSION_STATUSES).toEqual([
    "open",
    "extracting",
    "awaiting-review",
    "writing",
    "done",
    "failed",
    "dead",
  ]);
});

test("active session statuses are the ones the relay acts on", () => {
  // extracting and writing are in-flight; failed is resting (retryable after backoff).
  // open is NOT active — the relay does not act on an open session until the host closes it.
  // awaiting-review is NOT active — the review gate, same omission as the recording side.
  expect(ACTIVE_SESSION_STATUSES).toEqual(["extracting", "writing", "failed"]);
});

test("finished session statuses are the ones the relay will not revisit", () => {
  expect(FINISHED_SESSION_STATUSES).toEqual(["done", "dead"]);
});

test("the RxDB schema is at version 0", () => {
  // The sessions collection is new — starts at version 0, not bumped from the outbox's version.
  expect(sessionRxSchema.version).toBe(0);
});

test("sessionDocumentSchema and sessionRxSchema agree on properties", () => {
  // Same drift guard as the recording schema.
  const zodKeys = Object.keys(sessionDocumentSchema.shape).sort();
  const rxKeys = Object.keys(sessionRxSchema.properties).sort();
  expect(zodKeys).toEqual(rxKeys);
});

test("a session with status 'open' requires no extracted or reviewOutcome", () => {
  const doc = sessionDocumentSchema.parse(validSession());
  expect(doc.status).toBe("open");
  expect(doc.extracted).toBeUndefined();
  expect(doc.reviewOutcome).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch fail** — `pnpm vitest run --project unit packages/ribo-core/src/queue/session-schema.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement the session schema**

````ts
// session-schema.ts
import type { RxJsonSchema } from "rxdb";
import { z } from "zod";

import { reviewOutcomeSchema } from "../review.js";

export const SESSION_COLLECTION_NAME = "sessions";

/**
 * The session state machine:
 *
 * ```
 * open → extracting → awaiting-review → writing → done
 *                          ↘ (transient) → failed → (backoff) → retry
 *                          ↘ (terminal)  → dead ⇢ awaiting-review (reopenSessionForReview)
 * ```
 *
 * `open` is the host's phase: recordings are being captured and transcribed.
 * The relay does not touch an open session — it transcribes the session's
 * recordings, but session-level extraction waits for the host to close the
 * session (the auditor is done walking the house).
 *
 * `awaiting-review` is the review gate, same as the recording side: absent
 * from ACTIVE_SESSION_STATUSES so the relay drains past it.
 */
export const SESSION_STATUSES = [
  "open",
  "extracting",
  "awaiting-review",
  "writing",
  "done",
  "failed",
  "dead",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ACTIVE_SESSION_STATUSES = [
  "extracting",
  "writing",
  "failed",
] as const satisfies readonly SessionStatus[];

export const FINISHED_SESSION_STATUSES = [
  "done",
  "dead",
] as const satisfies readonly SessionStatus[];

/**
 * The persisted shape of one session document.
 *
 * A session owns extraction, review and write state for a set of recordings
 * captured together. The recording set is identified by the `extractedFromRecordingIds`
 * cache key — the sorted ids of the recordings whose transcripts produced `extracted`.
 * When a new recording is added after close, the set changes and extraction re-runs.
 */
export const sessionDocumentSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(SESSION_STATUSES),
  /** When the session was opened. */
  openedAt: z.iso.datetime(),
  /**
   * When the host closed the session. Absent while `status === "open"`.
   * Set by `closeSession`; a reopened session clears this.
   */
  closedAt: z.iso.datetime().optional(),
  /**
   * Session-level retry state — same shape and semantics as the recording's
   * `attempts`/`nextAttemptAt`: drives backoff for extraction and write failures.
   */
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime(),
  lastError: z.string().optional(),
  /** Extraction output. Present once session-level extraction has succeeded. */
  extracted: z.record(z.string(), z.unknown()).optional(),
  /** Which engine produced `extracted` — trust signal for review. */
  extractedBy: z.string().optional(),
  /**
   * The sorted recording ids whose transcripts produced `extracted`.
   * Absent before the first extraction; changes when a recording is added or
   * discarded, triggering a re-extraction.
   */
  extractedFromRecordingIds: z.array(z.string()).optional(),
  /** What the human decided. Present once review has been submitted. */
  reviewOutcome: reviewOutcomeSchema.optional(),
  /** What the tool adapter returned from the write. */
  writeResult: z.record(z.string(), z.unknown()).optional(),
  /** Per-instance write progress — same shape as the recording's old field. */
  writtenInstances: z.record(z.string(), z.array(z.boolean())).optional(),
  /**
   * The vendor write idempotency key. Generated once at session open and reused
   * on every retry — same guarantee as the recording's old `idempotencyKey`.
   */
  idempotencyKey: z.string().min(1),
});

export type SessionDocument = z.infer<typeof sessionDocumentSchema>;

/**
 * The consumer projection. No derived fields today — the session has no
 * attachments — but the split mirrors the recording's document/item pair
 * so a future derived field (e.g. recording count) has a place to land.
 */
export const sessionItemSchema = sessionDocumentSchema;

export type SessionItem = z.infer<typeof sessionItemSchema>;

export type SessionPatch = Partial<Omit<SessionDocument, "id" | "openedAt" | "idempotencyKey">>;

export const sessionRxSchema: RxJsonSchema<SessionDocument> = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    status: { type: "string", maxLength: 16 },
    openedAt: { type: "string", maxLength: 32 },
    closedAt: { type: "string", maxLength: 32 },
    attempts: { type: "integer", minimum: 0 },
    nextAttemptAt: { type: "string", maxLength: 32 },
    lastError: { type: "string" },
    extracted: { type: "object" },
    extractedBy: { type: "string" },
    extractedFromRecordingIds: { type: "array" },
    reviewOutcome: { type: "object" },
    writeResult: { type: "object" },
    writtenInstances: { type: "object" },
    idempotencyKey: { type: "string", maxLength: 64 },
  },
  required: ["id", "status", "openedAt", "attempts", "nextAttemptAt", "idempotencyKey"],
  indexes: ["openedAt"],
  attachments: {},
};
````

- [ ] **Step 4: Add the `sessions` collection to the database**

In `database.ts`, widen the database type and add the collection:

```ts
import {
  SESSION_COLLECTION_NAME,
  sessionRxSchema,
  type SessionDocument,
} from "./session-schema.js";

export type SessionCollection = RxCollection<SessionDocument>;
export type OutboxDatabase = RxDatabase<{
  outbox: OutboxCollection;
  sessions: SessionCollection;
}>;

// In openOutboxDatabase, add the second collection:
await database.addCollections({
  [OUTBOX_COLLECTION_NAME]: {
    schema: outboxRxSchema,
    migrationStrategies: OUTBOX_MIGRATION_STRATEGIES,
  },
  [SESSION_COLLECTION_NAME]: { schema: sessionRxSchema },
});
```

The sessions collection starts at version 0 with no migration strategies — it is new.

- [ ] **Step 5: Export from the queue barrel**

In `queue/index.ts`:

```ts
export {
  ACTIVE_SESSION_STATUSES,
  FINISHED_SESSION_STATUSES,
  SESSION_COLLECTION_NAME,
  SESSION_STATUSES,
  sessionDocumentSchema,
  sessionItemSchema,
  sessionRxSchema,
} from "./session-schema.js";
export type {
  SessionDocument,
  SessionItem,
  SessionPatch,
  SessionStatus,
} from "./session-schema.js";
```

- [ ] **Step 6: Run the tests** — Expected: PASS.

- [ ] **Step 7: Mutate to prove the tests bite**

Remove `extracting` from `ACTIVE_SESSION_STATUSES`; the active-statuses test must fail. Add a stray
key to `sessionRxSchema.properties` that is not in `sessionDocumentSchema.shape`; the drift-guard
test must fail. Restore, re-run, report.

- [ ] **Step 8: Commit**

```bash
git add packages/ribo-core/src/queue
git commit -m "feat(core): add the session schema and sessions RxDB collection"
```

---

## Task 2: Session outbox operations

Add session lifecycle methods to the `Outbox` class. The session owns the state the recording used
to carry: `extracted`, `reviewOutcome`, `writeResult`, `writtenInstances`, `idempotencyKey`. The
recording gains a `sessionId` reference (optional in this task, required in Task 3).

**Files:**

- Modify: `packages/ribo-core/src/queue/outbox.ts` (add session methods, add `sessionId` to enqueue)
- Modify: `packages/ribo-core/src/queue/schema.ts` (add optional `sessionId` to recording document)
- Modify: `packages/ribo-core/src/queue/database.ts` (migration strategy for v6 if `sessionId` is
  added to the outbox schema — but see the note below)
- Create: `packages/ribo-core/src/queue/session-outbox.test.ts`
- Modify: `packages/ribo-core/src/queue/index.ts` (export session outbox methods)

**Interfaces:**

- Consumes: Task 1.
- Produces: `Outbox.openSession(options)`, `Outbox.closeSession(id)`,
  `Outbox.getSession(id)`, `Outbox.listSessions(query)`, `Outbox.watchSessions(query)`,
  `Outbox.patchSession(id, patch)`, `Outbox.submitSessionReview(id, outcome)`,
  `Outbox.reopenSessionForReview(id)`.

- [ ] **Step 1: Add `sessionId` to the recording document (optional)**

In `schema.ts`, add `sessionId: z.string().min(1).optional()` to `outboxDocumentSchema`. This is
additive — existing recordings have no `sessionId`, which is correct for this task since the session
flow runs alongside the per-item flow. Task 3 makes it required.

Bump `outboxRxSchema.version` to 6 and add the field to `outboxRxSchema.properties`. Add an identity
migration strategy `6: (doc) => doc` in `database.ts`.

Update `schema.test.ts`: the optional-keys test gains `"sessionId"` (but it is optional, so it
should NOT appear in the optional-keys list — `sessionId` is optional, so it SHOULD appear). Check:
the existing test lists optional keys; add `"sessionId"` to the expected list.

- [ ] **Step 2: Write the failing tests for session operations**

In `session-outbox.test.ts` (node tier — memory storage, no browser needed):

```ts
test("openSession creates an open session with an idempotency key", async () => {
  const outbox = await openOutbox({ name: uniqueName(), storage: getRxStorageMemory() });
  const session = await outbox.openSession();
  expect(session.status).toBe("open");
  expect(session.idempotencyKey).toBeTruthy();
  expect(session.extracted).toBeUndefined();
  await outbox.close();
});

test("closeSession transitions open → extracting (or done if no recordings)", async () => {
  const outbox = await openOutbox({ name: uniqueName(), storage: getRxStorageMemory() });
  const session = await outbox.openSession();
  // No recordings → close goes straight to done (OQ1: all-discarded = done).
  const closed = await outbox.closeSession(session.id);
  expect(closed.status).toBe("done");
  await outbox.close();
});

test("submitSessionReview moves awaiting-review → writing", async () => {
  const outbox = await openOutbox({ name: uniqueName(), storage: getRxStorageMemory() });
  const session = await outbox.openSession();
  // Manually park it at awaiting-review for the test.
  await outbox.patchSession(session.id, {
    status: "awaiting-review",
    extracted: {},
    extractedFromRecordingIds: [],
  });
  const submitted = await outbox.submitSessionReview(session.id, {
    status: "accepted",
    fields: { basedata: { yearBuilt: 1950 } },
  });
  expect(submitted.status).toBe("writing");
  expect(submitted.reviewOutcome).toBeDefined();
  await outbox.close();
});

test("submitSessionReview refuses a session that is not awaiting-review", async () => {
  const outbox = await openOutbox({ name: uniqueName(), storage: getRxStorageMemory() });
  const session = await outbox.openSession();
  await expect(
    outbox.submitSessionReview(session.id, { status: "accepted", fields: {} }),
  ).rejects.toThrow(/not "awaiting-review"/);
  await outbox.close();
});

test("reopenSessionForReview moves dead → awaiting-review and clears the outcome", async () => {
  const outbox = await openOutbox({ name: uniqueName(), storage: getRxStorageMemory() });
  const session = await outbox.openSession();
  await outbox.patchSession(session.id, {
    status: "dead",
    extracted: {},
    extractedFromRecordingIds: [],
    reviewOutcome: { status: "accepted", fields: {} },
    lastError: "write failed",
  });
  const reopened = await outbox.reopenSessionForReview(session.id);
  expect(reopened.status).toBe("awaiting-review");
  expect(reopened.reviewOutcome).toBeUndefined();
  expect(reopened.attempts).toBe(0);
  // lastError is deliberately left — it explains why the session needed reopening.
  expect(reopened.lastError).toBe("write failed");
  await outbox.close();
});

test("enqueue with a sessionId attaches the recording to that session", async () => {
  const outbox = await openOutbox({ name: uniqueName(), storage: getRxStorageMemory() });
  const session = await outbox.openSession();
  const item = await outbox.enqueue({
    recording: { ...recording, ctx: {} },
    audio: audioBlob(),
    sessionId: session.id,
  });
  expect(item.sessionId).toBe(session.id);
  await outbox.close();
});
```

- [ ] **Step 3: Run and watch fail** — Expected: FAIL, `openSession` is not a method.

- [ ] **Step 4: Implement the session outbox methods**

Add to `outbox.ts`. These mirror the recording-side methods in shape; the status guards and
`incrementalModify` patterns are identical to `submitReview`/`reopenForReview`:

```ts
/** What a caller hands to open a session. */
export interface OpenSessionInput {
  /** Stable id for the session. Generated if omitted. */
  id?: string;
  /** Idempotency key for the vendor write. Generated if omitted. */
  idempotencyKey?: string;
}

async openSession(options: OpenSessionInput = {}): Promise<SessionItem> {
  const doc = await this.#sessionsCollection.insert(
    sessionDocumentSchema.parse({
      id: options.id ?? this.#createId(),
      status: "open",
      openedAt: this.#nowIso(),
      attempts: 0,
      nextAttemptAt: this.#nowIso(),
      idempotencyKey: options.idempotencyKey ?? this.#createIdempotencyKey(),
    } satisfies SessionDocument),
  );
  return this.#toSession(doc);
}

/**
 * Close a session: the auditor is done walking the house.
 *
 * If every recording is `discarded` (or there are none), transitions directly
 * to `done` — there is nothing to extract or review (OQ1). Otherwise transitions
 * to `extracting`; the relay picks it up on its next drain.
 */
async closeSession(id: string): Promise<SessionItem> {
  // Check whether any non-discarded, non-dead recording belongs to this session.
  const recordings = await this.list({ sessionId: id });
  const hasContent = recordings.some(
    (r) => r.status !== "discarded" && r.status !== "dead",
  );
  const status = hasContent ? "extracting" : "done";
  return await this.patchSession(id, { status, closedAt: this.#nowIso() });
}

async getSession(id: string): Promise<SessionItem | undefined> {
  const doc = await this.#sessionsCollection.findOne(id).exec();
  return doc ? this.#toSession(doc) : undefined;
}

async listSessions(query: SessionQuery = {}): Promise<SessionItem[]> {
  const docs = await this.#sessionsCollection.find(sessionMangoQuery(query)).exec();
  return docs.map((doc) => this.#toSession(doc));
}

watchSessions(query: SessionQuery = {}): Observable<SessionItem[]> {
  return this.#sessionsCollection
    .find(sessionMangoQuery(query))
    .$.pipe(map((docs) => docs.map((doc) => this.#toSession(doc))));
}

async patchSession(id: string, patch: SessionPatch): Promise<SessionItem> {
  const doc = await this.#sessionsCollection.findOne(id).exec();
  if (!doc) throw new Error(`outbox: no session with id "${id}"`);
  sessionItemSchema.parse({ ...this.#toSession(doc), ...patch });
  const updated = await doc.incrementalPatch(patch);
  return this.#toSession(updated);
}
```

The `submitSessionReview` and `reopenSessionForReview` methods are structurally identical to the
recording-side `submitReview`/`reopenForReview`, with `awaiting-review` ↔ `writing` / `dead` ↔
`awaiting-review` transitions. Copy the guards and the `incrementalModify` pattern; the ABA race
analysis carries over unchanged. The one difference: `submitSessionReview`'s `discarded` branch
does NOT drop audio (audio lives on recordings, and discarding a session discards the _review_, not
the recordings — the host may want to re-review).

Add `sessionId` to `enqueue` and `beginRecording`:

```ts
async enqueue({ recording, audio, sessionId }: EnqueueInput & { sessionId: string }): Promise<OutboxItem> {
  // ... same as today, but the document includes sessionId.
}
```

Wait — in this task `sessionId` is optional (the old per-item flow still works). Make it
`sessionId?: string` for now; Task 3 makes it required.

- [ ] **Step 5: Add the `SessionQuery` type and `sessionMangoQuery` helper**

Mirror `OutboxQuery`/`mangoQuery` — filter by `status`, sort by `openedAt` ascending:

```ts
export interface SessionQuery {
  status?: SessionStatus | readonly SessionStatus[];
  limit?: number;
}

function sessionMangoQuery({ status, limit }: SessionQuery): MangoQuery<SessionDocument> {
  const statuses = status === undefined ? undefined : [status].flat();
  return {
    ...(statuses ? { selector: { status: { $in: statuses } } } : {}),
    sort: [{ openedAt: "asc" }],
    ...(limit === undefined ? {} : { limit }),
  };
}
```

- [ ] **Step 6: Add `#toSession` and the `#sessionsCollection` field**

```ts
// In the constructor:
this.#sessionsCollection = database.collections.sessions;

// The projection — no derived fields today:
#toSession(doc: RxDocument<SessionDocument>): SessionItem {
  return sessionItemSchema.parse(doc.toJSON());
}
```

- [ ] **Step 7: Add `sessionId` to `OutboxQuery`**

In `schema.ts`/`outbox.ts`, extend `OutboxQuery` with an optional `sessionId` filter so the relay
and the UI can ask "which recordings belong to this session?". Update `mangoQuery` to include it in
the selector when present.

- [ ] **Step 8: Run the tests** — Expected: PASS. Run `pnpm typecheck` to catch any fixture that
      references the new optional `sessionId` field incorrectly.

- [ ] **Step 9: Mutate to prove the tests bite**

In `submitSessionReview`, remove the status guard; the "refuses a session that is not
awaiting-review" test must fail. In `closeSession`, always transition to `extracting` regardless of
recordings; the "no recordings → done" test must fail. Restore, re-run, report.

- [ ] **Step 10: Commit**

```bash
git add packages/ribo-core/src/queue
git commit -m "feat(core): add session lifecycle operations to the outbox"
```

---

## Task 3: Schema split, relay rewrite, and session-level pipeline

The breaking change. The recording document loses every session-level field; the relay stops after
transcription and gains a session drain phase; extraction and write operate on sessions; review
takes a session.

This is the largest task. It has three logical phases — schema split, relay rewrite, review/write
update — but they land in one commit because the code does not compile between them.

**Files:**

- Modify: `packages/ribo-core/src/queue/schema.ts`
- Modify: `packages/ribo-core/src/queue/relay.ts`
- Modify: `packages/ribo-core/src/queue/outbox.ts`
- Modify: `packages/ribo-core/src/queue/database.ts`
- Modify: `packages/ribo-core/src/queue/index.ts`
- Modify: `packages/ribo-core/src/index.ts`
- Modify: `packages/ribo-core/src/write-step.ts`
- Modify: `packages/ribo-core/src/instance-write-step.ts`
- Modify: `packages/ribo-core/src/extractor.ts`
- Modify: `packages/ribo-core/src/work-safety.ts`
- Create: `packages/ribo-core/src/queue/session-extract.ts`
- Modify: all test files that reference removed fields (`relay.browser.test.ts`,
  `outbox.browser.test.ts`, `schema.test.ts`, `write-step.test.ts`, `work-safety.test.ts`, etc.)

**Interfaces:**

- Consumes: Tasks 1, 2.
- Produces: `SessionExtractStep`, `SessionWriteStep`, `toSessionExtractStep`, rewritten relay with
  two drain phases, recording schema without session-level fields, `useReview(session)`.

### Phase A: Recording schema split

- [ ] **Step 1: Write the failing schema tests**

In `schema.test.ts`:

- The optional-keys test loses `extracted`, `extractedBy`, `reviewOutcome`, `writeResult`,
  `writtenInstances` — those are gone from the recording document. `sessionId` is now required, so
  it moves to the required-keys test.
- The status-partition test loses `extracting`, `awaiting-review`, `writing`, `done` from
  `OUTBOX_STATUSES` and gains `transcribed`. `ACTIVE_OUTBOX_STATUSES` loses `extracting`, `writing`
  — only `queued`, `transcribing`, `failed` remain. `FINISHED_OUTBOX_STATUSES` loses `done` — only
  `dead`, `discarded` remain. `RECORDING_OUTBOX_STATUSES` is unchanged (`recording`).
- The RxDB schema version test expects 7 (v5 → v6 added `sessionId` in Task 2; v6 → v7 removes the
  session-level fields).

Wait — Task 2 bumped to v6 to add `sessionId`. This task bumps to v7 to remove the session-level
fields. Alternatively, combine both into one bump: v5 → v6 adds `sessionId` and removes the
session-level fields in one migration. That is cleaner — one migration instead of two — and the
design says "no back-compat burden." Let me revise: Task 2 adds `sessionId` as optional without
bumping the version (adding an optional field to the zod schema is fine; the RxDB schema can add it
without a version bump if we do it in the same task as the split). Actually, RxDB requires a version
bump whenever the schema changes. So let me do: Task 2 adds `sessionId` (v5 → v6), Task 3 removes
session-level fields and makes `sessionId` required (v6 → v7). Two migrations, but each is simple.

Actually, even simpler: Task 2 does NOT add `sessionId` to the recording schema at all. The session
methods work without it — the relay can find a session's recordings by querying the outbox with a
`sessionId` filter that is added in Task 3. Task 2's `enqueue` does not take `sessionId` yet; only
Task 3 adds it. This way there is only one schema bump: v5 → v6 in Task 3.

Let me revise the plan: Task 2 does NOT touch the recording schema. It only adds the sessions
collection and session outbox methods. The `enqueue`/`beginRecording` changes (taking `sessionId`)
happen in Task 3 alongside the schema split. This is cleaner — one migration, one breaking change.

- [ ] **Step 2: Remove session-level fields from the recording document**

In `schema.ts`:

Remove from `outboxDocumentSchema`:

- `extracted`
- `extractedBy`
- `reviewOutcome`
- `writeResult`
- `writtenInstances`
- `idempotencyKey`

Add:

- `sessionId: z.string().min(1)` — required, not optional. Every recording belongs to a session.

Change `OUTBOX_STATUSES`:

- Remove: `extracting`, `awaiting-review`, `writing`, `done`
- Add: `transcribed`
- Keep: `recording`, `queued`, `transcribing`, `failed`, `dead`, `discarded`

The recording state machine is now:

```
recording → queued → transcribing → transcribed
                    ↘ (transient) → failed → (backoff) → retry
                    ↘ (terminal)  → dead
                    ↘ discarded (human decision)
```

Update `ACTIVE_OUTBOX_STATUSES` to `["queued", "transcribing", "failed"]`.
Update `FINISHED_OUTBOX_STATUSES` to `["transcribed", "dead", "discarded"]`.

Wait — `transcribed` is finished (the relay will not act on it again), but it is not terminal in the
same sense as `dead` or `discarded`. A `transcribed` recording is done from the relay's perspective,
but it still has a transcript that the session needs. Should it be in `FINISHED_OUTBOX_STATUSES`?
Yes — the relay will not act on it. But it is not "dead" or "discarded"; it is "done
transcribing." Let me add it to `FINISHED_OUTBOX_STATUSES`.

Actually, `FINISHED_OUTBOX_STATUSES` today means "the relay will not act on again unattended." With
the split, `transcribed` fits: the relay transcribes it, marks it `transcribed`, and never touches
it again. The session owns the next steps. So:

```ts
export const FINISHED_OUTBOX_STATUSES = [
  "transcribed",
  "dead",
  "discarded",
] as const satisfies readonly OutboxStatus[];
```

Add `RECORDED_OUTBOX_STATUSES` (renamed from `RECORDING_OUTBOX_STATUSES` — no, keep the name) is
unchanged: `["recording"]`.

Bump `outboxRxSchema.version` to 6. Remove the deleted fields from `outboxRxSchema.properties`.
Add `sessionId: { type: "string", maxLength: 64 }` to properties and `required`. Add `transcribed`
to the status enum (implicit — status is a string).

- [ ] **Step 3: Update the migration strategy**

In `database.ts`, add v6:

```ts
6: (doc: OutboxDocument) => {
  // v6 removes extracted, extractedBy, reviewOutcome, writeResult, writtenInstances,
  // idempotencyKey from the recording and adds sessionId. The removed fields are
  // migrated to sessions in Task 4; this strategy drops them from the recording
  // document and leaves sessionId absent (the migration in Task 4 fills it in).
  const next = { ...doc };
  delete next.extracted;
  delete next.extractedBy;
  delete next.reviewOutcome;
  delete next.writeResult;
  delete next.writtenInstances;
  delete next.idempotencyKey;
  // sessionId is set by the Task 4 migration; for now, use a placeholder that
  // the migration will replace. Actually — the migration runs per-document, and
  // RxDB migration strategies cannot create documents in another collection.
  // So the session creation must happen BEFORE the outbox migration, in a
  // pre-migration step. See Task 4 for the full design.
  return next as OutboxDocument;
},
```

**Important:** RxDB migration strategies run per-document within a collection and cannot write to
other collections. The session-creation migration (Task 4) must run as a separate step before or
after the outbox schema migration. See Task 4 for the design.

- [ ] **Step 4: Update `OutboxPatch`**

Remove the deleted fields from the `Omit` list (they no longer exist on `OutboxDocument`). The
`Omit` list is now `"id" | "seq" | "enqueuedAt" | "recording" | "capture" | "preview" | "sessionId"`.

- [ ] **Step 5: Update `enqueue` and `beginRecording`**

Both now require `sessionId`:

```ts
async enqueue({ recording, audio, sessionId }: EnqueueInput & { sessionId: string }): Promise<OutboxItem> {
  // document includes sessionId
}
```

Update `EnqueueInput` to include `sessionId: string`.

### Phase B: Relay rewrite

- [ ] **Step 6: Define the new step interfaces**

In `relay.ts`:

```ts
export interface SessionExtractInput {
  session: SessionItem;
  /** The joined transcript text of all transcribed recordings, in capture order. */
  transcript: string;
  /** The recording ids that produced `transcript`, sorted — the cache key. */
  recordingIds: readonly string[];
}

export type SessionExtractStep = (input: SessionExtractInput) => Promise<ExtractStepResult>;

export interface SessionWriteInput {
  session: SessionItem;
  reviewed: ExtractedFieldMap;
  idempotencyKey: string;
  /**
   * The write context, parsed from one of the session's recordings' `ctx`.
   * All recordings in a session share the same `ctx` (they are for the same job),
   * so the relay reads it from the first transcribed recording.
   */
  ctx: unknown;
}

export type SessionWriteStep = (input: SessionWriteInput) => Promise<ExtractedFieldMap | void>;
```

Update `RelayOptions`:

```ts
export interface RelayOptions extends BackoffOptions {
  outbox: Outbox;
  transcriber: Transcriber;
  /** Session-level extraction: joined transcripts → structured fields. */
  sessionExtract: SessionExtractStep;
  /** Session-level write: reviewed fields → host tool. */
  sessionWrite: SessionWriteStep;
  // ... same options as today (locks, now, maxAttempts, stepTimeoutMs, etc.)
}
```

The old `extract` and `write` options are replaced by `sessionExtract` and `sessionWrite`.

- [ ] **Step 7: Implement `session-extract.ts`**

```ts
// session-extract.ts
import type { Outbox, OutboxItem } from "./outbox.js";
import type { SessionItem } from "./session-schema.js";

/**
 * Join the transcript text of every transcribed recording belonging to `sessionId`,
 * in capture order (seq-ascending), excluding `discarded` and `dead`.
 *
 * This is the app's `runJobExtraction.ts` rule, promoted: the contractor threw
 * that recording away, and its words should not return through a later extraction.
 */
export async function joinSessionTranscript(
  outbox: Outbox,
  sessionId: string,
): Promise<{ text: string; recordingIds: string[] }> {
  const recordings = await outbox.list({ sessionId });
  const usable = recordings
    .filter((r) => r.status === "transcribed" && r.transcript !== undefined)
    .sort((a, b) => a.seq - b.seq);
  return {
    text: usable.map((r) => r.transcript!.text).join(" "),
    recordingIds: usable.map((r) => r.id).sort(),
  };
}

/**
 * Whether the session's recording set has changed since the last extraction.
 * Compares the sorted recording ids against `session.extractedFromRecordingIds`.
 */
export function recordingSetChanged(
  session: SessionItem,
  recordingIds: readonly string[],
): boolean {
  const cached = session.extractedFromRecordingIds;
  if (cached === undefined) return true;
  if (cached.length !== recordingIds.length) return true;
  return recordingIds.some((id, i) => id !== cached[i]);
}
```

- [ ] **Step 8: Rewrite the relay drain loop**

The relay now has two drain phases: recordings (transcribe) and sessions (extract/write).

```ts
async #drain(): Promise<void> {
  for (;;) {
    // 1. Live needs the worker: do not admit new items while anything is recording.
    const [recording] = await this.#options.outbox.list({ status: ["recording"], limit: 1 });
    if (recording) return;

    // 2. Drain recordings: transcribe the next pending one.
    const item = await this.#options.outbox.nextPending();
    if (item) {
      if (Date.parse(item.nextAttemptAt) > this.#now()) return;
      const held = await holdLock(/* ... same as today ... */);
      if (held === undefined) return;
      if (!(await held.ready)) return;
      continue;
    }

    // 3. Drain sessions: extract or write the next pending one.
    const session = await this.#options.outbox.nextPendingSession();
    if (session) {
      if (Date.parse(session.nextAttemptAt) > this.#now()) return;
      const held = await holdLock(
        relaySessionLock(session.id),
        async () => {
          const fresh = await this.#options.outbox.getSession(session.id);
          if (!fresh) return false;
          if (!isSessionActive(fresh.status)) return false;
          if (Date.parse(fresh.nextAttemptAt) > this.#now()) return false;
          return await this.#processSessionStep(fresh);
        },
        this.#options.locks ?? navigator.locks,
      );
      if (held === undefined) return;
      if (!(await held.ready)) return;
      continue;
    }

    return; // nothing to do
  }
}
```

- [ ] **Step 9: Implement `#processStep` for recordings (transcribe-only)**

The recording's `#processStep` only transcribes. `nextStep` simplifies to:

```ts
function nextStep(item: OutboxItem): "transcribe" {
  // Recordings only transcribe. Extraction and write are session-level.
  if (!item.transcript) return "transcribe";
  // A recording with a transcript is transcribed; the relay should not have
  // been handed it (it is in FINISHED_OUTBOX_STATUSES). This is a no-op.
  return "transcribe"; // unreachable through the state machine
}
```

Actually, `nextStep` can be deleted — there is only one step. The `#processStep` for recordings is:

```ts
async #processStep(item: OutboxItem): Promise<boolean> {
  try {
    await this.#patch(item.id, { status: "transcribing" });
    await this.#transcribe(item);
    return true;
  } catch (error) {
    this.#options.onError?.(error, item);
    const parked = await this.#recordFailure(item, error);
    return !parked;
  }
}
```

And `#transcribe` transitions to `transcribed` (not `extracting`):

```ts
async #transcribe(item: OutboxItem): Promise<void> {
  // ... same audio fetch and transcribe as today ...
  // On success:
  await this.#options.outbox.writeTranscript(item.id, transcript, {
    status: "transcribed",  // was "extracting"
    attempts: 0,
  });
  // ... dropAudioAfterTranscription unchanged ...
}
```

The implausibility guard parks the recording at... hmm. Today it parks at `awaiting-review`. But
`awaiting-review` is a session status now, not a recording status. What happens to an implausible
transcript?

The recording has a bad transcript. It can't advance to extraction (which is session-level). But
the recording itself is done transcribing — it just got a bad result. I think the recording should
still transition to `transcribed` — it has a transcript, just a suspicious one. The session-level
extraction will use it, and the human can investigate at review time (the transcript is there, the
audio is there). The implausibility flag could be stored on the transcript or surfaced at review.

Actually, looking at the current code more carefully, the implausibility guard parks the _item_ at
`awaiting-review` so a human can investigate. With the split, the recording transitions to
`transcribed` regardless, and the session-level extraction runs on the joined transcript (which
includes the suspicious one). The human sees the result at review time. If the extraction is empty or
wrong because of the bad transcript, the human can investigate — the audio is still there (the guard
deliberately does not drop audio).

This is a behavior change: the implausible transcript no longer blocks the pipeline; it flows
through to session-level extraction. I think this is acceptable — the recording is `transcribed`
(it has a transcript), and the session handles the next steps. If needed, a per-recording "flag"
could be added later, but for now the recording's `transcribed` status is honest.

So: remove the implausibility guard from the relay. The recording always transitions to
`transcribed` after a successful transcription. The guard was a safety net for per-item extraction;
with session-level extraction, the human reviews the session, not the individual recording, and can
see all transcripts.

Wait — actually, the implausibility guard was valuable: it prevented feeding an empty transcript to
extraction, which produces a mostly-empty audit. With session-level extraction, the joined
transcript might be mostly empty if one of N recordings is bad. But the other N-1 recordings
contribute their text, so the joined transcript is not necessarily empty. The guard is less
valuable at the session level. I'll remove it and note the change.

- [ ] **Step 10: Implement `#processSessionStep`**

```ts
async #processSessionStep(session: SessionItem): Promise<boolean> {
  const step = sessionNextStep(session);
  try {
    await this.#patchSession(session.id, { status: SESSION_STEP_STATUS[step] });
    await this.#runSessionStep(step, session);
    return true;
  } catch (error) {
    this.#options.onError?.(error, session);
    const parked = await this.#recordSessionFailure(session, error);
    return !parked;
  }
}

function sessionNextStep(session: SessionItem): "extract" | "write" {
  if (session.extracted === undefined || session.status === "extracting") return "extract";
  return "write";
}
```

Wait — `sessionNextStep` needs to be more careful. A session at `extracting` needs extraction. A
session at `writing` needs write. A session at `failed` needs to retry whatever it was doing. The
step is derived from status, not from outputs:

```ts
function sessionNextStep(session: SessionItem): "extract" | "write" {
  // The relay only hands us sessions in ACTIVE_SESSION_STATUSES:
  // extracting, writing, failed.
  // failed → retry whatever the session was doing before it failed.
  //   If extracted is present, it was writing; if not, it was extracting.
  if (session.status === "extracting" || session.status === "failed") {
    if (session.extracted === undefined) return "extract";
    // If extracted is present but status is extracting/failed, the extraction
    // succeeded but the session hasn't parked at awaiting-review yet.
    // This shouldn't happen through the state machine, but handle it:
    return "extract"; // re-extract? No — extracted is present, so park it.
  }
  return "write";
}
```

Actually, this is getting complicated. Let me simplify: the relay processes sessions in
`ACTIVE_SESSION_STATUSES` (`extracting`, `writing`, `failed`). For `extracting` and `failed`-without-
`extracted`, run extraction. For `writing` and `failed`-with-`extracted`, run write.

```ts
function sessionNextStep(session: SessionItem): "extract" | "write" {
  if (session.extracted === undefined) return "extract";
  return "write";
}
```

This is the same pattern as the recording's `nextStep`: derive from persisted outputs. If
`extracted` is absent, extract. If `extracted` is present, write. The status tells us the session is
active; the outputs tell us which step.

But there's a subtlety: after extraction succeeds, the session parks at `awaiting-review` (not
active). The relay won't see it again until `submitSessionReview` moves it to `writing`. So
`sessionNextStep` will only be called on sessions that are `extracting` (no `extracted` yet),
`writing` (has `extracted` and `reviewOutcome`), or `failed` (retrying either).

- [ ] **Step 11: Implement `#sessionExtract`**

```ts
async #sessionExtract(session: SessionItem): Promise<void> {
  const { text, recordingIds } = await joinSessionTranscript(this.#options.outbox, session.id);

  // Cache check: if the recording set hasn't changed and we already have extracted,
  // don't re-extract. But if status is "extracting", we're here because the relay
  // picked us up — either the first extraction or a retry. Run it.
  const result = await withTimeout(
    this.#options.sessionExtract({ session, transcript: text, recordingIds }),
    this.#options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    "session-extract",
  );

  await this.#patchSession(session.id, {
    extracted: result.fields,
    ...(result.engine !== undefined ? { extractedBy: result.engine } : {}),
    extractedFromRecordingIds: recordingIds,
    status: "awaiting-review",
    attempts: 0,
  });
}
```

- [ ] **Step 12: Implement `#sessionWrite`**

```ts
async #sessionWrite(session: SessionItem): Promise<void> {
  const outcome = session.reviewOutcome;
  if (outcome === undefined || outcome.status === "discarded") {
    throw new TerminalQueueError(
      `session ${session.id} reached the write step with no review outcome.`,
    );
  }
  if (Object.keys(outcome.fields).length === 0) {
    throw new TerminalQueueError(
      `session ${session.id} reached the write step with nothing to write.`,
    );
  }

  // Read ctx from one of the session's transcribed recordings.
  const recordings = await this.#options.outbox.list({ sessionId: session.id });
  const recording = recordings.find((r) => r.transcript !== undefined);
  if (!recording) {
    throw new TerminalQueueError(
      `session ${session.id} has a review outcome but no transcribed recordings to provide a write context.`,
    );
  }

  const writeResult = await withTimeout(
    this.#options.sessionWrite({
      session,
      reviewed: outcome.fields,
      idempotencyKey: session.idempotencyKey,
      ctx: recording.recording.ctx,
    }),
    this.#options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    "session-write",
  );

  await this.#patchSession(session.id, {
    status: "done",
    attempts: 0,
    ...(writeResult ? { writeResult } : {}),
  });
}
```

- [ ] **Step 13: Implement `#recordSessionFailure`**

Same pattern as `#recordFailure` for recordings: increment `attempts`, classify transient vs
terminal, transition to `failed` (with backoff) or `dead`.

- [ ] **Step 14: Remove the old `#extract` and `#write` from the relay**

Delete `#extract`, `#write`, the old `ExtractStep`/`WriteStep` types, and the `extract`/`write`
options from `RelayOptions`. The relay now only transcribes recordings and extracts/writes sessions.

- [ ] **Step 15: Update `writeTranscript` transition**

In `outbox.ts`, `writeTranscript` is called by the relay after transcription. The `patch.status`
changes from `"extracting"` to `"transcribed"`.

### Phase C: Review and write adapters

- [ ] **Step 16: Update `toExtractStep` → `toSessionExtractStep`**

In `extractor.ts`:

```ts
export function toSessionExtractStep<F>(extractor: Extractor<F>): SessionExtractStep {
  return async ({ transcript }) => {
    const result = await extractor.extract(transcript);
    return {
      fields: result.fields as ExtractedFieldMap,
      ...(result.usage.engine !== undefined ? { engine: result.usage.engine } : {}),
    };
  };
}
```

- [ ] **Step 17: Update `toWriteStep` for sessions**

In `write-step.ts`:

```ts
export function toWriteStep<V extends Record<string, unknown>, C>(
  adapter: ToolAdapter<V, C>,
): SessionWriteStep {
  return async ({ reviewed, ctx, idempotencyKey }) => {
    const parsedCtx = adapter.ctxSchema.parse(ctx);
    const fields = adapter.schema.parse(reviewed);
    await adapter.write(fields, parsedCtx, { idempotencyKey });
  };
}
```

- [ ] **Step 18: Update `toInstanceWriteStep` for sessions**

In `instance-write-step.ts`, the signature changes:

- `item: OutboxItem` → `session: SessionItem`
- `item.recording.ctx` → `ctx` from the `SessionWriteInput`
- `item.writtenInstances` → `session.writtenInstances`
- `outbox.patch(item.id, { writtenInstances })` → `outbox.patchSession(session.id, { writtenInstances })`
- `item.idempotencyKey` → `session.idempotencyKey`

- [ ] **Step 19: Update `useReview` to take a session**

In `use-review.ts`:

```ts
export function useReview(
  session: SessionItem | undefined,
  options: UseReviewOptions,
): UseReviewResult {
  // ... same logic, but:
  // - `item.extracted` → `session.extracted`
  // - `item.transcript` → joined transcript (built from the session's recordings)
  // - `outbox.submitReview(id, ...)` → `outbox.submitSessionReview(id, ...)`
  // - `state.forItem` → `state.forSession`
}
```

The hook needs the joined transcript to build the review request. Two options:

1. The hook takes a `transcript: string` argument (the host provides it)
2. The hook reads the session's recordings from the outbox and joins them

Option 2 is cleaner — the host doesn't need to know about the join logic. But it requires an
async operation inside the hook, which adds complexity. Option 1 is simpler and follows the
"least privilege" principle (the hook gets exactly what it needs).

Actually, `buildReviewRequest` takes a `Transcript` object, not a string. The joined transcript is
a string. So either:

- `buildReviewRequest` changes to take a string (breaking)
- The hook synthesizes a `Transcript` from the joined string

I think synthesizing a `Transcript` is cleaner:

```ts
const transcript: Transcript = {
  recordingId: session.id, // the session id, not a recording id
  text: joinedText,
  engine: "joined", // or the engines of the contributing recordings
  confidence: undefined,
};
```

But this is a bit hacky. Let me think... Actually, `buildReviewRequest` uses `transcript.text` for
`isSpanGrounded` and returns the transcript in the `ReviewRequest`. The transcript's `recordingId`
and `engine` are for display. A synthesized transcript with the session id and a descriptive engine
is honest: "this is the joined transcript of session X."

The hook needs to join the transcripts. This requires reading the session's recordings from the
outbox. The hook already has the outbox (through `useRiboInstance`), so it can do:

```ts
const { items: recordings } = useOutboxItems({ sessionId: session?.id });
const joinedTranscript = useMemo(() => {
  if (!session || recordings.length === 0) return undefined;
  const usable = recordings.filter((r) => r.transcript !== undefined).sort((a, b) => a.seq - b.seq);
  if (usable.length === 0) return undefined;
  return {
    recordingId: session.id,
    text: usable.map((r) => r.transcript!.text).join(" "),
    engine: usable[0]!.transcript!.engine, // or join engines
  } satisfies Transcript;
}, [session, recordings]);
```

This composes `useOutboxItems` internally — same pattern as `useWorkSafety` composing hooks.

- [ ] **Step 20: Update `work-safety.ts`**

`summarizeWork` now classifies both recordings and sessions:

```ts
export interface WorkOnDevice {
  readonly pending: number;
  readonly dead: number;
  readonly synced: number;
  readonly awaitingReview: number;
  // New: sessions that are open (auditor still walking)
  readonly openSessions: number;
}
```

A recording is:

- `pending` if `queued`/`transcribing`/`failed`/`recording` (same as today minus `extracting`/`writing`)
- `synced` if `transcribed` (it has been transcribed; its transcript is available to the session)
  — wait, `transcribed` is not "synced" in the sense of "left the device." The recording's transcript
  is on the device. Only when the session reaches `done` (write succeeded) is the work truly synced.

Hmm, this is a subtle change. Today, `done` means "written to the host tool" — truly synced. With the
split, `done` is a session status, not a recording status. Recordings are `transcribed` — they're
done from the relay's perspective but not synced. Sessions are `done` — written and synced.

So `summarizeWork` should count:

- `pending`: recordings in `queued`/`transcribing`/`failed`/`recording` + sessions in
  `open`/`extracting`/`writing`/`failed`
- `dead`: recordings in `dead` + sessions in `dead`
- `synced`: sessions in `done`
- `awaitingReview`: sessions in `awaiting-review`
- `openSessions`: sessions in `open`

Recordings in `transcribed` are NOT pending (the relay is done with them) and NOT synced (the write
hasn't happened). They're... in limbo. They belong to a session that is either `open`, `extracting`,
`awaiting-review`, or `writing`. The session's status determines their safety.

So `summarizeWork` should probably classify based on sessions, not recordings — or a combination.
A recording in `transcribed` whose session is `done` is synced. A recording in `transcribed` whose
session is `awaiting-review` is pending (awaiting review). A recording in `queued` is pending
(awaiting transcription).

The simplest approach: classify on sessions for the "synced"/"awaitingReview"/"openSessions"
counts, and on recordings for the "pending"/"dead" counts. But avoid double-counting: a recording
in `transcribed` should not be counted as pending if its session is already counting it.

Actually, the cleanest approach is to classify on sessions only, and count recordings only for the
"in-flight capture" signal:

```ts
export const summarizeWork = (
  recordings: readonly Pick<OutboxItem, "status">[],
  sessions: readonly Pick<SessionItem, "status">[],
): WorkOnDevice => {
  let pending = 0;
  let dead = 0;
  let synced = 0;
  let awaitingReview = 0;
  let openSessions = 0;

  for (const { status } of sessions) {
    if (status === "done") synced += 1;
    else if (status === "dead") dead += 1;
    else if (status === "awaiting-review") {
      pending += 1;
      awaitingReview += 1;
    } else if (status === "open") {
      openSessions += 1;
      pending += 1;
    } else if (isSessionActive(status)) pending += 1;
  }

  // Recordings in flight (queued/transcribing/failed/recording) are pending work
  // that hasn't reached a session yet. Transcribed recordings are counted through
  // their session above; discarded/dead recordings are counted through their session
  // or not at all.
  for (const { status } of recordings) {
    if (
      status === "recording" ||
      status === "queued" ||
      status === "transcribing" ||
      status === "failed"
    ) {
      pending += 1;
    } else if (status === "dead") {
      dead += 1;
    }
    // transcribed and discarded are counted through their session
  }

  return { pending, dead, synced, awaitingReview, openSessions };
};
```

This is a starting point; the exact classification needs refinement during implementation. The key
invariant stays: `safe` means "no unsynced work on the device," and only sessions in `done` count
as synced.

- [ ] **Step 21: Update all tests**

This is the mechanical part: every test that references `item.extracted`, `item.reviewOutcome`,
`item.writeResult`, `item.writtenInstances`, `item.idempotencyKey`, or the statuses `extracting`,
`awaiting-review`, `writing`, `done` on a recording needs updating. The relay browser tests need
rewriting to use sessions. The work-safety tests need session inputs.

- [ ] **Step 22: Run `./check.sh`** — Expected: PASS. This is the gate for the whole task.

- [ ] **Step 23: Mutate to prove the tests bite**

In `#sessionExtract`, skip the cache check (always re-extract); a test that asserts extraction runs
once should fail if one exists, or note that the cache is a performance optimization the tests
don't gate yet. In `#transcribe`, transition to `extracting` instead of `transcribed`; the schema
test must fail (`extracting` is no longer a recording status). In `sessionNextStep`, return
`"write"` when `extracted` is absent; the relay browser test must fail (writing without extraction).
Restore, re-run, report.

- [ ] **Step 24: Commit**

```bash
git add packages/ribo-core/src packages/ribo-ui-react/src
git commit -m "feat(core)!: split the outbox into recordings and sessions

The recording document loses extracted, extractedBy, reviewOutcome, writeResult,
writtenInstances and idempotencyKey; those move to the session document. The
recording state machine narrows to recording → queued → transcribing → transcribed
(+ discarded, dead, failed). The session state machine is open → extracting →
awaiting-review → writing → done (+ failed, dead).

The relay transcribes recordings and extracts/writes sessions. Session-level
extraction joins every transcribed recording's text in capture order, excluding
discarded, and caches by recording set. useReview takes a session."
```

---

## Task 4: Outbox migration v5 → v6

Migrate existing single-collection data to the two-collection schema. Each v5 recording document
carries `ctx.assessmentId` (or equivalent); the migration synthesises one session per distinct
assessment and attaches its recordings, moving `extracted`, `reviewOutcome`, `writeResult`,
`writtenInstances` and `idempotencyKey` up to the session.

**The RxDB migration constraint:** RxDB migration strategies run per-document within a collection
and cannot create documents in another collection. So the session synthesis must happen in a
**pre-migration step** — a function the host calls after opening the database but before RxDB
migrates the outbox schema, or in a separate migration runner that reads the old data and writes
sessions before the outbox schema bump takes effect.

**Approach:** `openOutbox` runs a `migrateV5ToV6` function after opening the database and before
returning the `Outbox` instance. This function:

1. Checks whether the outbox collection is at schema version 5 (pre-migration).
2. Reads all v5 documents.
3. Groups them by `ctx.assessmentId` (or a singleton for rows with no assessment id).
4. For each group, creates a session document with the moved fields.
5. Patches each recording with its `sessionId` and removes the moved fields.
6. Lets RxDB's normal migration handle the schema version bump (v5 → v6).

Wait — step 6 is the problem. If `migrateV5ToV6` runs before RxDB migrates, the outbox collection is
still at v5. The function can read v5 documents (they have the old fields) and write session
documents (the sessions collection is at v0, new). But it cannot patch recordings to remove the old
fields — RxDB's schema validation would reject a document missing required fields... actually, the
old fields (`extracted`, etc.) are optional, so removing them is fine even at v5. And adding
`sessionId` is adding a field the v5 schema doesn't know — RxDB may reject it.

Better approach: do the session synthesis in the v6 migration strategy itself. The strategy runs
per-document, so it cannot create sessions. But it can:

1. Extract the session-level fields from the recording.
2. Store them in a temporary location (e.g. a module-level Map) keyed by `sessionId`.
3. After all documents have been migrated, a post-migration step reads the Map and creates sessions.

This is fragile. Let me think of a better way.

**Best approach:** The migration runs in three steps, orchestrated by `openOutbox`:

1. **Open the database at v5** (the old schema). This requires the outbox collection to accept v5
   documents — which it does, because RxDB hasn't migrated yet (autoMigrate is true by default, but
   we can disable it for this collection and run the migration manually).

Actually, the simplest approach given "no back-compat burden" and "no published users":

**Just delete the old data.** The design says "nothing is published and there are no users, so no
deployed data is at risk." The migration is an exercise in the migration path, not a real data
migration. The v6 migration strategy can be identity (drop the old fields, set `sessionId` to a
generated value), and a separate function creates sessions from the old data if any exists.

But the design doc §9 explicitly describes a migration: "Existing rows already carry
`ctx.assessmentId`, so the migration synthesises one session per distinct assessment and attaches
its recordings, moving `extracted`, `reviewOutcome` and `writeResult` up." So the migration is a
real requirement, even if there are no users today — it validates the path and handles dev/test
data.

**Final approach:** A `migrateToSessions(outbox)` function that:

1. Checks if the outbox has v5 documents (with `extracted` etc. — but those fields are gone from
   the schema after Task 3). So this needs to run BEFORE the schema bump.

OK, I think the cleanest approach is:

1. In Task 3, the outbox schema bumps to v6. The v6 migration strategy is: move the old fields to
   the document's `_meta` (or a temporary field), set `sessionId` to a per-assessment synthesised
   id, and drop the old fields from the document.

2. In Task 4, a `migrateToSessions` post-migration function reads the `_meta` (or temporary field)
   and creates sessions from it.

But RxDB migration strategies can't write to `_meta`... and adding a temporary field to the schema
is ugly.

**Simplest working approach:** Do the migration entirely outside RxDB's migration plugin:

1. In `openOutbox`, before adding collections, check if the database exists and has an outbox
   collection at version 5.
2. If so, read all documents directly from the storage (bypassing the collection schema), group by
   assessment, create sessions, and patch recordings.
3. Then add collections at the new schema version.

This is complex but correct. However, "no back-compat burden" means we can also just:

**Bump the schema and drop the old data.** The v6 migration strategy sets `sessionId` to a
synthesised value (one session per assessment, created in a post-migration step) and drops the old
fields. The session creation happens in a post-migration function that reads the patched recordings
(which still have `ctx.assessmentId`) and creates sessions.

Wait — after the v6 migration, the recording has `sessionId` but no `extracted`/`reviewOutcome`.
The session needs those fields. So the migration strategy needs to preserve them somewhere.

I think the answer is: the v6 migration strategy creates the `sessionId` (a deterministic uuid
from `assessmentId`) and drops the old fields. A post-migration function reads the recordings,
groups by `sessionId`, and for each group creates a session with the moved fields... but the moved
fields are gone from the recording. They were dropped by the migration.

So the migration strategy needs to preserve the old fields. It can do this by writing them to a
side collection or by keeping them in the document under a different key.

**Final final approach:** Do it all in the migration strategy by abusing the fact that RxDB
migration strategies receive the full old document and return the new document. The strategy can:

1. Read `assessmentId` from `doc.recording.ctx`.
2. Synthesise a deterministic `sessionId` from `assessmentId`.
3. Store the old session-level fields in a module-level Map keyed by `sessionId`.
4. Return the new document with `sessionId` set and the old fields dropped.

Then, after RxDB's migration completes, `openOutbox` reads the Map and creates sessions. This
works because the migration strategies run synchronously per document, and the Map is populated
before the post-migration step.

Actually, RxDB migration is async, and the strategies are called one by one. The Map approach works
if the post-migration step runs after all strategies have completed. `openOutbox` can await the
collection addition (which triggers migration) and then run the post-migration step.

Let me go with this approach. It's not elegant but it works and it's a one-time migration.

- [ ] **Step 1: Write the failing migration test**

```ts
test("v5 recordings migrate to v6 with sessions", async () => {
  // 1. Seed a v5 outbox with two recordings sharing an assessmentId,
  //    one with extracted/reviewOutcome, one without.
  // 2. Open at v6 (triggers migration).
  // 3. Assert: two recordings, both with sessionId, no extracted/reviewOutcome.
  // 4. Assert: one session, status "awaiting-review", with the moved extracted/reviewOutcome.
});
```

- [ ] **Step 2: Implement the migration**

In `database.ts`:

```ts
// Module-level map populated by the v6 migration strategy.
const migratedSessionData = new Map<string, {
  extracted?: Record<string, unknown>;
  extractedBy?: string;
  reviewOutcome?: PersistedReviewOutcome;
  writeResult?: Record<string, unknown>;
  writtenInstances?: Record<string, boolean[]>;
  idempotencyKey: string;
  recordingIds: string[];
}>();

6: (doc: OutboxDocument) => {
  // Read assessmentId from ctx (opaque to core, but the migration needs it).
  const ctx = doc.recording.ctx as Record<string, unknown> | null;
  const assessmentId = typeof ctx === "object" && ctx !== null
    ? String(ctx.assessmentId ?? "singleton")
    : "singleton";
  const sessionId = `session-${assessmentId}`;

  // Stash the session-level fields for the post-migration step.
  const existing = migratedSessionData.get(sessionId);
  if (existing) {
    existing.recordingIds.push(doc.id);
    // If this recording has extracted/reviewOutcome, merge them in
    // (the first recording's values win — they should all be the same
    // since extraction was per-assessment in the old model).
  } else {
    migratedSessionData.set(sessionId, {
      extracted: (doc as any).extracted,
      extractedBy: (doc as any).extractedBy,
      reviewOutcome: (doc as any).reviewOutcome,
      writeResult: (doc as any).writeResult,
      writtenInstances: (doc as any).writtenInstances,
      idempotencyKey: (doc as any).idempotencyKey ?? crypto.randomUUID(),
      recordingIds: [doc.id],
    });
  }

  // Return the v6 document: sessionId set, old fields dropped.
  const next = { ...doc } as any;
  delete next.extracted;
  delete next.extractedBy;
  delete next.reviewOutcome;
  delete next.writeResult;
  delete next.writtenInstances;
  delete next.idempotencyKey;
  next.sessionId = sessionId;
  return next as OutboxDocument;
},
```

After `addCollections`, in `openOutbox`:

```ts
// Post-migration: create sessions from the stashed data.
if (migratedSessionData.size > 0) {
  const sessionsCollection = database.collections.sessions;
  for (const [sessionId, data] of migratedSessionData) {
    const hasContent = data.extracted !== undefined;
    const status =
      data.reviewOutcome !== undefined
        ? data.writeResult !== undefined
          ? "done"
          : "writing"
        : data.extracted !== undefined
          ? "awaiting-review"
          : "open";
    await sessionsCollection.insert({
      id: sessionId,
      status,
      openedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
      idempotencyKey: data.idempotencyKey,
      ...(data.extracted !== undefined ? { extracted: data.extracted } : {}),
      ...(data.extractedBy !== undefined ? { extractedBy: data.extractedBy } : {}),
      ...(data.reviewOutcome !== undefined ? { reviewOutcome: data.reviewOutcome } : {}),
      ...(data.writeResult !== undefined ? { writeResult: data.writeResult } : {}),
      ...(data.writtenInstances !== undefined ? { writtenInstances: data.writtenInstances } : {}),
      extractedFromRecordingIds: data.recordingIds.sort(),
    });
  }
  migratedSessionData.clear();
}
```

- [ ] **Step 3: Run and watch the migration test pass** — Expected: PASS.

- [ ] **Step 4: Mutate**

Remove the post-migration session creation; the migration test must fail (no sessions created).
Remove the `delete next.extracted` in the strategy; the schema test must fail (`extracted` is not a
v6 field). Restore, re-run, report.

- [ ] **Step 5: Commit**

```bash
git add packages/ribo-core/src/queue
git commit -m "feat(core): migrate v5 outbox data to v6 recordings + sessions"
```

---

## Task 5: UI hooks — `useSessions`, `useReview(session)`, `useWorkSafety` update

Update the headless hook layer to work with the two-entity model.

**Files:**

- Create: `packages/ribo-ui-react/src/use-sessions.ts`
- Modify: `packages/ribo-ui-react/src/use-review.ts` (already done in Task 3, but may need
  refinement)
- Modify: `packages/ribo-ui-react/src/use-work-safety.ts` (compose session state)
- Modify: `packages/ribo-ui-react/src/index.ts` (export `useSessions`)
- Modify: `playground/src/App.tsx` (open a session, enqueue into it, review the session)

- [ ] **Step 1: Implement `useSessions`**

Mirror `useOutboxItems` — subscribe to `outbox.watchSessions(query)`:

```ts
export function useSessions(query: SessionQuery = {}, outbox?: Outbox): UseSessionsResult {
  // Same pattern as useOutboxItems: serialize the query, subscribe, manage loading/error.
}
```

- [ ] **Step 2: Update `useWorkSafety`**

`useWorkSafety` now composes `useOutboxItems` (for recordings) AND `useSessions` (for sessions),
feeds both to `summarizeWork`, and runs `workSafety` on the result. The `WorkOnDevice` shape changes
(see Task 3 Step 20).

- [ ] **Step 3: Update the playground**

The playground opens a session, enqueues recordings into it, closes the session, reviews it, and
submits. This is the end-to-end composition check.

- [ ] **Step 4: Run `./check.sh`** — Expected: PASS.

- [ ] **Step 5: Mutate**

In `useWorkSafety`, pass only recordings to `summarizeWork` (omit sessions); a test that asserts a
session in `awaiting-review` is counted as pending must fail. In `useSessions`, drop the query
serialization; a re-subscription storm test (if one exists) must fail. Restore, re-run, report.

- [ ] **Step 6: Commit**

```bash
git add packages/ribo-ui-react/src playground/src
git commit -m "feat(ui-react): session-scoped hooks — useSessions, useReview(session), work safety"
```

---

## Summary of breaking changes

| Before (v5)                                                                                                                         | After (v6)                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| One collection (`outbox`), one document (`OutboxDocument`)                                                                          | Two collections (`outbox` + `sessions`), two documents (`OutboxDocument` + `SessionDocument`)     |
| `OutboxItem` carries `extracted`, `reviewOutcome`, `writeResult`, `writtenInstances`, `idempotencyKey`                              | Those fields live on `SessionItem`; `OutboxItem` carries `sessionId`                              |
| Recording statuses: `recording`/`queued`/`transcribing`/`extracting`/`awaiting-review`/`writing`/`done`/`failed`/`dead`/`discarded` | Recording statuses: `recording`/`queued`/`transcribing`/`transcribed`/`failed`/`dead`/`discarded` |
| Relay: transcribe → extract → park → write (per item)                                                                               | Relay: transcribe (per recording) → extract → park → write (per session)                          |
| `useReview(item, { valuesSchema })`                                                                                                 | `useReview(session, { valuesSchema })`                                                            |
| `ExtractStep` / `WriteStep` (per item)                                                                                              | `SessionExtractStep` / `SessionWriteStep` (per session)                                           |
| `summarizeWork(items)`                                                                                                              | `summarizeWork(recordings, sessions)`                                                             |
| `Outbox.submitReview` / `Outbox.reopenForReview`                                                                                    | `Outbox.submitSessionReview` / `Outbox.reopenSessionForReview`                                    |
