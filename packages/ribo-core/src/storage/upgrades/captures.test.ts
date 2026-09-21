import { expect, test } from "vitest";

import { CAPTURE_DOCUMENT_UPGRADES, CAPTURE_DOCUMENT_VERSION } from "./captures.js";

// Guard A. It relates the ladder to the version and nothing else — it does NOT
// catch a shape change at an unchanged version, which is the bug this repository
// actually shipped. `signatures.test.ts` is the guard for that.
test("the capture ladder has one rung per version", () => {
  expect(CAPTURE_DOCUMENT_UPGRADES).toHaveLength(CAPTURE_DOCUMENT_VERSION);
});

// Pinned as a literal so a bump is a deliberate edit. The constant is written by
// hand rather than derived from the ladder's length; if it were derived, the test
// above would assert a value against itself and check nothing.
test("the capture document is at shape version 7", () => {
  expect(CAPTURE_DOCUMENT_VERSION).toBe(7);
});

test("every capture rung says why the version moved", () => {
  for (const rung of CAPTURE_DOCUMENT_UPGRADES) {
    expect(rung.reason.length).toBeGreaterThan(0);
  }
});

test("only the session split rewrites a stored capture", () => {
  const rewriting = CAPTURE_DOCUMENT_UPGRADES.map((rung, index) => ({ rung, index })).filter(
    ({ rung }) => "upgrade" in rung,
  );
  expect(rewriting.map(({ index }) => index)).toEqual([5]);
});

const v5Capture = (): Record<string, unknown> => ({
  id: "c1",
  seq: 3,
  status: "awaiting-review",
  enqueuedAt: 1000,
  recording: { ctx: { assessmentId: "a1" } },
  extracted: { roof: "tile" },
  extractedBy: "ondevice",
  reviewOutcome: { status: "accepted", fields: {} },
  writeResult: { ok: true },
  writtenInstances: { hvac: [true] },
  idempotencyKey: "idem-1",
});

// The golden fixture. Nothing pinned rung behaviour before this — the strategies
// were exported "so a test can exercise them" and then none did.
test("the session split lifts the six session-owned fields and derives a sessionId", () => {
  const rung = CAPTURE_DOCUMENT_UPGRADES[5]!;
  if (!("upgrade" in rung)) throw new Error("rung 5 should rewrite");

  const result = rung.upgrade(v5Capture());

  expect(result.extracted).toBeUndefined();
  expect(result.extractedBy).toBeUndefined();
  expect(result.reviewOutcome).toBeUndefined();
  expect(result.writeResult).toBeUndefined();
  expect(result.writtenInstances).toBeUndefined();
  expect(result.idempotencyKey).toBeUndefined();

  expect(result.legacy).toEqual({
    extracted: { roof: "tile" },
    extractedBy: "ondevice",
    reviewOutcome: { status: "accepted", fields: {} },
    writeResult: { ok: true },
    writtenInstances: { hvac: [true] },
    idempotencyKey: "idem-1",
  });

  // From the recording's ctx, not the recording.
  expect(result.sessionId).toBe("migrated-session-a1");
  // A status the session now owns becomes the last one the recording owns.
  expect(result.status).toBe("transcribed");
});

test("the session split is deterministic", () => {
  const rung = CAPTURE_DOCUMENT_UPGRADES[5]!;
  if (!("upgrade" in rung)) throw new Error("rung 5 should rewrite");

  expect(rung.upgrade(v5Capture())).toEqual(rung.upgrade(v5Capture()));
});

// Pinning a hazard rather than a feature. The function's comment used to claim
// idempotence; it does not have it, and the failure is silent and destructive —
// the second pass finds the six fields already lifted, rebuilds `legacy` empty,
// and overwrites the carrier holding the extraction and review. `backfillSessions`
// then mints a session from nothing.
//
// This is unreachable under RxDB, which tracks a version per document and never
// re-runs a strategy on a migrated row. It is very reachable for a backend that
// batches, checkpoints and resumes by replaying a rung over a collection. That
// backend owes the at-most-once guarantee; this test is here so the claim cannot
// quietly revert to "idempotent" and take the guarantee with it.
test("re-applying the session split destroys the legacy carrier — apply it at most once per document", () => {
  const rung = CAPTURE_DOCUMENT_UPGRADES[5]!;
  if (!("upgrade" in rung)) throw new Error("rung 5 should rewrite");

  const once = rung.upgrade(v5Capture());
  const twice = rung.upgrade({ ...once });

  expect(once.legacy).not.toEqual({});
  expect(twice.legacy).toEqual({});
});
