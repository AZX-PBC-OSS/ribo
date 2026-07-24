import { describe, expect, test } from "vitest";

import type { OutboxStatus } from "./queue/schema.js";
import { summarizeWork, workSafety } from "./work-safety.js";
import type { StoragePersistence, WorkOnDevice } from "./work-safety.js";

// A `WorkOnDevice` with nothing on the device: no unsynced work, nothing dead,
// nothing ever synced. Individual tests override just the field they exercise.
const empty: WorkOnDevice = { pending: 0, dead: 0, synced: 0 };

const items = (...statuses: OutboxStatus[]): { status: OutboxStatus }[] =>
  statuses.map((status) => ({ status }));

describe("summarizeWork", () => {
  test("buckets every active status as pending unsynced work", () => {
    const summary = summarizeWork(
      items("queued", "transcribing", "extracting", "writing", "failed"),
    );
    expect(summary).toEqual({ pending: 5, dead: 0, synced: 0 });
  });

  test("counts done as synced — work that has left the device", () => {
    expect(summarizeWork(items("done", "done"))).toEqual({ pending: 0, dead: 0, synced: 2 });
  });

  test("counts dead separately — it is neither pending nor synced", () => {
    expect(summarizeWork(items("dead"))).toEqual({ pending: 0, dead: 1, synced: 0 });
  });

  test("an empty outbox is all zeros", () => {
    expect(summarizeWork([])).toEqual({ pending: 0, dead: 0, synced: 0 });
  });

  test("a realistic mix", () => {
    expect(summarizeWork(items("queued", "failed", "done", "dead", "done"))).toEqual({
      pending: 2,
      dead: 1,
      synced: 2,
    });
  });
});

describe("workSafety — the truly-safe edge", () => {
  test("nothing captured is safe, and says so", () => {
    expect(workSafety(empty, "granted", "online")).toEqual({
      level: "safe",
      reason: "nothing-captured",
    });
  });

  test("everything synced is safe — the reassuring 'all up' answer", () => {
    expect(workSafety({ pending: 0, dead: 0, synced: 3 }, "unsupported", "offline")).toEqual({
      level: "safe",
      reason: "all-synced",
    });
  });

  test("persistence is irrelevant once nothing is left on the device", () => {
    // No on-device work, so a refused persistence grant cannot make it unsafe.
    expect(workSafety({ pending: 0, dead: 0, synced: 1 }, "denied", "offline").level).toBe("safe");
  });
});

describe("workSafety — the three situations stay distinct", () => {
  test("pending work waiting for connectivity is a normal, protected field condition", () => {
    expect(workSafety({ pending: 3, dead: 0, synced: 0 }, "granted", "offline")).toEqual({
      level: "protected",
      reason: "awaiting-sync",
      pending: 3,
      connectivity: "offline",
    });
  });

  test("protected carries connectivity so the UI can say 'syncing' vs 'waiting'", () => {
    expect(workSafety({ pending: 1, dead: 0, synced: 0 }, "granted", "online")).toEqual({
      level: "protected",
      reason: "awaiting-sync",
      pending: 1,
      connectivity: "online",
    });
  });

  test("the SAME pending work becomes at-risk when storage is not persistent", () => {
    expect(workSafety({ pending: 3, dead: 0, synced: 0 }, "denied", "offline")).toEqual({
      level: "at-risk",
      reason: "not-persisted",
      pending: 3,
      persistence: "denied",
    });
  });

  test("a permanently-failed item needs a human", () => {
    expect(workSafety({ pending: 0, dead: 1, synced: 0 }, "granted", "online")).toEqual({
      level: "action-required",
      reason: "failed-permanently",
      dead: 1,
    });
  });
});

describe("workSafety — persistence that is not an outright grant is never a grant", () => {
  const notGranted: Exclude<StoragePersistence, "granted">[] = ["denied", "unsupported", "unknown"];

  for (const persistence of notGranted) {
    test(`pending work with persistence='${persistence}' is at-risk, carrying the reason`, () => {
      const safety = workSafety({ pending: 2, dead: 0, synced: 0 }, persistence, "online");
      expect(safety).toEqual({
        level: "at-risk",
        reason: "not-persisted",
        pending: 2,
        persistence,
      });
    });
  }

  test("'unknown' (grant still being checked) is treated conservatively, not as safe", () => {
    // Never overstate safety while the answer is still in flight.
    expect(workSafety({ pending: 1, dead: 0, synced: 0 }, "unknown", "online").level).toBe(
      "at-risk",
    );
  });
});

describe("workSafety — load-bearing rules", () => {
  // If someone later loosens the persistence rule, THIS must break.
  test("work present + persistence NOT granted must NOT classify as fully safe", () => {
    for (const persistence of ["denied", "unsupported", "unknown"] as const) {
      for (const connectivity of ["offline", "probing", "online"] as const) {
        const safety = workSafety({ pending: 1, dead: 0, synced: 0 }, persistence, connectivity);
        expect(safety.level).not.toBe("safe");
        expect(safety.level).not.toBe("protected");
        expect(safety.level).toBe("at-risk");
      }
    }
  });

  test("only synced is truly safe: a persistence grant does NOT make on-device work 'safe'", () => {
    // Best case for on-device work — granted storage, online — is still only
    // 'protected'. Nothing short of leaving the device earns 'safe'.
    expect(workSafety({ pending: 1, dead: 0, synced: 5 }, "granted", "online").level).toBe(
      "protected",
    );
  });

  test("a dead item outranks an eviction risk — the human is told first", () => {
    // dead AND not-persisted AND pending: the permanent failure is the most
    // severe, most actionable answer, so it wins.
    expect(workSafety({ pending: 4, dead: 2, synced: 0 }, "denied", "offline")).toEqual({
      level: "action-required",
      reason: "failed-permanently",
      dead: 2,
    });
  });
});
