import { expect, test } from "vitest";

import { backfillSessions } from "./backfill.js";
import { captureV5ToV6Upgrade } from "./v5-to-v6.js";
import { createMemoryBackend } from "../memory-backend.js";
import type { StorageBackend, StoredDocument } from "../port.js";

// The memory backend is a legitimate subject here, unlike for the durability
// suites: this tests grouping, status derivation and ordering, not that bytes
// reach disk. Nothing below would pass on memory and fail on IndexedDB.

let nextDatabase = 0;
const freshBackend = (): StorageBackend => createMemoryBackend(`backfill-${nextDatabase++}`);

/** A v5 recording, put through the ladder's rung so it carries a real carrier. */
const migrated = (
  id: string,
  seq: number,
  legacyFields: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): StoredDocument =>
  captureV5ToV6Upgrade({
    id,
    seq,
    status: "transcribed",
    attempts: 0,
    nextAttemptAt: "2026-01-01T00:00:00.000Z",
    enqueuedAt: `2026-01-0${seq + 1}T00:00:00.000Z`,
    recording: { kind: "audio", ctx: { assessmentId: "a1" } },
    ...legacyFields,
    ...overrides,
  }) as StoredDocument;

test("two recordings sharing a derived session become one session", async () => {
  const backend = freshBackend();
  await backend.insert("captures", migrated("c1", 0, { extracted: { roof: "tile" } }));
  await backend.insert("captures", migrated("c2", 1, {}));

  await backfillSessions(backend);

  const sessions = await backend.find("sessions", {});
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.id).toBe("migrated-session-a1");
  // `ref` is the assessment id itself, not the session id.
  expect(sessions[0]!.ref).toBe("a1");
});

test("the session's status comes from the whole group, not from one row", async () => {
  const backend = freshBackend();
  // Only the SECOND recording carries the review. A per-document fold could not
  // see it while deciding the first one's contribution — this is the property
  // that makes the backfill impossible to express as a rung.
  await backend.insert("captures", migrated("c1", 0, { extracted: { roof: "tile" } }));
  await backend.insert("captures", migrated("c2", 1, { reviewOutcome: { status: "accepted" } }));

  await backfillSessions(backend);

  const [session] = await backend.find("sessions", {});
  expect(session!.status).toBe("writing");
});

test("the carriers are cleared once the session holds the data", async () => {
  const backend = freshBackend();
  await backend.insert("captures", migrated("c1", 0, { extracted: { roof: "tile" } }));

  await backfillSessions(backend);

  const [capture] = await backend.find("captures", {});
  expect(capture!.legacy).toBeUndefined();
  expect(capture!.sessionId).toBe("migrated-session-a1");
});

test("a recording with no carrier is left alone", async () => {
  const backend = freshBackend();
  // Enqueued by current code: it already has a real session and must not be
  // swept into a synthetic one.
  await backend.insert("captures", {
    id: "c9",
    seq: 0,
    status: "queued",
    sessionId: "a-real-session",
    attempts: 0,
    nextAttemptAt: "2026-01-01T00:00:00.000Z",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    recording: { kind: "audio", ctx: {} },
  });

  await backfillSessions(backend);

  expect(await backend.find("sessions", {})).toHaveLength(0);
});

test("an empty database is a no-op, so a backend may call it unconditionally", async () => {
  const backend = freshBackend();
  await backfillSessions(backend);
  expect(await backend.find("sessions", {})).toHaveLength(0);
});

// The idempotency hinge. A crash between the insert and the clear leaves the
// carriers in place with the session already built, so the next open finds the
// same group again and must leave it alone rather than colliding on the primary
// key. Unlike the rungs, this one really is safe to re-run — which is what makes
// it usable as an unconditional step at open.
test("running the backfill twice neither throws nor mints a second session", async () => {
  const backend = freshBackend();
  await backend.insert("captures", migrated("c1", 0, { extracted: { roof: "tile" } }));

  await backfillSessions(backend);
  const afterFirst = await backend.find("sessions", {});
  await backfillSessions(backend);
  const afterSecond = await backend.find("sessions", {});

  expect(afterSecond).toHaveLength(1);
  expect(afterSecond[0]).toEqual(afterFirst[0]);
});

// Simulates the crash the hinge exists for: the session was inserted, the clear
// never happened, and the next open sees a carrier with a session already there.
test("a group whose session already exists is not re-inserted", async () => {
  const backend = freshBackend();
  await backend.insert("captures", migrated("c1", 0, { extracted: { roof: "tile" } }));
  await backend.insert("sessions", {
    id: "migrated-session-a1",
    status: "done",
    openedAt: "2020-01-01T00:00:00.000Z",
    ctx: {},
    ref: "pre-existing",
    attempts: 0,
    nextAttemptAt: "2020-01-01T00:00:00.000Z",
    idempotencyKey: "pre-existing",
  });

  await backfillSessions(backend);

  const sessions = await backend.find("sessions", {});
  expect(sessions).toHaveLength(1);
  // Untouched — the pre-existing session wins, and the carrier is still cleared.
  expect(sessions[0]!.ref).toBe("pre-existing");
  const [capture] = await backend.find("captures", {});
  expect(capture!.legacy).toBeUndefined();
});
