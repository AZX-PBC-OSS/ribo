/**
 * @file The capture document's shape version and upgrade ladder.
 *
 * The version constant is maintained by hand and is **not** derived from the
 * ladder's length. Deriving it would make the length invariant assert a value
 * against itself — the two agree because a test makes them, and that test is the
 * mechanism. See `docs/roadmap/design/storage-migrations-design.md` §7.
 *
 * Reasons for rungs 0→5 come from the strategy doc comments in
 * `@azx/ribo-storage-rxdb`'s `database.ts`, which is where this history lived
 * before it was data.
 */

import type { ShapeUpgrade } from "./rung.js";
import { captureV5ToV6Upgrade } from "./v5-to-v6.js";

/** @category Offline & Storage */
export const CAPTURE_DOCUMENT_VERSION = 7;

/** @category Offline & Storage */
export const CAPTURE_DOCUMENT_UPGRADES: readonly ShapeUpgrade[] = [
  {
    reason: "Added the optional `reviewOutcome` field — the review gate.",
    rewrite: "none",
  },
  {
    reason:
      "Added the optional `capture` field. Revision 9 later removed " +
      "`canonicalAttachmentId` and `step`, so nothing here populates them.",
    rewrite: "none",
  },
  {
    reason:
      "Added the optional `preview` field — live transcription. A document captured " +
      "before live transcription existed correctly has no preview.",
    rewrite: "none",
  },
  {
    reason:
      "Added the optional `extractedBy` field — on-device extraction provenance. " +
      "Nothing reads it to decide behaviour; it is a trust signal shown at review, " +
      "so its absence degrades a badge rather than the state machine.",
    rewrite: "none",
  },
  {
    reason:
      "R1.6 instance modeling — a house can have two of things. Added the optional " +
      "`writtenInstances` field; a document written before per-instance resumability " +
      "existed has no progress to record, and the next write treats every instance as " +
      "unwritten.",
    rewrite: "none",
  },
  {
    reason:
      "The session entity splits out of the capture — the expand half of an " +
      "expand/contract. Six session-owned fields move into a `legacy` carrier for " +
      "`backfillSessions` to drain, the recording gains a `sessionId`, and the state " +
      "machine narrows to capture plus transcription.",
    upgrade: captureV5ToV6Upgrade,
  },
  {
    reason:
      "Added the optional `transcript.annotations` field. Nothing on disk changes and " +
      "the bump is not needed to read it — RxDB stores `transcript` opaquely, and " +
      "annotations round-trip at version 6 with no strategy at all. The bump buys a " +
      "clean failure on DOWNGRADE: `transcriptSchema` is a strict object, so old code " +
      "rejects a new document for the unknown key, and without the bump that rejection " +
      "surfaces deep in a read on a recording the user can see rather than at open.",
    rewrite: "none",
  },
];
